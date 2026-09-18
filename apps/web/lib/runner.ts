/**
 * The page's handle on the conversion worker.
 *
 * It owns one worker, hands it one job at a time, and — this is the part that
 * matters — degrades to running the same code on the main thread if the worker
 * cannot start. Module workers are not universal: Safari only got them in 15, and
 * some managed-device setups block worker scripts outright. A church secretary on
 * a locked-down laptop should get a converted file and a note that the page may
 * pause, not a dead button and no explanation.
 *
 * `lib/convert.ts` is written to run in either place, so the fallback is the same
 * pipeline, not a lesser one.
 */

import type { ConvertOptions, ConvertOutcome, Stage } from '@/lib/convert';
import type { WorkerRequest, WorkerResponse, ZipEntry } from '@/lib/protocol';

export type RunMode = 'worker' | 'inline';

export interface EngineStatus {
  ok: boolean;
  /** Present when `ok` is false. Written for the visitor. */
  message?: string;
}

/* ------------------------------------------------------------- how long to wait */

/**
 * A worker can die without telling anyone.
 *
 * `onerror` fires for a script that fails to load or an exception that reaches the
 * top level. It does **not** fire when the thread is killed underneath us — an
 * out-of-memory kill on a tab that is already tight for memory, a managed-device
 * policy that terminates workers, a browser tab discarded and restored. In those
 * cases the `postMessage` simply never gets an answer, and without a deadline the
 * promise never settles: the row sits on "Converting…" forever, the queue behind it
 * never moves, and the Stop button is the only way out of a batch of forty.
 *
 * ## Why these numbers
 *
 * Measured on the real pipeline (WASM extractor -> model -> emitter -> preview)
 * over the corpus, on a 2024 laptop. The largest file we have, `923566.pub` at
 * 587 KB, takes **203 ms** end to end — 37 ms to extract, 8 ms to build the model,
 * 154 ms for the heaviest emitter (PDF) and 4 ms for the preview. That is roughly
 * 0.35 ms per KB, and it is the number the budget below has to leave alone.
 *
 * `MAX_FILE_BYTES` lets a file be 50 MB, which is 85x that. Assume it scales
 * linearly, then assume the machine is a six-year-old school laptop running perhaps
 * 10x slower, and the worst legitimate 50 MB conversion is on the order of three
 * minutes. So:
 *
 *   60 s of grace  +  15 s per megabyte of input
 *
 * gives 75 s for the largest file we have actually measured — 370x what it really
 * costs — and 13.5 minutes for a 50 MB one, about 4x the pessimistic estimate. The
 * asymmetry is deliberate: firing early means telling somebody their perfectly good
 * conversion failed, which is the one thing this product cannot afford to do.
 *
 * And it is a **silence** budget, not a total one — `#arm` restarts the clock on
 * every stage message, so a conversion that is visibly making progress is never
 * interrupted no matter how long it takes in total. The deadline can only be
 * reached by a worker that has stopped saying anything at all.
 */
const GRACE_MS = 60_000;
const PER_MEGABYTE_MS = 15_000;

function budgetFor(bytes: number): number {
  return GRACE_MS + PER_MEGABYTE_MS * Math.ceil(Math.max(0, bytes) / (1024 * 1024));
}

/**
 * Warming fetches the 465 KB extractor and instantiates it. The only slow part is
 * the network, and 60 s of total silence is already generous for 465 KB on a bad
 * school connection; past that, saying so beats a button that never enables.
 */
const WARM_BUDGET_MS = GRACE_MS;

interface Pending {
  request: WorkerRequest;
  settle: (value: unknown) => void;
  fail: (error: Error) => void;
  onStage?: (stage: Stage) => void;
  /** Milliseconds of complete silence tolerated before the request is given up on. */
  budgetMs: number;
  /** Shown to the visitor as-is when that happens. */
  deadMessage: string;
  /** Cleared on every settle, failure, and sign of life. */
  timer?: ReturnType<typeof setTimeout>;
}

export class ConversionRunner {
  #worker: Worker | null = null;
  #mode: RunMode = 'worker';
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #disposed = false;

  /** Where work is actually happening. Only meaningful after the first request. */
  get mode(): RunMode {
    return this.#mode;
  }

  /** Start the extractor before anyone drops a file, and find out if it works at all. */
  warm(): Promise<EngineStatus> {
    return this.#send<EngineStatus>((id) => ({ kind: 'warm', id }), {
      budgetMs: WARM_BUDGET_MS,
      deadMessage:
        'The Publisher reader did not finish loading. Check your connection and try again — ' +
        'nothing about your file has been sent anywhere.',
    });
  }

  convert(
    file: File,
    options: ConvertOptions,
    onStage?: (stage: Stage) => void,
  ): Promise<ConvertOutcome> {
    return this.#send<ConvertOutcome>((id) => ({ kind: 'convert', id, file, options }), {
      budgetMs: budgetFor(file.size),
      deadMessage:
        'Converting this file stopped responding, so we gave up on it rather than leave you ' +
        'waiting. This is usually a browser running short of memory: closing other tabs and ' +
        'converting it on its own often works.',
      onStage,
    });
  }

  zip(entries: ZipEntry[], comment?: string): Promise<Blob> {
    const bytes = entries.reduce((total, entry) => total + entry.blob.size, 0);
    return this.#send<Blob>((id) => ({ kind: 'zip', id, entries, comment }), {
      budgetMs: budgetFor(bytes),
      deadMessage:
        'Packing your files into one .zip stopped responding. You can still save them one at a time.',
    });
  }

  dispose(): void {
    this.#disposed = true;
    this.#worker?.terminate();
    this.#worker = null;
    for (const pending of this.#pending.values()) this.#disarm(pending);
    this.#pending.clear();
  }

  /* ---------------------------------------------------------------- internals */

  #send<T>(
    build: (id: number) => WorkerRequest,
    options: { budgetMs: number; deadMessage: string; onStage?: (stage: Stage) => void },
  ): Promise<T> {
    const id = this.#nextId++;
    const request = build(id);

    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        request,
        settle: resolve as (value: unknown) => void,
        fail: reject,
        budgetMs: options.budgetMs,
        deadMessage: options.deadMessage,
        ...(options.onStage ? { onStage: options.onStage } : {}),
      };
      this.#pending.set(id, pending);
      this.#arm(id, pending);

      const worker = this.#ensureWorker();
      if (worker) worker.postMessage(request);
      else void this.#runInline(id, pending);
    });
  }

  /* -------------------------------------------------------------- the deadline */

  /**
   * (Re)start the silence clock for one request. Called when it is sent and again
   * on every sign of life, so the budget is "how long since we last heard anything"
   * rather than "how long in total" — see the note on GRACE_MS.
   */
  #arm(id: number, pending: Pending): void {
    this.#disarm(pending);
    pending.timer = setTimeout(() => this.#giveUp(id), pending.budgetMs);
  }

  #disarm(pending: Pending): void {
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }

  /**
   * Settle a request and stop its clock. The only way anything leaves `#pending`.
   * Idempotent on purpose: a worker that answers after we gave up on it, and an
   * inline job that finishes after the same, both land here and must do nothing.
   */
  #finish(id: number, pending: Pending, outcome: { value: unknown } | { error: Error }): void {
    if (this.#pending.get(id) !== pending) return;
    this.#disarm(pending);
    this.#pending.delete(id);
    if ('error' in outcome) pending.fail(outcome.error);
    else pending.settle(outcome.value);
  }

  /**
   * Nothing has been heard from this request for its whole budget. Tell the caller,
   * so the row stops saying "Converting…" and the batch moves to the next file, then
   * throw the worker away: a thread that has stopped answering will not start again,
   * and everything still owed has to be re-sent to a fresh one or it is lost with it.
   *
   * Deliberately not `#demote()`. One wedged file is not evidence that workers are
   * unavailable here, and moving the whole session to the main thread would make
   * every later conversion freeze the page while it ran.
   */
  #giveUp(id: number): void {
    const pending = this.#pending.get(id);
    if (!pending) return;

    this.#finish(id, pending, { error: new Error(pending.deadMessage) });

    if (this.#mode !== 'worker' || !this.#worker) return;
    this.#worker.terminate();
    this.#worker = null;

    // Whatever else was in flight on that worker never got an answer either.
    for (const [otherId, other] of [...this.#pending]) {
      const worker = this.#ensureWorker();
      if (worker) {
        this.#arm(otherId, other);
        worker.postMessage(other.request);
      } else {
        void this.#runInline(otherId, other);
      }
    }
  }

  #ensureWorker(): Worker | null {
    if (this.#disposed || this.#mode === 'inline') return null;
    if (this.#worker) return this.#worker;
    if (typeof Worker === 'undefined') {
      this.#mode = 'inline';
      return null;
    }

    try {
      // Written inline on purpose: webpack only recognises a worker when it sees
      // this exact `new Worker(new URL(…, import.meta.url))` shape, and bundles
      // lib/worker.ts as its own entry because of it.
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<WorkerResponse>) => this.#receive(event.data);
      // A browser without module workers does not throw here; it fails to parse the
      // script and tells us about it asynchronously. Either way, we move to plan B.
      worker.onerror = () => this.#demote();
      worker.onmessageerror = () => this.#demote();
      this.#worker = worker;
      return worker;
    } catch {
      this.#mode = 'inline';
      return null;
    }
  }

  #receive(message: WorkerResponse): void {
    const pending = this.#pending.get(message.id);
    if (!pending) return;

    // "The worker could not start the extractor, but you might." Leave the request
    // in the queue: #demote re-runs everything still owed on the main thread.
    if (
      (message.kind === 'warmed' && !message.ok && message.retryInline) ||
      (message.kind === 'failed' && message.retryInline)
    ) {
      this.#demote();
      return;
    }

    switch (message.kind) {
      case 'stage':
        // Proof of life. Reset the clock before telling the UI, so a conversion that
        // is visibly moving is never given up on however long it takes overall.
        this.#arm(message.id, pending);
        pending.onStage?.(message.stage);
        return;
      case 'warmed':
        this.#finish(message.id, pending, {
          value: message.ok
            ? { ok: true }
            : { ok: false, message: message.message ?? 'Unavailable.' },
        });
        return;
      case 'converted':
        this.#finish(message.id, pending, { value: message.outcome });
        return;
      case 'zipped':
        this.#finish(message.id, pending, { value: message.blob });
        return;
      case 'failed':
        this.#finish(message.id, pending, { error: new Error(message.message) });
        return;
    }
  }

  /** The worker died or never lived. Move everything still owed to the main thread. */
  #demote(): void {
    if (this.#mode === 'inline') return;
    this.#mode = 'inline';
    this.#worker?.terminate();
    this.#worker = null;

    for (const [id, pending] of [...this.#pending]) {
      // A fresh budget: the work is starting over somewhere else, and the time it
      // already spent failing to start in the worker is not its fault.
      this.#arm(id, pending);
      void this.#runInline(id, pending);
    }
  }

  async #runInline(id: number, pending: Pending): Promise<void> {
    // Only reached when there is no worker, so this chunk is never downloaded by
    // the browsers that do have one.
    const { request } = pending;
    try {
      if (request.kind === 'warm') {
        const { checkEngine } = await import('@/lib/convert');
        const result = await checkEngine();
        this.#finish(id, pending, {
          value: result.ok ? { ok: true } : { ok: false, message: result.message },
        });
        return;
      }

      if (request.kind === 'convert') {
        const { convertFile } = await import('@/lib/convert');
        const outcome = await convertFile(request.file, request.options, (stage) => {
          // Same clock as the worker path. It buys less here — a synchronous hang on
          // the main thread stalls the timer too — but it still catches an import or
          // a fetch that never comes back, which is the failure this path has.
          if (this.#pending.get(id) === pending) this.#arm(id, pending);
          pending.onStage?.(stage);
        });
        this.#finish(id, pending, { value: outcome });
        return;
      }

      const { zipOutputs } = await import('@/lib/zip');
      const blob = await zipOutputs(request.entries, request.comment);
      this.#finish(id, pending, { value: blob });
    } catch (error) {
      // Already given up on and reported; a late failure must not reject twice.
      if (this.#pending.get(id) !== pending) return;
      this.#finish(id, pending, {
        error:
          error instanceof Error ? error : new Error('Something went wrong converting this file.'),
      });
    }
  }
}
