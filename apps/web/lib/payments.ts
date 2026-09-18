/**
 * The configuration boundary between the free tool and the paid one.
 *
 * Read `docs/PRICING.md` before changing anything here. The short version: single-file
 * conversion in the browser is free, forever, with no account and no limit, because
 * eight free competitors exist and a paywalled converter is the ninth-best converter.
 * The only thing sold is the batch runner, which is a separate download.
 *
 * Two rules follow, and this file exists to enforce them:
 *
 *   1. **Absent keys must be a silent, complete no-op.** `paymentsConfig()` returns
 *      null and every paid surface disappears. It must never half-appear, never throw
 *      on a page the free user is looking at, and never make the free path slower.
 *
 *   2. **No secret may reach the browser.** Everything below reads `process.env`
 *      without a `NEXT_PUBLIC_` prefix and is imported only from route handlers.
 *      `paymentsAdvertised()` is the one thing the client may ask, and it answers
 *      from a public build-time flag that carries no secret.
 *
 * There is no Stripe SDK here on purpose. Checkout session creation is one form-encoded
 * POST and webhook verification is one HMAC; the SDK would add a dependency, a bundle,
 * and a Node-only runtime constraint to a project whose whole argument is that it is
 * cheap to keep alive unattended.
 */

/**
 * Hard stop if this module is ever pulled into a browser bundle. It is imported only
 * from route handlers, which are server-only by construction, but an accidental import
 * from a component would ship a file that reads `STRIPE_SECRET_KEY` to every visitor.
 *
 * The `server-only` package turns this into a *build* error rather than a runtime one
 * and is worth adding the next time dependencies are touched; it is deliberately not
 * added here because it would mean an install, and this project's whole argument is
 * that it stays cheap and boring to maintain.
 */
if (typeof window !== 'undefined') {
  throw new Error(
    'lib/payments.ts was imported into the browser. It reads server-side secrets and ' +
      'must only be imported from route handlers.',
  );
}

/* ------------------------------------------------------------------ config -- */

export interface PaymentsConfig {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  /** Absolute origin used to build the return URLs Stripe redirects to. */
  siteUrl: string;
}

function trimmed(name: string): string | null {
  const raw = process.env[name];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value === '' ? null : value;
}

/**
 * The single gate. Null means "payments are not set up", which is the default and a
 * perfectly good state to ship in: the free converter does not know or care.
 *
 * Deliberately all-or-nothing. A half-configured Stripe — a secret key but no webhook
 * secret — takes money and never fulfils it, which is worse than not selling at all.
 */
export function paymentsConfig(): PaymentsConfig | null {
  const secretKey = trimmed('STRIPE_SECRET_KEY');
  const webhookSecret = trimmed('STRIPE_WEBHOOK_SECRET');
  const priceId = trimmed('STRIPE_PRICE_ID');
  if (!secretKey || !webhookSecret || !priceId) return null;

  const siteUrl = (trimmed('NEXT_PUBLIC_SITE_URL') ?? 'https://pubshift.app').replace(/\/$/, '');
  return { secretKey, webhookSecret, priceId, siteUrl };
}

/** True when the keys are live rather than test. Used only to label the admin surface. */
export function isLiveMode(config: PaymentsConfig): boolean {
  return config.secretKey.startsWith('sk_live_') || config.secretKey.startsWith('rk_live_');
}

/* ---------------------------------------------------------------- checkout -- */

const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_API_VERSION = '2025-08-27.basil';

export interface CheckoutResult {
  ok: boolean;
  url?: string;
  /** Written for a buyer, not for a log. */
  message?: string;
}

/**
 * Creates a one-time-payment Checkout Session and returns the URL to send the buyer to.
 *
 * `mode: 'payment'` because the product is a one-time purchase. A subscription would be
 * the wrong shape twice over: the value is a file conversion that either happened or
 * did not, and the demand ends shortly after 1 October 2026, so a subscription would be
 * a stream of cancellations and refund requests arriving exactly when the product stops
 * being useful.
 */
export async function createCheckoutSession(
  config: PaymentsConfig,
  options: { idempotencyKey: string; clientReference?: string },
): Promise<CheckoutResult> {
  const body = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price]': config.priceId,
    'line_items[0][quantity]': '1',
    success_url: `${config.siteUrl}/batch/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${config.siteUrl}/batch`,
    // Stripe emails the receipt and the download link; we do not run a mailing list.
    'automatic_tax[enabled]': 'true',
    // A real address is needed for VAT/sales-tax on a digital good sold internationally.
    'billing_address_collection': 'required',
  });
  if (options.clientReference) body.set('client_reference_id', options.clientReference);

  let response: Response;
  try {
    response = await fetch(`${STRIPE_API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
        // A double-clicked button must not create two charges.
        'Idempotency-Key': options.idempotencyKey,
      },
      body,
    });
  } catch {
    return { ok: false, message: 'We could not reach the payment provider. Please try again shortly.' };
  }

  if (!response.ok) {
    // Stripe's error text can name the account and the key; it belongs in the log.
    console.error('stripe: checkout session failed', response.status, await response.text().catch(() => ''));
    return { ok: false, message: 'We could not start the checkout. Please try again shortly.' };
  }

  const session = (await response.json()) as { url?: string };
  if (!session.url) {
    console.error('stripe: checkout session has no url');
    return { ok: false, message: 'We could not start the checkout. Please try again shortly.' };
  }
  return { ok: true, url: session.url };
}

/* -------------------------------------------------- webhook verification -- */

/**
 * Default replay window, matching Stripe's own recommendation. A signature older than
 * this is rejected even if the HMAC is perfect: without it, anyone who ever observes a
 * valid request body and header can replay it forever.
 */
const DEFAULT_TOLERANCE_SECONDS = 300;

export type VerifyFailure =
  | 'NO_SIGNATURE'
  | 'MALFORMED_SIGNATURE'
  | 'TIMESTAMP_OUT_OF_TOLERANCE'
  | 'SIGNATURE_MISMATCH';

export type VerifyResult<T = unknown> =
  | { ok: true; event: T }
  | { ok: false; reason: VerifyFailure };

/* ----------------------------------------------------- reading a request body -- */

/**
 * The most a request to either endpoint is allowed to be.
 *
 * Both routes used to buffer whatever arrived, entirely, before any check ran — so a
 * single unauthenticated POST of a multi-gigabyte body was an out-of-memory kill on
 * the function, from anyone who knows the URL. The webhook URL is public by
 * construction; there is nothing to guess.
 *
 * A Stripe event is a few kilobytes and the largest documented ones are well under
 * 100 KB, so 256 KB is generous by a wide margin and still small enough to be
 * harmless. The checkout endpoint takes one JSON object holding one idempotency key
 * of at most 128 characters, so 2 KB is already absurd for it.
 */
export const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;
export const MAX_CHECKOUT_BODY_BYTES = 2 * 1024;

export type BodyResult = { ok: true; text: string } | { ok: false; reason: 'TOO_LARGE' };

/**
 * Reads a request body, refusing to hold more than `limit` bytes of it.
 *
 * `Content-Length` is checked first because it is free and rejects the honest
 * oversized caller before a single byte is read. It is not trusted, though: it is
 * absent on a chunked request and a hostile caller may simply lie, so the stream is
 * also counted as it arrives and abandoned the moment it goes over. `request.text()`
 * has no such bound, which is the whole defect.
 */
export async function readBodyCapped(request: Request, limit: number): Promise<BodyResult> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: 'TOO_LARGE' };

  const body = request.body;
  if (!body) return { ok: true, text: '' };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'TOO_LARGE' };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  // The signature is over these exact bytes, so decode once and never re-encode.
  return { ok: true, text: new TextDecoder().decode(joined) };
}

/** Constant-time byte comparison. A length check may short-circuit; the contents may not. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

/**
 * Verifies a `Stripe-Signature` header against the raw request body.
 *
 * This is the part that is usually got wrong, in four specific ways, so each is handled
 * explicitly:
 *
 *   1. **The body must be the raw bytes as received.** Parsing to JSON and
 *      re-serialising changes key order and whitespace and the HMAC no longer matches —
 *      which is why `rawBody` is a string parameter and the route reads `request.text()`
 *      before it touches anything else. Never `JSON.stringify(await request.json())`.
 *   2. **The comparison must be constant-time.** A `===` on hex leaks, byte by byte,
 *      how much of a forged signature was right, which is enough to forge one.
 *   3. **The timestamp must be checked.** A valid signature is valid forever otherwise,
 *      so a captured request can be replayed to re-run fulfilment at will.
 *   4. **There can be more than one `v1=`.** During a secret rollover Stripe signs with
 *      both the old and the new secret; taking only the first one breaks the rollover.
 *
 * Returns the parsed event only after the signature is proven, never before.
 */
export type SignaturePreCheck =
  | { ok: true; timestamp: string; candidates: Uint8Array[] }
  | { ok: false; reason: VerifyFailure };

/**
 * Everything about a `Stripe-Signature` header that can be decided **without the
 * body**: that it is there, that it parses, that it carries at least one `v1=`, and
 * that its timestamp is inside the replay window.
 *
 * Split out so the route can run it first and hang up on a caller who has no
 * plausible signature at all, rather than buffering their payload and only then
 * discovering there was never anything to check it against. The HMAC itself is over
 * the whole body and genuinely cannot be computed before reading it — this is the
 * most that can honestly be done first, and it is enough to turn "read anything,
 * then decide" into "decide what we can, then read a bounded amount".
 */
export function preCheckStripeSignature(
  signatureHeader: string | null,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): SignaturePreCheck {
  if (!signatureHeader) return { ok: false, reason: 'NO_SIGNATURE' };

  let timestamp: string | null = null;
  const candidates: Uint8Array[] = [];

  for (const part of signatureHeader.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') {
      const bytes = hexToBytes(value);
      if (bytes) candidates.push(bytes);
    }
  }

  if (!timestamp || candidates.length === 0) return { ok: false, reason: 'MALFORMED_SIGNATURE' };

  const sentAt = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(sentAt)) return { ok: false, reason: 'MALFORMED_SIGNATURE' };

  // Absolute difference: a timestamp far in the future is as wrong as one far in the past.
  const skew = Math.abs(Math.floor(Date.now() / 1000) - sentAt);
  if (skew > toleranceSeconds) return { ok: false, reason: 'TIMESTAMP_OUT_OF_TOLERANCE' };

  return { ok: true, timestamp, candidates };
}

export async function verifyStripeSignature<T = unknown>(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  toleranceSeconds: number = DEFAULT_TOLERANCE_SECONDS,
): Promise<VerifyResult<T>> {
  const pre = preCheckStripeSignature(signatureHeader, toleranceSeconds);
  if (!pre.ok) return pre;
  const { timestamp, candidates } = pre;

  const expected = await hmacSha256(secret, `${timestamp}.${rawBody}`);

  // Check every candidate, and do not stop early on a match: bailing out on the first
  // success makes the loop's duration depend on which signature matched.
  let matched = false;
  for (const candidate of candidates) {
    if (timingSafeEqual(expected, candidate)) matched = true;
  }
  if (!matched) return { ok: false, reason: 'SIGNATURE_MISMATCH' };

  try {
    return { ok: true, event: JSON.parse(rawBody) as T };
  } catch {
    // A body that verifies but does not parse means the secret is right and the payload
    // is not JSON, which cannot happen with Stripe. Treat it as malformed, not as valid.
    return { ok: false, reason: 'MALFORMED_SIGNATURE' };
  }
}

/* -------------------------------------------------------------- the event -- */

export interface StripeEvent {
  id: string;
  type: string;
  created: number;
  data: { object: Record<string, unknown> };
}

/**
 * Stripe retries a webhook until it gets a 2xx, and it may deliver the same event more
 * than once even after success. Fulfilment must therefore be idempotent on `event.id`.
 *
 * This in-memory set is *not* that guarantee — a serverless instance is recycled and a
 * second instance shares nothing — it only suppresses the common case of a burst of
 * retries hitting one warm instance. The durable check belongs in whatever `fulfil()`
 * writes to, and it is one of the items on the owner's checklist in docs/PRICING.md.
 */
const recentlySeen = new Set<string>();
const RECENT_LIMIT = 500;

export function seenBefore(eventId: string): boolean {
  if (recentlySeen.has(eventId)) return true;
  recentlySeen.add(eventId);
  if (recentlySeen.size > RECENT_LIMIT) {
    const oldest = recentlySeen.values().next().value;
    if (oldest !== undefined) recentlySeen.delete(oldest);
  }
  return false;
}

/**
 * The fulfilment seam. Everything above this line is plumbing that is correct and
 * finished; what a purchase should *do* is a product decision that cannot be made
 * without deciding how the batch runner is delivered.
 *
 * Whatever goes here must be idempotent on `event.id` and must not block the response:
 * Stripe treats a slow webhook as a failure and retries it.
 *
 * See docs/PRICING.md, "What a human must still do".
 */
export async function fulfil(event: StripeEvent): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as { id?: string; client_reference_id?: string };
      // Intentionally only a log. Issuing a download link, a licence key or an email
      // from here without a durable store would be a payment taken and nothing sent.
      console.info('stripe: paid checkout session', session.id, '— fulfilment not wired');
      return;
    }
    case 'charge.refunded':
    case 'charge.dispute.created':
      console.info('stripe:', event.type, '— revocation not wired');
      return;
    default:
      return;
  }
}
