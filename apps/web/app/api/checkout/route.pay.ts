/**
 * POST /api/checkout — starts a Stripe Checkout Session for the batch runner.
 *
 * The `.pay.ts` in the filename is load-bearing. `next.config.mjs` only adds
 * `pay.ts` to `pageExtensions` when `PUBSHIFT_PAYMENTS=1`, so with payments off this
 * file is not a route at all: it is not compiled, not exported, and cannot be called.
 * That is what lets the free tool ship as a pure static export with no server —
 * see docs/DEPLOY.md.
 *
 * No document ever reaches this endpoint. It carries a price ID and nothing else; the
 * conversion happens in the visitor's tab and is none of Stripe's business.
 */

import { NextResponse } from 'next/server';
import { createCheckoutSession, paymentsConfig } from '@/lib/payments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const config = paymentsConfig();
  if (!config) {
    // Reachable only if the route was built with PUBSHIFT_PAYMENTS=1 but the keys are
    // missing at runtime. Say so plainly rather than half-starting a checkout.
    return NextResponse.json(
      { ok: false, message: 'Purchasing is not available right now. The free converter is unaffected.' },
      { status: 503 },
    );
  }

  // Lets a double-clicked button, or a retry over a flaky connection, land on the same
  // session instead of creating a second one. Supplied by the client; falling back to a
  // fresh UUID means the worst case is a duplicate session, never a duplicate charge
  // (Checkout only charges once the buyer completes it).
  let idempotencyKey = crypto.randomUUID();
  try {
    const body = (await request.json()) as { idempotencyKey?: unknown };
    if (typeof body.idempotencyKey === 'string' && /^[A-Za-z0-9._-]{16,128}$/.test(body.idempotencyKey)) {
      idempotencyKey = body.idempotencyKey;
    }
  } catch {
    // No body, or not JSON. Fine — the generated key stands.
  }

  const result = await createCheckoutSession(config, { idempotencyKey });
  if (!result.ok) return NextResponse.json({ ok: false, message: result.message }, { status: 502 });

  return NextResponse.json({ ok: true, url: result.url });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: false, message: 'Use the button on the page.' }, { status: 405 });
}
