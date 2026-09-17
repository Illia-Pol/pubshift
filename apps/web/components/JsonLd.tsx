/**
 * Structured data. Only ever describes things that are true on the page itself —
 * no ratings, no review counts, no install totals. Fabricating those is both a
 * manual-action risk and exactly the behaviour this product is positioned against.
 */
export default function JsonLd({ data }: { data: Record<string, unknown> }) {
  return (
    <script
      type="application/ld+json"
      // Escaping `<` keeps a stray "</script>" inside any string from ending the
      // block early. JSON parsers read < identically.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }}
    />
  );
}
