/**
 * POST /api/stripe/webhook — the only endpoint that must be got exactly right.
 *
 * Everything reaching it is attacker-controlled until the signature is verified: the
 * URL is public, and a forged `checkout.session.completed` is a free copy of whatever
 * fulfilment eventually sends. So the order below is deliberate and must not be
 * rearranged:
 *
 *      raw text  ->  verify signature  ->  parse  ->  dedupe  ->  fulfil
 *
 * Reading the body as text first is not a style choice. `request.json()` would consume
 * the stream and force a re-serialisation to check the HMAC, and re-serialised JSON has
 * different whitespace and key order, so the signature would never match — the usual
 * fix for which, disastrously, is to stop checking the signature.
 *
 * Like the checkout route, `.pay.ts` means this file is only a route when
 * PUBSHIFT_PAYMENTS=1. See docs/DEPLOY.md.
 */

import { NextResponse } from 'next/server';
import { fulfil, paymentsConfig, seenBefore, verifyStripeSignature, type StripeEvent } from '@/lib/payments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const config = paymentsConfig();
  if (!config) return NextResponse.json({ received: false }, { status: 503 });

  // 1. Raw bytes, exactly as sent. Nothing may touch the body before this.
  const rawBody = await request.text();

  // 2. Prove it came from Stripe before believing a single field of it.
  const verified = await verifyStripeSignature<StripeEvent>(
    rawBody,
    request.headers.get('stripe-signature'),
    config.webhookSecret,
  );

  if (!verified.ok) {
    // 400, never a retryable 5xx: a bad signature will not become good on retry, and
    // answering 500 invites Stripe to hammer the endpoint. The reason is logged but not
    // returned — telling a caller *which* check failed helps only the caller forging one.
    console.warn('stripe: rejected webhook —', verified.reason);
    return NextResponse.json({ received: false }, { status: 400 });
  }

  const event = verified.event;

  // 3. Stripe retries until it sees a 2xx and can deliver the same event twice anyway.
  //    Acknowledge a repeat without re-running fulfilment.
  if (seenBefore(event.id)) return NextResponse.json({ received: true, duplicate: true });

  // 4. Fulfil. A throw here must still return 200 only if the work is durably recorded;
  //    it is not, so a failure returns 500 and lets Stripe retry, which is the correct
  //    behaviour for a payment that has been taken but not yet acted on.
  try {
    await fulfil(event);
  } catch (error) {
    console.error('stripe: fulfilment failed for', event.id, error);
    return NextResponse.json({ received: false }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
