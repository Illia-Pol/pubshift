import type { Metadata, Viewport } from 'next';
import './globals.css';

const SITE_NAME = 'Pubshift';
const TAGLINE = 'Open your Publisher files after Publisher is gone';
const DESCRIPTION =
  'Turn a Microsoft Publisher .pub file into PowerPoint, Word, PDF or a design file. Nothing to install, works on Mac, Windows and Chromebook, and your file is deleted right after it is converted.';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'https://pubshift.app'),
  title: { default: `${SITE_NAME} — ${TAGLINE}`, template: `%s — ${SITE_NAME}` },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: ['Publisher', '.pub file', 'convert pub to word', 'convert pub to pdf', 'Publisher retirement'],
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    title: `${SITE_NAME} — ${TAGLINE}`,
    description: DESCRIPTION,
  },
  twitter: { card: 'summary_large_image', title: `${SITE_NAME} — ${TAGLINE}`, description: DESCRIPTION },
  robots: { index: true, follow: true },
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
          <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-4">
            <span className="text-lg font-semibold tracking-tight">{SITE_NAME}</span>
            <span className="text-sm text-muted">Publisher files, opened safely</span>
          </div>
        </header>

        <main>{children}</main>

        <footer className="mt-24 border-t border-line">
          <div className="mx-auto flex max-w-5xl flex-col gap-2 px-5 py-8 text-sm text-muted">
            <p>
              {SITE_NAME} is not connected to Microsoft. Publisher is a Microsoft product; we only read
              the files it made.
            </p>
            <p>Uploaded files are deleted as soon as your download is ready.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
