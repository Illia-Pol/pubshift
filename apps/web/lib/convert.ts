/**
 * The whole conversion, running in the visitor's browser tab.
 *
 *   .pub bytes -> WebAssembly extractor -> IR -> document model -> assess -> emitter -> Blob
 *
 * Nothing in this file touches the network except to fetch the extractor itself
 * (a static 465 KB asset). The document never leaves the machine it is on, which
 * is the one claim on the landing page that has to be literally true.
 *
 * This module is written to run **inside a Web Worker** (`lib/worker.ts`), and is
 * also correct on the main thread, which is where it ends up on a browser that
 * will not give us a module worker. It therefore takes a plain progress callback
 * instead of touching any UI, and everything it returns survives a structured
 * clone: numbers, strings and Blobs, no class instances.
 *
 * ## Why the extractor is loaded by URL rather than imported
 *
 * `wasm/dist/pubshift.mjs` is Emscripten output built for `web,worker,node`, so it
 * contains `require("node:fs")` behind a runtime environment check. Feeding that to
 * a browser bundler is a fight nobody wins. Instead the built artefacts are copied
 * into a content-addressed folder under `public/` (see `scripts/prepare-assets.mjs`)
 * and imported at runtime with a native dynamic import the bundler is told to leave
 * alone. Side benefit: the 465 KB module is not in the page's initial download, so
 * the landing page stays light for the majority of visitors who read before they
 * convert.
 *
 * ## Why the emitters are imported through `@emit/…`
 *
 * They are written by a separate workstream and may not all exist yet. A static
 * import of a missing file is a build failure, so `next.config.mjs` resolves each
 * `@emit/<format>` to the real emitter when it is in the tree and to
 * `lib/emitters/unavailable.ts` when it is not. The format picker greys out what
 * this build cannot produce, and nobody is offered a button that fails after their
 * file has already been read.
 */

import {
  assess, buildDoc, readIR, recommendFormat,
  type Assessment, type Doc, type Recommendation,
} from '@pubshift/core';
import * as pptxEmitter from '@emit/pptx';
import * as docxEmitter from '@emit/docx';
import * as pdfEmitter from '@emit/pdf';
import * as svgEmitter from '@emit/svg';
import { WASM_ENTRY_URL } from '@/lib/wasm-asset';
import {
  MAX_FILE_BYTES,
  formatBytes,
  hasOleMagic,
  type ConvertNote,
  type DocxMode,
  type OutputFile,
  type TargetFormat,
} from '@/lib/types';

/* -------------------------------------------------------------------------- */
/* The extractor                                                              */
/* -------------------------------------------------------------------------- */

interface ExtractorHandle {
  readonly version: string;
  extractJSON(bytes: Uint8Array): string;
}

interface EngineModule {
  loadPubshift(options?: {
    locateFile?: (path: string, prefix: string) => string;
  }): Promise<ExtractorHandle>;
}

let enginePromise: Promise<ExtractorHandle> | null = null;
let engineAttempt = 0;

/**
 * The extractor could not be started here.
 *
 * `retryElsewhere` means *here* specifically, not this browser: webpack compiles
 * our worker as a classic worker rather than a module one, and a classic worker
 * cannot always run a dynamic `import()` — Firefox in particular refuses. The main
 * thread has no such restriction, so the runner moves the job there and the
 * conversion still happens, a little less smoothly. Without this flag that browser
 * would be told its perfectly good setup cannot read Publisher files, which is
 * both false and the sort of thing that sends someone back to an uploader.
 */
export class EngineLoadError extends Error {
  readonly retryElsewhere: boolean;

  constructor(message: string, retryElsewhere: boolean, cause?: unknown) {
    super(message);
    this.name = 'EngineLoadError';
    this.retryElsewhere = retryElsewhere;
    this.cause = cause;
    Object.setPrototypeOf(this, EngineLoadError.prototype);
  }
}

const ENGINE_FAILED =
  'The Publisher reader could not start in this browser. If you are on a very old ' +
  'browser, or an extension is blocking part of this page, that is usually the cause.';

/**
 * Starts the extractor, once per thread. Safe and cheap to call early — the panel
 * calls it as soon as someone shows intent, so that by the time a file is dropped
 * the module is warm and the conversion is instant. Measured cold load is 2.6 ms
 * (docs/FIDELITY.md).
 *
 * It also means a visitor can convert one file, disconnect from the network, and
 * convert a second one. That is a test anybody can run, and we invite them to.
 */
export function startEngine(): Promise<ExtractorHandle> {
  if (enginePromise) return enginePromise;

  engineAttempt += 1;

  const started = (async () => {
    // A variable specifier plus the ignore comments: the bundler must not try to
    // follow this, because the file it points at is a copied build artefact served
    // from /public, not a module in the dependency graph.
    //
    // The query string on a retry is not cache-busting for its own sake. A module
    // that fails to load is recorded as failed in the realm's module map, and every
    // later `import()` of the *same specifier* re-throws the stored error without
    // going near the network (HTML standard, "fetch a single module script"). So a
    // second attempt at the same URL is guaranteed to fail even after the asset is
    // back — which would make the retry offered on screen a lie. A distinct
    // specifier is a distinct entry, so the fetch genuinely happens again.
    //
    // It does not disturb anything else: `dist/pubshift.mjs` and `pubshift.wasm`
    // are resolved relative to this module and URL resolution drops the query, so
    // both keep their content-addressed, immutably cacheable URLs.
    const url = engineAttempt === 1 ? WASM_ENTRY_URL : `${WASM_ENTRY_URL}?attempt=${engineAttempt}`;
    let mod: EngineModule;
    try {
      mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ url)) as EngineModule;
    } catch (cause) {
      // Either this context will not do dynamic imports at all, or the asset is not
      // where we said it was. Both are worth trying once on the main thread before
      // telling somebody their browser is the problem.
      throw new EngineLoadError(ENGINE_FAILED, true, cause);
    }
    // index.mjs finds its own .wasm next to itself, and prepare-assets.mjs copies
    // it there, so no locateFile override is needed or wanted: hard-coding a second
    // path is how the two get to disagree after a rebuild.
    return mod.loadPubshift();
  })();

  enginePromise = started;

  // A failed load must not be cached as a permanent failure: a flaky first fetch
  // should not condemn the tab to uselessness.
  started.catch(() => {
    if (enginePromise === started) enginePromise = null;
  });

  return started;
}

/** True when the extractor is loadable here. Used to fail loudly before a file is chosen. */
export async function checkEngine(): Promise<
  { ok: true } | { ok: false; message: string; retryElsewhere: boolean }
> {
  if (typeof WebAssembly === 'undefined') {
    return {
      ok: false,
      retryElsewhere: false,
      message:
        'This browser cannot run WebAssembly, which is what reads Publisher files here. ' +
        'A current Chrome, Edge, Firefox or Safari will work.',
    };
  }
  try {
    await startEngine();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: ENGINE_FAILED,
      retryElsewhere: error instanceof EngineLoadError && error.retryElsewhere,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* The emitters                                                               */
/* -------------------------------------------------------------------------- */

/** `lib/emitters/unavailable.ts` sets this; a real emitter module does not. */
function isStub(mod: unknown): boolean {
  return (mod as Record<string, unknown>).EMITTER_UNAVAILABLE === true;
}

const EMITTER_MODULE: Record<TargetFormat, unknown> = {
  pptx: pptxEmitter,
  docx: docxEmitter,
  pdf: pdfEmitter,
  svg: svgEmitter,
};

/**
 * Which formats this build can actually produce.
 *
 * Re-exported rather than computed here: a page component that asked this module
 * for the answer would pull every emitter into the landing page's bundle, and the
 * answer is fixed at build time anyway. `lib/available.ts` reads the constant that
 * `next.config.mjs` wrote while it was choosing the aliases. `isStub` above stays
 * as the guard at the moment of use, which is the one that cannot be out of date.
 */
export { availableFormats } from '@/lib/available';

const MIME: Record<TargetFormat, string> = {
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  svg: 'image/svg+xml',
};

/**
 * TypeScript's DOM lib has shifted on whether a `Uint8Array` satisfies `BlobPart`
 * across recent releases. The runtime has never been in any doubt.
 */
function blobOf(data: Uint8Array | string, mime: string): Blob {
  return new Blob([data as unknown as BlobPart], { type: mime });
}

/* -------------------------------------------------------------------------- */
/* The pipeline                                                               */
/* -------------------------------------------------------------------------- */

/** What the converter is doing right now. The panel turns these into a sentence. */
export type Stage = 'reading' | 'extracting' | 'assembling' | 'checking' | 'writing';

export interface DocStats {
  pages: number;
  elements: number;
  textLength: number;
  images: number;
}

/** Page one, rendered as SVG, so somebody can see it worked before downloading. */
export interface PreviewPage {
  svg: Blob;
  /** Points. Used for the aspect ratio of the thumbnail frame. */
  width: number;
  height: number;
  pageCount: number;
}

export type ConvertOutcome =
  | {
      kind: 'done';
      /** `partial` means we read it but found suspiciously little. Never hidden. */
      verdict: 'ok' | 'partial';
      outputs: OutputFile[];
      notes: ConvertNote[];
      stats: DocStats;
      /** `assess()`'s sentence when the verdict is `partial`. Shown next to the download. */
      caveat?: string;
      /**
       * Only present when the measurements actually back a suggestion for this shape of
       * document, and only when it differs from what the user picked — see
       * packages/core/src/model/recommend.ts for why it stays quiet the rest of the time.
       */
      suggestion?: { format: TargetFormat; because: string };
      preview?: PreviewPage;
    }
  /**
   * The file is at fault, or we honestly cannot read it. Never a blank download —
   * see docs/FIDELITY.md on the five corpus files that parse cleanly and hold nothing.
   */
  | { kind: 'unreadable'; message: string; stats?: DocStats }
  /** We are at fault: the module would not start, an emitter is missing. */
  | {
      kind: 'error';
      message: string;
      /** The same work may still succeed on the main thread. See `EngineLoadError`. */
      retryElsewhere?: boolean;
    };

export interface ConvertOptions {
  format: TargetFormat;
  docxMode: DocxMode;
  /** Render page one as SVG for the results list. On by default. */
  preview?: boolean;
}

/**
 * A preview is a nicety; a 40 MB string of base64 photographs in every row of a
 * fifty-file batch is not. Past this, the row says so instead.
 */
const MAX_PREVIEW_BYTES = 6 * 1024 * 1024;

/** `Bulletin March 2019.pub` -> `Bulletin March 2019` */
function stemOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? 'publication';
  return base.replace(/\.pub$/i, '').trim() || 'publication';
}

function messageOf(error: unknown, fallback: string): string {
  // Both `PubshiftError` and `IRReadError` carry a message already written for a
  // non-technical reader. Passing it through beats paraphrasing it badly.
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function statsOf(a: Assessment): DocStats {
  return { pages: a.pages, elements: a.elements, textLength: a.textLength, images: a.images };
}

/** Page one as SVG, or nothing at all. A failed preview never fails a conversion. */
function previewOf(doc: Doc): PreviewPage | undefined {
  const first = doc.pages[0];
  if (!first) return undefined;
  try {
    // One page, not all of them. A fifteen-year run of bulletins is exactly the batch
    // this product is for, and rendering forty pages to show the first one is forty
    // times the work for the same thumbnail.
    const svg = svgEmitter.emitSVG(doc, { page: 0 });
    if (!svg || svg.length > MAX_PREVIEW_BYTES) return undefined;
    return {
      svg: blobOf(svg, MIME.svg),
      width: first.width,
      height: first.height,
      pageCount: doc.pages.length,
    };
  } catch {
    return undefined;
  }
}

export async function convertFile(
  file: File,
  options: ConvertOptions,
  onStage: (stage: Stage) => void = () => {},
): Promise<ConvertOutcome> {
  if (file.size === 0) {
    return { kind: 'unreadable', message: 'This file is empty — it may not have finished copying.' };
  }
  if (file.size > MAX_FILE_BYTES) {
    return {
      kind: 'unreadable',
      message: `This file is ${formatBytes(file.size)}. We open files up to ${formatBytes(
        MAX_FILE_BYTES,
      )} in the browser, past which a shared office computer starts to struggle.`,
    };
  }

  onStage('reading');

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return {
      kind: 'error',
      message:
        'Your browser could not read that file from disk. If it is on a network drive, copy it to the desktop and try again.',
    };
  }

  if (!hasOleMagic(bytes)) {
    return {
      kind: 'unreadable',
      message:
        'This file is named .pub but it is not a Publisher publication inside. If it was renamed, or downloaded from an email, try the original file.',
    };
  }

  let handle: ExtractorHandle;
  try {
    handle = await startEngine();
  } catch (error) {
    return {
      kind: 'error',
      message:
        'The Publisher reader could not start in this browser. It needs a current version of Chrome, Edge, Firefox or Safari.',
      retryElsewhere: error instanceof EngineLoadError && error.retryElsewhere,
    };
  }

  let doc: Doc;
  try {
    onStage('extracting');
    const json = handle.extractJSON(bytes);
    onStage('assembling');
    doc = buildDoc(readIR(json));
  } catch (error) {
    return { kind: 'unreadable', message: messageOf(error, 'We could not read this Publisher file.') };
  }

  // The gate. A document with nothing in it is never offered as a success — see
  // docs/FIDELITY.md on the five corpus files that parse cleanly and hold nothing.
  onStage('checking');
  const verdict = assess(doc);
  if (verdict.verdict === 'empty') {
    return { kind: 'unreadable', message: verdict.message, stats: statsOf(verdict) };
  }

  // A second opinion, but only where the corpus supports one and only where it disagrees
  // with the choice already made. Recommending the format the user already picked is noise.
  const advice: Recommendation = recommendFormat(doc);
  const suggestion =
    advice.confident && advice.format !== options.format
      ? { format: advice.format, because: advice.because }
      : undefined;

  const module = EMITTER_MODULE[options.format];
  if (isStub(module)) {
    return {
      kind: 'error',
      message: 'That format is not switched on in this version yet. Please pick another one.',
    };
  }

  const stem = stemOf(file.name);
  let outputs: OutputFile[];

  onStage('writing');
  try {
    if (options.format === 'svg') {
      const pages = svgEmitter.emitSVGPages(doc);
      outputs = pages.map((svg, index) => {
        const name = pages.length === 1 ? `${stem}.svg` : `${stem} — page ${index + 1}.svg`;
        const blob = blobOf(svg, MIME.svg);
        return { name, blob, sizeBytes: blob.size };
      });
    } else {
      const written =
        options.format === 'docx'
          ? await docxEmitter.emitDOCX(doc, { mode: options.docxMode })
          : options.format === 'pptx'
            ? await pptxEmitter.emitPPTX(doc)
            : await pdfEmitter.emitPDF(doc);
      const blob = blobOf(written, MIME[options.format]);
      outputs = [{ name: `${stem}.${options.format}`, blob, sizeBytes: blob.size }];
    }
  } catch (error) {
    return {
      kind: 'error',
      message: messageOf(
        error,
        'We read your publication but could not write the converted file. Trying a different format usually works.',
      ),
    };
  }

  if (outputs.length === 0) {
    return {
      kind: 'unreadable',
      message:
        'We read this file but there were no pages in it to convert, and we would rather say so than hand you an empty document.',
      stats: statsOf(verdict),
    };
  }

  const notes: ConvertNote[] = (doc.warnings ?? []).map((w) => ({
    code: w.code,
    message: w.message,
    page: w.page,
    count: w.count,
  }));

  return {
    kind: 'done',
    verdict: verdict.verdict,
    outputs,
    notes,
    stats: statsOf(verdict),
    caveat: verdict.verdict === 'partial' ? verdict.message : undefined,
    suggestion,
    preview: options.preview === false ? undefined : previewOf(doc),
  };
}
