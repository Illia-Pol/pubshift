/**
 * Unit normalization. Everything downstream is in POINTS, degrees, or a 0..1
 * fraction — never in whatever librevenge claimed.
 *
 * libmspub tags several properties with a unit that does not match what they
 * hold. The mapping below is measured against the 31-file corpus (see the table
 * in docs/IR.md), so there is one helper per *semantic kind* rather than one
 * function trying to guess from the tag: the tag is exactly the thing we cannot
 * trust.
 */

import { isMeasure, type IRValue } from './types';

const PT_PER_INCH = 72;
const PT_PER_TWIP = 1 / 20;

function finite(n: number): number | undefined {
  return Number.isFinite(n) ? n : undefined;
}

/**
 * A length, in points. Covers geometry (`svg:x`, `svg:width`, `fo:margin-*`,
 * `style:column-width`, `svg:stroke-width`) and also `fo:font-size`, which
 * libmspub reports in inches — 0.138889in is a 10pt font.
 *
 * A generic (untagged) length is inches: the inch is librevenge's native unit.
 * A percentage is not a length, so it yields `undefined` rather than a number
 * that would silently be wrong by a factor of 72.
 */
export function toPoints(v: IRValue | undefined): number | undefined {
  if (!isMeasure(v)) return undefined;
  switch (v.u) {
    case 'pt': return finite(v.v);
    case 'twip': return finite(v.v * PT_PER_TWIP);
    case 'in':
    case '': return finite(v.v * PT_PER_INCH);
    default: return undefined;
  }
}

/**
 * An angle, in degrees clockwise. `librevenge:rotate` and `draw:angle` are both
 * tagged `in`; the tag is meaningless and the number is already degrees.
 * Not normalized into [0, 360): -46 is a real, signed rotation we keep as-is.
 */
export function toDegrees(v: IRValue | undefined): number | undefined {
  if (!isMeasure(v)) return undefined;
  return finite(v.v);
}

/**
 * A 0..1 fraction. `draw:opacity`, `draw:shadow-opacity`, `svg:offset` and
 * `svg:stop-opacity` are all tagged `%` but carry the fraction directly —
 * a fully opaque fill arrives as 1, not 100.
 */
export function toFraction(v: IRValue | undefined): number | undefined {
  if (!isMeasure(v)) return undefined;
  const n = finite(v.v);
  if (n === undefined) return undefined;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * A line-height multiplier. `fo:line-height` is tagged `%` but carries the
 * multiplier (1.15 means 115%). Values above 10 cannot be a multiplier — no one
 * sets 1150% leading — so they are folded back from a literal percentage.
 */
export function toMultiplier(v: IRValue | undefined): number | undefined {
  if (!isMeasure(v)) return undefined;
  const n = finite(v.v);
  if (n === undefined || n <= 0) return undefined;
  return n > 10 ? n / 100 : n;
}

/**
 * A true percentage. `fo:text-scale` really is one: 80 means 80% width.
 */
export function toPercent(v: IRValue | undefined): number | undefined {
  if (!isMeasure(v)) return undefined;
  return finite(v.v);
}

/** An unsigned count (`librevenge:row`, `table:number-columns-spanned`, path flags). */
export function toInt(v: IRValue | undefined): number | undefined {
  if (!isMeasure(v)) return undefined;
  const n = finite(v.v);
  return n === undefined ? undefined : Math.round(n);
}

export function inchesToPoints(inches: number): number {
  return inches * PT_PER_INCH;
}
