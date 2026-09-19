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
/**
 * End of support for the bought-outright **2021** versions — Office LTSC 2021 and
 * the consumer Office 2021 — which is what Microsoft's announcement actually ties
 * to this date. The software keeps running; only the updates stop.
 *
 * It is specifically *not* the date for Publisher 2019. Attaching 2019 to it, as
 * this site used to, tells a 2019 owner they have another year of support when they
 * have none: see `OFFICE_2019_SUPPORT_ENDED`.
 */
export const SUPPORT_END_DATE = '13 October 2026';
/**
 * Office 2019 is already out of support — it went in October 2025, before this site
 * existed. Nothing on the 2026 timetable applies to it, and saying otherwise would
 * be reassuring somebody about a deadline they have already missed.
 */
export const OFFICE_2019_SUPPORT_ENDED = 'October 2025';

/**
 * Measured on `packages/core/test/corpus/` — 31 real Publisher files, 97 through 2010.
 * docs/FIDELITY.md: 24 real content, 1 partial, 5 empty, 1 not a Publisher file.
 *
 * `intact` and `partial` are separate on purpose. They were once added together and
 * reported as "25 come out with their contents intact", which is not what the
 * measurement says: the partial file lost its text. This audience is being asked to
 * trust a number about their own files, and a number that flatters us by one is
 * worth less than nothing — docs/POSITIONING.md.
 */
export const CORPUS = {
  total: 31,
  /** Come out with their contents intact: text and/or pictures, all of it we can see. */
  intact: 24,
  /** `fdo64631-2.pub`: the shapes came through, the text did not. Flagged to the user. */
  partial: 1,
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
  coldLoadMs: 2.6,
  medianFileMs: 0.6,
} as const;

/**
 * Where the code and the batch runner actually live. It is a build input because the
 * repository does not exist yet and a download button pointing at a 404 is worse than no
 * button — the /batch page hides it rather than shipping a dead link.
 */
export const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL ?? '';
