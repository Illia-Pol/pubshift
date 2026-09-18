/**
 * The spreadsheet, and the summary printed at the end.
 *
 * The summary leads with the number of files that need a person, not the number that
 * worked. That ordering is the point of the whole tool: somebody converting a parish
 * archive is not going to open four hundred PowerPoint files to check them, so the one
 * number that changes what they do next is "how many do I have to deal with myself" —
 * and docs/POSITIONING.md argues that telling them is the product.
 */

import { accessSync, constants, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Options } from './args';
import { UsageError, type Row, type Summary } from './types';
import { duration, plural, type Paint } from './ui';

const COLUMNS = [
  'File',
  'Result',
  'What to do',
  'Converted to',
  'Saved as',
  'Pages',
  'Pictures',
  'Text characters',
  'Format chosen by',
  'Notes',
  'Seconds',
  'Source file',
] as const;

const RESULT_WORDS: Record<Row['status'], string> = {
  converted: 'Converted',
  attention: 'Needs attention',
  skipped: 'Skipped',
};

/** RFC 4180: quote anything with a comma, a quote or a line break; double the quotes. */
function csvCell(value: string | number | undefined): string {
  const text = value === undefined ? '' : String(value);
  if (!/[",\r\n]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function rowCells(row: Row, options: Options): (string | number)[] {
  const formats = [...new Set(row.outputs.map((o) => o.format))].join('; ');
  const saved = row.outputs
    .filter((o) => o.path !== '')
    .map((o) => path.relative(options.out, o.path) || path.basename(o.path))
    .join('; ');

  return [
    row.relative,
    RESULT_WORDS[row.status],
    row.reason,
    formats,
    saved,
    row.pages ?? '',
    row.images ?? '',
    row.textLength ?? '',
    row.rule,
    row.notes.join(' | '),
    (row.ms / 1000).toFixed(2),
    row.source,
  ];
}

export function toCSV(rows: readonly Row[], options: Options): string {
  const lines = [COLUMNS.map(csvCell).join(',')];
  for (const row of rows) lines.push(rowCells(row, options).map(csvCell).join(','));
  // A byte-order mark, because the buyer opens this by double-clicking it, and Excel
  // on Windows reads a BOM-less UTF-8 CSV as the local code page — which turns every
  // accented parish name into mojibake in the one artefact meant to be readable.
  return `﻿${lines.join('\r\n')}\r\n`;
}

export function toJSON(rows: readonly Row[], options: Options, summary: Summary): string {
  return `${JSON.stringify({
    tool: 'pubshift',
    command: options.command,
    input: options.input,
    out: options.command === 'convert' ? options.out : undefined,
    requestedFormats: options.formats,
    summary: {
      total: summary.total,
      converted: summary.converted,
      needsAttention: summary.attention,
      skipped: summary.skipped,
      seconds: Number((summary.ms / 1000).toFixed(2)),
    },
    files: rows.map((row) => ({
      file: row.relative,
      source: row.source,
      result: row.status,
      reason: row.reason,
      outputs: row.outputs.map((o) => ({ format: o.format, path: o.path, bytes: o.bytes })),
      rule: row.rule,
      verdict: row.verdict,
      pages: row.pages,
      elements: row.elements,
      pictures: row.images,
      textCharacters: row.textLength,
      notes: row.notes,
      seconds: Number((row.ms / 1000).toFixed(2)),
    })),
  }, null, 2)}\n`;
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
      'Check the folder exists and that you have permission to write into it.',
    );
  }
}

export function writeReport(
  reportPath: string,
  rows: readonly Row[],
  options: Options,
  summary: Summary,
): void {
  const body = reportPath.toLowerCase().endsWith('.json')
    ? toJSON(rows, options, summary)
    : toCSV(rows, options);
  try {
    writeFileSync(reportPath, body, 'utf8');
  } catch (error) {
    throw new UsageError(
      `We could not save the report to "${reportPath}" (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`,
    );
  }
}

/** How many problem files to name on screen before deferring to the report. */
const MAX_LISTED = 20;

export function renderSummary(
  rows: readonly Row[],
  summary: Summary,
  options: Options,
  paint: Paint,
): string {
  const out: string[] = [];
  const checking = options.command === 'check';
  const verb = checking ? 'would convert' : 'converted';

  out.push('');
  if (summary.total === 0) {
    out.push(paint.bold('No Publisher files found.'));
    out.push(
      options.recursive
        ? `Nothing ending in .pub under "${options.input}".`
        : `Nothing ending in .pub directly in "${options.input}". Add --recursive to look in the folders inside it.`,
    );
    return `${out.join('\n')}\n`;
  }

  out.push(paint.bold(`Finished in ${duration(summary.ms)}.`));
  out.push('');

  // Attention first, always, even when it is zero.
  const attentionLine = `${summary.attention} ${plural(summary.attention, 'file needs', 'files need')} a person to look at ${plural(summary.attention, 'it', 'them')}`;
  out.push(`  ${summary.attention > 0 ? paint.red(paint.bold(attentionLine)) : paint.green(attentionLine)}`);
  out.push(`  ${summary.converted} ${plural(summary.converted, 'file')} ${verb}`);
  if (summary.skipped > 0) {
    out.push(`  ${summary.skipped} ${plural(summary.skipped, 'file')} skipped, because the converted ${plural(summary.skipped, 'file was', 'files were')} already there`);
  }

  if (!checking && !options.dryRun && summary.converted > 0) {
    out.push('');
    out.push(`  Converted files are in: ${options.out}`);
  }
  if (options.dryRun) {
    out.push('');
    out.push(paint.dim('  This was a dry run. Nothing was written.'));
  }
  if (options.reportPath !== null) {
    out.push(`  Full list: ${options.reportPath}`);
  }

  const problems = rows.filter((r) => r.status === 'attention');
  if (problems.length > 0) {
    out.push('');
    out.push(paint.bold(`${plural(problems.length, 'This file needs', 'These files need')} a person:`));
    for (const row of problems.slice(0, MAX_LISTED)) {
      out.push(`  ${paint.amber(row.relative)}`);
      out.push(`      ${row.reason}`);
    }
    if (problems.length > MAX_LISTED) {
      const rest = problems.length - MAX_LISTED;
      out.push(paint.dim(`  ...and ${rest} more.`));
      if (options.reportPath === null) {
        out.push(paint.dim('  Add --report report.csv to get the whole list as a spreadsheet.'));
      }
    }
  }

  if (options.verbose && summary.peakRssBytes > 0) {
    out.push('');
    out.push(paint.dim(`  Most memory used at any point: ${(summary.peakRssBytes / (1024 * 1024)).toFixed(0)} MB`));
  }

  return `${out.join('\n')}\n`;
}
