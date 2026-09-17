// Runs the real pipeline and drops its output on disk for compare.mjs to render.
//
// It lives behind a subprocess for one reason: the pipeline is TypeScript and the oracle
// must stay runnable as plain `node tools/fidelity/compare.mjs`. compare.mjs starts this
// under `npx tsx`, feeds it the corpus, and reads NDJSON back.
//
//   npx tsx tools/fidelity/lib/emit-worker.mjs job.json
//
// where job.json is `{stage, bin, formats: [...], files: [...]}` — a file rather than
// flags so that paths never have to survive two layers of shell quoting.
//
// Two things here are deliberate rather than defensive:
//
//   * Emitters are discovered, not assumed. This project's emitters are written in
//     parallel by different hands; one that does not exist yet, or that exports a
//     different name, must produce a line saying so — not a crash, and above all not a
//     silently missing column in the results table.
//   * A file whose `assess` verdict is 'empty' is reported and NOT emitted. libmspub
//     hands back an empty event stream for five corpus files; writing out a blank .pptx
//     for those and scoring it would blame the emitters for a parser gap and would also
//     be the exact "here is your empty document" failure the product exists to prevent.
//
// Output is one JSON object per line: first `{t:'emitters'}`, then `{t:'file'}` per input.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = resolve(HERE, '../../../packages/core/src');

/**
 * Where each target format comes from. `perPage: true` means the emitter returns one
 * artefact per page rather than one document; SVG is the only such format, because an SVG
 * file has no concept of a second page.
 */
const EMITTERS = {
  pptx: { module: `${CORE}/emit/pptx.ts`, name: 'emitPPTX', ext: 'pptx', perPage: false },
  docx: { module: `${CORE}/emit/docx.ts`, name: 'emitDOCX', ext: 'docx', perPage: false },
  pdf: { module: `${CORE}/emit/pdf.ts`, name: 'emitPDF', ext: 'pdf', perPage: false },
  svg: { module: `${CORE}/emit/svg.ts`, name: 'emitSVGPages', ext: 'svg', perPage: true },
};

/** Extractor output for one corpus file can be tens of megabytes of base64 assets. */
const EXTRACT_BUFFER = 1 << 28;

/** An emitter that has not returned after this long is not going to. */
const EMIT_TIMEOUT_MS = 60_000;

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

/** Whatever an emitter returns, turned into files — or a clear complaint about its shape. */
function toBuffers(value, perPage) {
  if (typeof value === 'string') return [Buffer.from(value, 'utf8')];
  if (value instanceof Uint8Array) return [Buffer.from(value.buffer, value.byteOffset, value.byteLength)];
  if (value instanceof ArrayBuffer) return [Buffer.from(value)];
  if (Array.isArray(value)) {
    if (!perPage) throw new Error('returned an array from a single-document emitter');
    return value.flatMap((v) => toBuffers(v, false));
  }
  throw new Error(`returned ${value === null ? 'null' : typeof value}, expected bytes or a string`);
}

async function loadEmitters(formats) {
  const out = {};
  for (const format of formats) {
    const spec = EMITTERS[format];
    if (!spec) {
      out[format] = { available: false, reason: `unknown format '${format}'` };
      continue;
    }
    try {
      const mod = await import(spec.module);
      const fn = mod[spec.name];
      if (typeof fn !== 'function') {
        out[format] = {
          available: false,
          module: spec.module,
          reason: `${spec.module} exists but does not export ${spec.name}() (exports: ${Object.keys(mod).join(', ') || 'none'})`,
        };
        continue;
      }
      out[format] = { available: true, module: spec.module, export: spec.name, fn, ...spec };
    } catch (e) {
      out[format] = {
        available: false,
        module: spec.module,
        reason: e?.code === 'ERR_MODULE_NOT_FOUND' ? `${spec.module} does not exist yet` : `${spec.module} failed to load: ${e?.message ?? e}`,
      };
    }
  }
  return out;
}

async function withTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not return within ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const jobPath = process.argv[2];
  if (!jobPath) throw new Error('usage: emit-worker.mjs <job.json>');
  const job = JSON.parse(readFileSync(jobPath, 'utf8'));
  const stage = resolve(job.stage);
  const bin = resolve(job.bin);
  const formats = job.formats ?? Object.keys(EMITTERS);
  const files = job.files ?? [];

  const { readIR, buildDoc, assess } = await import(`${CORE}/index.ts`);
  const emitters = await loadEmitters(formats);

  emit({
    t: 'emitters',
    emitters: Object.fromEntries(
      Object.entries(emitters).map(([k, v]) => [
        k,
        v.available ? { available: true, module: v.module, export: v.export } : { available: false, reason: v.reason },
      ]),
    ),
  });

  for (const file of files) {
    const name = basename(file);
    let raw;
    try {
      raw = execFileSync(bin, [resolve(file)], { maxBuffer: EXTRACT_BUFFER }).toString();
    } catch (e) {
      emit({ t: 'file', name, ok: false, stage: 'extract', error: (e?.message ?? String(e)).slice(0, 400) });
      continue;
    }

    let doc;
    let verdict;
    try {
      doc = buildDoc(readIR(raw));
      verdict = assess(doc);
    } catch (e) {
      emit({ t: 'file', name, ok: false, stage: 'model', error: (e?.message ?? String(e)).slice(0, 400) });
      continue;
    }

    const record = {
      t: 'file',
      name,
      ok: true,
      verdict: verdict.verdict,
      message: verdict.message,
      pages: doc.pages.length,
      elements: verdict.elements,
      textLength: verdict.textLength,
      warnings: doc.warnings.map((w) => w.code),
      pageSizes: doc.pages.map((p) => ({ width: p.width, height: p.height })),
      artifacts: {},
    };

    // The gate. An empty verdict is an upstream parse gap; emitting anything for it would
    // put a blank page into the fidelity numbers and call the emitters guilty.
    if (verdict.verdict === 'empty') {
      emit(record);
      continue;
    }

    for (const [format, spec] of Object.entries(emitters)) {
      if (!spec.available) {
        record.artifacts[format] = { status: 'unavailable', reason: spec.reason };
        continue;
      }
      const dir = join(stage, name, format);
      try {
        const value = await withTimeout(Promise.resolve(spec.fn(doc)), EMIT_TIMEOUT_MS, `${spec.export}(${name})`);
        const buffers = toBuffers(value, spec.perPage);
        if (buffers.length === 0) throw new Error('produced no output');
        mkdirSync(dir, { recursive: true });
        const paths = buffers.map((buf, i) => {
          const p = join(dir, spec.perPage ? `page-${i + 1}.${spec.ext}` : `document.${spec.ext}`);
          writeFileSync(p, buf);
          return p;
        });
        record.artifacts[format] = {
          status: 'emitted',
          files: paths,
          bytes: buffers.reduce((a, b) => a + b.length, 0),
          perPage: spec.perPage,
        };
      } catch (e) {
        record.artifacts[format] = { status: 'error', reason: (e?.message ?? String(e)).slice(0, 400) };
      }
    }

    emit(record);
  }
}

await main();
