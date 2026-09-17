/**
 * Messages between the page and the conversion worker.
 *
 * Still not a wire protocol: both ends are the same tab, and `postMessage` copies
 * within the process. `File` and `Blob` survive a structured clone by reference,
 * so a 600 KB publication is handed over without being serialised, and the
 * finished .pptx comes back the same way.
 *
 * Nothing here can hold a class instance or a function — that is the constraint
 * that keeps `ConvertOutcome` plain data, which is also what makes the main-thread
 * fallback in `lib/runner.ts` a drop-in for the worker.
 */

import type { ConvertOptions, ConvertOutcome, Stage } from '@/lib/convert';

export interface ZipEntry {
  name: string;
  blob: Blob;
}

export type WorkerRequest =
  /** Start the extractor before there is anything to convert, so the first file is instant. */
  | { kind: 'warm'; id: number }
  | { kind: 'convert'; id: number; file: File; options: ConvertOptions }
  | { kind: 'zip'; id: number; entries: ZipEntry[]; comment?: string };

export type WorkerResponse =
  /** Progress for a running conversion; there may be several per request. */
  | { kind: 'stage'; id: number; stage: Stage }
  | { kind: 'converted'; id: number; outcome: ConvertOutcome }
  | {
      kind: 'warmed';
      id: number;
      ok: boolean;
      message?: string;
      /**
       * The worker could not load the extractor, but the main thread still might:
       * webpack gives us a classic worker, and a classic worker cannot always run a
       * dynamic `import()`. The runner takes this as "stand down", not as "broken".
       */
      retryInline?: boolean;
    }
  | { kind: 'zipped'; id: number; blob: Blob }
  /** The request could not be completed; `message` is safe to show as-is. */
  | { kind: 'failed'; id: number; message: string; retryInline?: boolean };
