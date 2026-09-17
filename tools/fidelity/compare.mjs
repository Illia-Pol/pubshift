#!/usr/bin/env node
// The fidelity oracle.
//
//   node tools/fidelity/compare.mjs
//
// For every file in the corpus: render the ORIGINAL .pub to PNG, run our pipeline to
// produce PPTX/DOCX/PDF/SVG, render those to PNG through the same engine, and score each
// page against the original page. Writes tools/fidelity/fidelity.json and a diff image per
// compared page.
//
// What the reference actually is, stated plainly because it decides what the numbers mean:
// LibreOffice opening the same .pub. LibreOffice reads Publisher with libmspub, which is
// the same parser behind our own extractor, so both sides of every comparison inherit the
// same parse. That is the point — it holds the parser constant and isolates *our* model and
// emitters, which is the thing under test. It is NOT a measurement against Microsoft
// Publisher's own rendering; nothing available here can produce that.
//
// Files whose `assess` verdict is 'empty' are skipped and reported separately. libmspub
// returns an empty event stream for five corpus files; that is a measured upstream gap, and
// folding it into the conversion score would both flatter the parser and libel the
// emitters.
//
// Flags:
//   --dpi N          rasterisation resolution (default 96)
//   --jobs N         parallel LibreOffice conversions (default 4)
//   --formats a,b    which targets to score (default pptx,docx,pdf,svg)
//   --filter STR     only corpus files whose name contains STR
//   --out DIR        artefact root (default tools/fidelity/.artifacts); each run gets its own
//                    subdirectory under <root>/runs, so concurrent runs cannot clash
//   --no-cache       re-render the reference .pub files instead of reusing cached PNGs
//   --no-diff        skip writing diff images
//   --json           machine output on stdout instead of the table
//   --quiet          summary only

import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { comparePNGFiles, detectRasteriser, pngInkCount, renderToPNG } from './render.mjs';
import { describeMetric } from './lib/pixel.mjs';
import { DEFAULT_DPI } from './lib/soffice.mjs';
import { corpusFiles, EXPECTED_FAILURES } from './lib/extract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const BIN = join(ROOT, 'bin/pubshift-extract');
const CORPUS = join(ROOT, 'packages/core/test/corpus');

/** Every target we know how to score, in the order the table shows them. PPTX leads: it is the flagship. */
const FORMATS = ['pptx', 'docx', 'pdf', 'svg'];

/** Concurrent LibreOffice conversions. Each gets its own profile, so the limit is CPU, not locking. */
const DEFAULT_JOBS = 4;

/** A corpus file that has not converted in this long has hung something. */
const RENDER_TIMEOUT_MS = 180_000;

/** The emit worker is one `npx tsx` process for the whole corpus; this is its whole-run budget. */
const WORKER_TIMEOUT_MS = 600_000;

/**
 * Restarts allowed if the worker dies outright. An emitter that segfaults or runs the heap
 * out on one file must not cost us the results for every file after it.
 */
const MAX_WORKER_RESTARTS = 3;

/**
 * Completed run directories kept under `.artifacts/runs`. Each full run is a few hundred
 * PNGs and they are only good for looking at afterwards.
 */
const KEEP_RUNS = 3;

/**
 * A run directory is never pruned while it is this fresh, however old it ranks.
 *
 * Several agents work this repo at once, so two `compare.mjs` runs overlapping is normal
 * rather than exotic — and before per-run directories existed it was destructive: the
 * second run's `rmSync` of the shared staging directory deleted the first run's emitted
 * files mid-flight, and the first then reported `source file could not be loaded` against
 * emitters that were perfectly fine. A measurement tool that fabricates failures under
 * concurrency is worse than one that is slow.
 */
const RUN_GRACE_MS = 30 * 60 * 1000;

/**
 * Score bands for the table. Not a gate — this tool reports, it does not fail the build —
 * but a number with no scale is a number nobody acts on.
 *   >= GOOD  the page is the same page; differences are placement noise
 *   >= FAIR  recognisably the same page, with visible movement or missing detail
 *   <  FAIR  a reader would call this a different document
 */
const GOOD_SCORE = 0.9;
const FAIR_SCORE = 0.6;

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};

const dpi = Number(opt('--dpi', DEFAULT_DPI));
const jobs = Math.max(1, Number(opt('--jobs', DEFAULT_JOBS)));
const formats = String(opt('--formats', FORMATS.join(','))).split(',').filter(Boolean);
const filter = opt('--filter', null);
const outDir = resolve(opt('--out', join(HERE, '.artifacts')));
const useCache = !flag('--no-cache');
const wantDiff = !flag('--no-diff');
const asJson = flag('--json');
const quiet = flag('--quiet') || asJson;

/**
 * Everything this run writes, except the shared reference cache, lives here. It is unique
 * per run so that a second `compare.mjs` cannot delete this one's files out from under it.
 * The cache is safe to share: it is keyed by content and every entry is written by
 * rendering the same source to the same bytes.
 */
const runDir = join(outDir, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`);
const diffDir = join(runDir, 'diff');

// ---------------------------------------------------------------- helpers

const pad = (s, n, right = false) => (right ? String(s).padStart(n) : String(s).padEnd(n));
const fmt = (n) => (n === null || n === undefined ? '  —  ' : n.toFixed(3));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (n) => (n === null || n === undefined ? null : Math.round(n * 10000) / 10000);

function band(score) {
  if (score === null || score === undefined) return '';
  if (score >= GOOD_SCORE) return 'good';
  if (score >= FAIR_SCORE) return 'fair';
  return 'poor';
}

/**
 * Identity of a source file for caching.
 *
 * The hash of render.mjs is part of the key so that editing the renderer can never serve
 * reference pages an older version of it produced. Reference renders are the one thing this
 * tool caches across runs, and a stale one is undetectable by eye: it would still be a
 * plausible-looking page, just not the page the current code draws.
 *
 * To be clear about what this did NOT fix, since a measurement tool that misremembers its
 * own bugs is worth very little: the five files that first scored exactly 0.000 were not a
 * caching fault. LibreOffice's Publisher import inserts a leading blank page for some
 * documents, so our page 1 was being scored against a blank sheet. `alignReferencePages` below
 * is the fix for that, and it was verified by rendering the .pub directly, outside the
 * cache, and counting ink per page.
 */
const RENDERER_SOURCE_HASH = createHash('sha256')
  .update(readFileSync(new URL('./render.mjs', import.meta.url)))
  .digest('hex')
  .slice(0, 16);

function cacheKey(file, renderer) {
  const st = statSync(file);
  return createHash('sha256')
    .update([
      file, st.size, st.mtimeMs, dpi,
      renderer.version, renderer.pdfRasteriser,
      RENDERER_SOURCE_HASH,
    ].join('|'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Deletes all but the newest `KEEP_RUNS` run directories, and never touches one that has
 * been written to within `RUN_GRACE_MS` — that one may belong to a run still in progress.
 */
function pruneOldRuns() {
  const runs = join(outDir, 'runs');
  if (!existsSync(runs)) return;
  const entries = readdirSync(runs)
    .map((n) => ({ n, path: join(runs, n) }))
    .filter((e) => {
      try {
        return statSync(e.path).isDirectory();
      } catch {
        return false;
      }
    })
    .map((e) => ({ ...e, mtime: statSync(e.path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const now = Date.now();
  for (const e of entries.slice(KEEP_RUNS)) {
    if (now - e.mtime < RUN_GRACE_MS) continue;
    rmSync(e.path, { recursive: true, force: true });
  }
}

/** Runs `tasks` with at most `limit` in flight, preserving result order. */
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------- emitting

/**
 * Runs the pipeline over `files` and returns what it produced. The worker is a separate
 * `npx tsx` process; if it dies, we restart it on whatever it had not reached yet and note
 * the death, rather than losing the rest of the corpus to one bad emitter.
 */
async function emitAll(files, stage) {
  mkdirSync(stage, { recursive: true });
  const records = new Map();
  let emitters = null;
  const deaths = [];

  let remaining = files.map((f) => f.path);
  for (let attempt = 0; attempt <= MAX_WORKER_RESTARTS && remaining.length; attempt++) {
    const jobFile = join(stage, `job-${attempt}.json`);
    writeFileSync(jobFile, JSON.stringify({ stage, bin: BIN, formats, files: remaining }));

    const result = await runWorker(jobFile, (line) => {
      if (line.t === 'emitters') emitters ??= line.emitters;
      else if (line.t === 'file') records.set(line.name, line);
    });

    const done = new Set([...records.keys()]);
    const left = remaining.filter((p) => !done.has(basename(p)));
    if (!result.ok && left.length) {
      deaths.push({ after: remaining.length - left.length, reason: result.reason, nextFile: basename(left[0]) });
      // The first file it had not finished is the one that killed it; record and step over.
      records.set(basename(left[0]), {
        t: 'file',
        name: basename(left[0]),
        ok: false,
        stage: 'worker',
        error: `the emit worker died on this file: ${result.reason}`,
      });
      remaining = left.slice(1);
      continue;
    }
    remaining = left;
    if (result.ok) break;
  }

  return { records, emitters: emitters ?? {}, deaths };
}

function runWorker(jobFile, onLine) {
  return new Promise((resolvePromise) => {
    const child = spawn('npx', ['tsx', join(HERE, 'lib/emit-worker.mjs'), jobFile], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }, WORKER_TIMEOUT_MS);

    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          onLine(JSON.parse(line));
        } catch {
          stderr += `unparseable worker line: ${line.slice(0, 200)}\n`;
        }
      }
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolvePromise({ ok: false, reason: e.message, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise(
        code === 0
          ? { ok: true, stderr }
          : { ok: false, reason: `exit ${code}${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' / ').slice(0, 300)}` : ''}`, stderr },
      );
    });
  });
}

// ---------------------------------------------------------------- rendering

/** Rasterises a document, reusing a cached render of an unchanged source when allowed. */
async function render(file, dir, renderer, { cache = false } = {}) {
  if (cache && useCache) {
    const cached = join(outDir, 'cache', cacheKey(file, renderer));
    if (existsSync(join(cached, 'manifest.json'))) {
      const m = JSON.parse(readFileSync(join(cached, 'manifest.json'), 'utf8'));
      if (m.pages.every((p) => existsSync(p))) return { ...m, cached: true };
    }
    const fresh = await renderToPNG(file, { dpi, outDir: cached, timeoutMs: RENDER_TIMEOUT_MS });
    if (fresh.ok) writeFileSync(join(cached, 'manifest.json'), JSON.stringify({ ok: true, pages: fresh.pages, via: fresh.via, ms: fresh.ms }));
    return fresh;
  }
  return renderToPNG(file, { dpi, outDir: dir, timeoutMs: RENDER_TIMEOUT_MS });
}

/**
 * Corrects for the one page-alignment artefact the reference renderer is known to produce.
 *
 * LibreOffice's Publisher import inserts a LEADING blank page for some documents — measured
 * on this corpus, five of them. Left alone, our page 1 is scored against that blank sheet,
 * which awards 0 and blames the emitters for an artefact of the reference renderer.
 *
 * The correction is deliberately narrow: drop blank pages from the FRONT of the reference
 * only, and only as many as the reference has pages in surplus. Page order is meaningful, so
 * anything wider is dangerous — the first attempt at this dropped every blank page from both
 * sequences, which fixed the leading-blank files and immediately broke REG-TST2, where our
 * own output has a blank page in the MIDDLE. Removing it slid our pages 3 and 4 up into slots
 * 2 and 3 and scored content against unrelated content: 0.028 and 0.056 for pages that were
 * merely misaligned. A blank page of ours in the middle of a document is a real defect and
 * must score 0 against the content it replaced, not quietly renumber everything after it.
 *
 * @returns {{pages:string[], strippedLeadingBlanks:number}}
 */
export function alignReferencePages(paths, referenceInk, candidateCount) {
  const surplus = paths.length - candidateCount;
  let strip = 0;
  while (strip < surplus && referenceInk[strip] === 0) strip++;
  return { pages: paths.slice(strip), strippedLeadingBlanks: strip };
}

/**
 * Scores one emitted artefact set against the reference pages.
 *
 * Page counts are allowed to differ — a flow format will not hold the original pagination,
 * and saying so is half the point of the exercise. Pages are compared pairwise as far as
 * both go, and the file's score is the mean page score multiplied by
 * min(pages)/max(pages), so dropping half the document cannot be hidden behind two good
 * pages.
 */
async function scoreArtifact(name, format, artifact, reference, referenceInk, dir, renderer) {
  if (artifact.status !== 'emitted') return { status: artifact.status, reason: artifact.reason };

  // SVG is one file per page; everything else is one file holding every page.
  const renders = [];
  for (const [i, f] of artifact.files.entries()) {
    const r = await render(f, join(dir, `${format}-${i + 1}`), renderer);
    if (!r.ok) return { status: 'render-failed', reason: r.reason, file: basename(f) };
    renders.push(...r.pages);
  }

  const aligned = alignReferencePages(reference, referenceInk, renders.length);
  const blankOutputPages = renders.filter((p) => pngInkCount(p) === 0).length;
  const n = Math.min(aligned.pages.length, renders.length);
  const pages = [];
  for (let i = 0; i < n; i++) {
    const diffPath = wantDiff ? join(diffDir, name, `${format}-p${i + 1}.png`) : undefined;
    let cmp;
    try {
      cmp = comparePNGFiles(aligned.pages[i], renders[i], { diffPath });
    } catch (e) {
      return { status: 'compare-failed', reason: e.message };
    }
    pages.push({
      page: i + 1,
      score: cmp.score,
      byRadius: cmp.byRadius,
      sizeMatch: cmp.dimensions.match,
      // Only when they differ: identical dimensions on every page of every format is a lot
      // of JSON saying nothing, and `sizeMatch` already says it.
      ...(cmp.dimensions.match ? {} : { dimensions: cmp.dimensions }),
      ink: cmp.ink,
      perPixel: { exactRatio: cmp.perPixel.exactRatio, tolerantRatio: cmp.perPixel.tolerantRatio },
      // Relative to `runDir`, which the report names once. An absolute path here would carry
      // the run's timestamp into every record and make the whole file churn between runs
      // that found exactly the same thing.
      ...(cmp.diffPath ? { diff: relative(runDir, cmp.diffPath) } : {}),
    });
  }

  const pageMean = mean(pages.map((p) => p.score));
  const refCount = aligned.pages.length;
  const pageCountPenalty =
    refCount && renders.length ? Math.min(refCount, renders.length) / Math.max(refCount, renders.length) : 0;

  return {
    status: 'scored',
    score: round(pageMean === null ? 0 : pageMean * pageCountPenalty),
    pageMean: round(pageMean),
    pageCountPenalty: round(pageCountPenalty),
    referencePages: refCount,
    outputPages: renders.length,
    strippedLeadingBlankReferencePages: aligned.strippedLeadingBlanks,
    blankOutputPages,
    bytes: artifact.bytes,
    pages,
  };
}

// ---------------------------------------------------------------- run

async function run() {
  const renderer = detectRasteriser();
  if (!renderer.available) {
    console.error(`cannot run the fidelity oracle: ${renderer.reason}`);
    console.error('install LibreOffice and re-run; there is no structural fallback for this tool.');
    return 2;
  }

  let files = corpusFiles(CORPUS);
  if (filter) files = files.filter((f) => f.name.includes(filter));
  if (files.length === 0) {
    console.error(`no corpus files${filter ? ` matching '${filter}'` : ''}`);
    return 2;
  }

  // Everything except the reference cache is output of this run and must not survive it:
  // a stale PNG from a previous emitter would be scored as if it were current.
  const stage = join(runDir, 'emitted');
  mkdirSync(stage, { recursive: true });
  pruneOldRuns();

  if (!quiet) {
    console.log(`corpus     ${CORPUS}  (${files.length} files)`);
    console.log(`renderer   ${renderer.engine} ${renderer.version} -> ${renderer.pdfRasteriser} at ${dpi} DPI`);
    console.log(`reference  LibreOffice's own rendering of each .pub`);
    console.log(`artefacts  ${runDir}\n`);
    process.stderr.write('running the pipeline over the corpus…\n');
  }

  const started = Date.now();
  const { records, emitters, deaths } = await emitAll(files, stage);

  if (!quiet) {
    for (const f of formats) {
      const e = emitters[f];
      console.log(`emitter    ${pad(f, 6)} ${e?.available ? `${e.export} from ${e.module.replace(ROOT + '/', '')}` : `NOT AVAILABLE — ${e?.reason ?? 'not attempted'}`}`);
    }
    console.log('');
    console.log(
      `${pad('FILE', 46)}${pad('PG', 4, true)}  ${pad('VERDICT', 9)}${formats.map((f) => pad(f.toUpperCase(), 8, true)).join('')}`,
    );
    console.log('-'.repeat(59 + formats.length * 8));
  }

  const rows = [];
  const skipped = { empty: [], unreadable: [], modelError: [], referenceBlank: [] };

  // The table is printed in corpus order once the pool is done, but the pool takes minutes
  // and silence for minutes reads as a hang. Progress goes to stderr so `--json` stays clean.
  let finished = 0;
  const progress = (name, note) => {
    if (quiet) return;
    process.stderr.write(`  [${String(++finished).padStart(2)}/${files.length}] ${name}${note ? ` — ${note}` : ''}\n`);
  };

  const tasks = files.map((file) => async () => {
    const rec = records.get(file.name);
    if (!rec) {
      progress(file.name, 'the pipeline never reported on it');
      return { name: file.name, status: 'not-processed' };
    }

    if (!rec.ok) {
      const bucket = EXPECTED_FAILURES.has(file.name) ? 'unreadable' : rec.stage === 'extract' ? 'unreadable' : 'modelError';
      progress(file.name, `${rec.stage} failed`);
      return { name: file.name, status: 'failed', bucket, stage: rec.stage, error: rec.error, expected: EXPECTED_FAILURES.has(file.name) };
    }
    if (rec.verdict === 'empty') {
      progress(file.name, "verdict 'empty', skipped");
      return { name: file.name, status: 'empty', message: rec.message, pages: rec.pages, elements: rec.elements };
    }

    const dir = join(runDir, 'render', file.name);
    const ref = await render(file.path, join(dir, 'reference'), renderer, { cache: true });
    if (!ref.ok) {
      progress(file.name, 'the reference render failed');
      return { name: file.name, status: 'reference-failed', reason: ref.reason, verdict: rec.verdict };
    }

    const referenceInk = ref.pages.map(pngInkCount);
    if (referenceInk.every((n) => n === 0)) {
      progress(file.name, 'the reference renders blank, nothing to compare against');
      return {
        name: file.name,
        status: 'reference-blank',
        verdict: rec.verdict,
        pages: rec.pages,
        referencePages: ref.pages.length,
      };
    }

    const out = {};
    for (const format of formats) {
      out[format] = await scoreArtifact(
        file.name,
        format,
        rec.artifacts[format] ?? { status: 'unavailable', reason: 'not attempted' },
        ref.pages,
        referenceInk,
        dir,
        renderer,
      );
    }
    progress(
      file.name,
      formats.map((f) => `${f} ${out[f].status === 'scored' ? out[f].score.toFixed(3) : out[f].status}`).join(' '),
    );

    return {
      name: file.name,
      status: 'scored',
      verdict: rec.verdict,
      pages: rec.pages,
      referencePages: ref.pages.length,
      referenceBlankPages: referenceInk.filter((n) => n === 0).length,
      referenceCached: Boolean(ref.cached),
      warnings: rec.warnings,
      formats: out,
    };
  });

  const results = await pool(tasks, jobs);

  for (const r of results) {
    if (r.status === 'empty') {
      skipped.empty.push({ name: r.name, pages: r.pages, elements: r.elements, message: r.message });
      if (!quiet) console.log(`${pad(r.name, 46)}${pad(r.pages, 4, true)}  ${pad('empty', 9)}${pad('skipped — upstream parser gap', 30)}`);
      continue;
    }
    if (r.status === 'reference-blank') {
      skipped.referenceBlank.push({ name: r.name, verdict: r.verdict, pages: r.pages, referencePages: r.referencePages });
      if (!quiet) console.log(`${pad(r.name, 46)}${pad(r.pages, 4, true)}  ${pad(r.verdict, 9)}${pad('not scored — the reference renders blank', 40)}`);
      continue;
    }
    if (r.status === 'failed') {
      skipped[r.bucket].push({ name: r.name, stage: r.stage, error: r.error, expected: r.expected });
      if (!quiet) {
        console.log(`${pad(r.name, 46)}${pad('-', 4, true)}  ${pad(r.expected ? 'expected' : 'FAILED', 9)}${(r.error ?? '').split('\n')[0].slice(0, 44)}`);
      }
      continue;
    }
    if (r.status !== 'scored') {
      skipped.modelError.push({ name: r.name, error: r.reason ?? r.status });
      if (!quiet) console.log(`${pad(r.name, 46)}${pad('-', 4, true)}  ${pad('ERROR', 9)}${(r.reason ?? r.status).slice(0, 44)}`);
      continue;
    }

    rows.push(r);
    if (!quiet) {
      const cells = formats.map((f) => {
        const s = r.formats[f];
        return pad(s.status === 'scored' ? fmt(s.score) : s.status === 'unavailable' ? '—' : '!', 8, true);
      });
      console.log(`${pad(r.name, 46)}${pad(r.referencePages, 4, true)}  ${pad(r.verdict, 9)}${cells.join('')}`);
    }
  }

  const byFormat = {};
  for (const f of formats) {
    const scored = rows.map((r) => r.formats[f]).filter((s) => s.status === 'scored');
    const pageScores = scored.flatMap((s) => s.pages.map((p) => p.score));
    byFormat[f] = {
      available: Boolean(emitters[f]?.available),
      ...(emitters[f]?.available ? {} : { reason: emitters[f]?.reason ?? 'not attempted' }),
      filesScored: scored.length,
      pagesScored: pageScores.length,
      score: round(mean(scored.map((s) => s.score))),
      meanPageScore: round(mean(pageScores)),
      good: scored.filter((s) => s.score >= GOOD_SCORE).length,
      fair: scored.filter((s) => s.score >= FAIR_SCORE && s.score < GOOD_SCORE).length,
      poor: scored.filter((s) => s.score < FAIR_SCORE).length,
      failures: rows
        .map((r) => ({ name: r.name, ...r.formats[f] }))
        .filter((s) => s.status !== 'scored' && s.status !== 'unavailable')
        .map((s) => ({ name: s.name, status: s.status, reason: s.reason })),
    };
  }

  const scoredFormats = formats.filter((f) => byFormat[f].filesScored > 0);
  const report = {
    generatedAt: new Date().toISOString(),
    corpusDir: CORPUS,
    runDir,
    renderer: { ...renderer, dpi },
    reference: 'LibreOffice rendering the original .pub — the same libmspub parse our own extractor uses',
    metric: describeMetric(),
    bands: { good: GOOD_SCORE, fair: FAIR_SCORE },
    emitters,
    totals: {
      corpusFiles: files.length,
      scored: rows.length,
      skippedEmpty: skipped.empty.length,
      skippedReferenceBlank: skipped.referenceBlank.length,
      unreadable: skipped.unreadable.length,
      modelErrors: skipped.modelError.length,
      overall: round(mean(scoredFormats.map((f) => byFormat[f].score).filter((s) => s !== null))),
      flagship: byFormat.pptx?.score ?? null,
      wallMs: Date.now() - started,
      ...(deaths.length ? { workerDeaths: deaths } : {}),
    },
    byFormat,
    skipped,
    files: rows,
  };

  writeFileSync(join(HERE, `fidelity${filter ? '.filtered' : ''}.json`), JSON.stringify(report, null, 2) + '\n');

  if (asJson) console.log(JSON.stringify(report, null, 2));
  else printSummary(report);

  return 0;
}

function printSummary(report) {
  const t = report.totals;
  console.log('');
  for (const [f, s] of Object.entries(report.byFormat)) {
    if (!s.available) {
      console.log(`${pad(f.toUpperCase(), 6)}  not available — ${s.reason}`);
      continue;
    }
    if (s.filesScored === 0) {
      console.log(`${pad(f.toUpperCase(), 6)}  emitter present but nothing scored${s.failures.length ? `: ${s.failures[0].status} (${s.failures[0].reason ?? ''})` : ''}`);
      continue;
    }
    console.log(
      `${pad(f.toUpperCase(), 6)}  score ${fmt(s.score)}  (${band(s.score)})  ·  ${s.filesScored} files, ${s.pagesScored} pages` +
        `  ·  ${s.good} good / ${s.fair} fair / ${s.poor} poor` +
        (s.failures.length ? `  ·  ${s.failures.length} did not produce a comparable file` : ''),
    );
    for (const fail of s.failures.slice(0, 3)) console.log(`        ${fail.name}: ${fail.status} — ${(fail.reason ?? '').slice(0, 90)}`);
  }

  console.log('');
  console.log(
    `corpus   ${t.scored} scored  ·  ${t.skippedEmpty} skipped as 'empty' (upstream parser gap, not a conversion failure)` +
      `  ·  ${t.skippedReferenceBlank} skipped as reference-blank` +
      `  ·  ${t.unreadable} unreadable  ·  ${t.modelErrors} model errors  ·  ${(t.wallMs / 1000).toFixed(1)}s`,
  );
  if (report.skipped.empty.length) {
    console.log(`         empty: ${report.skipped.empty.map((e) => e.name).join(', ')}`);
  }
  if (report.skipped.referenceBlank.length) {
    console.log(
      `         reference-blank (LibreOffice draws nothing, so there is no signal either way): ` +
        report.skipped.referenceBlank.map((e) => e.name).join(', '),
    );
  }
  if (report.skipped.unreadable.length) {
    console.log(`         unreadable: ${report.skipped.unreadable.map((e) => `${e.name}${e.expected ? ' (expected)' : ''}`).join(', ')}`);
  }
  if (t.workerDeaths) {
    for (const d of t.workerDeaths) console.log(`         emit worker died before ${d.nextFile}: ${d.reason}`);
  }

  console.log('');
  console.log(`SCORE    ${fmt(t.overall)} overall  ·  ${fmt(t.flagship)} PPTX (the flagship format)`);
  console.log(
    `         the number is symmetric ink agreement at ${report.metric.placementTolerance.split(';')[0]} against LibreOffice's own render of the .pub.`,
  );
  console.log(`         it does not measure fidelity to Microsoft Publisher, and it cannot see text that is drawn but not selectable.`);
  console.log(`\nwrote    ${join(HERE, `fidelity${filter ? '.filtered' : ''}.json`)}`);
  if (wantDiff) console.log(`         diff images under ${diffDir}`);
}

// `alignReferencePages` is exported above so the page-alignment rule can be unit-tested: it
// is the subtlest thing in this file, and the one place a wrong answer looks like an emitter
// bug rather than a harness bug. Running the oracle is therefore guarded on being the entry
// point, so importing this file never starts a corpus run.
if (import.meta.url === `file://${process.argv[1]}`) process.exit(await run());
