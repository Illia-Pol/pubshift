/**
 * One worker thread: read a file, hand back what came out of it.
 *
 * Deliberately tiny, and deliberately without a single filesystem *write*. Everything
 * this thread knows how to do is compute; the main thread decides where anything goes.
 * See pool.ts for why.
 *
 * Nothing here opens a socket either. A worker is the easiest place in a program to hide
 * something that phones home, which is exactly why this file is short enough to read in
 * one sitting.
 */

import { parentPort } from 'node:worker_threads';

import { produce, transfers } from './convert';
import { EngineUnavailable } from './engine';
import type { Reply, Request } from './pool';

const port = parentPort;

if (port !== null) {
  port.on('message', (request: Request) => {
    void (async () => {
      try {
        const produced = await produce(request.file, request.options);
        const reply: Reply = { ok: true, produced };
        port.postMessage(reply, transfers(produced));
      } catch (error) {
        // The reader failing to start is not this file's fault and will not be the next
        // file's fault either: the pool turns `fatal` into one message and stops.
        const fatal = error instanceof EngineUnavailable;
        const reply: Reply = {
          ok: false,
          fatal,
          message: error instanceof Error ? error.message : String(error),
        };
        port.postMessage(reply);
      }
    })();
  });
}
