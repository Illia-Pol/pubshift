import { FAQ } from '@/lib/faq';

/**
 * Collapsed by default because there are a dozen of them and a wall of text helps
 * nobody, but built from `<details>` so it still opens with JavaScript switched off
 * and reads correctly to a screen reader and to a crawler.
 */
export default function Faq() {
  return (
    /*
       No `overflow-hidden` here. It was rounding the corners of the first and last
       rows, and clipping the focus ring of every question along with them — so a
       keyboard user tabbing down the FAQ saw nothing at all move. The corners are
       rounded on the end rows directly instead, which costs nothing and clips
       nothing.
    */
    <div
      className={[
        'mt-6 divide-y divide-line rounded-2xl border border-line bg-surface',
        '[&>details:first-of-type>summary]:rounded-t-2xl',
        '[&>details:last-of-type>summary]:rounded-b-2xl',
      ].join(' ')}
    >
      {FAQ.map((item) => (
        <details key={item.q} className="group">
          {/* Safari keeps its own triangle unless the webkit marker is hidden too. */}
          {/* The ring is inset so it is drawn inside the row rather than over the
              container's border, which keeps it fully visible on the first and last
              questions as well as in the middle. */}
          <summary
            className={[
              'flex cursor-pointer list-none items-start justify-between gap-4 p-4 text-left font-medium',
              'hover:bg-accent-soft/40 [&::-webkit-details-marker]:hidden sm:p-5',
              'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
            ].join(' ')}
          >
            <h3 className="text-base font-semibold">{item.q}</h3>
            <span
              aria-hidden="true"
              className="mt-0.5 shrink-0 text-muted transition-transform group-open:rotate-45"
            >
              <svg viewBox="0 0 20 20" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
                <path d="M10 4v12M4 10h12" />
              </svg>
            </span>
          </summary>
          <div className="space-y-3 px-4 pb-5 sm:px-5">
            {item.a.map((paragraph) => (
              <p key={paragraph.slice(0, 40)} className="max-w-prose text-muted">
                {paragraph}
              </p>
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}
