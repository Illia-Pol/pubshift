/**
 * The vocabulary every other module in this package shares.
 *
 * One rule governs the whole shape of this file: a row is a *small, serialisable
 * record*. It holds path strings and counts, never file bytes and never a `Doc`.
 * The run loop keeps one row per source file for the final report, so a folder of
 * four hundred bulletins holds four hundred of these — and that has to stay cheap
 * whether the bulletins are 20 KB or 20 MB.
 */

/** The formats an emitter in @pubshift/core can actually produce. */
export type Format = 'pptx' | 'docx' | 'pdf' | 'svg';

export const FORMATS: readonly Format[] = ['pptx', 'docx', 'pdf', 'svg'];

/** What the user may pass to `--to`. `auto` is resolved per file by recommendFormat(). */
export type RequestedFormat = Format | 'auto';

/** How the DOCX emitter should treat a page. See DOCX_MODE_DESCRIPTIONS in @pubshift/core. */
export type DocxMode = 'layout' | 'flow';

/** What to do when the output file already exists. */
export type ConflictPolicy = 'rename' | 'skip' | 'overwrite';

/**
 * Three outcomes, and the distinction between the last two is the one that matters.
 *
 * `attention` means *we produced nothing and a person has to deal with this file*.
 * `skipped` means *we deliberately did not do the work*, almost always because the
 * output is already there from a previous run. Folding the second into the first
 * would make a re-run of a finished batch report four hundred problems, which would
 * teach the user to ignore the number that is supposed to be the whole point.
 */
export type RowStatus = 'converted' | 'attention' | 'skipped';

/** Why `--to auto` chose what it chose. Written into the report, per the brief. */
export type AutoRule = '' | 'auto: recommended' | 'auto: default (PPTX)';

export interface OutputRecord {
  format: Format;
  /** Absolute path actually written. */
  path: string;
  bytes: number;
}

export interface Row {
  /** Absolute path of the source file. */
  source: string;
  /** Source path relative to the folder the user named; this is what a person recognises. */
  relative: string;
  status: RowStatus;
  /**
   * One sentence for a person, empty when the conversion was clean. Where the
   * failure came from @pubshift/core or the reader, this is *their* wording
   * verbatim — those messages are already written for a non-technical reader and
   * paraphrasing them badly is a regression.
   */
  reason: string;
  outputs: OutputRecord[];
  /** Which `--to auto` rule applied. Empty when the user named formats explicitly. */
  rule: AutoRule;
  /** assess()'s verdict, when we got far enough to have one. */
  verdict?: 'ok' | 'partial' | 'empty';
  pages?: number;
  elements?: number;
  textLength?: number;
  images?: number;
  /** Fidelity losses worth telling the user about, already flattened to sentences. */
  notes: string[];
  /** Wall-clock milliseconds for this file. */
  ms: number;
}

export interface Summary {
  converted: number;
  attention: number;
  skipped: number;
  total: number;
  ms: number;
  /** Peak resident memory for the process, in bytes; 0 where the platform will not say. */
  peakRssBytes: number;
}

export function summarise(rows: readonly Row[], ms: number, peakRssBytes: number): Summary {
  let converted = 0;
  let attention = 0;
  let skipped = 0;
  for (const row of rows) {
    if (row.status === 'converted') converted++;
    else if (row.status === 'attention') attention++;
    else skipped++;
  }
  return { converted, attention, skipped, total: rows.length, ms, peakRssBytes };
}

/**
 * Exit codes, defined once so `--help`, the README and the code cannot drift apart.
 * These are a documented interface: somebody's backup script branches on them.
 */
export const EXIT = {
  /** Every file found was converted. */
  OK: 0,
  /** Some files need a human look. The rest converted. */
  ATTENTION: 1,
  /** Nothing convertible: no .pub files found, or not one of them could be converted. */
  NOTHING: 2,
  /** Bad arguments, or a folder we could not read or write. Nothing was attempted. */
  USAGE: 3,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Thrown for anything that should end the run with EXIT.USAGE and a plain sentence. */
export class UsageError extends Error {
  override readonly name = 'UsageError';
  /** An extra line of advice, printed under the error. */
  readonly hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}
