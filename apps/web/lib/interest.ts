/**
 * Capturing the one visitor who would have paid.
 *
 * Today there is no checkout: the owner is a Belarusian citizen in Belarus and no payment
 * rail is reliably open (docs/business/rails.md). Until that is settled, somebody who
 * arrives with four hundred files — precisely the person the paid tool exists for — hits
 * a dead end and is gone.
 *
 * This turns that dead end into two things worth more than the lost sale:
 *
 *  1. **They get served anyway.** The batch runner is finished and works; it is handed
 *     over free. A person whose archive converted is a better asset than a $29 payment.
 *  2. **The measurement.** docs/business/metrics.md asks for a fixed denominator, and the
 *     market research named batch-intent as the assumption the whole business is most
 *     sensitive to and the one nobody has measured. Every submission here is one
 *     observation of it.
 *
 * ## What leaves the browser, exactly
 *
 * An address the visitor typed, and an optional rough file count. That is all. It does not
 * touch the converter: no document, no filename, no derived data ever leaves the tab, and
 * the page's own Content-Security-Policy (`connect-src 'self'`) is what stops it. This
 * form posts to a configured endpoint and is the ONLY outbound path on the site, which is
 * why it is opt-in, obvious, and described in these words on the page itself.
 *
 * With no endpoint configured the form does not render at all — a mailto link takes its
 * place. A form that silently discards what someone typed would be worse than no form.
 */

/** Set at build time. Absent in a normal build, and then no form is shown. */
export const INTEREST_ENDPOINT = process.env.NEXT_PUBLIC_INTEREST_ENDPOINT ?? '';

export const INTEREST_EMAIL = process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? '';

export function interestCaptureAvailable(): boolean {
  return INTEREST_ENDPOINT.length > 0;
}

/** Deliberately coarse. A precise count is not needed and is more than we should ask for. */
export const ARCHIVE_SIZES = [
  { id: 'under-20', label: 'Fewer than 20 files' },
  { id: '20-100', label: '20 to 100' },
  { id: '100-500', label: '100 to 500' },
  { id: 'over-500', label: 'More than 500' },
] as const;

export type ArchiveSize = (typeof ARCHIVE_SIZES)[number]['id'];

export interface InterestSubmission {
  email: string;
  archiveSize: ArchiveSize | '';
  /** Which page it came from, so the funnel can be read later. No document data. */
  source: string;
}

/** A deliberately forgiving check: the server and the person both get a say, not a regex. */
export function looksLikeEmail(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length >= 6 && trimmed.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed);
}
