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
 * caller keeps a `Row` per file, which is strings and numbers. That is what makes four
 * hundred files cost the same as four.
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
import type { AutoRule, Format, OutputRecord, Row } from './types';
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

/** Collects warnings from the model and the emitters without repeating any. */
class NoteBag {
  readonly #seen = new Set<string>();
  readonly #lines: string[] = [];

  add(warning: Warning): void {
    const key = `${warning.code}|${warning.page ?? ''}|${warning.message}`;
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    const where = warning.page === undefined ? '' : ` (page ${warning.page})`;
    const many = warning.count !== undefined && warning.count > 1 ? ` [${warning.count} times]` : '';
    this.#lines.push(`${warning.message}${where}${many}`);
  }

  addAll(warnings: readonly Warning[] | undefined): void {
    for (const w of warnings ?? []) this.add(w);
  }

  get lines(): string[] { return this.#lines; }
}

interface Emitted {
  /** One entry per file to write. SVG produces one per page; everything else one. */
  parts: { suffix: string; data: Uint8Array | string }[];
}

/** Resolves `--to auto` for this document, and says which rule did it. */
export function chooseFormats(doc: Doc, requested: readonly ('auto' | Format)[]): {
  formats: Format[];
  rule: AutoRule;
  because: string;
} {
  const formats: Format[] = [];
  let rule: AutoRule = '';
  let because = '';

  for (const want of requested) {
    if (want !== 'auto') {
      if (!formats.includes(want)) formats.push(want);
      continue;
    }
    const advice = recommendFormat(doc);
    // The brief, and docs/POSITIONING.md behind it: take the recommendation only where
    // it is confident, and fall back to PPTX otherwise. recommendFormat() already
    // returns pptx when it is unsure, but going through it explicitly means the report
    // can say *which* of the two rules applied, and the two are not the same claim.
    const chosen: Format = advice.confident ? advice.format : 'pptx';
    rule = advice.confident ? 'auto: recommended' : 'auto: default (PPTX)';
    because = advice.because;
    if (!formats.includes(chosen)) formats.push(chosen);
  }

  return { formats, rule, because };
}

async function emit(
  doc: Doc,
  format: Format,
  options: Options,
  notes: NoteBag,
): Promise<Emitted> {
  switch (format) {
    case 'pptx': {
      const result = await emitPPTXWithReport(doc);
      notes.addAll(result.warnings);
      return { parts: [{ suffix: '', data: result.bytes }] };
    }
    case 'docx': {
      const bytes = await emitDOCX(doc, {
        mode: options.docxMode,
        onWarning: (w) => notes.add(w),
      });
      return { parts: [{ suffix: '', data: bytes }] };
    }
    case 'pdf': {
      // emitPDF appends its own losses to doc.warnings rather than returning them,
      // so the caller re-reads that list afterwards.
      const bytes = await emitPDF(doc);
      return { parts: [{ suffix: '', data: bytes }] };
    }
    case 'svg': {
      // One page at a time rather than emitSVGPages(), which would hold every page of
      // a fifty-page newsletter as a string at once. Same output, a fraction of the peak.
      const parts: Emitted['parts'] = [];
      for (let i = 0; i < doc.pages.length; i++) {
        parts.push({
          suffix: doc.pages.length === 1 ? '' : ` page ${i + 1}`,
          data: emitSVG(doc, { page: i }),
        });
      }
      return { parts };
    }
  }
}

export interface ConvertDeps {
  options: Options;
  planner: OutputPlanner;
}

/**
 * Converts one file and returns the row for the report. Never throws for anything the
 * file or the disk did — those become a row with `status: 'attention'`, because one
 * bad file in a folder of four hundred must not end the run.
 */
export async function convertOne(file: FoundFile, deps: ConvertDeps): Promise<Row> {
  const { options, planner } = deps;
  const started = Date.now();
  const relativeDir = path.dirname(file.relative) === '.' ? '' : path.dirname(file.relative);
  const stem = stemOf(file.path);

  const base = {
    source: file.path,
    relative: file.relative,
    outputs: [] as OutputRecord[],
    rule: '' as AutoRule,
    notes: [] as string[],
  };
  const attention = (reason: string, extra: Partial<Row> = {}): Row => ({
    ...base, status: 'attention', reason, ms: Date.now() - started, ...extra,
  });

  if (file.size === 0) {
    return attention('This file is empty. It may not have finished copying.');
  }
  if (file.size > options.maxFileBytes) {
    return attention(
      `This file is ${formatBytes(file.size)}, which is past the ${formatBytes(options.maxFileBytes)} limit. ` +
      'Use --max-file-size to raise it, but be aware the reader works in a 512 MB space and very large files may not fit.',
    );
  }

  let bytes: Uint8Array | undefined;
  try {
    bytes = new Uint8Array(await readFile(file.path));
  } catch (error) {
    return attention(readFailureReason(error, file.path));
  }

  if (!hasOleMagic(bytes)) {
    return attention(
      'This file is named .pub but it is not a Publisher publication inside. If it was renamed, or came out of an email, try the original file.',
    );
  }

  let engine: ExtractorHandle;
  try {
    engine = await loadEngine();
  } catch (error) {
    // The reader failing is our fault, not the file's, and it will fail for every
    // remaining file too. Rethrow: the run loop stops rather than writing four
    // hundred identical rows blaming the user's documents.
    throw error;
  }

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
    return attention(messageOf(error, 'We could not read this Publisher file.'));
  }

  // ---- the gate ----------------------------------------------------------
  // docs/FIDELITY.md: five corpus files parse cleanly and hold nothing. They are told
  // about, never written. Removing this makes the product no better than the free
  // uploaders it is defined against.
  const verdict = assess(doc);
  const stats = {
    verdict: verdict.verdict,
    pages: verdict.pages,
    elements: verdict.elements,
    textLength: verdict.textLength,
    images: verdict.images,
  };
  if (verdict.verdict === 'empty') {
    return attention(verdict.message, stats);
  }

  const { formats, rule, because } = chooseFormats(doc, options.formats);

  const notes = new NoteBag();
  notes.addAll(doc.warnings);
  if (verdict.verdict === 'partial') notes.add({ code: 'SHAPE_APPROXIMATED', message: verdict.message });
  if (rule === 'auto: recommended') notes.add({ code: 'SHAPE_APPROXIMATED', message: because });

  // `check` and `--dry-run` stop here: everything above is the part that decides
  // whether a file converts, and it has already run for real.
  if (options.command === 'check' || options.dryRun) {
    const planned: OutputRecord[] = [];
    for (const format of formats) {
      if (options.command === 'check') {
        planned.push({ format, path: '', bytes: 0 });
        continue;
      }
      const pageCount = format === 'svg' ? doc.pages.length : 1;
      for (let i = 0; i < pageCount; i++) {
        const suffix = format === 'svg' && pageCount > 1 ? ` page ${i + 1}` : '';
        const claim = planner.plan(relativeDir, `${stem}${suffix}`, format);
        if (claim.action === 'skip') continue;
        planned.push({ format, path: claim.path, bytes: 0 });
      }
    }
    return {
      ...base, ...stats, rule,
      status: planned.length === 0 ? 'skipped' : 'converted',
      reason: planned.length === 0 ? 'The converted file is already there.' : '',
      outputs: planned,
      notes: notes.lines,
      ms: Date.now() - started,
    };
  }

  const written: OutputRecord[] = [];
  let skippedAll = formats.length > 0;

  for (const format of formats) {
    let produced: Emitted;
    try {
      produced = await emit(doc, format, options, notes);
    } catch (error) {
      notes.add({
        code: 'SHAPE_APPROXIMATED',
        message: messageOf(
          error,
          `We read this publication but could not write the ${format.toUpperCase()} version of it.`,
        ),
      });
      continue;
    }
    // emitPDF reports through doc.warnings rather than a return value.
    notes.addAll(doc.warnings);

    for (const part of produced.parts) {
      let claim: Claim = planner.plan(relativeDir, `${stem}${part.suffix}`, format);
      if (claim.action === 'skip') continue;
      skippedAll = false;

      const payload = typeof part.data === 'string' ? Buffer.from(part.data, 'utf8') : part.data;
      try {
        planner.ensureDir(claim);
        // Exclusive create unless the user asked for overwrite, so that a file that
        // appeared between our check and our write is still not clobbered.
        for (;;) {
          try {
            await writeFile(claim.path, payload, {
              flag: options.conflict === 'overwrite' ? 'w' : 'wx',
            });
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            claim = planner.retry(claim);
            planner.ensureDir(claim);
          }
        }
        written.push({ format, path: claim.path, bytes: payload.byteLength });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        notes.add({
          code: 'SHAPE_APPROXIMATED',
          message:
            code === 'ENOSPC' ? 'The disk is full, so this could not be written.'
              : code === 'EACCES' || code === 'EPERM'
                ? `We do not have permission to write into "${path.dirname(claim.path)}".`
                : `We could not write "${path.basename(claim.path)}" (${code ?? 'unknown error'}).`,
        });
      }
    }
  }

  if (written.length === 0) {
    if (skippedAll) {
      return {
        ...base, ...stats, rule,
        status: 'skipped',
        reason: 'The converted file is already there, so it was left alone.',
        notes: notes.lines,
        ms: Date.now() - started,
      };
    }
    return attention(
      notes.lines[0] ?? 'We read this publication but could not write the converted file.',
      { ...stats, rule, notes: notes.lines },
    );
  }

  return {
    ...base, ...stats, rule,
    status: 'converted',
    reason: '',
    outputs: written,
    notes: notes.lines,
    ms: Date.now() - started,
  };
}
