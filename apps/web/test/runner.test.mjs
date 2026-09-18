/**
 * Tests for the conversion runner's deadline.
 *
 * The failure this guards against is not theoretical: a worker can be killed
 * without `onerror` ever firing — an out-of-memory kill, a managed-device policy,
 * a discarded tab — and before this deadline existed the promise simply never
 * settled. The row said "Converting…" forever and every file queued behind it was
 * stuck with it, which on a batch of forty bulletins means the whole batch.
 *
 * So each way that can happen gets a test:
 *
 *   - a worker that never answers is given up on, with a message a person can read
 *   - the queue keeps moving afterwards: the next file converts normally
 *   - a worker that is still reporting progress is never given up on, however long
 *     it takes in total
 *   - a worker that answers late cannot settle a promise that already failed
 *
 * Run: node --test apps/web/test/runner.test.mjs
 * (Node strips the TypeScript types on import, as in payments.test.mjs.)
 */

import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { ConversionRunner } from '../lib/runner.ts';

/** Bigger than any budget the runner computes for the files used here. */
const WELL_PAST_ANY_DEADLINE_MS = 30 * 60 * 1000;

/**
 * A `Worker` that does exactly what we tell it to and nothing else. `script` is
 * called with each request and may answer, stay silent, or answer later.
 */
function installWorker(script) {
  const sent = [];
  class FakeWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
      this.onmessageerror = null;
      this.terminated = false;
      FakeWorker.live.push(this);
    }
    postMessage(request) {
      sent.push(request);
      script(request, (response) => {
        if (!this.terminated) this.onmessage?.({ data: response });
      });
    }
    terminate() {
      this.terminated = true;
    }
  }
  FakeWorker.live = [];
  globalThis.Worker = FakeWorker;
  return { sent, workers: FakeWorker.live };
}

/** The runner only ever reads `.size` and hands the object straight to postMessage. */
const fileOf = (name, size) => ({ name, size });

/** Let every already-resolved promise job run before asserting. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a worker that never answers is given up on rather than left pending', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => delete globalThis.Worker);

  installWorker(() => {
    /* the whole point: no answer, and no onerror either */
  });

  const runner = new ConversionRunner();
  const promise = runner.convert(fileOf('bulletin.pub', 200 * 1024), {
    format: 'pptx',
    docxMode: 'layout',
  });

  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );

  t.mock.timers.tick(59_000);
  await settle();
  assert.equal(settled, false, 'must not fire early on a file that may still be working');

  t.mock.timers.tick(WELL_PAST_ANY_DEADLINE_MS);
  const error = await promise.then(
    () => null,
    (e) => e,
  );

  assert.ok(error instanceof Error, 'the promise must reject, not hang');
  assert.match(error.message, /stopped responding/i);
  // Written for a church secretary, not for a console.
  assert.ok(!/undefined|\[object|Error:/.test(error.message));
  runner.dispose();
});

test('the batch keeps moving: the file after a hung one still converts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => delete globalThis.Worker);

  let answer = false;
  const outcome = { kind: 'done', verdict: 'ok', outputs: [], notes: [], stats: {} };
  installWorker((request, reply) => {
    if (answer) reply({ kind: 'converted', id: request.id, outcome });
  });

  const runner = new ConversionRunner();
  const first = runner.convert(fileOf('wedged.pub', 100 * 1024), {
    format: 'pptx',
    docxMode: 'layout',
  });
  first.catch(() => {});

  t.mock.timers.tick(WELL_PAST_ANY_DEADLINE_MS);
  await assert.rejects(first);

  // Exactly what the queue does next.
  answer = true;
  const second = await runner.convert(fileOf('next.pub', 100 * 1024), {
    format: 'pptx',
    docxMode: 'layout',
  });
  assert.equal(second, outcome, 'the next file must convert on a fresh worker');
  assert.equal(runner.mode, 'worker', 'one wedged file is not a reason to freeze the page');
  runner.dispose();
});

test('a slow conversion that is still reporting progress is never given up on', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => delete globalThis.Worker);

  const pending = [];
  installWorker((request, reply) => pending.push({ request, reply }));

  const runner = new ConversionRunner();
  const seen = [];
  const promise = runner.convert(
    fileOf('enormous.pub', 400 * 1024),
    { format: 'pdf', docxMode: 'layout' },
    (stage) => seen.push(stage),
  );

  const job = pending[0];
  // Far longer in total than any budget, but never silent for one budget's worth.
  for (const stage of ['reading', 'extracting', 'assembling', 'checking', 'writing']) {
    t.mock.timers.tick(50_000);
    await settle();
    job.reply({ kind: 'stage', id: job.request.id, stage });
    await settle();
  }

  const outcome = { kind: 'done', verdict: 'ok', outputs: [], notes: [], stats: {} };
  job.reply({ kind: 'converted', id: job.request.id, outcome });

  assert.equal(await promise, outcome, '250 s of visible progress must not be a timeout');
  assert.deepEqual(seen, ['reading', 'extracting', 'assembling', 'checking', 'writing']);
  runner.dispose();
});

test('a worker that answers after we gave up cannot resurrect the request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => delete globalThis.Worker);

  const pending = [];
  installWorker((request, reply) => pending.push({ request, reply }));

  const runner = new ConversionRunner();
  const promise = runner.convert(fileOf('late.pub', 100 * 1024), {
    format: 'pptx',
    docxMode: 'layout',
  });
  promise.catch(() => {});

  t.mock.timers.tick(WELL_PAST_ANY_DEADLINE_MS);
  await assert.rejects(promise);

  // The terminated worker's reply, arriving anyway.
  const job = pending[0];
  job.reply({ kind: 'converted', id: job.request.id, outcome: { kind: 'done' } });
  await settle();

  // Still rejected, and nothing threw on the way through.
  await assert.rejects(promise);
  runner.dispose();
});

test('warming has its own deadline, so the Convert button cannot wait forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => delete globalThis.Worker);

  installWorker(() => {});

  const runner = new ConversionRunner();
  const promise = runner.warm();
  promise.catch(() => {});

  t.mock.timers.tick(WELL_PAST_ANY_DEADLINE_MS);
  const error = await promise.then(
    () => null,
    (e) => e,
  );
  assert.ok(error instanceof Error);
  assert.match(error.message, /did not finish loading/i);
  runner.dispose();
});
