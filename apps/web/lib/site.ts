/**
 * One source of truth for everything the copy repeats: the name, the dates, the
 * measured numbers. Nothing here may be invented — every figure traces to
 * `docs/FIDELITY.md`, and every date to Microsoft's own retirement notice.
 *
 * If a number changes in the docs, change it here and it changes on the page.
 */

export const SITE_NAME = 'Pubshift';

export const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL ?? 'https://pubshift.app').replace(
  /\/$/,
  '',
);

/** Publisher leaves Microsoft 365 on this date. */
export const RETIREMENT_DATE = '1 October 2026';
/** Support for the bought-outright versions ends here; the software keeps running. */
export const SUPPORT_END_DATE = '13 October 2026';

/**
 * Measured on `packages/core/test/corpus/` — 31 real Publisher files, 97 through 2010.
 * docs/FIDELITY.md: 24 real content, 1 partial, 5 empty, 1 not a Publisher file.
 */
export const CORPUS = {
  total: 31,
  /** Files that come out with something in them (24 full + 1 partial). */
  withContent: 25,
  /** Parse without error and contain nothing we can see. The honest weak point. */
  empty: 5,
  /** Not a Publisher file at all; correctly rejected. */
  notPublisher: 1,
  /** REG-TST2-pub2010.pub: 13 of its 18 pictures are WMF and are dropped. */
  wmfPictures: 13,
  wmfPicturesOutOf: 18,
} as const;

/** docs/FIDELITY.md, WebAssembly parity section. */
export const ENGINE = {
  wasmSizeKB: 465,
  coldLoadMs: 3.1,
  medianFileMs: 0.5,
} as const;
