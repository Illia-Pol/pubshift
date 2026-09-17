'use client';

interface PagePreviewProps {
  /** Object URL of an SVG rendering of page one. */
  url: string;
  /** Page size in points, used for the frame's shape. */
  width: number;
  height: number;
  pageCount: number;
  fileName: string;
}

/**
 * Page one of the converted document, so somebody can see that it worked before
 * they spend a click finding out.
 *
 * The SVG is shown through an `<img>` rather than inlined. An inline `<svg>` is
 * part of the page and can run script and fetch things; an `<img>` cannot do
 * either. The document being previewed came off a stranger's disk, and the whole
 * promise of this page is that opening it is safe.
 */
export default function PagePreview({ url, width, height, pageCount, fileName }: PagePreviewProps) {
  const portrait = height >= width;

  return (
    <figure className="mt-3 flex items-start gap-3">
      <div
        className="overflow-hidden rounded-lg border border-line bg-white"
        style={{
          width: portrait ? 104 : 160,
          height: portrait ? 134 : 116,
        }}
      >
        <img
          src={url}
          alt={`Page 1 of ${fileName}, as converted`}
          className="h-full w-full object-contain"
          loading="lazy"
          decoding="async"
        />
      </div>
      <figcaption className="text-sm text-muted">
        {pageCount === 1 ? 'The only page' : `Page 1 of ${pageCount}`}, as it came out.
        <span className="mt-1 block text-xs">
          A quick look, not the finished file — open the download to see it properly.
        </span>
      </figcaption>
    </figure>
  );
}
