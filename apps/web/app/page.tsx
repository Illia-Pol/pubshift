import type { Metadata } from 'next';
import Link from 'next/link';
import Converter from '@/components/Converter';
import Faq from '@/components/Faq';
import JsonLd from '@/components/JsonLd';
import { FAQ } from '@/lib/faq';
import { FORMAT_LIST } from '@/lib/formats';
import {
  CORPUS,
  OFFICE_2019_SUPPORT_ENDED,
  RETIREMENT_DATE,
  SITE_NAME,
  SITE_URL,
  SUPPORT_END_DATE,
} from '@/lib/site';

export const metadata: Metadata = {
  alternates: { canonical: '/' },
};

/* Short, concrete, and each one is true of the page you are reading. */
const ASSURANCES = [
  'Your file is never uploaded',
  'Nothing to install',
  'Free, no sign-up',
  'Mac, Windows, Chromebook, iPad',
];

const LIMITS = [
  {
    title: 'Some Publisher files cannot be read at all',
    body: `Out of the ${CORPUS.total} real Publisher files we test against, ${CORPUS.intact} come out with their contents intact and ${CORPUS.partial} comes out only partly — its shapes converted, its text did not, and we say so on that file. ${CORPUS.empty} open without any error at all and turn out to hold nothing we can see, and ${CORPUS.notPublisher} is not a Publisher file despite its name. Which group yours falls into cannot be worked out from the file — only by trying. When nothing can be read we tell you, and you get no download rather than a blank one.`,
  },
  {
    title: 'Old clipart usually disappears',
    body: `Pictures stored in the old Windows Metafile format — which is what nearly all 1990s and 2000s Publisher clipart is — are not converted. We name the page each one was on so you can drop a replacement in by hand. In one of our test publications, ${CORPUS.wmfPictures} of its ${CORPUS.wmfPicturesOutOf} pictures were that format. Photographs, scans and anything pasted in from a modern source are unaffected.`,
  },
  {
    title: 'Text that overflowed its box becomes visible',
    body: 'If a paragraph was too long for the box it sat in, Publisher hid the overflow and showed you a little warning symbol. We draw it instead. You may find a sentence you forgot you had written; that is better than silently losing text that was really there.',
  },
  {
    title: 'Fonts travel with the computer, not the file',
    body: 'If your publication used a font that is not installed on the machine opening the converted file, that text appears in a substitute and the line lengths shift. This is true of every document format, not just this conversion, and it is the most common reason a result looks slightly off on a different computer.',
  },
];

function softwareJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    applicationCategory: 'UtilitiesApplication',
    applicationSubCategory: 'File converter',
    operatingSystem: 'Any — runs in a web browser',
    browserRequirements: 'Requires a browser with WebAssembly support',
    isAccessibleForFree: true,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    description:
      'Converts Microsoft Publisher .pub files to PowerPoint, Word, PDF or SVG inside the browser. Files are not uploaded: the conversion runs on the visitor’s own computer.',
    featureList: [
      'Converts .pub files to PowerPoint (.pptx)',
      'Converts .pub files to Word (.docx)',
      'Converts .pub files to PDF',
      'Converts .pub files to SVG, one file per page',
      'Runs entirely in the browser — files are never uploaded',
      'Reports what could not be converted, page by page',
    ],
  };
}

function faqJsonLd() {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a.join(' ') },
    })),
  };
}

export default function HomePage() {
  return (
    <div className="mx-auto max-w-4xl px-5">
      <JsonLd data={softwareJsonLd()} />
      <JsonLd data={faqJsonLd()} />

      {/* --- the tool is the page: everything above it fits on one phone screen --- */}
      <section className="pt-8 sm:pt-12">
        <p className="text-sm text-muted">
          Microsoft is retiring Publisher on {RETIREMENT_DATE}.{' '}
          <a href="#deadline" className="underline underline-offset-2 hover:text-ink">
            What that actually means
          </a>
        </p>

        <h1 className="mt-3 text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">
          Convert a Publisher file to PowerPoint, Word or PDF
        </h1>

        <p className="mt-3 max-w-prose text-lg text-muted">
          Drop your <strong className="font-semibold text-ink">.pub</strong> file below. This page
          opens it on your own computer — the file is never uploaded, and there is nothing to install
          or sign up for.
        </p>
      </section>

      <section id="start" className="card mt-6 p-4 sm:p-6" aria-label="Convert your file">
        <Converter />
      </section>

      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted">
        {ASSURANCES.map((item) => (
          <li key={item} className="flex items-center gap-1.5">
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4 text-positive" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8.5l3.5 3.5L13 5" />
            </svg>
            {item}
          </li>
        ))}
      </ul>

      {/* --- 1. the differentiator that matters to this audience --- */}
      <section id="privacy" className="mt-16 scroll-mt-8">
        <h2 className="text-2xl font-semibold tracking-tight">Your file never leaves your computer</h2>

        <div className="mt-4 max-w-prose space-y-4 text-muted">
          <p>
            Every other free .pub converter you can use in a browser works the same way: you send
            them your file, their server converts it, you download the result. This one has nowhere
            to send it. The program that reads Publisher files was compiled to run inside a web
            browser, so when you drop a file in, it is opened here, by this page, on your own
            machine. It does not cross the network, because there is no network step.
          </p>
          <p>
            That matters when your publication has people in it. A parish directory has home
            addresses and phone numbers. A giving statement has donor names and amounts. A school
            newsletter has photographs of children, and the class list has their full names next to
            them. Sending those to a free conversion website means giving a copy to a company you
            have never dealt with — at least one well-known service states plainly that it keeps your
            file for twenty-four hours.
          </p>
          <p>
            For a lot of schools and churches that is the line between a tool they are allowed to use
            and one they are not. Nothing here depends on trusting our conduct: there is no transfer
            to be careful with in the first place.
          </p>
          <p className="rounded-xl border border-line bg-surface p-4 text-ink">
            <strong className="font-semibold">You can check this yourself.</strong> Convert one file,
            then turn off your Wi-Fi and convert another. It still works, because nothing about it
            needed the internet.{' '}
            <Link href="/privacy" className="underline underline-offset-2">
              What this site does and does not collect
            </Link>
            .
          </p>
        </div>
      </section>

      {/* --- 2. format choice, PowerPoint first, with the reason --- */}
      <section id="formats" className="mt-16 scroll-mt-8">
        <h2 className="text-2xl font-semibold tracking-tight">Which format should you pick?</h2>

        <p className="mt-4 max-w-prose text-muted">
          Start with <strong className="font-semibold text-ink">PowerPoint</strong>. Publisher pages
          are boxes placed on a page, and so are PowerPoint slides — Word is a river of text, which is
          why it rearranges your layout. It feels like the wrong program until you try it, and then
          it is obviously the right one.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {FORMAT_LIST.map((format) => (
            <div key={format.id} className="card p-5">
              <h3 className="text-lg font-semibold">
                {format.name}{' '}
                <span className="text-sm font-normal text-muted">{format.extension}</span>
              </h3>
              <p className="mt-1 text-xs uppercase tracking-wide text-muted">
                Opens in {format.opensIn}
              </p>
              <p className="mt-3 text-sm">{format.keeps}</p>
              <p className="mt-2 text-sm text-muted">
                <span className="font-medium text-ink">What it costs you: </span>
                {format.costs}
              </p>
            </div>
          ))}
        </div>

        <p className="mt-5 max-w-prose text-muted">
          Microsoft’s own advice is to save your publications as PDF. That is right for an archive and
          no help at all for the bulletin you have to produce again next Sunday, which is why
          PowerPoint is the default here.
        </p>
      </section>

      {/* --- 3. the limits, in the real measured numbers --- */}
      <section id="limits" className="mt-16 scroll-mt-8">
        <h2 className="text-2xl font-semibold tracking-tight">What this cannot do</h2>

        <p className="mt-4 max-w-prose text-muted">
          Publisher’s file format was never published by Microsoft. The reader at the heart of this
          tool was worked out from the outside, by the open-source project behind LibreOffice, and it
          does not get everything. The numbers below are measured against {CORPUS.total} real
          Publisher files spanning Publisher 97 to 2010 — they are not estimates, and we would rather
          you read them before you rely on the thing.
        </p>

        <dl className="mt-6 space-y-5">
          {LIMITS.map((limit) => (
            <div key={limit.title} className="border-l-2 border-line pl-4">
              <dt className="font-semibold">{limit.title}</dt>
              <dd className="mt-1 max-w-prose text-muted">{limit.body}</dd>
            </div>
          ))}
        </dl>

        <p className="mt-6 max-w-prose text-muted">
          Everything we could not carry across is listed on screen after each conversion, with the
          page number, so you know which two files out of forty need a human eye. What we will not do
          is hand you an empty document and call it a success — if we cannot read your publication we
          say so, and tell you what still works instead.
        </p>
      </section>

      {/* --- 4. the deadline, accurately, without the scare --- */}
      <section id="deadline" className="mt-16 scroll-mt-8">
        <h2 className="text-2xl font-semibold tracking-tight">
          What actually happens on {RETIREMENT_DATE}
        </h2>

        <p className="mt-4 max-w-prose text-muted">
          It depends on how you got Publisher, and the difference is bigger than most of the warnings
          going around suggest.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="card p-5">
            <h3 className="font-semibold">If Publisher came with Microsoft 365</h3>
            <p className="mt-2 text-sm text-muted">
              This is the subscription most organisations are on. Microsoft is removing Publisher from
              it on {RETIREMENT_DATE}. After that date it will not open, and your .pub files will need
              a different program. This is the group with a real deadline.
            </p>
          </div>
          <div className="card p-5">
            <h3 className="font-semibold">If you bought Publisher outright</h3>
            <p className="mt-2 text-sm text-muted">
              A one-off purchase is not taken away from you. It stays on the computer and keeps
              opening your files. What ends is Microsoft’s support — no more updates and no more
              security fixes. For Publisher 2021, whether it came with Office LTSC 2021 or with a
              consumer Office 2021, that is {SUPPORT_END_DATE}. Publisher 2019 is not on the same
              timetable: its support ended in {OFFICE_2019_SUPPORT_ENDED}, and it still opens your
              files today.
            </p>
          </div>
        </div>

        <div className="mt-6 max-w-prose space-y-4 text-muted">
          <p>
            In neither case do your .pub files get deleted, locked or expire. They stay on your disk
            exactly as they are. What shrinks is the list of programs able to open them — and that is
            a real problem, slowly, rather than a cliff edge on a Thursday.
          </p>
          <p>
            You will see countdown clocks elsewhere, and pages telling you your files will be lost
            forever. That is not true, and we are not going to tell you it is. Convert the files you
            actually use, keep the originals, and take the afternoon you need rather than the panic
            someone is selling you.
          </p>
        </div>
      </section>

      {/* --- 5. the questions this cohort really asks --- */}
      <section id="faq" className="mt-16 scroll-mt-8">
        <h2 className="text-2xl font-semibold tracking-tight">Questions people ask</h2>
        <Faq />
      </section>

      <section id="about" className="mt-16 scroll-mt-8">
        <h2 className="text-2xl font-semibold tracking-tight">About this tool</h2>
        <p className="mt-4 max-w-prose text-muted">
          {SITE_NAME} is an independent project and is not made by, endorsed by or connected to
          Microsoft. The Publisher reader at its heart is libmspub, the open-source parser written by
          the Document Liberation Project and used by LibreOffice; {SITE_NAME} itself is licensed
          under the Mozilla Public License. The numbers quoted on this page come from running the
          converter against a corpus of real Publisher files, and they are the numbers we got, not
          the numbers we wanted.
        </p>
      </section>
    </div>
  );
}
