/**
 * Types for the browser-side converter.
 *
 * There is deliberately no wire contract in this file. Conversion happens inside
 * the page — the WebAssembly extractor and the emitters both run on the visitor's
 * own machine — so nothing here describes a request or a response. If a type in
 * this file ever starts describing an upload, the product has changed and
 * `CLAUDE.md`'s "no file ever leaves the browser" invariant has been broken.
 */

export const TARGET_FORMATS = ['pptx', 'docx', 'pdf', 'svg'] as const;
export type TargetFormat = (typeof TARGET_FORMATS)[number];

/** Word can either keep the boxes where they are, or give up on them on purpose. */
export type DocxMode = 'layout' | 'flow';

/**
 * Not a server limit — there is no server. It is the point past which holding the
 * file, the parsed document and the output in one browser tab stops being polite
 * on a six-year-old school laptop.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export const ACCEPTED_EXTENSION = '.pub';

/** OLE compound document signature — every real .pub file starts with these bytes. */
export const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

/** A finished file, held in memory and handed to the browser's download machinery. */
export interface OutputFile {
  name: string;
  blob: Blob;
  sizeBytes: number;
}

/** Plain-language note about something the conversion could not carry across. */
export interface ConvertNote {
  code: string;
  message: string;
  page?: number;
  count?: number;
}

export type QueueItemStatus =
  /** Chosen, not converted yet. */
  | 'ready'
  /** Being read and converted, here, now. */
  | 'working'
  /** Converted; files are ready to download. */
  | 'done'
  /** We read the file and there was nothing in it, or we could not read it. */
  | 'unreadable'
  /** Something went wrong on our side rather than with the file. */
  | 'error';

export interface QueueItem {
  id: string;
  file: File;
  status: QueueItemStatus;
  /** Shown to the visitor as-is. Written for someone who is not technical. */
  message?: string;
  outputs?: OutputFile[];
  notes?: ConvertNote[];
  /**
   * A different format that the fidelity measurements say suits this document better.
   * Only set where the evidence is strong and it disagrees with the chosen format;
   * see packages/core/src/model/recommend.ts.
   */
  suggestion?: { format: TargetFormat; because: string };
  /** What the worker is doing right now, while `status` is `working`. */
  stage?: string;
  /**
   * `partial` means the file was read but held suspiciously little — a download is
   * still offered, with `message` alongside it. `assess()`'s `empty` never reaches
   * here: it becomes `unreadable`, which has no download by design.
   */
  verdict?: 'ok' | 'partial';
  /** What `assess()` counted, shown as a one-line "here is what we found". */
  stats?: { pages: number; elements: number; textLength: number; images: number };
  /**
   * Page one as an SVG object URL, rendered in an `<img>` so the document cannot
   * script the page. Revoked when the item is removed or reconverted.
   */
  preview?: { url: string; width: number; height: number; pageCount: number };
  /** The format this item was converted to, which may no longer be the selected one. */
  format?: TargetFormat;
}

export function isTargetFormat(value: unknown): value is TargetFormat {
  return typeof value === 'string' && (TARGET_FORMATS as readonly string[]).includes(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** True when the first eight bytes are the OLE signature a .pub file must start with. */
export function hasOleMagic(bytes: Uint8Array): boolean {
  if (bytes.length < OLE_MAGIC.length) return false;
  return OLE_MAGIC.every((b, i) => bytes[i] === b);
}
