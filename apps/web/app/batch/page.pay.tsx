import type { Metadata } from 'next';
import Link from 'next/link';
import BuyButton from '@/components/BuyButton';
import { SITE_NAME } from '@/lib/site';

/**
 * The only thing that is sold. See docs/PRICING.md for why it is this and not a limit
 * on the free tool.
 *
 * `page.pay.tsx`: this file is only a route when PUBSHIFT_PAYMENTS=1. In the default
 * build `/batch` does not exist, is not exported, is not linked and is not indexed —
 * the free converter is the whole site. That is the configuration boundary the paid
 * path lives behind, and it is one environment variable wide.
 */

export const metadata: Metadata = {
  title: 'Convert a whole folder at once',
  description:
    'A desktop batch runner for Windows, macOS and Linux that converts an entire folder of Publisher files in one pass. One-time purchase.',
};

/**
 * Display only. The charged amount is the Stripe Price object named by STRIPE_PRICE_ID,
 * so this string and Stripe can disagree — and if they ever do, Stripe wins and the
 * customer is right to be annoyed. Change both together.
 */
const PRICE_DISPLAY = 'US$29';

const INCLUDED = [
  {
    title: 'Point it at a folder',
    body: 'It walks the folder, including everything nested inside it, and converts every .pub file it finds. One pass, unattended.',
  },
  {
    title: 'Windows, macOS and Linux',
    body: 'The same engine as this website, built as a command-line tool. Publisher never ran on a Mac; this does.',
  },
  {
    title: 'A report of what did not convert',
    body: 'A spreadsheet listing every file, what came out, and which ones need a human look — so a folder of four hundred becomes a list of the nine that matter.',
  },
  {
    title: 'Still nothing uploaded',
    body: 'It runs on your machine and has no network access at all. The privacy story is the same one the website makes, for the same reason.',
  },
];

export default function BatchPage() {
  return (
    <div className="mx-auto max-w-4xl px-5 pt-14 sm:pt-20">
      <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-sm text-muted">
        For folders, not files
      </p>

      <h1 className="mt-5 max-w-prose text-3xl font-semibold tracking-tight sm:text-4xl">
        Convert a whole archive in one pass
      </h1>

      <p className="mt-4 max-w-prose text-lg text-muted">
        Converting one file on this website is free and always will be. If what you have is a shared
        drive with hundreds of Publisher files on it, dragging them in one at a time is the wrong
        tool, and that is what this is for.
      </p>

      <section className="card mt-10 p-5 sm:p-8">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-3xl font-semibold tracking-tight">{PRICE_DISPLAY}</span>
          <span className="text-muted">one-time, not a subscription</span>
        </div>

        <p className="mt-3 max-w-prose text-sm text-muted">
          Includes updates until 31 December 2026. We are not going to pretend this is a service you
          will still need in 2028 — Publisher leaves Microsoft 365 on 1 October 2026, and this is a
          tool for getting out before then.
        </p>

        <div className="mt-6">
          <BuyButton />
        </div>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-semibold tracking-tight">What you get</h2>
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          {INCLUDED.map((item) => (
            <div key={item.title} className="card p-5">
              <h3 className="font-semibold">{item.title}</h3>
              <p className="mt-2 text-sm text-muted">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-14 max-w-prose">
        <h2 className="text-2xl font-semibold tracking-tight">Try it free first</h2>
        <p className="mt-4 text-muted">
          Convert one of your own files on the{' '}
          <Link href="/" className="underline underline-offset-2 hover:text-ink">
            front page
          </Link>{' '}
          before you buy anything. It is the same engine, so what you see there is what the batch
          runner will do to the rest of the folder — including the files it cannot read, which it
          will tell you about rather than quietly skip.
        </p>
        <p className="mt-4 text-muted">
          If it does not work on your files, it will not work on them in bulk either, and you should
          not buy it. {SITE_NAME} refunds on request, no argument.
        </p>
      </section>
    </div>
  );
}
