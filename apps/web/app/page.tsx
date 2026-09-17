import ConvertPanel from '@/components/ConvertPanel';

/**
 * PLACEHOLDER COPY — states the real proposition, but the wording is a stand-in
 * until the marketing pass. Keep the claims; rewrite the sentences.
 */

const STEPS = [
  {
    title: 'Drop your file in',
    body: 'Drag the .pub file straight from your desktop or a folder. Nothing to download, nothing to sign up for.',
  },
  {
    title: 'Choose what you want back',
    body: 'PowerPoint keeps the design closest. Word is best for the text. PDF is exact. We tell you what each one costs you.',
  },
  {
    title: 'Download and keep working',
    body: 'You get a file you can open and edit today, in a program you already have. Your original stays untouched.',
  },
];

const ASSURANCES = [
  { title: 'Nothing to install', body: 'It all happens in this page. No download, no add-in, no admin password.' },
  { title: 'Mac, Windows or Chromebook', body: 'Publisher never ran on a Mac. This does — any computer with a browser.' },
  { title: 'Your file is deleted', body: 'We delete your upload as soon as your download is ready. We do not keep a copy.' },
  { title: 'You keep your original', body: 'We only read the file you send. The copy on your computer is not changed.' },
];

export default function HomePage() {
  return (
    <div className="mx-auto max-w-5xl px-5">
      <section className="pt-14 sm:pt-20">
        <p className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-sm text-muted">
          Microsoft is retiring Publisher on 1 October 2026
        </p>

        <h1 className="mt-5 max-w-prose text-4xl font-semibold leading-tight tracking-tight sm:text-5xl">
          Get your Publisher files out while you still can
        </h1>

        <p className="mt-4 max-w-prose text-lg text-muted">
          Drag a .pub file in and get back a PowerPoint, Word document, PDF or design file that you can
          open and edit today. Nothing to install, works on Mac, Windows and Chromebook, and your file is
          deleted right after it is converted.
        </p>
      </section>

      <section id="start" className="card mt-10 p-5 sm:p-8">
        <ConvertPanel />
      </section>

      <section className="mt-20">
        <h2 className="text-2xl font-semibold tracking-tight">How it works</h2>
        <ol className="mt-6 grid gap-5 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="card p-5">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
                {index + 1}
              </span>
              <h3 className="mt-3 font-semibold">{step.title}</h3>
              <p className="mt-2 text-sm text-muted">{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mt-16">
        <h2 className="text-2xl font-semibold tracking-tight">What you should know before you start</h2>
        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          {ASSURANCES.map((item) => (
            <div key={item.title} className="card p-5">
              <h3 className="font-semibold">{item.title}</h3>
              <p className="mt-2 text-sm text-muted">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-16 max-w-prose">
        <h2 className="text-2xl font-semibold tracking-tight">Why the hurry</h2>
        <p className="mt-4 text-muted">
          Microsoft has said that from 1 October 2026 Publisher will no longer open, and it is asking
          people to save their files in another format before that date. Files made years ago for a
          newsletter, a bulletin or a flyer stop being openable on that day unless something else can
          read them. That is what this page is for.
        </p>
      </section>
    </div>
  );
}
