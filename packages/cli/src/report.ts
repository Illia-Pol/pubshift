/**
 * The report: a spreadsheet, a page, and what is printed at the end of a run.
 *
 * This is the reason someone pays for the batch runner instead of dragging files into
 * the free web page four hundred times (docs/PRICING.md). So it obeys one rule above
 * every other: **it leads with what needs a human, never with the success count.**
 *
 * Somebody converting a fifteen-year parish archive is not going to open four hundred
 * PowerPoint files to check them. The only number that changes what they do next is
 * "how many do I have to deal with myself", and the only list worth printing is which
 * ones and what each of them lost. A report that opens with "397 converted!" has buried
 * its own purpose.
 *
 * The plain-English sentence for each kind of loss lives here, once, copied verbatim
 * from `apps/web/lib/notes.ts` so that the CLI and the website never describe the same
 * loss in two different ways. `test/report.test.ts` reads that file and fails if the two
 * ever drift apart.
 */

import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Warning } from '@pubshift/core';

import { UsageError, type FileResult, type Outcome } from './types';

export type { FileResult, FormatChoice, Outcome, OutputFile } from './types';

// ---------------------------------------------------------------------------
// Plain English
// ---------------------------------------------------------------------------

/**
 * One sentence per warning code in `packages/core/src/model/types.ts`.
 *
 * Copied verbatim from `apps/web/lib/notes.ts`. It is duplicated rather than imported
 * because that module lives behind the web app's `@/` alias and pulling the app into
 * this package to reach nine strings would be the worse trade — so the test asserts the
 * strings are identical instead. If you change one, change both; the test will tell you.
 *
 * An unrecognised code falls back to the message the pipeline wrote, which is why adding
 * a code upstream degrades to "wordier" rather than to "silent".
 */
const PLAIN: Record<string, string> = {
  ROTATED_TEXT_APPROXIMATED:
    'Text set at an angle has been placed as close to the original as we could manage.',
  GRADIENT_FLATTENED: 'A colour fade was replaced with a single flat colour.',
  WMF_IMAGE_NOT_CONVERTED:
    'Older Publisher clip art is stored in a Windows-only picture format we cannot read, so it is missing. This is the largest thing we still lose.',
  SHADOW_DROPPED: 'A drop shadow was left off.',
  COLUMNS_FLATTENED: 'Text that ran in columns was straightened into one column.',
  FONT_NOT_EMBEDDED:
    'A font is named but not included in the file, so it will only look right on a computer that has that font.',
  SHAPE_APPROXIMATED: 'An unusual shape was redrawn as closely as we could.',
  TABLE_IN_UNSUPPORTED_TARGET:
    'A table could not stay a table in this format, so its text was laid out instead.',
  OVERLAP_MAY_REFLOW:
    'Some boxes overlap, so they may shift when you start editing the converted file.',
};

export interface LossGroup {
  code: string;
  /** What happened, in plain language. */
  sentence: string;
  /** How many times, across the whole document. */
  count: number;
  /** Pages it happened on, ascending and deduplicated. Empty when document-wide. */
  pages: number[];
}

/** `page 3`, `pages 3 and 4`, `pages 3, 4 and 9`. */
export function pageList(pages: readonly number[]): string {
  if (pages.length === 0) return '';
  if (pages.length === 1) return `page ${pages[0]}`;
  const head = pages.slice(0, -1).join(', ');
  return `pages ${head} and ${pages[pages.length - 1]}`;
}

/**
 * Warnings, merged by kind, counted, with the pages collected.
 *
 * Most frequent first, exactly as the website orders them: the loss that happened
 * thirteen times is the one worth looking at before the one that happened once.
 */
export function groupLosses(warnings: readonly Warning[] | undefined): LossGroup[] {
  if (!warnings || warnings.length === 0) return [];

  const groups = new Map<string, { sentence: string; count: number; pages: Set<number> }>();

  for (const warning of warnings) {
    const code = String(warning.code);
    const existing = groups.get(code);
    const group = existing ?? {
      sentence: PLAIN[code] ?? warning.message,
      count: 0,
      pages: new Set<number>(),
    };
    group.count += warning.count ?? 1;
    if (typeof warning.page === 'number' && Number.isFinite(warning.page)) {
      group.pages.add(warning.page);
    }
    if (!existing) groups.set(code, group);
  }

  return [...groups.entries()]
    .map(([code, g]) => ({
      code,
      sentence: g.sentence,
      count: g.count,
      pages: [...g.pages].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** `A drop shadow was left off. (3 times, pages 1 and 3)` */
export function describeLoss(group: LossGroup): string {
  const bits: string[] = [];
  if (group.count > 1) bits.push(`${group.count} times`);
  const pages = pageList(group.pages);
  if (pages !== '') bits.push(pages);
  return bits.length === 0 ? group.sentence : `${group.sentence} (${bits.join(', ')})`;
}

/** Every loss for one file, as sentences, worst first. */
export function lossSentences(result: FileResult): string[] {
  // Operational failures first, verbatim and unmapped. They are the more urgent thing to
  // read — "the disk is full" needs acting on, a flattened gradient does not — and they
  // deliberately do not go through describeLoss, which resolves a WarningCode to canned
  // prose and would turn a real error into decorative text.
  return [...(result.problems ?? []), ...groupLosses(result.warnings).map(describeLoss)];
}

/** How many separate things went wrong, for ordering one flagged file against another. */
function lossWeight(result: FileResult): number {
  let total = 0;
  for (const w of result.warnings) total += w.count ?? 1;
  // An operational failure outranks any number of fidelity losses when ordering.
  total += (result.problems?.length ?? 0) * 100;
  return total;
}

// ---------------------------------------------------------------------------
// Counting and ordering
// ---------------------------------------------------------------------------

/**
 * A file somebody has to open themselves.
 *
 * A file that converted *with losses* counts. That is a deliberate choice and the
 * single most consequential line in this module: the alternative is a report that calls
 * a newsletter a success when its clip art is missing, which is the failure this whole
 * product is defined against (docs/POSITIONING.md).
 */
export function needsAttention(result: FileResult): boolean {
  return (
    result.outcome === 'failed' ||
    result.outcome === 'unreadable' ||
    result.outcome === 'converted-with-caveats' ||
    // A file whose PDF could not be written is not a clean success, whatever else
    // happened to it.
    (result.problems?.length ?? 0) > 0
  );
}

export interface ReportSummary {
  total: number;
  converted: number;
  withCaveats: number;
  unreadable: number;
  failed: number;
  skipped: number;
  needsAttention: number;
  /** Files that produced at least one output, or already had one. */
  written: number;
  outputs: number;
}

export function summariseResults(results: readonly FileResult[]): ReportSummary {
  const summary: ReportSummary = {
    total: results.length,
    converted: 0,
    withCaveats: 0,
    unreadable: 0,
    failed: 0,
    skipped: 0,
    needsAttention: 0,
    written: 0,
    outputs: 0,
  };

  for (const result of results) {
    switch (result.outcome) {
      case 'converted': summary.converted++; break;
      case 'converted-with-caveats': summary.withCaveats++; break;
      case 'unreadable': summary.unreadable++; break;
      case 'failed': summary.failed++; break;
      case 'skipped': summary.skipped++; break;
    }
    if (needsAttention(result)) summary.needsAttention++;
    if (result.outcome === 'converted' || result.outcome === 'converted-with-caveats' ||
        result.outcome === 'skipped') {
      summary.written++;
    }
    summary.outputs += result.outputs.length;
  }

  return summary;
}

/** Worst kind first. The order the whole report is presented in. */
const RANK: Record<Outcome, number> = {
  failed: 0,
  unreadable: 1,
  'converted-with-caveats': 2,
  converted: 3,
  skipped: 4,
};

/**
 * The files needing a human first, worst kind first, then most-damaged first, then by
 * name. Returns a new array: a caller rendering three formats from one run must get the
 * same order in all three, and must not have its own list reordered underneath it.
 */
export function sortForReport(results: readonly FileResult[]): FileResult[] {
  return [...results].sort((a, b) => {
    const rank = RANK[a.outcome] - RANK[b.outcome];
    if (rank !== 0) return rank;
    const weight = lossWeight(b) - lossWeight(a);
    if (weight !== 0) return weight;
    return a.source.localeCompare(b.source);
  });
}

// ---------------------------------------------------------------------------
// Shared wording
// ---------------------------------------------------------------------------

const OUTCOME_WORDS: Record<Outcome, string> = {
  converted: 'Converted',
  'converted-with-caveats': 'Converted, but something was lost',
  unreadable: 'Nothing could be read from it',
  failed: 'Could not be converted',
  skipped: 'Skipped',
};

/** `21 KB`, `1.5 KB`, `5.0 MB`. How a person reads a file listing, not how a disk does. */
export function humanBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? 'TB'}`;
}

/** What a person should do next about this file. One sentence, never a code. */
function advice(result: FileResult): string {
  if (result.message !== undefined && result.message !== '') return result.message;
  const losses = lossSentences(result);
  if (losses.length > 0) return losses.join(' ');
  return OUTCOME_WORDS[result.outcome];
}

function distinctFormats(result: FileResult): string {
  const seen = result.outputs.length > 0
    ? result.outputs.map((o) => o.format)
    : result.format
      ? [result.format.format]
      : [];
  return [...new Set(seen)].join('; ');
}

/** Context a report can mention but must never require. */
export interface ReportContext {
  /** The folder the user pointed at. */
  root?: string;
  /** Where converted files were written. Absent for `check` and `--dry-run`. */
  out?: string;
  command?: 'convert' | 'check';
  dryRun?: boolean;
  /** Whole-run wall clock, milliseconds. */
  ms?: number;
  version?: string;
  /** When the run happened, as an ISO string. Passed in so output stays reproducible. */
  when?: string;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const COLUMNS = [
  'Source file',
  'Size (bytes)',
  'Size',
  'Outcome',
  'Needs attention',
  'Pages',
  'Output files',
  'Format',
  'Format chosen automatically',
  'Why this format',
  'What was lost',
  'Note',
] as const;

/**
 * One CSV field, RFC 4180, and safe to open.
 *
 * Two separate jobs, and the second is the one people forget. RFC 4180 says quote a
 * field containing a comma, a quote or a line break. That is not enough here, because
 * the first column is a **filename from the user's disk** and Excel, LibreOffice and
 * Sheets all treat a leading `=`, `+`, `-`, `@`, tab or carriage return as the start of
 * a formula. A parish archive is unlikely to contain `=cmd|'/c calc'!A1.pub` by
 * accident, but the report exists to be opened by a non-technical person on a Windows
 * machine, and "your spreadsheet ran the filename" is not a thing that should be
 * possible. A leading apostrophe makes it text; every spreadsheet understands it and
 * none of them display it.
 */
export function csvCell(value: string | number | undefined | null): string {
  const text = value === undefined || value === null ? '' : String(value);
  const risky = /^[=+\-@\t\r]/.test(text);
  const body = risky ? `'${text}` : text;
  // The tab is in here as well as in the neutralising set: a field that merely contains
  // one still has to be quoted or a re-import splits the column.
  if (/["\r\n,\t]/.test(body) || /^\s|\s$/.test(body)) {
    return `"${body.replace(/"/g, '""')}"`;
  }
  return body;
}

function csvRow(result: FileResult): string {
  return [
    result.source,
    result.sizeBytes,
    humanBytes(result.sizeBytes),
    OUTCOME_WORDS[result.outcome],
    needsAttention(result) ? 'yes' : 'no',
    result.pages,
    result.outputs.map((o) => o.path).filter((p) => p !== '').join('; '),
    distinctFormats(result),
    result.format === undefined ? '' : result.format.automatic ? 'yes' : 'no',
    result.format?.because ?? '',
    lossSentences(result).join('; '),
    result.message ?? '',
  ].map(csvCell).join(',');
}

export function renderCsv(results: readonly FileResult[]): string {
  const lines = [COLUMNS.map(csvCell).join(',')];
  for (const result of sortForReport(results)) lines.push(csvRow(result));
  // A byte-order mark, because the buyer opens this by double-clicking it, and Excel on
  // Windows reads a BOM-less UTF-8 CSV as the local code page — which turns every
  // accented parish name into mojibake in the one artefact meant to be readable.
  // CRLF for the same reason: it is what RFC 4180 specifies and what Excel expects.
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---------------------------------------------------------------------------
// The terminal summary
// ---------------------------------------------------------------------------

/** How many clean files to name before saying "and N more". */
const MAX_CLEAN_LISTED = 20;
/** How many flagged files to name before pointing at the report file. */
const MAX_FLAGGED_LISTED = 40;

/**
 * Deliberately ASCII, including the punctuation.
 *
 * This is printed to a Windows console, which in 2026 still opens at code page 437 or
 * 1252 for a user who has not gone looking for the setting. A curly quote in *our own*
 * wording becomes a question mark there and makes the tool look broken. Filenames are
 * the user's text and are passed through exactly as they are: mangling those to protect
 * a code page would break the one column they need to find the file.
 */
export function renderTextSummary(
  results: readonly FileResult[],
  context: ReportContext = {},
): string {
  const out: string[] = [];
  const summary = summariseResults(results);

  if (summary.total === 0) {
    out.push('No .pub files were found.');
    if (context.root !== undefined) out.push(`Looked in: ${context.root}`);
    out.push('If they are inside folders, add --recursive to look there too.');
    return `${out.join('\n')}\n`;
  }

  const sorted = sortForReport(results);
  const flagged = sorted.filter(needsAttention);

  out.push('');
  if (flagged.length === 0) {
    out.push('NOTHING NEEDS A HUMAN');
    out.push(`  All ${summary.total} ${summary.total === 1 ? 'file' : 'files'} came through cleanly.`);
  } else {
    out.push('NEEDS A HUMAN');
    out.push(
      `  ${flagged.length} of ${summary.total} ${summary.total === 1 ? 'file' : 'files'}` +
      ` ${flagged.length === 1 ? 'needs' : 'need'} a human look.`,
    );
    out.push('');
    for (const result of flagged.slice(0, MAX_FLAGGED_LISTED)) {
      out.push(`  ${result.source}`);
      out.push(`      ${advice(result)}`);
      if (result.message !== undefined && result.message !== '') {
        for (const loss of lossSentences(result)) out.push(`      ${loss}`);
      }
    }
    if (flagged.length > MAX_FLAGGED_LISTED) {
      out.push(`  ...and ${flagged.length - MAX_FLAGGED_LISTED} more.`);
    }
  }

  // Only files that really converted. A shortcut we did not follow and a file whose
  // output was already there are not conversions, and listing them here would be the
  // report telling a small lie about work it did not do.
  const clean = sorted.filter((r) => r.outcome === 'converted');
  out.push('');
  out.push('CONVERTED CLEANLY');
  if (clean.length === 0) {
    out.push('  None.');
  } else {
    out.push(`  ${clean.length} ${clean.length === 1 ? 'file' : 'files'}.`);
    for (const result of clean.slice(0, MAX_CLEAN_LISTED)) out.push(`  ${result.source}`);
    if (clean.length > MAX_CLEAN_LISTED) {
      out.push(`  ...and ${clean.length - MAX_CLEAN_LISTED} more.`);
    }
  }

  const skipped = sorted.filter((r) => r.outcome === 'skipped');
  if (skipped.length > 0) {
    out.push('');
    out.push('SKIPPED, NOTHING TO DO');
    for (const result of skipped.slice(0, MAX_CLEAN_LISTED)) {
      out.push(`  ${result.source}`);
      if (result.message !== undefined && result.message !== '') {
        out.push(`      ${result.message}`);
      }
    }
    if (skipped.length > MAX_CLEAN_LISTED) {
      out.push(`  ...and ${skipped.length - MAX_CLEAN_LISTED} more.`);
    }
  }

  out.push('');
  // Only point at the output folder when something is actually in it. Announcing a path
  // after a run that wrote nothing sends someone to an empty folder to look for work we
  // did not do.
  const wroteSomething = results.some((r) => r.outputs.length > 0);
  if (context.out !== undefined && context.dryRun !== true && wroteSomething) {
    out.push(`Converted files are in: ${context.out}`);
  }
  if (context.dryRun === true) out.push('This was a dry run. Nothing was written.');
  if (context.command === 'check') out.push('This was a check. Nothing was written.');

  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** The five characters that can turn a filename into markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Deliberately not a stylesheet, not a font, not a logo, not a script.
 *
 * The page has to open from a USB stick on a school laptop with no internet, in 2031,
 * and show exactly what it showed on the day it was made. Anything fetched at view time
 * is a thing that can be missing, blocked, or watching. The test enforces this: no
 * `src`, no `href`, no `url(`, no `@import`, nothing with a scheme.
 */
const STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0 auto; padding: 2rem 1rem; max-width: 60rem;
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #16181d; background: #fbfbfa;
  }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.15rem; margin: 2.5rem 0 .75rem; }
  .meta { color: #5c6270; margin: 0 0 .15rem; font-size: .9rem; word-break: break-all; }
  .lead { font-size: 1.05rem; margin: .5rem 0 1.25rem; }
  .flag { border-left: 4px solid #b3261e; padding: .1rem 0 .1rem 1rem; margin: 0 0 1.25rem; }
  .ok { border-left: 4px solid #1e7b41; padding: .1rem 0 .1rem 1rem; margin: 0 0 1.25rem; }
  .name { font-weight: 600; word-break: break-all; }
  .why { margin: .2rem 0 0; }
  .loss { margin: .2rem 0 0; color: #45301c; }
  .wrote { margin: .2rem 0 0; color: #5c6270; font-size: .92rem; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; font-size: .93rem; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #e2e2df; vertical-align: top; }
  th { font-weight: 600; white-space: nowrap; }
  td.file { word-break: break-all; }
  tr.attention td { background: #fdf3f2; }
  footer { margin-top: 3rem; color: #5c6270; font-size: .85rem; }
  @media (prefers-color-scheme: dark) {
    body { color: #e7e7e4; background: #16181d; }
    .meta, .wrote, footer { color: #a2a7b3; }
    .loss { color: #e8c9a0; }
    th, td { border-bottom-color: #2e323b; }
    tr.attention td { background: #2a1d1c; }
  }
  @media print {
    body { max-width: none; padding: 0; color: #000; background: #fff; }
    .flag, .ok { border-left-color: #000; }
    tr.attention td { background: transparent; }
  }
`;

function htmlFlagged(result: FileResult): string {
  const parts = [`<p class="name">${escapeHtml(result.source)}</p>`];
  if (result.message !== undefined && result.message !== '') {
    parts.push(`<p class="why">${escapeHtml(result.message)}</p>`);
  } else {
    parts.push(`<p class="why">${escapeHtml(OUTCOME_WORDS[result.outcome])}</p>`);
  }
  for (const loss of lossSentences(result)) {
    parts.push(`<p class="loss">${escapeHtml(loss)}</p>`);
  }
  const wrote = result.outputs.map((o) => o.path).filter((p) => p !== '');
  if (wrote.length > 0) {
    parts.push(`<p class="wrote">Written: ${escapeHtml(wrote.join('; '))}</p>`);
  }
  return `<div class="flag">${parts.join('')}</div>`;
}

function htmlRow(result: FileResult): string {
  const cells = [
    escapeHtml(result.source),
    escapeHtml(OUTCOME_WORDS[result.outcome]),
    String(result.pages),
    escapeHtml(result.outputs.map((o) => o.path).filter((p) => p !== '').join('; ')),
    escapeHtml(lossSentences(result).join(' ')),
  ];
  const cls = needsAttention(result) ? ' class="attention"' : '';
  return `<tr${cls}><td class="file">${cells[0]}</td><td>${cells[1]}</td>` +
    `<td>${cells[2]}</td><td class="file">${cells[3]}</td><td>${cells[4]}</td></tr>`;
}

/**
 * The whole run as one file somebody can email to the person who asked for it.
 *
 * Same order as everything else: what needs a human, then everything.
 */
export function renderHtml(
  results: readonly FileResult[],
  context: ReportContext = {},
): string {
  const summary = summariseResults(results);
  const sorted = sortForReport(results);
  const flagged = sorted.filter(needsAttention);

  const head: string[] = [];
  if (context.root !== undefined) {
    head.push(`<p class="meta">Folder: ${escapeHtml(context.root)}</p>`);
  }
  if (context.out !== undefined) {
    head.push(`<p class="meta">Converted files: ${escapeHtml(context.out)}</p>`);
  }
  if (context.when !== undefined) {
    head.push(`<p class="meta">Run: ${escapeHtml(context.when)}</p>`);
  }

  const body: string[] = [];
  body.push('<h1>Pubshift conversion report</h1>');
  body.push(head.join(''));

  if (summary.total === 0) {
    body.push('<p class="lead">No .pub files were found.</p>');
  } else if (flagged.length === 0) {
    body.push(
      `<div class="ok"><p class="lead">Nothing needs a human. All ${summary.total} ` +
      `${summary.total === 1 ? 'file' : 'files'} came through cleanly.</p></div>`,
    );
  } else {
    body.push('<h2>Needs a human</h2>');
    body.push(
      `<p class="lead">${flagged.length} ${flagged.length === 1 ? 'file' : 'files'} of ` +
      `${summary.total} ${flagged.length === 1 ? 'needs' : 'need'} a human look.</p>`,
    );
    for (const result of flagged) body.push(htmlFlagged(result));
  }

  if (summary.total > 0) {
    body.push('<h2>Every file</h2>');
    body.push(
      '<table><thead><tr><th>File</th><th>Outcome</th><th>Pages</th>' +
      '<th>Written</th><th>What was lost</th></tr></thead><tbody>',
    );
    for (const result of sorted) body.push(htmlRow(result));
    body.push('</tbody></table>');
  }

  body.push(
    '<footer><p>Made by pubshift' +
    (context.version === undefined ? '' : ` ${escapeHtml(context.version)}`) +
    '. Every file was read and converted on this computer; nothing was uploaded.</p></footer>',
  );

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>Pubshift conversion report</title>',
    `<style>${STYLE}</style>`,
    '</head>',
    '<body>',
    body.join('\n'),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// JSON, for the person who is scripting this
// ---------------------------------------------------------------------------

export function renderJson(
  results: readonly FileResult[],
  context: ReportContext = {},
): string {
  const summary = summariseResults(results);
  return `${JSON.stringify(
    {
      tool: 'pubshift',
      version: context.version,
      command: context.command,
      root: context.root,
      out: context.out,
      seconds: context.ms === undefined ? undefined : Number((context.ms / 1000).toFixed(2)),
      summary,
      files: sortForReport(results).map((result) => ({
        file: result.source,
        path: result.absolute,
        sizeBytes: result.sizeBytes,
        outcome: result.outcome,
        needsAttention: needsAttention(result),
        pages: result.pages,
        outputs: result.outputs,
        format: result.format,
        note: result.message,
        lost: lossSentences(result),
        warnings: result.warnings,
        seconds: result.ms === undefined ? undefined : Number((result.ms / 1000).toFixed(2)),
      })),
    },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// Writing it out
// ---------------------------------------------------------------------------

export type ReportKind = 'csv' | 'html' | 'json';

/** The report format is chosen by the extension, because that is what the user typed. */
export function reportKind(reportPath: string): ReportKind {
  const ext = path.extname(reportPath).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.json') return 'json';
  return 'csv';
}

/**
 * Checked before the run rather than after it, so that a bad `--report` path fails in
 * the first second instead of after forty minutes of conversion.
 */
export function checkReportDestination(reportPath: string): void {
  const dir = path.dirname(reportPath);
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
  } catch {
    throw new UsageError(
      `We cannot write the report to "${reportPath}".`,
      'Check that the folder exists and that you have permission to write into it.',
    );
  }
}

export function renderReport(
  kind: ReportKind,
  results: readonly FileResult[],
  context: ReportContext,
): string {
  switch (kind) {
    case 'html': return renderHtml(results, context);
    case 'json': return renderJson(results, context);
    case 'csv': return renderCsv(results);
  }
}

export function writeReport(
  reportPath: string,
  results: readonly FileResult[],
  context: ReportContext,
): void {
  const body = renderReport(reportKind(reportPath), results, context);
  try {
    writeFileSync(reportPath, body, 'utf8');
  } catch (error) {
    throw new UsageError(
      `We could not save the report to "${reportPath}" ` +
      `(${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`,
    );
  }
}
