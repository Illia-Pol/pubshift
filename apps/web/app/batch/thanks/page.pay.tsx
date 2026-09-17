import type { Metadata } from 'next';
import Link from 'next/link';

/**
 * Where Stripe returns a buyer after a successful payment.
 *
 * Deliberately says nothing about the purchase itself. The `session_id` in the URL is
 * supplied by the browser and proves nothing — treating a visit to this page as proof
 * of payment is how people end up handing the product to anyone who guesses the URL.
 * The authority on whether money moved is the webhook, which is signed.
 *
 * Delivery therefore happens out of band (Stripe's receipt email, or whatever `fulfil()`
 * is eventually wired to). This page only reassures a human that the button worked.
 */

export const metadata: Metadata = {
  title: 'Thank you',
  description: 'Your purchase went through.',
  robots: { index: false, follow: false },
};

export default function ThanksPage() {
  return (
    <div className="mx-auto max-w-4xl px-5 pt-14 sm:pt-20">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Thank you — that worked</h1>

      <p className="mt-5 max-w-prose text-lg text-muted">
        Your payment went through and Stripe has emailed you a receipt. The download link is on its
        way to the same address; if it has not arrived within a few minutes, check the spam folder
        and then write to us and we will send it directly.
      </p>

      <p className="mt-4 max-w-prose text-muted">
        In the meantime the free converter is unchanged and still open: you can keep converting
        single files on the front page while you wait.
      </p>

      <p className="mt-10">
        <Link href="/" className="underline underline-offset-2 hover:text-ink">
          Back to the converter
        </Link>
      </p>
    </div>
  );
}
