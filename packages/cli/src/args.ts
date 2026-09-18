/**
 * Argument parsing, by hand and on purpose.
 *
 * This package ships with no runtime dependencies (see build.mjs), and an argument
 * parser is the one place where that is easy to keep. What it buys is worth more
 * than the hundred lines it costs: every error message below can be written for a
 * parish administrator following instructions somebody else typed for them, rather
 * than being whatever a library prints.
 *
 * The rule those messages follow: say what was wrong, say what is allowed, and do
 * not make the reader open the manual to recover.
 */

import os from 'node:os';
import path from 'node:path';
import { DEFAULT_FILE_TIMEOUT_MS } from './pool';

import {
  FORMATS,
  UsageError,
  type ConflictPolicy,
  type DocxMode,
  type Format,
  type RequestedFormat,
} from './types';

export interface Options {
  command: 'convert' | 'check';
  /** Absolute. A folder, or a single .pub file. */
  input: string;
  /** Absolute. Ignored by `check` and by `--dry-run`. */
  out: string;
  formats: RequestedFormat[];
  docxMode: DocxMode;
  recursive: boolean;
  followSymlinks: boolean;
  conflict: ConflictPolicy;
  /** 1 means "do the work on this thread"; above 1 spawns that many workers. */
  jobs: number;
  /** Absolute path, or null for no report file. */
  reportPath: string | null;
  dryRun: boolean;
  quiet: boolean;
  verbose: boolean;
  maxFileBytes: number;
  /** Milliseconds one file may run before it is stopped. 0 disables. See pool.ts. */
  fileTimeoutMs: number;
  colour: boolean;
}

export type Parsed =
  | { kind: 'help'; topic: 'general' }
  | { kind: 'version' }
  | { kind: 'run'; options: Options };

/**
 * A Publisher file has to be read whole before any of it makes sense — it is an OLE
 * compound document, not a stream — so peak memory for one file is roughly its size
 * plus what the reader expands it into. The reader's own workspace is capped at
 * 512 MB by the WebAssembly build, so a file far past this default cannot succeed
 * anyway; reporting it is kinder than letting it take the run down.
 */
const DEFAULT_MAX_FILE_BYTES = 128 * 1024 * 1024;

/**
 * Each worker carries its own copy of the reader and its own workspace, so `--jobs`
 * buys speed with memory. Eight is where that trade stops being obviously worth it
 * on the kind of machine this is bought for.
 */
const MAX_JOBS = 8;

const DEFAULT_OUT = 'Converted';

function isOption(token: string): boolean {
  return token.startsWith('-') && token !== '-';
}

/** Quotes a value back at the user so a stray space or quote mark is visible. */
function show(value: string): string {
  return JSON.stringify(value);
}

export /**
 * `--file-timeout <seconds>`; 0 means wait forever. Seconds because the person setting it
 * is thinking "give it five minutes", not in milliseconds.
 */
function parseTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_FILE_TIMEOUT_MS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new UsageError(`--file-timeout needs a number of seconds, not "${raw}".`);
  }
  return Math.round(seconds * 1000);
}

function parseSize(raw: string, flag: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/i.exec(raw.trim());
  if (!match) {
    throw new UsageError(
      `${flag} did not understand ${show(raw)}.`,
      'Write a size like 50MB, 500KB or 2GB.',
    );
  }
  const n = Number(match[1]);
  const unit = (match[2] ?? 'b').toLowerCase();
  const scale =
    unit === 'b' ? 1
      : unit === 'k' || unit === 'kb' ? 1024
        : unit === 'm' || unit === 'mb' ? 1024 * 1024
          : 1024 * 1024 * 1024;
  const bytes = Math.floor(n * scale);
  if (bytes <= 0) throw new UsageError(`${flag} must be larger than zero.`);
  return bytes;
}

function parseJobs(raw: string): number {
  if (raw.trim().toLowerCase() === 'auto') {
    // One per core, less one for the machine the user is still trying to use.
    return Math.max(1, Math.min(MAX_JOBS, os.cpus().length - 1));
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new UsageError(
      `--jobs needs a whole number of 1 or more, not ${show(raw)}.`,
      'Use --jobs 1 to convert one file at a time, or --jobs auto to use this machine’s processors.',
    );
  }
  if (n > MAX_JOBS) {
    throw new UsageError(
      `--jobs ${n} is more than this tool will run at once (${MAX_JOBS}).`,
      'Each one holds a separate copy of the Publisher reader, so past eight it costs memory without going faster.',
    );
  }
  return n;
}

function parseFormats(raw: string): RequestedFormat[] {
  const parts = raw
    .split(',')
    .map((p) => p.trim().toLowerCase().replace(/^\./, ''))
    .filter((p) => p !== '');

  if (parts.length === 0) {
    throw new UsageError(
      '--to was given nothing to convert to.',
      'Try --to pptx, or --to pptx,pdf for both, or --to auto to let it choose.',
    );
  }

  const seen: RequestedFormat[] = [];
  for (const part of parts) {
    const alias =
      part === 'powerpoint' ? 'pptx'
        : part === 'word' || part === 'doc' ? 'docx'
          : part;
    if (alias !== 'auto' && !(FORMATS as readonly string[]).includes(alias)) {
      throw new UsageError(
        `We cannot convert to ${show(part)}.`,
        'The choices are pptx (PowerPoint), docx (Word), pdf, svg, or auto.',
      );
    }
    const value = alias as RequestedFormat;
    if (!seen.includes(value)) seen.push(value);
  }
  return seen;
}

function parseConflict(raw: string): ConflictPolicy {
  const value = raw.trim().toLowerCase();
  if (value === 'rename' || value === 'skip' || value === 'overwrite') return value;
  throw new UsageError(
    `--on-conflict does not understand ${show(raw)}.`,
    'The choices are rename (the default: writes "Bulletin (2).pptx"), skip, or overwrite.',
  );
}

function parseDocxMode(raw: string): DocxMode {
  const value = raw.trim().toLowerCase();
  if (value === 'layout' || value === 'flow') return value;
  throw new UsageError(
    `--docx-mode does not understand ${show(raw)}.`,
    'The choices are layout (the default: keeps the page looking like the original) or flow (ordinary Word paragraphs you can retype).',
  );
}

/** Long options carrying a value, mapped to the short forms that mean the same thing. */
const VALUE_FLAGS = new Set([
  '--to', '--out', '--report', '--jobs', '--on-conflict', '--docx-mode', '--max-file-size',
  '--file-timeout',
]);

const SHORT: Record<string, string> = {
  '-t': '--to',
  '-o': '--out',
  '-r': '--recursive',
  '-j': '--jobs',
  '-q': '--quiet',
  '-v': '--verbose',
  '-h': '--help',
  '-V': '--version',
};

export function parseArgs(argv: readonly string[], cwd: string): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();

  let onlyPositional = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;

    if (onlyPositional || !isOption(token)) {
      positional.push(token);
      continue;
    }
    if (token === '--') { onlyPositional = true; continue; }

    let name = token;
    let inline: string | undefined;

    const eq = token.indexOf('=');
    if (token.startsWith('--') && eq !== -1) {
      name = token.slice(0, eq);
      inline = token.slice(eq + 1);
    }
    if (SHORT[name]) name = SHORT[name] as string;

    if (VALUE_FLAGS.has(name)) {
      let value = inline;
      if (value === undefined) {
        const next = argv[i + 1];
        // A value that itself looks like an option is nearly always a forgotten
        // argument (`--to --out ...`), and consuming it hides the real mistake.
        if (next === undefined || isOption(next)) {
          throw new UsageError(
            `${name} needs a value after it.`,
            'Run "pubshift --help" to see what each option expects.',
          );
        }
        value = next;
        i++;
      }
      flags.set(name, value);
      continue;
    }

    if (inline !== undefined) {
      throw new UsageError(`${name} does not take a value, so ${show(token)} is not understood.`);
    }
    flags.set(name, true);
  }

  if (flags.has('--help')) return { kind: 'help', topic: 'general' };
  if (flags.has('--version')) return { kind: 'version' };

  const known = new Set([
    ...VALUE_FLAGS,
    '--recursive', '--follow-symlinks', '--dry-run', '--quiet', '--verbose',
    '--no-color', '--no-colour', '--help', '--version',
  ]);
  for (const name of flags.keys()) {
    if (!known.has(name)) {
      throw new UsageError(
        `${name} is not an option this tool knows.`,
        'Run "pubshift --help" for the full list.',
      );
    }
  }

  const command = positional[0];
  if (command === undefined) {
    return { kind: 'help', topic: 'general' };
  }
  if (command !== 'convert' && command !== 'check') {
    // The commonest slip: pointing at a folder without saying what to do with it.
    const looksLikeAPath = command.includes('/') || command.includes('\\') || command.includes('.');
    throw new UsageError(
      `${show(command)} is not a command.`,
      looksLikeAPath
        ? `Did you mean: pubshift convert ${command} --to pptx --out ./Converted`
        : 'The commands are "convert" and "check".',
    );
  }

  const target = positional[1];
  if (target === undefined) {
    throw new UsageError(
      `"pubshift ${command}" needs a folder to look in.`,
      `For example: pubshift ${command} ./Bulletins`,
    );
  }
  if (positional.length > 2) {
    throw new UsageError(
      `"pubshift ${command}" takes one folder, but ${positional.length - 1} were given.`,
      'A folder name containing spaces needs quotes around it, like "Parish Bulletins".',
    );
  }

  const quiet = flags.has('--quiet');
  const verbose = flags.has('--verbose');
  if (quiet && verbose) {
    throw new UsageError('--quiet and --verbose ask for opposite things.', 'Pick one.');
  }

  const str = (name: string): string | undefined => {
    const value = flags.get(name);
    return typeof value === 'string' ? value : undefined;
  };

  const rawReport = str('--report');
  const options: Options = {
    command,
    input: path.resolve(cwd, target),
    out: path.resolve(cwd, str('--out') ?? DEFAULT_OUT),
    formats: parseFormats(str('--to') ?? 'pptx'),
    docxMode: parseDocxMode(str('--docx-mode') ?? 'layout'),
    recursive: flags.has('--recursive'),
    followSymlinks: flags.has('--follow-symlinks'),
    conflict: parseConflict(str('--on-conflict') ?? 'rename'),
    jobs: parseJobs(str('--jobs') ?? '1'),
    reportPath: rawReport === undefined ? null : path.resolve(cwd, rawReport),
    dryRun: flags.has('--dry-run'),
    quiet,
    verbose,
    maxFileBytes: parseSize(str('--max-file-size') ?? String(DEFAULT_MAX_FILE_BYTES), '--max-file-size'),
    fileTimeoutMs: parseTimeout(str('--file-timeout')),
    colour: !flags.has('--no-color') && !flags.has('--no-colour'),
  };

  if (options.command === 'check' && flags.has('--out')) {
    throw new UsageError(
      '"pubshift check" never writes converted files, so --out has nothing to do.',
      'Use "pubshift convert" to write files, or drop --out to just look.',
    );
  }

  return { kind: 'run', options };
}

/** The formats that will definitely be produced, ignoring whatever `auto` resolves to. */
export function fixedFormats(options: Options): Format[] {
  return options.formats.filter((f): f is Format => f !== 'auto');
}
