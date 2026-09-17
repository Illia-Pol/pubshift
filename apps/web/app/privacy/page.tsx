import type { Metadata } from 'next';
import Link from 'next/link';
import { SITE_NAME } from '@/lib/site';

export const metadata: Metadata = {
  title: 'Privacy',
  description:
    'What does and does not leave your browser when you convert a .pub file here. Your document is never uploaded: the conversion runs on your own computer.',
  alternates: { canonical: '/privacy' },
};

/**
 * Short on purpose. A privacy page is long when there is a lot to disclose; this
 * one is accurate *because* the tool does not upload anything, and padding it with
 * the usual paragraphs would hide the only fact that matters.
 *
 * Every sentence here is a statement about what the code does. If the code changes,
 * this page changes in the same commit — see `next.config.mjs`, where the
 * Content-Security-Policy makes the central claim enforceable rather than promised.
 */
export default function PrivacyPage() {
  return (
    <div className="mx-auto max-w-4xl px-5 pt-10 sm:pt-14">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Privacy</h1>

      <p className="mt-4 max-w-prose text-lg text-muted">
        The short version: your publication never leaves your computer, so there is nothing for us to
        keep, lose, sell or be asked to hand over.
      </p>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">What never leaves your browser</h2>
        <ul className="mt-3 max-w-prose list-disc space-y-1.5 pl-5 text-muted">
          <li>The .pub file you drop in, and everything inside it.</li>
          <li>Its name, its size and how many pages it has.</li>
          <li>The converted PowerPoint, Word, PDF or SVG file that comes out.</li>
          <li>The list of things that could not be converted.</li>
        </ul>
        <p className="mt-3 max-w-prose text-muted">
          None of that is uploaded, copied to a server, queued, cached or logged anywhere but on your
          own machine. The Publisher reader is a program compiled to run inside the browser tab; it
          opens the file where the file already is. There is no conversion server in this product —
          not one that deletes your file promptly, not one at all.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">What does leave your browser</h2>
        <p className="mt-3 max-w-prose text-muted">
          One thing, and it is the same thing that happens on every website you have ever opened: to
          show you this page, your browser asks our web host for it, and for the files it is made of —
          the text, the styling, and the 465 KB Publisher reader itself. That request carries your IP
          address and which browser you are using, the way every web request does. We do not add
          anything to it, we do not use it to recognise you, and it happens whether or not you go on
          to convert a file.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">Things this site does not have</h2>
        <ul className="mt-3 max-w-prose list-disc space-y-1.5 pl-5 text-muted">
          <li>No accounts, no sign-in, no email address to hand over.</li>
          <li>No analytics, no advertising and no tracking pixels.</li>
          <li>No third-party scripts, fonts or embeds — nothing on this page comes from another company.</li>
          <li>No tracking cookies. If the page remembers a preference, your browser keeps it on your computer and it is not sent anywhere.</li>
          <li>
            No payment for converting files, so no card details and no billing information. If
            anything on this site is ever sold, it would be a separate purchase handled by a payment
            provider — and it would still never involve your publications, which do not leave your
            computer either way.
          </li>
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">Why you do not have to take our word for it</h2>
        <div className="mt-3 max-w-prose space-y-4 text-muted">
          <p>
            Convert a file, then disconnect from the internet and convert another. It still works,
            because nothing about it needed a network.
          </p>
          <p>
            The page also ships a Content Security Policy that tells your browser to refuse any
            connection to any other site, and to refuse to submit a form anywhere at all. Every
            current browser enforces it. That turns “we do not upload your file” from a promise about
            our conduct into a rule your own browser applies to us.
          </p>
          <p>
            Neither of those is a promise. One is a test you can run in twenty seconds, and the other
            is a rule your browser applies whether we like it or not.
          </p>
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">
          If your school, parish or charity needs this in writing
        </h2>
        <p className="mt-3 max-w-prose text-muted">
          We cannot give you legal advice, but the factual part is short, and it is usually the part a
          policy needs: no document content is transmitted to {SITE_NAME}. Conversion happens locally,
          in the browser, on the user’s own device. We do not receive, store or process the personal
          data inside your publications — member directories, donor lists, class lists, photographs —
          because those files never reach us.
        </p>
      </section>

      <section className="mt-10">
        <h2 className="text-xl font-semibold tracking-tight">If this ever changes</h2>
        <p className="mt-3 max-w-prose text-muted">
          It is the whole product, so it will not change quietly. If any feature were ever added that
          sent a document anywhere, this page would say so plainly and before the fact. A tool like
          this has exactly one asset, and it is that you can believe this page.
        </p>
        <p className="mt-4 text-sm text-muted">Last reviewed 17 September 2026.</p>
      </section>

      <p className="mt-10">
        <Link href="/#start" className="btn-quiet">
          Back to converting a file
        </Link>
      </p>
    </div>
  );
}
