/**
 * `--jobs N`: converting several files at once.
 *
 * Sequential is the default and always will be. This exists because a fifteen-year
 * archive is four hundred files and a four-core laptop is idle for three of those cores
 * while one of them parses a newsletter — but every part of the design here is about
 * making the parallel path *no more dangerous* than the sequential one:
 *
 *  - Workers produce; they never choose a filename and never write. One `OutputPlanner`
 *    on the main thread decides every name, so two threads cannot both claim
 *    `Easter (2).pptx`.
 *  - A worker that dies takes one file down with it, not the run. It is replaced and the
 *    file is reported as needing a person. On a 400-file archive the one document that
 *    exhausts memory must not cost the other 399.
 *  - A reader that will not start at all is fatal and immediate, because it will fail for
 *    every remaining file and four hundred identical rows blaming the user's documents
 *    would be a lie.
 *
 * Each worker holds its own copy of the WebAssembly reader — roughly the reason `--jobs`
 * costs memory, and why args.ts caps it at eight.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { Options } from './args';
import type { Produced } from './convert';
import { EngineUnavailable } from './engine';
import type { FoundFile } from './walk';

export interface Request {
  file: FoundFile;
  options: Options;
}

export type Reply =
  | { ok: true; produced: Produced }
  | { ok: false; fatal: boolean; message: string };

export interface Pool {
  /** Never throws for anything one file did; throws only when the reader itself is dead. */
  run(file: FoundFile): Promise<Produced>;
  close(): Promise<void>;
}

/**
 * The built worker sits beside the built CLI. In a source checkout it does not exist —
 * there is nothing for Node to run — and the caller falls back to converting one file at
 * a time, which is correct, just slower.
 */
function workerEntry(): string | null {
  const url = new URL('./worker.js', import.meta.url);
  const file = fileURLToPath(url);
  return existsSync(file) ? file : null;
}

function crashed(message: string): Produced {
  return {
    status: 'failed',
    message,
    pages: 0, elements: 0, textLength: 0, images: 0,
    warnings: [], parts: [], ms: 0,
  };
}

/**
 * How long one file may go without a reply before we give up on it.
 *
 * Not a comfort measure: a malformed `.pub` can put libmspub into a loop inside
 * WebAssembly, and a CPU-bound loop in a single JavaScript thread cannot be interrupted
 * by any timer. Terminating the worker is the only way out, which is why conversion runs
 * in a worker even for `--jobs 1`.
 *
 * Chosen against measurement, not taste: the whole 31-file corpus converts in ~0.45 s,
 * and the slowest single publication in it takes 28 ms to parse and well under a second
 * end to end. Two minutes is over two orders of magnitude of headroom for one file, so it
 * cannot fire on a legitimately slow one, while still ending a stuck run inside the time
 * someone will sit and watch it. `--file-timeout 0` disables it for anyone who would
 * rather wait than lose a file.
 */
export const DEFAULT_FILE_TIMEOUT_MS = 120_000;

const TIMEOUT_MESSAGE =
  'This file took too long to read and was stopped so the rest of the folder could ' +
  'continue. It is most likely damaged. Try it on its own, or open it in Publisher and ' +
  'save it as PDF from there.';

const CRASH_MESSAGE =
  'The converter stopped while reading this file. It may be damaged, or too large to fit ' +
  'in memory. Nothing else in this run was affected; try this one on its own, or open it ' +
  'in Publisher and save it as PDF from there.';

class Lane {
  #worker: Worker;
  readonly #entry: string;
  readonly #timeoutMs: number;
  #pending: ((reply: Reply) => void) | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(entry: string, timeoutMs: number) {
    this.#entry = entry;
    this.#timeoutMs = timeoutMs;
    this.#worker = this.#spawn();
  }

  #spawn(): Worker {
    const worker = new Worker(this.#entry);
    worker.on('message', (reply: Reply) => this.#settle(reply));
    // A worker that throws on its way up, or is killed by the OS for using too much
    // memory, arrives here rather than as a reply.
    worker.on('error', () => this.#settle({ ok: false, fatal: false, message: CRASH_MESSAGE }));
    worker.on('exit', () => this.#settle({ ok: false, fatal: false, message: CRASH_MESSAGE }));
    // Deliberately *not* unref'd. A worker that does not hold the event loop open lets
    // Node decide the program is finished while the main thread is still waiting for the
    // first reply — the process exits mid-run, having converted nothing. `close()` in the
    // caller's `finally` is what ends them.
    return worker;
  }

  #settle(reply: Reply): void {
    if (this.#timer !== null) { clearTimeout(this.#timer); this.#timer = null; }
    const pending = this.#pending;
    this.#pending = null;
    pending?.(reply);
  }

  async run(request: Request): Promise<Produced> {
    const reply = await new Promise<Reply>((resolve) => {
      this.#pending = resolve;
      if (this.#timeoutMs > 0) {
        this.#timer = setTimeout(
          () => this.#settle({ ok: false, fatal: false, message: TIMEOUT_MESSAGE }),
          this.#timeoutMs,
        );
        // The timer must not be the reason Node stays alive once the work is done.
        this.#timer.unref?.();
      }
      this.#worker.postMessage(request);
    });

    if (reply.ok) return reply.produced;
    if (reply.fatal) throw new EngineUnavailable(reply.message);

    // It died mid-file. Replace it so the next file has somewhere to go.
    await this.#worker.terminate().catch(() => undefined);
    this.#worker = this.#spawn();
    return crashed(reply.message);
  }

  async close(): Promise<void> {
    await this.#worker.terminate().catch(() => undefined);
  }
}

/** Returns null when there is no worker module to run; the caller then goes sequential. */
export function openPool(jobs: number, options: Options): Pool | null {
  const entry = workerEntry();
  if (entry === null) return null;

  const timeoutMs = options.fileTimeoutMs ?? DEFAULT_FILE_TIMEOUT_MS;
  const lanes = Array.from({ length: jobs }, () => new Lane(entry, timeoutMs));
  const idle = [...lanes];
  const waiting: ((lane: Lane) => void)[] = [];

  const acquire = async (): Promise<Lane> => {
    const free = idle.pop();
    if (free !== undefined) return free;
    return new Promise<Lane>((resolve) => waiting.push(resolve));
  };
  const release = (lane: Lane): void => {
    const next = waiting.shift();
    if (next === undefined) idle.push(lane);
    else next(lane);
  };

  return {
    async run(file: FoundFile): Promise<Produced> {
      const lane = await acquire();
      try {
        return await lane.run({ file, options });
      } finally {
        release(lane);
      }
    },
    async close(): Promise<void> {
      await Promise.all(lanes.map((lane) => lane.close()));
    },
  };
}
