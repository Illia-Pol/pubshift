import type { Metadata } from 'next';
import Link from 'next/link';

import InterestForm from '@/components/InterestForm';
import { INTEREST_EMAIL, interestCaptureAvailable } from '@/lib/interest';
import { RETIREMENT_DATE, SITE_NAME } from '@/lib/site';

/**
 * `/batch` — and it exists in every build, which is the point of this file.
 *
 * It used to exist only when PUBSHIFT_PAYMENTS=1. Since there is no payment rail today
 * (docs/business/rails.md), that meant the page was never built, and somebody arriving
 * with a shared drive of four hundred Publisher files — the exact person the paid tool is
 * for — saw no sign that a batch tool existed at all. Every one of them was lost silently.
 *
 * So the page is unconditional and the checkout is the conditional part. With payments off
 * it does the two things that are worth more right now than the sale:
 *   - hands over the finished batch runner, free, so the archive actually gets converted;
 *   - offers to tell them when it can be bought, which measures batch-intent — the
 *     assumption the whole commercial case is most sensitive to and the one nobody has
 *     measured (docs/business/metrics.md).
 *
 * `page.pay.tsx` still holds the priced version and wins when payments are on.
 */

export const metadata: Metadata = {
  title: 'Convert a whole folder of Publisher files at once',
  description:
    'A free command-line tool for Windows, macOS and Linux that converts an entire folder of .pub files in one pass and tells you which ones need a person. Nothing is uploaded.',
};

const INCLUDED = [
  {
    title: 'Point it at a folder',
    body: 'It walks the folder and everything nested inside it, converts every .pub file it finds, and rebuilds the same folder structure on the way out. One pass, unattended.',
  },
  {
    title: 'Windows, macOS and Linux',
    body: 'The same engine as this website. Publisher never ran on a Mac, so if your archive has outlived the computer that made it, this still opens it.',
  },
  {
    title: 'A list of what needs a person',
    body: 'A spreadsheet or a page you can send on, naming every file, what came out, and what was lost — so a folder of four hundred becomes a list of the nine that matter.',
  },
  {
    title: 'Nothing is uploaded, again',
    body: 'It has no network access at all. Same argument as the website, same reason: your member lists and class lists are nobody else’s business.',
  },
];

export default function BatchPage() {
  const captureOn = interestCaptureAvailable();

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
        drive with fifteen years of parish bulletins on it, dragging them in one at a time is the
        wrong tool — this is the right one.
      </p>

      <section className="card mt-10 p-5 sm:p-8">
        <div className="flex flex-wrap items-baseline gap-x-3">
          <span className="text-3xl font-semibold tracking-tight">Free</span>
          <span className="text-muted">while we sort out how to take payment</span>
        </div>

        <p className="mt-3 max-w-prose text-sm text-muted">
          This was meant to be the paid part, and one day it will be. We cannot currently accept
          card payments, and Publisher leaves Microsoft 365 on {RETIREMENT_DATE} whether or not we
          have sorted that out — so it is free until we do. It is the finished tool, not a trial:
          no watermark, no file limit, no expiry.
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="https://github.com/pubshift/pubshift"
            className="rounded-xl bg-accent px-5 py-3 font-medium text-accent-ink"
          >
            Get the batch runner
          </Link>
          <Link
            href="/"
            className="rounded-xl border border-line px-5 py-3 font-medium hover:bg-surface"
          >
            Try one file first
          </Link>
        </div>
      </section>

      {captureOn ? (
        <section className="mt-8">
          <InterestForm source="batch" />
        </section>
      ) : INTEREST_EMAIL ? (
        <section className="card mt-8 p-5">
          <p className="font-medium">Want to be told when it can be bought?</p>
          <p className="mt-2 text-sm text-muted">
            Email <a className="underline underline-offset-2" href={`mailto:${INTEREST_EMAIL}`}>{INTEREST_EMAIL}</a>{' '}
            and say roughly how many files you have. One reply, when there is something to say.
          </p>
        </section>
      ) : null}

      <section className="mt-14">
        <h2 className="text-2xl font-semibold tracking-tight">What it does</h2>
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
        <h2 className="text-2xl font-semibold tracking-tight">Try it on one file first</h2>
        <p className="mt-4 text-muted">
          Convert one of your own files on the{' '}
          <Link href="/" className="underline underline-offset-2 hover:text-ink">
            front page
          </Link>{' '}
          before you go near the folder. It is the same engine, so what you see there is what the
          batch runner will do to the rest — including the files it cannot read, which it names
          rather than quietly skipping.
        </p>
        <p className="mt-4 text-muted">
          {SITE_NAME} is open source under the MPL-2.0, so the converter outlives whatever happens to
          us. If it does not work on your files it will not work on them in bulk either, and we would
          rather you found that out in ten seconds on the front page.
        </p>
      </section>
    </div>
  );
}
