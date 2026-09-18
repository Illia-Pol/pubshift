/**
 * One file, start to finish.
 *
 * .pub bytes -> WebAssembly reader -> IR -> document model -> assess -> emitter -> disk
 *
 * Two things in here are load-bearing and neither is negotiable.
 *
 * **The gate.** `assess()` returns `empty` for a file that libmspub parsed without
 * complaint and returned nothing from — five of the thirty-one corpus files do exactly
 * that (docs/FIDELITY.md). Those files get no output written, ever, under any flag.
 * A blank .docx presented as a success is the specific failure this product exists to
 * prevent, and in a batch it is worse than in the browser: nobody opens all four
 * hundred results, so a silent blank is a file the parish discovers it has lost in 2030.
 *
 * **Nothing accumulates.** Every large value — the file bytes, the IR JSON, the model,
 * each emitted document — is dropped as soon as the next step has what it needs. The
 * caller keeps a `FileResult` per file, which is strings, counts and warning codes. That
 * is what makes four hundred files cost about the same as four.
 *
 * The split between `produce` and `writeProduced` is what lets `--jobs` work: producing
 * is pure computation and can happen on a worker thread, while every decision about
 * *which name to write* stays on the main thread, where one `OutputPlanner` can see all
 * of them at once. Two threads picking output names independently is how you get two
 * files called `Easter (2).pptx`.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  assess, buildDoc, readIR, recommendFormat,
  type Doc, type Warning,
} from '@pubshift/core';
import { emitPPTXWithReport } from '@pubshift/core/emit/pptx';
import { emitDOCX } from '@pubshift/core/emit/docx';
import { emitPDF } from '@pubshift/core/emit/pdf';
import { emitSVG } from '@pubshift/core/emit/svg';

import type { Options } from './args';
import { loadEngine, reloadEngine, type ExtractorHandle } from './engine';
import { OutputPlanner, stemOf, type Claim } from './plan';
import type { FileResult, Format, FormatChoice, OutputFile } from './types';
import type { FoundFile } from './walk';

/** The first eight bytes of every OLE compound document, which is what a .pub is. */
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

function hasOleMagic(bytes: Uint8Array): boolean {
  if (bytes.length < OLE_MAGIC.length) return false;
  return OLE_MAGIC.every((b, i) => bytes[i] === b);
}

/**
 * `PubshiftError` and `IRReadError` both carry a sentence written for the person who
 * owns the file. Passing it through beats paraphrasing it into something more
 * technical and less useful.
 */
function messageOf(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return fallback;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/**
 * Why a read failed, in words the owner of the machine can act on.
 *
 * The lock-file check is the one that earns its keep: `~$Bulletin.pub` beside
 * `Bulletin.pub` is Office saying the document is open right now, which in an office
 * running a batch over a shared drive is the single likeliest reason a file will not
 * open. "Close it in Publisher and run this again" is a fix; "EBUSY" is not.
 */
function readFailureReason(error: unknown, file: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const openElsewhere = `It looks like this file is open in another program. Close "${path.basename(file)}" and run this again.`;

  switch (code) {
    case 'EBUSY':
    case 'ETXTBSY':
      return openElsewhere;
    case 'EACCES':
    case 'EPERM':
      return `We do not have permission to read this file. ${openElsewhere}`;
    case 'ENOENT':
      return 'This file disappeared while the conversion was running.';
    case 'EIO':
      return 'The disk reported an error reading this file. If it is on a network drive, copy it to this computer and try again.';
    case 'EISDIR':
      return 'This is a folder, not a file.';
    default:
      return `We could not read this file from disk (${code ?? 'unknown error'}).`;
  }
}

/**
 * Collects warnings from the model and the emitters without repeating any.
 *
 * The same warning arrives more than once by design: `emitPDF` appends its losses to
 * `doc.warnings` rather than returning them, so the caller re-reads that list after
 * every emitter and sees the earlier entries again. Deduplicating on the largest count
 * seen — rather than summing — keeps "13 times" honest; a report that inflates its own
 * numbers is worse than one that rounds down.
 */
class WarningBag {
  readonly #byKey = new Map<string, Warning>();

  add(warning: Warning): void {
    const key = `${warning.code}|${warning.page ?? ''}|${warning.message}`;
    const existing = this.#byKey.get(key);
    if (existing === undefined) {
      this.#byKey.set(key, { ...warning });
      return;
    }
    const count = Math.max(existing.count ?? 1, warning.count ?? 1);
    if (count > 1) existing.count = count;
  }

  addAll(warnings: readonly Warning[] | undefined): void {
    for (const w of warnings ?? []) this.add(w);
  }

  get all(): Warning[] { return [...this.#byKey.values()]; }
}

/** One file to write. `data` is absent for `check` and `--dry-run`, which write nothing. */
export interface EmittedPart {
  format: Format;
  /** Appended to the stem: SVG writes one file per page past the first. */
  suffix: string;
  data?: Uint8Array;
}

/**
 * Everything computing one file produced, with no decisions about disk in it.
 *
 * Deliberately plain data: this crosses a worker thread boundary under `--jobs`, so it
 * must survive `structuredClone` — no classes, no functions, no `Doc`.
 */
export interface Produced {
  /** `ready` means there is something to write; the other two never write anything. */
  status: 'ready' | 'unreadable' | 'failed';
  message?: string;
  pages: number;
  elements: number;
  textLength: number;
  images: number;
  warnings: Warning[];
  /** Operational failures, verbatim. Kept apart from `warnings` — see FileResult.problems. */
  problems?: string[];
  format?: FormatChoice;
  parts: EmittedPart[];
  ms: number;
}

/** Resolves `--to auto` for this document, and says why it chose what it chose. */
export function chooseFormats(doc: Doc, requested: readonly ('auto' | Format)[]): {
  formats: Format[];
  choice?: FormatChoice;
} {
  const formats: Format[] = [];
  let choice: FormatChoice | undefined;

  for (const want of requested) {
    if (want !== 'auto') {
      if (!formats.includes(want)) formats.push(want);
      continue;
    }
    const advice = recommendFormat(doc);
    // docs/POSITIONING.md: take the recommendation only where it is confident, and fall
    // back to PPTX otherwise. recommendFormat() already returns pptx when it is unsure,
    // but going through it explicitly means the report can say *which* of the two rules
    // applied, and the two are not the same claim.
    const chosen: Format = advice.confident ? advice.format : 'pptx';
    choice = { format: chosen, automatic: true, because: advice.because };
    if (!formats.includes(chosen)) formats.push(chosen);
  }

  // The user named exactly one format: worth recording, so the report can say which,
  // but not "chosen automatically", because it was not.
  if (choice === undefined && formats.length === 1) {
    choice = { format: formats[0] as Format, automatic: false, because: '' };
  }

  return choice === undefined ? { formats } : { formats, choice };
}

async function emit(
  doc: Doc,
  format: Format,
  options: Options,
  warnings: WarningBag,
): Promise<EmittedPart[]> {
  switch (format) {
    case 'pptx': {
      const result = await emitPPTXWithReport(doc);
      warnings.addAll(result.warnings);
      return [{ format, suffix: '', data: result.bytes }];
    }
    case 'docx': {
      const bytes = await emitDOCX(doc, {
        mode: options.docxMode,
        onWarning: (w) => warnings.add(w),
      });
      return [{ format, suffix: '', data: bytes }];
    }
    case 'pdf': {
      // emitPDF appends its own losses to doc.warnings rather than returning them,
      // so the caller re-reads that list afterwards.
      const bytes = await emitPDF(doc);
      return [{ format, suffix: '', data: bytes }];
    }
    case 'svg': {
      // One page at a time rather than emitSVGPages(), which would hold every page of
      // a fifty-page newsletter as a string at once. Same output, a fraction of the peak.
      const parts: EmittedPart[] = [];
      for (let i = 0; i < doc.pages.length; i++) {
        parts.push({
          format,
          suffix: doc.pages.length === 1 ? '' : ` page ${i + 1}`,
          data: Buffer.from(emitSVG(doc, { page: i }), 'utf8'),
        });
      }
      return parts;
    }
  }
}

function failed(message: string, started: number): Produced {
  return {
    status: 'failed', message, pages: 0, elements: 0, textLength: 0, images: 0,
    warnings: [], parts: [], ms: Date.now() - started,
  };
}

/**
 * Reads, parses, assesses and (unless this is a check) emits one file. Touches the disk
 * only to read. Never throws for anything the file or the disk did — those come back as
 * `failed`, because one bad file in a folder of four hundred must not end the run.
 *
 * It *does* throw when the reader itself will not start: that is our fault, it will fail
 * for every remaining file too, and four hundred rows blaming the user's documents for
 * it would be a lie.
 */
export async function produce(file: FoundFile, options: Options): Promise<Produced> {
  const started = Date.now();

  if (file.size === 0) {
    return failed('This file is empty. It may not have finished copying.', started);
  }
  if (file.size > options.maxFileBytes) {
    return failed(
      `This file is ${formatBytes(file.size)}, which is past the ${formatBytes(options.maxFileBytes)} limit. ` +
      'Use --max-file-size to raise it, but be aware the reader works in a 512 MB space and very large files may not fit.',
      started,
    );
  }

  let bytes: Uint8Array | undefined;
  try {
    bytes = new Uint8Array(await readFile(file.path));
  } catch (error) {
    return failed(readFailureReason(error, file.path), started);
  }

  if (!hasOleMagic(bytes)) {
    return failed(
      'This file is named .pub but it is not a Publisher publication inside. If it was renamed, or came out of an email, try the original file.',
      started,
    );
  }

  // Not wrapped: if the reader will not start, the run must stop rather than blame the
  // documents. `cli.ts` catches EngineUnavailable and says so once.
  const engine: ExtractorHandle = await loadEngine();

  let doc: Doc;
  try {
    const json = engine.extractJSON(bytes);
    bytes = undefined; // the reader is done with them; a 20 MB file need not stay resident
    doc = buildDoc(readIR(json));
  } catch (error) {
    bytes = undefined;
    // A load error means the module itself is unhappy; its heap may not be sane for
    // the next file, so rebuild it before carrying on.
    if (error instanceof Error && error.name === 'PubshiftLoadError') {
      try { await reloadEngine(); } catch { /* the next file will report it properly */ }
    }
    return failed(messageOf(error, 'We could not read this Publisher file.'), started);
  }

  // ---- the gate ----------------------------------------------------------
  // docs/FIDELITY.md: five corpus files parse cleanly and hold nothing. They are told
  // about, never written. Removing this makes the product no better than the free
  // uploaders it is defined against.
  const verdict = assess(doc);
  const counts = {
    pages: verdict.pages,
    elements: verdict.elements,
    textLength: verdict.textLength,
    images: verdict.images,
  };
  if (verdict.verdict === 'empty') {
    return {
      status: 'unreadable', message: verdict.message, ...counts,
      warnings: [], parts: [], ms: Date.now() - started,
    };
  }

  const { formats, choice } = chooseFormats(doc, options.formats);

  const warnings = new WarningBag();
  warnings.addAll(doc.warnings);
  // Operational failures, kept apart from fidelity losses — see FileResult.problems.
  const problems: string[] = [];

  // `check` and `--dry-run` stop here. Everything above is the part that decides whether
  // a file converts, and it has already run for real; what is left is only writing.
  if (options.command === 'check' || options.dryRun) {
    const parts: EmittedPart[] = [];
    for (const format of formats) {
      const pageCount = format === 'svg' ? doc.pages.length : 1;
      for (let i = 0; i < pageCount; i++) {
        parts.push({ format, suffix: format === 'svg' && pageCount > 1 ? ` page ${i + 1}` : '' });
      }
    }
    return {
      status: 'ready', ...counts, warnings: warnings.all, parts, ms: Date.now() - started,
    ...(problems.length > 0 ? { problems } : {}),
      ...(choice === undefined ? {} : { format: choice }),
      ...(verdict.verdict === 'partial' ? { message: verdict.message } : {}),
    };
  }

  const parts: EmittedPart[] = [];
  for (const format of formats) {
    try {
      parts.push(...await emit(doc, format, options, warnings));
    } catch (error) {
      problems.push(messageOf(
        error,
        `We read this publication but could not write the ${format.toUpperCase()} version of it.`,
      ));
    }
    // emitPDF reports through doc.warnings rather than a return value.
    warnings.addAll(doc.warnings);
  }

  if (parts.length === 0) {
    return {
      status: 'failed',
      message: 'We read this publication but could not produce a converted file from it.',
      ...counts, warnings: warnings.all, parts: [], ms: Date.now() - started,
      ...(problems.length > 0 ? { problems } : {}),
    };
  }

  return {
    status: 'ready', ...counts, warnings: warnings.all, parts, ms: Date.now() - started,
    ...(choice === undefined ? {} : { format: choice }),
    ...(verdict.verdict === 'partial' ? { message: verdict.message } : {}),
  };
}

/** The buffers in a `Produced`, so `postMessage` can move them instead of copying them. */
export function transfers(produced: Produced): ArrayBuffer[] {
  const buffers: ArrayBuffer[] = [];
  for (const part of produced.parts) {
    if (part.data === undefined) continue;
    const buffer = part.data.buffer;
    // A Buffer from `readFile` can be a view onto Node's shared 64 KB pool; transferring
    // that would detach memory other code still holds. Only whole, exclusively-owned
    // buffers are worth moving, and a copy is cheap next to the conversion.
    if (buffer instanceof ArrayBuffer &&
        part.data.byteOffset === 0 &&
        part.data.byteLength === buffer.byteLength &&
        !buffers.includes(buffer)) {
      buffers.push(buffer);
    }
  }
  return buffers;
}

export interface WriteDeps {
  options: Options;
  planner: OutputPlanner;
}

/**
 * Turns what was produced into files on disk and a row for the report.
 *
 * Runs on the main thread even under `--jobs`, because the planner has to be the only
 * thing choosing names.
 */
export async function writeProduced(
  file: FoundFile,
  produced: Produced,
  deps: WriteDeps,
): Promise<FileResult> {
  const { options, planner } = deps;
  const base: FileResult = {
    source: file.relative,
    absolute: file.path,
    sizeBytes: file.size,
    outcome: 'failed',
    outputs: [],
    pages: produced.pages,
    warnings: produced.warnings,
    ms: produced.ms,
    elements: produced.elements,
    textLength: produced.textLength,
    images: produced.images,
    ...(produced.format === undefined ? {} : { format: produced.format }),
    ...(produced.message === undefined ? {} : { message: produced.message }),
  };

  if (produced.status !== 'ready') {
    return { ...base, outcome: produced.status };
  }

  const relativeDir = path.dirname(file.relative) === '.' ? '' : path.dirname(file.relative);
  const stem = stemOf(file.path);
  const written: OutputFile[] = [];
  const problems: string[] = [...(produced.problems ?? [])];
  const warnings = new WarningBag();
  warnings.addAll(produced.warnings);
  let failures = 0;
  let skipped = 0;

  for (const part of produced.parts) {
    // `check` writes nothing and claims nothing. Asking the planner would make it report
    // files as "already converted" just because an old ./Converted folder is lying about,
    // which is the opposite of what a read-only look at the archive is for.
    if (options.command === 'check') {
      written.push({ format: part.format, path: '' });
      continue;
    }

    let claim: Claim = planner.plan(relativeDir, `${stem}${part.suffix}`, part.format);
    if (claim.action === 'skip') { skipped++; continue; }

    // `--dry-run` deliberately did not emit any bytes: record the name that would have
    // been used and move on.
    if (part.data === undefined) {
      written.push({ format: part.format, path: claim.path });
      continue;
    }

    try {
      planner.ensureDir(claim);
      // Exclusive create unless the user asked for overwrite, so that a file which
      // appeared between our check and our write is still not clobbered.
      for (;;) {
        try {
          await writeFile(claim.path, part.data, {
            flag: options.conflict === 'overwrite' ? 'w' : 'wx',
          });
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          claim = planner.retry(claim);
          planner.ensureDir(claim);
        }
      }
      written.push({ format: part.format, path: claim.path, bytes: part.data.byteLength });
    } catch (error) {
      failures++;
      const code = (error as NodeJS.ErrnoException).code;
      problems.push(
        code === 'ENOSPC' ? 'The disk is full, so this could not be written.'
          : code === 'EACCES' || code === 'EPERM'
            ? `We do not have permission to write into "${path.dirname(claim.path)}".`
            : `We could not write "${path.basename(claim.path)}" (${code ?? 'unknown error'}).`,
      );
    }
  }

  const result: FileResult = {
    ...base, warnings: warnings.all, outputs: written,
    ...(problems.length > 0 ? { problems } : {}),
  };

  if (written.length === 0) {
    if (skipped > 0 && failures === 0) {
      return {
        ...result,
        outcome: 'skipped',
        message: 'The converted file was already there, so it was left alone.',
      };
    }
    return {
      ...result,
      outcome: 'failed',
      message: result.message ?? 'We read this publication but could not write the converted file.',
    };
  }

  const caveats = failures > 0 || result.warnings.length > 0 ||
    (result.message !== undefined && result.message !== '');
  return { ...result, outcome: caveats ? 'converted-with-caveats' : 'converted' };
}

/** Produce and write, on this thread. The `--jobs 1` path, and the one tests drive. */
export async function convertOne(file: FoundFile, deps: WriteDeps): Promise<FileResult> {
  return writeProduced(file, await produce(file, deps.options), deps);
}
