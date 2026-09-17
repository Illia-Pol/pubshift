/**
 * The contract between the browser and `POST /api/convert`.
 * Both sides import from here; nothing else may invent a code or a limit.
 */

export const TARGET_FORMATS = ['pptx', 'docx', 'pdf', 'svg'] as const;
export type TargetFormat = (typeof TARGET_FORMATS)[number];

export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const ACCEPTED_EXTENSION = '.pub';

/** OLE compound document signature — every real .pub file starts with these bytes. */
export const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

export type ConvertErrorCode =
  | 'NO_FILE'
  | 'TOO_MANY_FILES'
  | 'BAD_FORMAT'
  | 'BAD_EXTENSION'
  | 'FILE_TOO_LARGE'
  | 'FILE_EMPTY'
  | 'NOT_A_PUBLISHER_FILE'
  | 'NOT_WIRED_YET'
  | 'CONVERSION_FAILED'
  | 'INTERNAL';

export interface ConvertWarning {
  code: string;
  message: string;
  page?: number;
  count?: number;
}

export interface ConvertSuccess {
  ok: true;
  format: TargetFormat;
  /** Display name only — never used to build a path. */
  fileName: string;
  downloadName: string;
  sizeBytes: number;
  /** Where the finished file can be fetched, once conversion is wired in. */
  downloadUrl: string;
  /** Fidelity losses worth telling the user about, in plain language. */
  warnings: ConvertWarning[];
}

export interface ConvertFailure {
  ok: false;
  error: {
    code: ConvertErrorCode;
    /** Written to be shown to a non-technical user exactly as-is. */
    message: string;
    fileName?: string;
  };
}

export type ConvertResponse = ConvertSuccess | ConvertFailure;

/** Multipart field names, so the client and the route cannot drift apart. */
export const FIELD_FILE = 'file';
export const FIELD_FORMAT = 'format';

export function isTargetFormat(value: unknown): value is TargetFormat {
  return typeof value === 'string' && (TARGET_FORMATS as readonly string[]).includes(value);
}

/* ---- client-side queue state (never crosses the wire) ---- */

export type QueueItemStatus = 'ready' | 'uploading' | 'converting' | 'done' | 'error';

export interface QueueItem {
  id: string;
  file: File;
  status: QueueItemStatus;
  /** 0..100, upload only. */
  progress: number;
  message?: string;
  result?: ConvertSuccess;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
