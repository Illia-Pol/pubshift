/**
 * The vocabulary every other module in this package shares.
 *
 * One rule governs the whole shape of this file: a result is a *small, serialisable
 * record*. It holds path strings, counts and warnings, never file bytes and never a
 * `Doc`. The run loop keeps one per source file for the final report, so a folder of
 * four hundred bulletins holds four hundred of these — and that has to stay cheap
 * whether the bulletins are 20 KB or 20 MB.
 *
 * The one thing deliberately *not* flattened here is the warning list. The plain-English
 * sentence for a loss lives in exactly one place (`report.ts`, matching the wording the
 * website uses), so a result carries the codes and lets the report do the talking. Turning
 * a warning into prose early is how the CLI and the site end up describing the same loss
 * in two different ways.
 */

import type { Warning } from '@pubshift/core';

/** The formats an emitter in @pubshift/core can actually produce. */
export type Format = 'pptx' | 'docx' | 'pdf' | 'svg';

export const FORMATS: readonly Format[] = ['pptx', 'docx', 'pdf', 'svg'];

/** What the user may pass to `--to`. `auto` is resolved per file by recommendFormat(). */
export type RequestedFormat = Format | 'auto';

/** How the DOCX emitter should treat a page. See EmitDOCXOptions in @pubshift/core. */
export type DocxMode = 'layout' | 'flow';

/** What to do when the output file already exists. */
export type ConflictPolicy = 'rename' | 'skip' | 'overwrite';

/**
 * How one source file ended up, and the distinctions here are the product.
 *
 * `unreadable` is the case docs/FIDELITY.md is about: libmspub parsed the file without
 * complaining and handed back nothing. Five of the thirty-one corpus files do exactly
 * that. Nothing is written for them, ever — they are reported instead.
 *
 * `converted-with-caveats` is a file that *did* convert but lost something a person
 * should look at. It is counted with the files needing attention rather than with the
 * successes, because a parish archivist who opens only the flagged files must not miss
 * the newsletter whose clip art vanished.
 *
 * `skipped` means we deliberately did not do the work, almost always because the output
 * was already there from a previous run. Folding that into the attention list would make
 * a re-run of a finished batch report four hundred problems, which teaches the user to
 * ignore the one number that matters.
 */
export type Outcome =
  | 'converted'
  | 'converted-with-caveats'
  | 'unreadable'
  | 'failed'
  | 'skipped';

export interface OutputFile {
  /** Path as written. Absolute in a real run; empty for `check`, which writes nothing. */
  path: string;
  format: Format;
  bytes?: number;
}

/** Which format was used for this file, and — when `--to auto` chose it — why. */
export interface FormatChoice {
  format: Format;
  /** True when `--to auto` picked it rather than the user naming it. */
  automatic: boolean;
  /** One sentence for someone who has never heard of a text frame. Empty when not automatic. */
  because: string;
}

/**
 * Everything the report needs about one source file, and nothing else.
 *
 * Only `source`, `sizeBytes`, `outcome`, `outputs`, `pages` and `warnings` are required:
 * a walk problem (a folder we could not open, a shortcut pointing nowhere) becomes one of
 * these too, with a `message` and no outputs, so that the report has a single kind of row.
 */
export interface FileResult {
  /** Path relative to the folder the user named — the spelling a person recognises. */
  source: string;
  sizeBytes: number;
  outcome: Outcome;
  outputs: OutputFile[];
  pages: number;
  /** Fidelity losses, still as codes. `report.ts` turns them into sentences. */
  warnings: Warning[];
  /** Absolute path on this disk. Carried for the JSON report and for `--verbose`. */
  absolute?: string;
  /**
   * One sentence for a person, when something other than a fidelity loss needs saying.
   * Where it came from @pubshift/core or the reader it is *their* wording verbatim —
   * those messages are already written for a non-technical reader and paraphrasing them
   * badly is a regression.
   */
  message?: string;
  format?: FormatChoice;
  /** Wall-clock milliseconds for this file. */
  ms?: number;
  /** assess()'s own counts, for the JSON report and for --verbose. */
  elements?: number;
  textLength?: number;
  images?: number;
}

/**
 * Exit codes, defined once so `--help`, the README and the code cannot drift apart.
 * These are a documented interface: somebody's backup script branches on them.
 */
export const EXIT = {
  /** Every file converted, and none of them lost anything worth mentioning. */
  OK: 0,
  /** Some files need a human look. */
  ATTENTION: 1,
  /** Nothing convertible: no .pub files found, or not one of them produced a file. */
  NOTHING: 2,
  /** Bad arguments, or a folder we could not read or write. */
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
