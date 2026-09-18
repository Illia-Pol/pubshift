/**
 * The whole program, run the way a buyer runs it: `node bin/pubshift.mjs <args>`.
 *
 * Unit tests cannot catch what this catches. The bug that made `--jobs 4` convert nothing
 * at all — the process deciding it was finished while four workers were still starting —
 * was invisible to every test that imported a function instead of spawning the command.
 *
 * The folder these tests build is the one the product is sold for: the real corpus plus
 * the debris a fifteen-year parish archive accumulates. Mixed-case extensions, spaces,
 * an umlaut and an emoji, nested folders, Office lock files, a shortcut that points
 * nowhere, a shortcut that points at a file we already have, a file nobody has permission
 * to read, a zero-byte file, a JPEG somebody renamed, and a filename that tries to run a
 * formula when the report is opened in Excel.
 */

import { execFile } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const binary = path.join(packageRoot, 'bin', 'pubshift.mjs');
const corpus = fileURLToPath(new URL('../../core/test/corpus/', import.meta.url));

/** The five that libmspub parses without complaint and returns nothing from. */
const EMPTY_FILES = [
  'border1.pub', 'multipara.pub', 'table1.pub', 'tdf89993-1.pub', '14.0-metadata.pub',
];
/** Not a Publisher file at all, and expected to be rejected. See CLAUDE.md. */
const NOT_PUBLISHER = 'EDB-29664-1.pub';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function pubshift(args: string[], cwd: string): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [binary, ...args], {
      cwd,
      maxBuffer: 32 * 1024 * 1024,
      // Deliberately not inheriting the parent's environment wholesale: NO_COLOR keeps the
      // assertions about text from tripping over escape codes.
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

let temp: string;
let archive: string;
/** Set when the filesystem let us make a file we cannot read; false when running as root. */
let hasUnreadable = false;

beforeAll(async () => {
  // Built here rather than assumed: `bin/pubshift.mjs` runs `dist/cli.js`, and a test that
  // silently exercises yesterday's bundle is worse than no test.
  await execFileAsync(process.execPath, [path.join(packageRoot, 'build.mjs')], {
    cwd: packageRoot,
    maxBuffer: 8 * 1024 * 1024,
  });

  temp = mkdtempSync(path.join(os.tmpdir(), 'pubshift-cli-'));
  archive = path.join(temp, 'Parish Archive');
  mkdirSync(path.join(archive, '2019 Bulletins'), { recursive: true });
  mkdirSync(path.join(archive, 'Nested', 'Deeper'), { recursive: true });
  mkdirSync(path.join(archive, 'Elsewhere'), { recursive: true });
  mkdirSync(path.join(archive, 'Collisions'), { recursive: true });

  // The real corpus, at the top level, under its own names.
  for (const name of readdirSync(corpus)) {
    if (name.toLowerCase().endsWith('.pub')) {
      cpSync(path.join(corpus, name), path.join(archive, name));
    }
  }

  const sample = (name: string): string => path.join(corpus, name);
  cpSync(sample('fonts.pub'), path.join(archive, 'BULLETIN.PUB'));
  cpSync(sample('langs.pub'), path.join(archive, 'Grusse ü \u{1f384} Weihnachten.pub'));
  cpSync(sample('text-style.pub'), path.join(archive, '2019 Bulletins', 'Easter.pub'));
  cpSync(sample('bold-style.pub'), path.join(archive, 'Nested', 'Deeper', 'Advent.pub'));
  cpSync(sample('tables.pub'), path.join(archive, 'Elsewhere', 'Outside.pub'));
  // A filename that is a spreadsheet formula. Legal on every filesystem this runs on.
  cpSync(sample('tables.pub'), path.join(archive, '=cmd|evil.pub'));

  // Two different publications whose output names collide inside a single run. A trailing
  // space before the extension is ordinary debris in an archive copied off Windows, and
  // both files must survive: neither `skip` nor `overwrite` may apply, because either
  // would mean one of the two documents the user asked for is missing at the end.
  cpSync(sample('text-style.pub'), path.join(archive, 'Collisions', 'Outside.pub'));
  cpSync(sample('bold-style.pub'), path.join(archive, 'Collisions', 'Outside .pub'));

  writeFileSync(path.join(archive, 'Renamed JPEG.pub'), 'this is not a publisher file');
  writeFileSync(path.join(archive, 'Zero bytes.pub'), '');
  // Office's lock file and a Mac metadata sidecar: named like documents, not documents.
  writeFileSync(path.join(archive, '~$fonts.pub'), 'x');
  writeFileSync(path.join(archive, '._fonts.pub'), 'x');

  symlinkSync('fonts.pub', path.join(archive, 'Shortcut to fonts.pub'));
  symlinkSync(path.join(temp, 'gone.pub'), path.join(archive, 'Broken shortcut.pub'));
  symlinkSync(path.join('..', 'Elsewhere'), path.join(archive, 'Nested', 'Link to elsewhere'));

  const locked = path.join(archive, 'Locked.pub');
  cpSync(sample('fonts.pub'), locked);
  chmodSync(locked, 0o000);
  try {
    readFileSync(locked);
  } catch {
    hasUnreadable = true;
  }
}, 120_000);

afterAll(() => {
  if (temp === undefined) return;
  try {
    chmodSync(path.join(archive, 'Locked.pub'), 0o600);
  } catch { /* it may not exist */ }
  rmSync(temp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

describe('check', () => {
  it('reads the whole archive, writes nothing, and exits 1', async () => {
    const run = await pubshift(['check', archive, '--recursive'], temp);

    expect(run.code).toBe(1);
    expect(run.stdout).toContain('NEEDS A HUMAN');
    expect(run.stdout).toContain('This was a check. Nothing was written.');
    // The default output folder is never even created by a check.
    expect(existsSync(path.join(temp, 'Converted'))).toBe(false);
  }, 120_000);

  it('refuses --out, because it has nothing to write', async () => {
    const run = await pubshift(['check', archive, '--out', path.join(temp, 'x')], temp);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain('never writes converted files');
  }, 60_000);
});

describe('convert', () => {
  const out = (): string => path.join(temp, 'Converted PPTX');

  it('converts the corpus and writes nothing for the files that hold nothing', async () => {
    const run = await pubshift(
      ['convert', archive, '--recursive', '--to', 'pptx', '--out', out()],
      temp,
    );

    // Some files need a person: five hold nothing, one is not Publisher, several lose
    // WMF clip art. docs/FIDELITY.md, and it is why the exit code is 1 and not 0.
    expect(run.code).toBe(1);

    const written = filesUnder(out());
    expect(written.length).toBeGreaterThan(20);

    // THE GATE. Not one of the five parse-but-empty files may produce a document, and
    // neither may the file that is not Publisher at all. A blank .pptx presented as a
    // success is the failure this product exists to prevent (docs/FIDELITY.md).
    for (const name of [...EMPTY_FILES, NOT_PUBLISHER]) {
      const stem = name.replace(/\.pub$/i, '');
      expect(written, `${name} must not produce an output`).not.toContain(`${stem}.pptx`);
      expect(written.some((w) => w.startsWith(stem)), name).toBe(false);
    }

    // And each of them is named in the summary as needing a person.
    for (const name of EMPTY_FILES) expect(run.stdout).toContain(name);
  }, 180_000);

  it('handles every awkward name an archive throws at it', async () => {
    const dest = path.join(temp, 'Converted awkward');
    const run = await pubshift(
      ['convert', archive, '--recursive', '--to', 'pptx', '--out', dest],
      temp,
    );
    const written = filesUnder(dest);

    expect(written).toContain('BULLETIN.pptx');                       // mixed-case .PUB
    expect(written).toContain('Grusse ü \u{1f384} Weihnachten.pptx'); // umlaut + emoji
    expect(written).toContain(path.join('2019 Bulletins', 'Easter.pptx'));
    expect(written).toContain(path.join('Nested', 'Deeper', 'Advent.pptx'));
    expect(written).toContain(path.join('Elsewhere', 'Outside.pptx'));

    // Office lock files and Mac sidecars are not publications and are never opened.
    expect(run.stdout).not.toContain('~$fonts.pub');
    expect(run.stdout).not.toContain('._fonts.pub');

    // Everything that cannot work is named, with a sentence a person can act on.
    expect(run.stdout).toContain('Zero bytes.pub');
    expect(run.stdout).toContain('It may not have finished copying');
    expect(run.stdout).toContain('Renamed JPEG.pub');
    expect(run.stdout).toContain('it is not a Publisher publication inside');
    expect(run.stdout).toContain('Broken shortcut.pub');
    expect(run.stdout).toContain('no longer points anywhere');

    // A shortcut to a file we already have is converted once, not twice.
    expect(run.stdout).toContain('reached through a shortcut');
    expect(written).not.toContain('Shortcut to fonts.pptx');

    // A shortcut to a folder is not followed without being asked.
    expect(run.stdout).toContain('was not followed');

    if (hasUnreadable) {
      expect(run.stdout).toContain('Locked.pub');
      expect(run.stdout).toContain('permission');
    }
  }, 180_000);

  it('never overwrites silently: a second run renames instead', async () => {
    const dest = path.join(temp, 'Twice');
    await pubshift(['convert', path.join(archive, 'Elsewhere'), '--out', dest], temp);
    const first = readFileSync(path.join(dest, 'Outside.pptx'));

    await pubshift(['convert', path.join(archive, 'Elsewhere'), '--out', dest], temp);

    const written = filesUnder(dest);
    expect(written).toContain('Outside.pptx');
    expect(written).toContain('Outside (2).pptx');
    // The file that was already there is byte-for-byte untouched.
    expect(readFileSync(path.join(dest, 'Outside.pptx')).equals(first)).toBe(true);
  }, 120_000);

  it('gives two files that want one name two names, in a single run', async () => {
    const dest = path.join(temp, 'Collisions out');
    const run = await pubshift(
      ['convert', path.join(archive, 'Collisions'), '--out', dest, '--on-conflict', 'overwrite'],
      temp,
    );

    const written = filesUnder(dest);
    expect(run.code).toBe(0);
    expect(written).toEqual(['Outside (2).pptx', 'Outside.pptx']);
    // Two different source documents, so two different files: neither was overwritten by
    // the other, even though the user asked for overwrite.
    const first = readFileSync(path.join(dest, 'Outside.pptx'));
    const second = readFileSync(path.join(dest, 'Outside (2).pptx'));
    expect(first.equals(second)).toBe(false);
  }, 120_000);

  it('--on-conflict skip leaves a finished batch alone', async () => {
    const dest = path.join(temp, 'Skip');
    await pubshift(['convert', path.join(archive, 'Elsewhere'), '--out', dest], temp);
    const before = filesUnder(dest);

    const run = await pubshift(
      ['convert', path.join(archive, 'Elsewhere'), '--out', dest, '--on-conflict', 'skip'],
      temp,
    );

    expect(filesUnder(dest)).toEqual(before);
    expect(run.stdout).toContain('SKIPPED, NOTHING TO DO');
    // Nothing needed doing, so nothing needs a person either.
    expect(run.code).toBe(0);
  }, 120_000);

  it('--dry-run writes nothing at all', async () => {
    const dest = path.join(temp, 'Dry');
    const run = await pubshift(
      ['convert', path.join(archive, 'Elsewhere'), '--out', dest, '--dry-run'],
      temp,
    );
    expect(run.stdout).toContain('Nothing was written.');
    expect(filesUnder(dest)).toEqual([]);
  }, 120_000);

  it('--jobs 2 produces exactly what one job produces', async () => {
    const one = path.join(temp, 'Jobs one');
    const two = path.join(temp, 'Jobs two');
    const a = await pubshift(['convert', archive, '--out', one, '--to', 'pptx'], temp);
    const b = await pubshift(['convert', archive, '--out', two, '--to', 'pptx', '--jobs', '2'], temp);

    expect(b.code).toBe(a.code);
    expect(filesUnder(two)).toEqual(filesUnder(one));
    for (const name of filesUnder(one)) {
      const left = readFileSync(path.join(one, name));
      const right = readFileSync(path.join(two, name));
      expect(left.equals(right), name).toBe(true);
    }
  }, 300_000);

  it('converts to several formats at once, and SVG writes a file per page', async () => {
    const dest = path.join(temp, 'Many formats');
    const run = await pubshift(
      ['convert', path.join(archive, 'Elsewhere'), '--out', dest, '--to', 'pptx,pdf,svg'],
      temp,
    );
    const written = filesUnder(dest);
    expect(run.code).toBeLessThan(2);
    expect(written).toContain('Outside.pptx');
    expect(written).toContain('Outside.pdf');
    expect(written.some((w) => w.endsWith('.svg'))).toBe(true);
    for (const name of written) {
      expect(statSync(path.join(dest, name)).size).toBeGreaterThan(0);
    }
  }, 120_000);
});

describe('exit codes', () => {
  it('0 when everything converted cleanly', async () => {
    const source = path.join(temp, 'Clean');
    mkdirSync(source, { recursive: true });
    cpSync(path.join(corpus, 'text-style.pub'), path.join(source, 'Notice.pub'));
    const run = await pubshift(['convert', source, '--out', path.join(temp, 'Clean out')], temp);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('NOTHING NEEDS A HUMAN');
  }, 120_000);

  it('2 when there is nothing to convert', async () => {
    const empty = path.join(temp, 'Empty folder');
    mkdirSync(empty, { recursive: true });
    const run = await pubshift(['check', empty], temp);
    expect(run.code).toBe(2);
    expect(run.stdout).toContain('No .pub files were found');
  }, 60_000);

  it('2 when every file found holds nothing', async () => {
    const source = path.join(temp, 'All empty');
    mkdirSync(source, { recursive: true });
    for (const name of EMPTY_FILES) cpSync(path.join(corpus, name), path.join(source, name));
    const dest = path.join(temp, 'All empty out');

    const run = await pubshift(['convert', source, '--out', dest], temp);

    expect(run.code).toBe(2);
    expect(filesUnder(dest)).toEqual([]);
  }, 120_000);

  it('3 for a folder that is not there, and for an option we do not have', async () => {
    const missing = await pubshift(['convert', path.join(temp, 'nowhere at all')], temp);
    expect(missing.code).toBe(3);
    expect(missing.stderr).toContain('There is no folder called');

    const wrong = await pubshift(['convert', archive, '--frobnicate'], temp);
    expect(wrong.code).toBe(3);
    expect(wrong.stderr).toContain('is not an option this tool knows');

    const noCommand = await pubshift(['./somewhere'], temp);
    expect(noCommand.code).toBe(3);
    expect(noCommand.stderr).toContain('Did you mean');
  }, 60_000);
});

describe('the report', () => {
  it('writes a CSV that Excel opens correctly and will not execute', async () => {
    const file = path.join(temp, 'report.csv');
    await pubshift(
      ['check', archive, '--recursive', '--report', file, '--quiet'],
      temp,
    );

    const raw = readFileSync(file);
    expect(raw.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

    const text = raw.toString('utf8');
    expect(text).toContain('\r\n');
    // The filename that is a formula is neutralised wherever it appears.
    expect(text).toContain('=cmd|evil.pub');
    expect(/(^|,|")=cmd/.test(text)).toBe(false);
    // Non-ASCII names survive.
    expect(text).toContain('Grusse ü \u{1f384} Weihnachten.pub');
    // The flagged files come before the clean ones.
    const lines = text.split('\r\n');
    const rowOf = (name: string): number => lines.findIndex((l) => l.includes(name));
    expect(rowOf('border1.pub')).toBeLessThan(rowOf('text-style.pub'));
  }, 120_000);

  it('writes an HTML page that loads nothing from anywhere', async () => {
    const file = path.join(temp, 'report.html');
    await pubshift(['check', archive, '--recursive', '--report', file, '--quiet'], temp);

    const html = readFileSync(file, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('Needs a human');
    expect(html).toContain('border1.pub');
    for (const tag of html.match(/<[^>]+>/g) ?? []) {
      expect(/^<\/?(script|link|iframe|img|object|embed|base)[\s/>]/i.test(tag), tag).toBe(false);
      expect(/\s(src|href|srcset)\s*=/i.test(tag), tag).toBe(false);
    }
    expect(/https?:\/\//i.test(html)).toBe(false);
  }, 120_000);

  it('leads with what needs a human, not with the success count', async () => {
    const run = await pubshift(['check', archive, '--recursive'], temp);
    expect(run.stdout.indexOf('NEEDS A HUMAN'))
      .toBeLessThan(run.stdout.indexOf('CONVERTED CLEANLY'));
  }, 120_000);
});

describe('the command itself', () => {
  it('prints help with no arguments and exits 0', async () => {
    const run = await pubshift([], temp);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('pubshift convert <folder>');
    expect(run.stdout).toContain('pubshift check   <folder>');
    expect(run.stdout).toContain('No file is uploaded');
  }, 60_000);

  it('prints a version', async () => {
    const run = await pubshift(['--version'], temp);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 60_000);

  it('--quiet says nothing on a successful run', async () => {
    const source = path.join(temp, 'Quiet');
    mkdirSync(source, { recursive: true });
    cpSync(path.join(corpus, 'text-style.pub'), path.join(source, 'Notice.pub'));
    const run = await pubshift(
      ['convert', source, '--out', path.join(temp, 'Quiet out'), '--quiet'],
      temp,
    );
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
  }, 120_000);
});

describe('the offline guarantee', () => {
  /**
   * docs/POSITIONING.md: no-upload is the product's first differentiator, and a batch
   * runner loose on a parish shared drive is exactly where a quiet "usage ping" would be
   * least welcome and least noticed. So: nothing in this package may reach the network,
   * and the check is mechanical rather than a promise in a README.
   */
  it('contains no way to open a socket and nothing that phones home', () => {
    const sources = readdirSync(path.join(packageRoot, 'src'))
      .filter((name) => name.endsWith('.ts'));
    expect(sources.length).toBeGreaterThan(5);

    for (const name of sources) {
      const text = readFileSync(path.join(packageRoot, 'src', name), 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(/\b(fetch|XMLHttpRequest|WebSocket)\s*\(/.test(code), name).toBe(false);
      expect(/from\s+'node:(http|https|net|tls|dgram|dns)'/.test(code), name).toBe(false);
    }

    // And the same for what actually ships, after bundling.
    for (const built of ['cli.js', 'worker.js']) {
      const bundle = readFileSync(path.join(packageRoot, 'dist', built), 'utf8');
      for (const module of ['node:http', 'node:https', 'node:net', 'node:tls', 'node:dgram']) {
        expect(bundle.includes(`require("${module}")`), `${built} requires ${module}`).toBe(false);
        expect(bundle.includes(`from "${module}"`), `${built} imports ${module}`).toBe(false);
      }
    }
  });
});
