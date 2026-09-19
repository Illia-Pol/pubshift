import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { cspMetaValue } from '@/lib/csp.mjs';
import { RETIREMENT_DATE, SITE_NAME, SITE_URL } from '@/lib/site';
import './globals.css';

/**
 * The policy, baked into every page of the static export.
 *
 * `headers()` in next.config.mjs does nothing under `output: 'export'` — Next says
 * so in a build warning — so the header copy only exists where the host is told
 * about it separately (`_headers`, `vercel.json`). On S3, nginx, GitHub Pages or a
 * folder served off a school's own intranet box, nothing tells the host anything,
 * and without this tag no policy would apply at all. A meta policy needs no server
 * configuration of any kind, which is the only way the privacy page's claim can be
 * true of every deployment rather than of two hosting providers.
 *
 * `frame-ancestors` is dropped from this copy because meta may not carry it; the
 * header copy still has it, alongside `X-Frame-Options`. Same source either way —
 * see lib/csp.mjs.
 */
const CSP = cspMetaValue({ dev: process.env.NODE_ENV === 'development' });

const TITLE = 'Convert a .pub file without Publisher';

/**
 * ~150 characters, and every clause is a claim a competitor cannot copy: in the
 * browser, never uploaded, free. Keyword stuffing loses to that in a field this
 * crowded, because the snippet is the only thing most people read.
 */
const DESCRIPTION =
  'Convert Microsoft Publisher (.pub) files to PowerPoint, Word or PDF. It runs inside your browser, so your file is never uploaded. Free, nothing to install.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: `${TITLE} — ${SITE_NAME}`, template: `%s — ${SITE_NAME}` },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  // Modest weight in ranking, but it costs nothing and these are the real queries.
  keywords: [
    'convert pub file',
    'open pub file without publisher',
    'pub to powerpoint',
    'pub to word',
    'pub to pdf',
    '.pub converter',
    'microsoft publisher ending',
    'publisher retirement 2026',
    'publisher alternative',
    'church bulletin publisher',
    'school newsletter publisher',
  ],
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: SITE_NAME,
    title: `${TITLE} — ${SITE_NAME}`,
    description: DESCRIPTION,
    locale: 'en',
  },
  twitter: { card: 'summary', title: `${TITLE} — ${SITE_NAME}`, description: DESCRIPTION },
  robots: { index: true, follow: true },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
    { media: '(prefers-color-scheme: dark)', color: '#0d121b' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        {/* React hoists this into <head> after Next's own bootstrap <script> tags —
            there is no supported way to get in front of those. It does not weaken
            anything that is claimed: those scripts are same-origin and would pass
            `script-src 'self'` regardless, and the two directives the privacy page
            rests on are checked at use rather than at parse. `connect-src` is
            evaluated on every fetch/XHR/beacon and `form-action` on every submit,
            all of which happen after the head has been parsed and the policy is in
            force. Verified present in the export: see the note in lib/csp.mjs. */}
        <meta httpEquiv="Content-Security-Policy" content={CSP} />
      </head>
      <body className="min-h-dvh">
        <a
          href="#start"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-2"
        >
          Skip to the file box
        </a>

        <header className="border-b border-line">
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-4">
            <Link href="/" className="text-lg font-semibold tracking-tight">
              {SITE_NAME}
            </Link>
            <nav aria-label="On this page" className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted">
              <Link href="/#privacy" className="hover:text-ink">
                Why nothing is uploaded
              </Link>
              <Link href="/#limits" className="hover:text-ink">
                What it cannot do
              </Link>
              <Link href="/#faq" className="hover:text-ink">
                Questions
              </Link>
              <Link href="/batch" className="hover:text-ink">
                A whole folder
              </Link>
            </nav>
          </div>
        </header>

        <main>{children}</main>

        <footer className="mt-24 border-t border-line">
          <div className="mx-auto flex max-w-4xl flex-col gap-3 px-5 py-10 text-sm text-muted">
            <p className="max-w-prose">
              <strong className="font-semibold text-ink">Nothing you convert here is sent to us.</strong>{' '}
              Your file is opened by this page on your own computer. There is no upload, no account and
              no copy on any server of ours.{' '}
              <Link href="/privacy" className="underline underline-offset-2 hover:text-ink">
                Privacy
              </Link>
            </p>
            <p className="max-w-prose">
              Microsoft, Microsoft 365, Publisher, PowerPoint and Word are trademarks of Microsoft
              Corporation. {SITE_NAME} is an independent tool and is not affiliated with, endorsed by
              or connected to Microsoft. Publisher leaves Microsoft 365 on {RETIREMENT_DATE}.
            </p>
            {/*
              Not just manners. pubshift.wasm ships libmspub and librevenge compiled in,
              which is distribution in Executable Form, and MPL-2.0 §3.2(a) requires that
              recipients be told how to obtain the source. The link is the telling, so it
              belongs on every page rather than only where someone thinks to look.
            */}
            <p className="max-w-prose">
              Publisher files are read with libmspub, the open-source parser from the Document
              Liberation Project, under the Mozilla Public License.{' '}
              <Link href="/credits" className="underline underline-offset-2 hover:text-ink">
                Credits, licences and source
              </Link>
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
