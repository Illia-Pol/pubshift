// Driving LibreOffice and a PDF rasteriser from Node, with every one of their quirks
// handled rather than hoped away.
//
// The quirks, all of them observed on this machine rather than read about:
//
//   * Startup costs about a second and the first run of a fresh profile costs more, so
//     everything here is async and compare.mjs runs a small pool.
//   * Two instances sharing a user profile refuse to run — the second silently attaches to
//     the first and converts nothing. Every invocation therefore gets its own
//     `-env:UserInstallation` directory, which is also what makes the pool safe.
//   * It can hang on a malformed document, and this machine has no `timeout` binary. The
//     timeout is implemented here: the child is spawned in its own process group and the
//     whole group is killed, because `soffice` is a shell script that execs `soffice.bin`
//     and killing the script alone leaves the real process running.
//   * `--convert-to png` renders the FIRST PAGE ONLY, with no warning. Every path in this
//     file therefore goes via PDF, which keeps all pages, and rasterises from there.
//   * It exits 0 while printing `Error: source file could not be loaded` and writing
//     nothing, so success is decided by the output file existing, not by the exit code.
//   * It writes Fontconfig warnings to stderr on every single run; they are filtered out
//     so a real message is not lost in them.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

/** Where LibreOffice installs itself. First hit wins; `soffice` on PATH is checked too. */
const SOFFICE_CANDIDATES = [
  '/opt/homebrew/bin/soffice',
  '/usr/local/bin/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  '/usr/bin/soffice',
  '/usr/lib/libreoffice/program/soffice',
];

/** Poppler's rasteriser. Optional: there is a LibreOffice-only fallback below. */
const PDFTOPPM_CANDIDATES = ['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm', '/usr/bin/pdftoppm'];

/** Flags that make LibreOffice behave like a batch tool instead of an application. */
const BATCH_FLAGS = [
  '--headless',
  '--invisible',
  '--norestore',
  '--nolockcheck',
  '--nodefault',
  '--nofirststartwizard',
  '--nologo',
];

/** Default wall clock for one conversion. Measured: a corpus file takes 1.4-4s. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/** Grace between SIGTERM and SIGKILL when a conversion runs over. */
const KILL_GRACE_MS = 2_000;

/** Rasterisation resolution. 96 DPI is one CSS pixel per point * 96/72, and letter -> 816x1056. */
export const DEFAULT_DPI = 96;

/** Points per inch, for turning a PDF page box into a pixel count. */
const POINTS_PER_INCH = 72;

const FONTCONFIG_NOISE = /^Fontconfig warning|^Warning: failed to launch javaldx|^javaldx:/;

function which(candidates, name) {
  for (const c of candidates) if (existsSync(c)) return c;
  const probe = spawnSync('command', ['-v', name], { encoding: 'utf8', shell: true, timeout: 5_000 });
  const found = (probe.stdout ?? '').trim().split('\n')[0];
  return found && existsSync(found) ? found : null;
}

function cleanStderr(s) {
  return (s ?? '')
    .split('\n')
    .filter((l) => l.trim() && !FONTCONFIG_NOISE.test(l))
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------- detection

let _soffice;
let _pdftoppm;

/** @returns {{available:boolean, bin:string|null, engine:string|null, version:string|null, reason?:string}} */
export function detectSoffice() {
  if (_soffice) return _soffice;
  const bin = which(SOFFICE_CANDIDATES, 'soffice');
  if (!bin) {
    _soffice = {
      available: false,
      bin: null,
      engine: null,
      version: null,
      reason: `LibreOffice not found (looked for soffice on PATH and at ${SOFFICE_CANDIDATES.join(', ')})`,
    };
    return _soffice;
  }
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 60_000 });
  const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  const version = /LibreOffice\s+(\d+\.\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1] ?? null;
  _soffice = version
    ? { available: true, bin, engine: 'libreoffice', version }
    : {
        available: false,
        bin,
        engine: null,
        version: null,
        reason: `\`${bin} --version\` did not identify itself: ${cleanStderr(out).slice(0, 200) || 'no output'}`,
      };
  return _soffice;
}

/** @returns {{available:boolean, bin:string|null, version:string|null, reason?:string}} */
export function detectPdftoppm() {
  if (_pdftoppm) return _pdftoppm;
  const bin = which(PDFTOPPM_CANDIDATES, 'pdftoppm');
  if (!bin) {
    _pdftoppm = { available: false, bin: null, version: null, reason: 'pdftoppm (poppler) not found on PATH' };
    return _pdftoppm;
  }
  const probe = spawnSync(bin, ['-v'], { encoding: 'utf8', timeout: 15_000 });
  const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  _pdftoppm = { available: true, bin, version: /pdftoppm version ([\d.]+)/.exec(out)?.[1] ?? 'unknown' };
  return _pdftoppm;
}

// ---------------------------------------------------------------- process

/**
 * Runs a child with a real timeout. Node's own `timeout` option kills only the direct
 * child, which is the wrapper script; this kills the process group.
 *
 * @returns {Promise<{code:number|null, stdout:string, stderr:string, timedOut:boolean, ms:number}>}
 */
export function run(bin, args, { timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) {
  return new Promise((resolvePromise) => {
    const t0 = Date.now();
    const child = spawn(bin, args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });

    const killGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          /* already gone */
        }
      }
    };

    let hardKill;
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup('SIGTERM');
      hardKill = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS);
    }, timeoutMs);

    const done = (code, spawnError) => {
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      resolvePromise({
        code,
        stdout,
        stderr: cleanStderr(spawnError ? `${stderr}\n${spawnError.message}` : stderr),
        timedOut,
        ms: Date.now() - t0,
      });
    };

    child.on('error', (e) => done(null, e));
    child.on('close', (code) => done(code));
  });
}

// ---------------------------------------------------------------- conversion

/**
 * One LibreOffice conversion, in a throwaway user profile.
 *
 * @param {string} input absolute path to the source document
 * @param {string} target a `--convert-to` value: `pdf`, or `pdf:filter:{json}` for options
 * @param {string} outDir directory the output lands in; created if missing
 * @returns {Promise<{ok:boolean, path?:string, ms:number, reason?:string, stderr?:string}>}
 */
export async function convert(input, target, outDir, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const lo = detectSoffice();
  if (!lo.available) return { ok: false, ms: 0, reason: lo.reason };

  mkdirSync(outDir, { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), 'pubshift-lo-'));
  const ext = target.split(':')[0];
  const expected = join(resolve(outDir), `${basename(input, extname(input))}.${ext}`);

  try {
    const r = await run(
      lo.bin,
      [`-env:UserInstallation=file://${profile}`, ...BATCH_FLAGS, '--convert-to', target, '--outdir', resolve(outDir), resolve(input)],
      { timeoutMs },
    );

    if (r.timedOut) {
      return { ok: false, ms: r.ms, reason: `LibreOffice exceeded ${timeoutMs}ms and was killed`, stderr: r.stderr };
    }
    // Exit code is not evidence: it prints `Error: ...` and exits 0. The file is evidence.
    if (!existsSync(expected)) {
      const said = /^Error:.*$/m.exec(r.stdout)?.[0] ?? r.stderr.split('\n')[0] ?? '';
      return {
        ok: false,
        ms: r.ms,
        reason: `LibreOffice produced no ${ext} (exit ${r.code})${said ? `: ${said}` : ''}`,
        stderr: r.stderr,
      };
    }
    return { ok: true, path: expected, ms: r.ms, stderr: r.stderr };
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- pdf pages

/** Page boxes in points, via pdf-lib — already a dependency of the pipeline we are testing. */
export async function pdfPageSizes(pdfPath) {
  const { readFileSync } = await import('node:fs');
  const { PDFDocument } = await import('pdf-lib');
  const doc = await PDFDocument.load(readFileSync(pdfPath), { updateMetadata: false, ignoreEncryption: true });
  return doc.getPages().map((p) => ({ width: p.getWidth(), height: p.getHeight() }));
}

/** `prefix-1.png`, `prefix-01.png`, … sorted by the page number poppler put in the name. */
function collectNumbered(dir, prefix) {
  return readdirSync(dir)
    .filter((n) => n.startsWith(`${prefix}-`) && n.endsWith('.png'))
    .map((n) => ({ n, page: Number(/-(\d+)\.png$/.exec(n)?.[1] ?? NaN) }))
    .filter((e) => Number.isFinite(e.page))
    .sort((a, b) => a.page - b.page)
    .map((e) => join(dir, e.n));
}

/**
 * Every page of a PDF as its own PNG.
 *
 * Preferred path is poppler, which renders the PDF as written. The fallback re-opens the
 * PDF in LibreOffice Draw, exports one page at a time back to PDF via the `PageRange`
 * filter option, and converts each single-page result to PNG — slower, and it re-interprets
 * the PDF through Draw's importer rather than rendering it, so the result is labelled
 * `libreoffice-reimport` and should not be compared against poppler output.
 *
 * @returns {Promise<{ok:boolean, pages?:string[], via?:string, ms:number, reason?:string}>}
 */
export async function rasterisePDF(pdfPath, outDir, { dpi = DEFAULT_DPI, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  mkdirSync(outDir, { recursive: true });
  const t0 = Date.now();
  const poppler = detectPdftoppm();

  if (poppler.available) {
    const prefix = 'page';
    const r = await run(poppler.bin, ['-png', '-r', String(dpi), resolve(pdfPath), join(resolve(outDir), prefix)], {
      timeoutMs,
    });
    const pages = collectNumbered(resolve(outDir), prefix);
    if (r.timedOut) return { ok: false, ms: Date.now() - t0, reason: `pdftoppm exceeded ${timeoutMs}ms` };
    if (pages.length === 0) {
      return { ok: false, ms: Date.now() - t0, reason: `pdftoppm produced no pages (exit ${r.code}): ${r.stderr.slice(0, 200)}` };
    }
    return { ok: true, pages, via: `pdftoppm ${poppler.version}`, ms: Date.now() - t0 };
  }

  const lo = detectSoffice();
  if (!lo.available) return { ok: false, ms: Date.now() - t0, reason: `no PDF rasteriser: ${poppler.reason}; ${lo.reason}` };

  let sizes;
  try {
    sizes = await pdfPageSizes(pdfPath);
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, reason: `cannot read PDF page count without poppler: ${e.message}` };
  }

  const pages = [];
  for (let i = 0; i < sizes.length; i++) {
    const sliceDir = join(outDir, `slice-${i + 1}`);
    const sliced = await convert(
      pdfPath,
      `pdf:draw_pdf_Export:${JSON.stringify({ PageRange: { type: 'string', value: String(i + 1) } })}`,
      sliceDir,
      { timeoutMs },
    );
    if (!sliced.ok) return { ok: false, ms: Date.now() - t0, reason: `page ${i + 1}: ${sliced.reason}` };

    const px = {
      PixelWidth: { type: 'long', value: Math.round((sizes[i].width * dpi) / POINTS_PER_INCH) },
      PixelHeight: { type: 'long', value: Math.round((sizes[i].height * dpi) / POINTS_PER_INCH) },
    };
    const png = await convert(sliced.path, `png:draw_png_Export:${JSON.stringify(px)}`, sliceDir, { timeoutMs });
    if (!png.ok) return { ok: false, ms: Date.now() - t0, reason: `page ${i + 1} to png: ${png.reason}` };
    pages.push(png.path);
  }

  return { ok: true, pages, via: `libreoffice-reimport ${lo.version}`, ms: Date.now() - t0 };
}
