/**
 * Tests for the Stripe webhook signature check.
 *
 * This path is the difference between "only Stripe can trigger fulfilment" and "anyone
 * who can POST can", so the four ways it is usually broken each get a test that fails
 * loudly if the protection is removed:
 *
 *   - a forged or truncated signature is rejected
 *   - an old but otherwise valid signature is rejected (replay)
 *   - a body altered after signing is rejected
 *   - a rotation header carrying two v1 signatures is accepted on either secret
 *
 * Run: node --test apps/web/test/payments.test.mjs
 * (No vitest here on purpose — apps/web has no test runner and does not need one for
 * a single dependency-free module. Node strips the TypeScript types on import.)
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CHECKOUT_BODY_BYTES,
  MAX_WEBHOOK_BODY_BYTES,
  preCheckStripeSignature,
  readBodyCapped,
  verifyStripeSignature,
} from '../lib/payments.ts';

const SECRET = 'whsec_test_2c8f1a6b4d9e3f705a1b8c6d4e2f0a9b';
const OTHER_SECRET = 'whsec_test_rotated_9b8c7d6e5f4a3b2c1d0e9f8a';

const BODY = JSON.stringify({
  id: 'evt_1PtestEventIdentifier',
  type: 'checkout.session.completed',
  created: 1_759_000_000,
  data: { object: { id: 'cs_test_abc123', client_reference_id: null } },
});

async function sign(secret, payload, timestamp) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${payload}`));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const now = () => Math.floor(Date.now() / 1000);

async function header(secret, payload, timestamp = now()) {
  return `t=${timestamp},v1=${await sign(secret, payload, timestamp)}`;
}

test('accepts a genuine signature and returns the parsed event', async () => {
  const result = await verifyStripeSignature(BODY, await header(SECRET, BODY), SECRET);
  assert.equal(result.ok, true);
  assert.equal(result.event.id, 'evt_1PtestEventIdentifier');
  assert.equal(result.event.type, 'checkout.session.completed');
});

test('rejects a missing signature header', async () => {
  const result = await verifyStripeSignature(BODY, null, SECRET);
  assert.deepEqual(result, { ok: false, reason: 'NO_SIGNATURE' });
});

test('rejects a header with no v1 component', async () => {
  const result = await verifyStripeSignature(BODY, `t=${now()},v0=deadbeef`, SECRET);
  assert.deepEqual(result, { ok: false, reason: 'MALFORMED_SIGNATURE' });
});

test('rejects a non-hex signature instead of mis-parsing it', async () => {
  const result = await verifyStripeSignature(BODY, `t=${now()},v1=zzzz`, SECRET);
  assert.deepEqual(result, { ok: false, reason: 'MALFORMED_SIGNATURE' });
});

test('rejects a signature made with the wrong secret', async () => {
  const result = await verifyStripeSignature(BODY, await header(OTHER_SECRET, BODY), SECRET);
  assert.deepEqual(result, { ok: false, reason: 'SIGNATURE_MISMATCH' });
});

test('rejects a body altered after signing', async () => {
  // The exact attack the raw-body rule exists to stop: signature valid for the original,
  // payload swapped for one naming a different session.
  const signed = await header(SECRET, BODY);
  const tampered = BODY.replace('cs_test_abc123', 'cs_test_attacker');
  const result = await verifyStripeSignature(tampered, signed, SECRET);
  assert.deepEqual(result, { ok: false, reason: 'SIGNATURE_MISMATCH' });
});

test('rejects a re-serialised body even when semantically identical', async () => {
  // Why the route must not do JSON.stringify(await request.json()): same object,
  // different bytes, and the HMAC is over bytes.
  const signed = await header(SECRET, BODY);
  const reserialised = JSON.stringify(JSON.parse(BODY), null, 2);
  const result = await verifyStripeSignature(reserialised, signed, SECRET);
  assert.deepEqual(result, { ok: false, reason: 'SIGNATURE_MISMATCH' });
});

test('rejects a valid signature that is older than the tolerance', async () => {
  const stale = now() - 3600;
  const result = await verifyStripeSignature(BODY, await header(SECRET, BODY, stale), SECRET);
  assert.deepEqual(result, { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' });
});

test('rejects a timestamp far in the future as well as far in the past', async () => {
  const ahead = now() + 3600;
  const result = await verifyStripeSignature(BODY, await header(SECRET, BODY, ahead), SECRET);
  assert.deepEqual(result, { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' });
});

test('accepts a signature at the edge of the tolerance window', async () => {
  const edge = now() - 299;
  const result = await verifyStripeSignature(BODY, await header(SECRET, BODY, edge), SECRET);
  assert.equal(result.ok, true);
});

test('accepts either signature during a secret rotation', async () => {
  // Stripe signs with both secrets while an endpoint's secret is being rolled.
  const t = now();
  const both = `t=${t},v1=${await sign(OTHER_SECRET, BODY, t)},v1=${await sign(SECRET, BODY, t)}`;

  assert.equal((await verifyStripeSignature(BODY, both, SECRET)).ok, true);
  assert.equal((await verifyStripeSignature(BODY, both, OTHER_SECRET)).ok, true);

  // ...and neither, if the endpoint is holding a third secret.
  const neither = await verifyStripeSignature(BODY, both, 'whsec_test_unrelated_secret_value');
  assert.deepEqual(neither, { ok: false, reason: 'SIGNATURE_MISMATCH' });
});

test('rejects a truncated signature rather than matching on a prefix', async () => {
  const t = now();
  const full = await sign(SECRET, BODY, t);
  const result = await verifyStripeSignature(BODY, `t=${t},v1=${full.slice(0, 32)}`, SECRET);
  assert.deepEqual(result, { ok: false, reason: 'SIGNATURE_MISMATCH' });
});

test('rejects a verified-looking body that is not JSON', async () => {
  const payload = 'not json at all';
  const result = await verifyStripeSignature(payload, await header(SECRET, payload), SECRET);
  assert.deepEqual(result, { ok: false, reason: 'MALFORMED_SIGNATURE' });
});

test('tolerates whitespace in the signature header', async () => {
  const t = now();
  const result = await verifyStripeSignature(BODY, ` t=${t} , v1=${await sign(SECRET, BODY, t)} `, SECRET);
  assert.equal(result.ok, true);
});

/* --------------------------------------------------------------------------- */
/* The body cap                                                                */
/*                                                                             */
/* Both routes used to buffer the whole request before any check ran, so one    */
/* unauthenticated POST of an enormous body was an out-of-memory kill on a      */
/* public URL. Each way that can be attempted gets a test.                      */
/* --------------------------------------------------------------------------- */

/** A Request whose body streams `chunks` and declares whatever `contentLength` says. */
function streamingRequest(chunks, contentLength) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  const headers = new Headers();
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  return new Request('https://example.test/api/stripe/webhook', {
    method: 'POST',
    body,
    headers,
    duplex: 'half',
  });
}

test('a body under the cap is returned byte for byte', async () => {
  const request = streamingRequest([BODY]);
  const result = await readBodyCapped(request, MAX_WEBHOOK_BODY_BYTES);
  assert.deepEqual(result, { ok: true, text: BODY });
});

test('a body split across chunks is rejoined in order', async () => {
  const request = streamingRequest(['{"a":1,', '"b":2}']);
  const result = await readBodyCapped(request, MAX_WEBHOOK_BODY_BYTES);
  assert.deepEqual(result, { ok: true, text: '{"a":1,"b":2}' });
});

test('an honest oversized body is refused on Content-Length, before reading', async () => {
  const request = streamingRequest(['x'], MAX_WEBHOOK_BODY_BYTES + 1);
  assert.deepEqual(await readBodyCapped(request, MAX_WEBHOOK_BODY_BYTES), {
    ok: false,
    reason: 'TOO_LARGE',
  });
  // Untouched: the refusal happened before the stream was read at all.
  assert.equal(request.bodyUsed, false);
});

test('a body that lies about its length is still refused, while it streams', async () => {
  // No Content-Length at all, which is what a chunked request looks like.
  const oversized = Array.from({ length: 8 }, () => 'z'.repeat(1024));
  const request = streamingRequest(oversized);
  assert.deepEqual(await readBodyCapped(request, 4 * 1024), { ok: false, reason: 'TOO_LARGE' });
});

test('a body exactly at the cap is allowed; one byte more is not', async () => {
  const exact = 'y'.repeat(MAX_CHECKOUT_BODY_BYTES);
  assert.deepEqual(await readBodyCapped(streamingRequest([exact]), MAX_CHECKOUT_BODY_BYTES), {
    ok: true,
    text: exact,
  });
  assert.deepEqual(
    await readBodyCapped(streamingRequest([`${exact}y`]), MAX_CHECKOUT_BODY_BYTES),
    { ok: false, reason: 'TOO_LARGE' },
  );
});

test('a request with no body at all reads as empty rather than throwing', async () => {
  const request = new Request('https://example.test/api/checkout', { method: 'POST' });
  assert.deepEqual(await readBodyCapped(request, MAX_CHECKOUT_BODY_BYTES), { ok: true, text: '' });
});

/* --------------------------------------------------------------------------- */
/* The header-only pre-check: what the route can refuse before reading anything */
/* --------------------------------------------------------------------------- */

test('the pre-check refuses a missing, garbled or stale signature with no body at all', async () => {
  assert.deepEqual(preCheckStripeSignature(null), { ok: false, reason: 'NO_SIGNATURE' });
  assert.deepEqual(preCheckStripeSignature('nonsense'), {
    ok: false,
    reason: 'MALFORMED_SIGNATURE',
  });
  assert.deepEqual(preCheckStripeSignature(`t=${now()},v0=deadbeef`), {
    ok: false,
    reason: 'MALFORMED_SIGNATURE',
  });
  assert.deepEqual(preCheckStripeSignature(`t=${now() - 4000},v1=deadbeef`), {
    ok: false,
    reason: 'TIMESTAMP_OUT_OF_TOLERANCE',
  });
});

test('the pre-check passes a well-formed fresh header, and decides nothing more', async () => {
  const t = now();
  const pre = preCheckStripeSignature(await header(SECRET, BODY, t));
  assert.equal(pre.ok, true);
  assert.equal(pre.timestamp, String(t));
  assert.equal(pre.candidates.length, 1);
  // It is not a verification: the same header passes the pre-check against any body,
  // which is exactly why the HMAC still has to run afterwards.
  assert.equal((await verifyStripeSignature('a different body', await header(SECRET, BODY, t), SECRET)).ok, false);
});
