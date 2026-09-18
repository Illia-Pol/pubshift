/**
 * POST /api/stripe/webhook — the only endpoint that must be got exactly right.
 *
 * Everything reaching it is attacker-controlled until the signature is verified: the
 * URL is public, and a forged `checkout.session.completed` is a free copy of whatever
 * fulfilment eventually sends. So the order below is deliberate and must not be
 * rearranged:
 *
 *      header pre-check  ->  bounded raw text  ->  verify signature  ->  parse
 *                        ->  dedupe  ->  fulfil
 *
 * Reading the body as text is not a style choice. `request.json()` would consume the
 * stream and force a re-serialisation to check the HMAC, and re-serialised JSON has
 * different whitespace and key order, so the signature would never match — the usual
 * fix for which, disastrously, is to stop checking the signature.
 *
 * Reading it **with a limit** is not a style choice either. This URL is public by
 * construction and takes unauthenticated POSTs from anyone who finds it. Buffering
 * whatever arrives before anything is checked turns that into a one-request
 * out-of-memory kill. So the parts of the signature that need no body are checked
 * first, and then at most `MAX_WEBHOOK_BODY_BYTES` is read — which is still orders of
 * magnitude more than any real Stripe event.
 *
 * Like the checkout route, `.pay.ts` means this file is only a route when
 * PUBSHIFT_PAYMENTS=1. See docs/DEPLOY.md.
 */

import { NextResponse } from 'next/server';
import {
  MAX_WEBHOOK_BODY_BYTES,
  fulfil,
  paymentsConfig,
  preCheckStripeSignature,
  readBodyCapped,
  seenBefore,
  verifyStripeSignature,
  type StripeEvent,
} from '@/lib/payments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<NextResponse> {
  const config = paymentsConfig();
  if (!config) return NextResponse.json({ received: false }, { status: 503 });

  const signature = request.headers.get('stripe-signature');

  // 1. Everything that can be decided from the header alone — is there a signature,
  //    does it parse, is its timestamp inside the replay window — before reading any
  //    of the body. A caller who fails this never gets to allocate anything.
  const pre = preCheckStripeSignature(signature);
  if (!pre.ok) {
    console.warn('stripe: rejected webhook —', pre.reason);
    return NextResponse.json({ received: false }, { status: 400 });
  }

  // 2. Raw bytes, exactly as sent, and never more than the cap. Nothing may touch or
  //    re-encode the body before the HMAC is computed over it.
  const body = await readBodyCapped(request, MAX_WEBHOOK_BODY_BYTES);
  if (!body.ok) {
    console.warn('stripe: rejected webhook — body over', MAX_WEBHOOK_BODY_BYTES, 'bytes');
    // 413, not 400: the request may have been well-formed and was simply too big.
    // Stripe never sends anything near this, so this is a stranger, not a retry.
    return NextResponse.json({ received: false }, { status: 413 });
  }
  const rawBody = body.text;

  // 3. Prove it came from Stripe before believing a single field of it.
  const verified = await verifyStripeSignature<StripeEvent>(
    rawBody,
    signature,
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

  // 4. Stripe retries until it sees a 2xx and can deliver the same event twice anyway.
  //    Acknowledge a repeat without re-running fulfilment.
  if (seenBefore(event.id)) return NextResponse.json({ received: true, duplicate: true });

  // 5. Fulfil. A throw here must still return 200 only if the work is durably recorded;
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
