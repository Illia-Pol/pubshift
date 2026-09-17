import { FAQ } from '@/lib/faq';

/**
 * Collapsed by default because there are a dozen of them and a wall of text helps
 * nobody, but built from `<details>` so it still opens with JavaScript switched off
 * and reads correctly to a screen reader and to a crawler.
 */
export default function Faq() {
  return (
    <div className="mt-6 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {FAQ.map((item) => (
        <details key={item.q} className="group">
          {/* Safari keeps its own triangle unless the webkit marker is hidden too. */}
          <summary className="flex cursor-pointer list-none items-start justify-between gap-4 p-4 text-left font-medium hover:bg-accent-soft/40 [&::-webkit-details-marker]:hidden sm:p-5">
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
