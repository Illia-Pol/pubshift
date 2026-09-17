'use client';

import { useCallback, useRef, useState } from 'react';

/**
 * Starts a Stripe Checkout Session and hands the browser over to Stripe.
 *
 * No card field is ever rendered here and no card detail passes through this origin.
 * Checkout is a redirect to Stripe's own page, which keeps card data out of the app
 * entirely — the difference between "we take payments" and "we handle card numbers",
 * and the reason the second is not worth anyone's time.
 */
export default function BuyButton({ label = 'Buy the batch runner' }: { label?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stable for the life of the component, so a double click or a retry after a dropped
  // connection reuses one Checkout Session instead of creating a second.
  const idempotencyKey = useRef<string>(crypto.randomUUID());

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey: idempotencyKey.current }),
      });
      const body = (await response.json()) as { ok: boolean; url?: string; message?: string };

      if (body.ok && body.url) {
        window.location.assign(body.url);
        return;
      }
      setError(body.message ?? 'We could not start the checkout. Please try again shortly.');
    } catch {
      setError('We could not reach the payment page. Please check your connection and try again.');
    } finally {
      // Not cleared on the success path: the redirect is in flight and re-enabling the
      // button would only invite a second click.
      setBusy(false);
    }
  }, []);

  return (
    <div className="flex flex-col gap-3">
      <button type="button" className="btn-primary self-start" onClick={start} disabled={busy}>
        {busy ? 'Opening checkout…' : label}
      </button>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <p className="text-sm text-muted">
        Payment is handled by Stripe. Your card details never touch this site.
      </p>
    </div>
  );
}
