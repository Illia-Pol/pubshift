import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { RETIREMENT_DATE, SITE_NAME, SITE_URL } from '@/lib/site';
import './globals.css';

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
