/**
 * The conversion worker.
 *
 * Parsing a typical file takes 0.5 ms and the biggest in the corpus takes 28 ms,
 * but the emitters are a different order of magnitude: a PDF with embedded fonts,
 * or forty bulletins in a row, is easily seconds of solid CPU. On the main thread
 * that is a frozen tab with a dead Stop button, which is precisely when someone
 * decides the page is broken and goes back to the uploader that keeps their file.
 *
 * So everything heavy lives here: the WebAssembly extractor, the document model,
 * the emitters and the zip. The page keeps the DOM and nothing else.
 *
 * The global is typed by hand rather than by pulling in the `webworker` lib,
 * which cannot be loaded alongside `dom` in the same program without the two
 * fighting over `self`.
 */

import { checkEngine, convertFile } from '@/lib/convert';
import { zipOutputs } from '@/lib/zip';
import type { WorkerRequest, WorkerResponse } from '@/lib/protocol';

const ctx = self as unknown as {
  postMessage(message: WorkerResponse): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
};

function post(message: WorkerResponse): void {
  ctx.postMessage(message);
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

ctx.addEventListener('message', (event) => {
  const request = event.data;

  // Deliberately not awaited: each request is independent, and the panel only ever
  // has one conversion in flight at a time anyway.
  void (async () => {
    switch (request.kind) {
      case 'warm': {
        const result = await checkEngine();
        post(
          result.ok
            ? { kind: 'warmed', id: request.id, ok: true }
            : {
                kind: 'warmed',
                id: request.id,
                ok: false,
                message: result.message,
                retryInline: result.retryElsewhere,
              },
        );
        return;
      }

      case 'convert': {
        try {
          const outcome = await convertFile(request.file, request.options, (stage) =>
            post({ kind: 'stage', id: request.id, stage }),
          );

          // Not a verdict on the file: this worker cannot start the extractor at
          // all. Hand the job back so the page can do it on the main thread rather
          // than tell somebody their browser is broken when it is not.
          if (outcome.kind === 'error' && outcome.retryElsewhere) {
            post({ kind: 'failed', id: request.id, message: outcome.message, retryInline: true });
            return;
          }

          post({ kind: 'converted', id: request.id, outcome });
        } catch (error) {
          // convertFile returns its failures rather than throwing, so anything
          // landing here is a bug on our side. Say that, do not blame the file.
          post({
            kind: 'failed',
            id: request.id,
            message: messageOf(error, 'Something went wrong converting this file.'),
          });
        }
        return;
      }

      case 'zip': {
        try {
          const blob = await zipOutputs(request.entries, request.comment);
          post({ kind: 'zipped', id: request.id, blob });
        } catch (error) {
          post({
            kind: 'failed',
            id: request.id,
            message: messageOf(
              error,
              'We could not put your files into one .zip. You can still download them one at a time.',
            ),
          });
        }
        return;
      }
    }
  })();
});
