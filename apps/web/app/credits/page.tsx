import type { Metadata } from 'next';
import Link from 'next/link';
import { SHIPPED_LIBRARIES, WASM_SHA256 } from '@/lib/wasm-asset';
import { SITE_NAME } from '@/lib/site';

/**
 * Credits, and the licence obligation that comes with them.
 *
 * Two different things share this page, and only one of them is manners:
 *
 *   - **Credit.** libmspub does the hard part. Every .pub file this site reads is read
 *     by code the Document Liberation Project wrote and gave away. Saying so is the
 *     least the project is owed.
 *
 *   - **Obligation.** `pubshift.wasm` contains libmspub and librevenge compiled to
 *     WebAssembly. Serving it is distribution in Executable Form, and MPL-2.0 §3.2(a)
 *     then requires that the corresponding Source Code Form be available *and* that
 *     recipients be told how to get it. A repository that happens to be public does not
 *     discharge that on its own — the telling has to reach the person who received the
 *     binary, which is whoever loaded this site. Hence this page, linked from the
 *     footer of every page, with the exact digest of the binary that was served.
 */

export const metadata: Metadata = {
  title: 'Credits and licences',
  description:
    'Pubshift is built on libmspub from the Document Liberation Project. Source code, licences and the exact build that runs in your browser.',
};

/**
 * Where the corresponding-source archive is published. Built by
 * `node tools/licence/sources.mjs offer`. Until it is uploaded and this is set, the
 * page says so plainly instead of linking somewhere that 404s — a broken source offer
 * is worse than an honest note about where to ask.
 */
const SOURCE_OFFER_URL = process.env.NEXT_PUBLIC_SOURCE_OFFER_URL ?? '';
const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL ?? '';

interface Credit {
  name: string;
  what: string;
  licence: string;
  href: string;
}

const CREDITS: Credit[] = [
  {
    name: 'libmspub',
    what:
      'Reads the Publisher file format. This is the part that makes any of this possible, and it is not ours.',
    licence: 'MPL-2.0',
    href: 'https://wiki.documentfoundation.org/DLP/Libraries/libmspub',
  },
  {
    name: 'librevenge',
    what: 'The document model libmspub reports into, and the reader for the OLE container a .pub file lives in.',
    licence: 'MPL-2.0',
    href: 'https://sourceforge.net/projects/libwpd/files/librevenge/',
  },
  {
    name: 'zlib',
    what: 'Decompresses the streams inside a .pub file.',
    licence: 'zlib licence',
    href: 'https://zlib.net/',
  },
  {
    name: 'Boost',
    what: 'Header-only utilities used by the parser.',
    licence: 'BSL-1.0',
    href: 'https://www.boost.org/',
  },
  {
    name: 'Emscripten, LLVM libc++ and musl',
    what: 'Compile the C++ parser to WebAssembly and give it a standard library inside your browser.',
    licence: 'MIT / Apache-2.0 with LLVM exception / NCSA',
    href: 'https://emscripten.org/',
  },
  {
    name: 'ICU',
    what:
      'Not linked in, but the character-encoding tables that turn old Windows codepages into readable text were dumped from ICU so the answers match rather than approximate.',
    licence: 'Unicode licence',
    href: 'https://icu.unicode.org/',
  },
];

export default function CreditsPage() {
  return (
    <div className="mx-auto max-w-4xl px-5 pt-14 sm:pt-20">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Credits and licences</h1>

      <p className="mt-5 max-w-prose text-lg text-muted">
        {SITE_NAME} did not work out how to read Microsoft Publisher files. The{' '}
        <a
          href="https://www.documentliberation.org/"
          className="underline underline-offset-2 hover:text-ink"
        >
          Document Liberation Project
        </a>{' '}
        did, over years, and published the result as free software. This page says whose work is in
        the converter, and how to get the source for the part that runs in your browser.
      </p>

      <section className="mt-12">
        <h2 className="text-2xl font-semibold tracking-tight">What is in the converter</h2>
        <ul className="mt-6 space-y-4">
          {CREDITS.map((credit) => (
            <li key={credit.name} className="card p-5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <a href={credit.href} className="font-semibold underline underline-offset-2">
                  {credit.name}
                </a>
                <span className="text-xs uppercase tracking-wide text-muted">{credit.licence}</span>
              </div>
              <p className="mt-2 text-sm text-muted">{credit.what}</p>
            </li>
          ))}
        </ul>
      </section>

      <section id="source" className="mt-14">
        <h2 className="text-2xl font-semibold tracking-tight">Getting the source</h2>

        <p className="mt-4 max-w-prose text-muted">
          The file your browser downloaded to do the conversion, <code>pubshift.wasm</code>, contains{' '}
          {SHIPPED_LIBRARIES.map((l) => `${l.name} ${l.version}`).join(' and ')}, compiled. Both are
          covered by the Mozilla Public License 2.0, which says that anyone given the compiled form
          must be able to get the source it was built from. So:
        </p>

        <ul className="mt-5 space-y-3 text-muted">
          <li className="flex gap-3">
            <span aria-hidden="true">•</span>
            <span>
              {SOURCE_OFFER_URL ? (
                <>
                  <a href={SOURCE_OFFER_URL} className="underline underline-offset-2 hover:text-ink">
                    The complete corresponding source
                  </a>{' '}
                  for this exact build — the upstream libraries at the revisions used, plus every
                  build input of ours — is a single archive, free to download.
                </>
              ) : (
                <>
                  The complete corresponding source archive for this build has not been uploaded yet.
                  Until it is, ask and it will be sent to you at no charge; the licence allows
                  charging no more than the cost of distribution, and there is no cost.
                </>
              )}
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden="true">•</span>
            <span>
              {REPO_URL ? (
                <>
                  {SITE_NAME}&rsquo;s own code is at{' '}
                  <a href={REPO_URL} className="underline underline-offset-2 hover:text-ink">
                    {REPO_URL.replace(/^https?:\/\//, '')}
                  </a>
                  , also MPL-2.0.
                </>
              ) : (
                <>{SITE_NAME}&rsquo;s own code is MPL-2.0, matching libmspub.</>
              )}
            </span>
          </li>
          <li className="flex gap-3">
            <span aria-hidden="true">•</span>
            <span>
              The licence text:{' '}
              <a href="/licences/MPL-2.0.txt" className="underline underline-offset-2 hover:text-ink">
                Mozilla Public License 2.0
              </a>
              . The full component list, with commit hashes and checksums:{' '}
              <a
                href="/licences/THIRD-PARTY-NOTICES.md"
                className="underline underline-offset-2 hover:text-ink"
              >
                third-party notices
              </a>
              .
            </span>
          </li>
        </ul>

        <p className="mt-6 max-w-prose text-sm text-muted">
          The build running on this page is{' '}
          <code className="break-all">{WASM_SHA256.slice(0, 32)}…</code> — the SHA-256 of the
          WebAssembly file, so you can tell which source matches what you were served.
        </p>
      </section>

      <section className="mt-14">
        <h2 className="text-2xl font-semibold tracking-tight">Not affiliated with Microsoft</h2>
        <p className="mt-4 max-w-prose text-muted">
          Microsoft, Publisher, PowerPoint and Word are trademarks of Microsoft Corporation.{' '}
          {SITE_NAME} is an independent tool that reads the files Publisher made. It is not endorsed
          by or connected to Microsoft, and nothing here is Microsoft code.
        </p>
      </section>

      <p className="mt-14">
        <Link href="/" className="underline underline-offset-2 hover:text-ink">
          Back to the converter
        </Link>
      </p>
    </div>
  );
}
