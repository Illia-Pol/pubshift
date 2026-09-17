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

interface Pending {
  request: WorkerRequest;
  settle: (value: unknown) => void;
  fail: (error: Error) => void;
  onStage?: (stage: Stage) => void;
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
    return this.#send<EngineStatus>((id) => ({ kind: 'warm', id }));
  }

  convert(
    file: File,
    options: ConvertOptions,
    onStage?: (stage: Stage) => void,
  ): Promise<ConvertOutcome> {
    return this.#send<ConvertOutcome>((id) => ({ kind: 'convert', id, file, options }), onStage);
  }

  zip(entries: ZipEntry[], comment?: string): Promise<Blob> {
    return this.#send<Blob>((id) => ({ kind: 'zip', id, entries, comment }));
  }

  dispose(): void {
    this.#disposed = true;
    this.#worker?.terminate();
    this.#worker = null;
    this.#pending.clear();
  }

  /* ---------------------------------------------------------------- internals */

  #send<T>(build: (id: number) => WorkerRequest, onStage?: (stage: Stage) => void): Promise<T> {
    const id = this.#nextId++;
    const request = build(id);

    return new Promise<T>((resolve, reject) => {
      const pending: Pending = {
        request,
        settle: resolve as (value: unknown) => void,
        fail: reject,
        ...(onStage ? { onStage } : {}),
      };
      this.#pending.set(id, pending);

      const worker = this.#ensureWorker();
      if (worker) worker.postMessage(request);
      else void this.#runInline(id, pending);
    });
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
        pending.onStage?.(message.stage);
        return;
      case 'warmed':
        this.#pending.delete(message.id);
        pending.settle(
          message.ok ? { ok: true } : { ok: false, message: message.message ?? 'Unavailable.' },
        );
        return;
      case 'converted':
        this.#pending.delete(message.id);
        pending.settle(message.outcome);
        return;
      case 'zipped':
        this.#pending.delete(message.id);
        pending.settle(message.blob);
        return;
      case 'failed':
        this.#pending.delete(message.id);
        pending.fail(new Error(message.message));
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
        this.#pending.delete(id);
        pending.settle(result.ok ? { ok: true } : { ok: false, message: result.message });
        return;
      }

      if (request.kind === 'convert') {
        const { convertFile } = await import('@/lib/convert');
        const outcome = await convertFile(request.file, request.options, (stage) =>
          pending.onStage?.(stage),
        );
        this.#pending.delete(id);
        pending.settle(outcome);
        return;
      }

      const { zipOutputs } = await import('@/lib/zip');
      const blob = await zipOutputs(request.entries, request.comment);
      this.#pending.delete(id);
      pending.settle(blob);
    } catch (error) {
      this.#pending.delete(id);
      pending.fail(
        error instanceof Error ? error : new Error('Something went wrong converting this file.'),
      );
    }
  }
}
