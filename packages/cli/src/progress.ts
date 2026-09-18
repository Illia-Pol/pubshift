/**
 * What the screen does during a long run.
 *
 * A forty-minute conversion of a parish archive has two audiences and they want
 * opposite things. A person watching wants to know it is still alive and roughly how
 * far along it is, on one line that does not scroll. A scheduled job wants a log that
 * still makes sense a week later, with no cursor tricks in it.
 *
 * So: a live counter only when this is attached to a terminal, and in every case a
 * permanent line for each file that needs a person — those must survive the counter
 * being overwritten, because they are the reason the run happened.
 *
 * All of it goes to stderr. stdout carries the summary, so `pubshift check ... > notes.txt`
 * gives a clean file.
 */

import { lossSentences, needsAttention } from './report';
import type { FileResult } from './types';
import { paint as makePaint, shorten, type Paint } from './ui';

const ESC = '[';
/** Erase from the cursor to the end of the line. */
const CLEAR_LINE = `${ESC}K`;

export interface ProgressOptions {
  quiet: boolean;
  verbose: boolean;
  colour: boolean;
}

export interface Writable {
  write(chunk: string): unknown;
  isTTY?: boolean;
  columns?: number;
}

/** How often to print a heartbeat when there is no terminal to redraw. */
const LOG_EVERY = 25;

export class Progress {
  readonly #stream: Writable;
  readonly #options: ProgressOptions;
  readonly #paint: Paint;
  readonly #live: boolean;

  #total = 0;
  #done = 0;
  #converted = 0;
  #attention = 0;
  #skipped = 0;
  #dirty = false;

  constructor(stream: Writable, options: ProgressOptions) {
    this.#stream = stream;
    this.#options = options;
    this.#paint = makePaint(options.colour, stream);
    this.#live = !options.quiet && !options.verbose && stream.isTTY === true;
  }

  start(total: number): void {
    this.#total = total;
    if (this.#options.quiet || total === 0) return;
    this.#stream.write(`Found ${total} Publisher ${total === 1 ? 'file' : 'files'}.\n`);
    this.#render();
  }

  /** A line that must stay on screen, printed above the live counter. */
  note(line: string): void {
    if (this.#options.quiet) return;
    this.#clear();
    this.#stream.write(`${line}\n`);
    this.#render();
  }

  tick(result: FileResult): void {
    this.#done++;
    const flagged = needsAttention(result);
    if (flagged) this.#attention++;
    else if (result.outcome === 'skipped') this.#skipped++;
    else this.#converted++;

    if (this.#options.quiet) return;

    // A file that needs a person is permanent output, at every verbosity but quiet.
    if (flagged) {
      this.#clear();
      const lost = result.message ?? lossSentences(result).join(' ');
      this.#stream.write(`${this.#paint.amber('needs a person')}  ${result.source}\n`);
      if (lost !== '') this.#stream.write(`                ${this.#paint.dim(lost)}\n`);
    } else if (this.#options.verbose) {
      const formats = [...new Set(result.outputs.map((o) => o.format))].join(', ');
      const where = formats === '' ? '' : `  -> ${formats}`;
      const word = result.outcome === 'skipped' ? 'skipped      ' : 'converted    ';
      this.#stream.write(`${word}  ${result.source}${where}\n`);
    } else if (!this.#live && this.#done % LOG_EVERY === 0) {
      this.#stream.write(`${this.#counter()}\n`);
    }

    this.#render();
  }

  /** Removes the live counter so the summary is not printed on top of it. */
  finish(): void {
    this.#clear();
  }

  #counter(): string {
    const parts = [`${this.#done}/${this.#total}`, `${this.#converted} converted`];
    if (this.#attention > 0) parts.push(`${this.#attention} need a person`);
    if (this.#skipped > 0) parts.push(`${this.#skipped} skipped`);
    return parts.join('   ');
  }

  #render(): void {
    if (!this.#live || this.#total === 0) return;
    const width = this.#stream.columns ?? 80;
    this.#stream.write(`\r${CLEAR_LINE}${shorten(this.#counter(), Math.max(10, width - 1))}`);
    this.#dirty = true;
  }

  #clear(): void {
    if (!this.#dirty) return;
    this.#stream.write(`\r${CLEAR_LINE}`);
    this.#dirty = false;
  }
}
