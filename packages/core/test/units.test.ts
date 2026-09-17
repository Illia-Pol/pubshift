import { describe, expect, it } from 'vitest';

import {
  inchesToPoints, toDegrees, toFraction, toInt, toMultiplier, toPercent, toPoints,
} from '../src/ir/units';
import type { IRMeasure, IRUnit } from '../src/ir/types';

const m = (v: number, u: IRUnit): IRMeasure => ({ v, u });

describe('toPoints', () => {
  it('converts the units librevenge actually tags correctly', () => {
    expect(toPoints(m(1, 'in'))).toBe(72);
    expect(toPoints(m(8.5, 'in'))).toBe(612);
    expect(toPoints(m(12, 'pt'))).toBe(12);
    expect(toPoints(m(1440, 'twip'))).toBe(72);
  });

  it('treats an untagged length as inches, librevenge’s native unit', () => {
    expect(toPoints(m(1, ''))).toBe(72);
  });

  it('reads fo:font-size, which libmspub reports in inches', () => {
    // The exact values the corpus carries for 8pt, 9pt, 10pt and 12pt.
    expect(toPoints(m(0.111111, 'in'))).toBeCloseTo(8, 3);
    expect(toPoints(m(0.125, 'in'))).toBe(9);
    expect(toPoints(m(0.138889, 'in'))).toBeCloseTo(10, 3);
    expect(toPoints(m(0.166667, 'in'))).toBeCloseTo(12, 3);
  });

  it('refuses to read a percentage as a length', () => {
    expect(toPoints(m(50, '%'))).toBeUndefined();
  });

  it('returns undefined for anything that is not a finite measure', () => {
    expect(toPoints(undefined)).toBeUndefined();
    expect(toPoints('solid')).toBeUndefined();
    expect(toPoints([])).toBeUndefined();
    expect(toPoints(m(Number.NaN, 'in'))).toBeUndefined();
    expect(toPoints(m(Number.POSITIVE_INFINITY, 'in'))).toBeUndefined();
  });
});

describe('toDegrees', () => {
  it('ignores the bogus `in` tag on librevenge:rotate and draw:angle', () => {
    expect(toDegrees(m(90, 'in'))).toBe(90);
    expect(toDegrees(m(45, 'in'))).toBe(45);
    expect(toDegrees(m(0, 'in'))).toBe(0);
  });

  it('keeps a signed rotation as measured, not normalized into [0, 360)', () => {
    expect(toDegrees(m(-46, 'in'))).toBe(-46);
  });

  it('never multiplies by 72', () => {
    expect(toDegrees(m(90, 'in'))).not.toBe(6480);
  });
});

describe('toFraction', () => {
  it('reads the `%`-tagged opacity properties as the 0..1 fractions they are', () => {
    expect(toFraction(m(1, '%'))).toBe(1);
    expect(toFraction(m(0.5, '%'))).toBe(0.5);
    expect(toFraction(m(0.800003, '%'))).toBeCloseTo(0.8, 5);
    expect(toFraction(m(0, '%'))).toBe(0);
  });

  it('reads gradient stop offsets, which carry the same lie', () => {
    expect(toFraction(m(0, '%'))).toBe(0);
    expect(toFraction(m(0.5, '%'))).toBe(0.5);
    expect(toFraction(m(1, '%'))).toBe(1);
  });

  it('clamps', () => {
    expect(toFraction(m(1.4, '%'))).toBe(1);
    expect(toFraction(m(-0.2, '%'))).toBe(0);
  });
});

describe('toMultiplier', () => {
  it('reads fo:line-height as the multiplier it carries, not as a percentage', () => {
    expect(toMultiplier(m(1.15, '%'))).toBe(1.15);
    expect(toMultiplier(m(1.10833, '%'))).toBe(1.10833);
    expect(toMultiplier(m(0.75, '%'))).toBe(0.75);
    expect(toMultiplier(m(2.5, '%'))).toBe(2.5);
  });

  it('folds a value that could only be a literal percentage', () => {
    expect(toMultiplier(m(115, '%'))).toBeCloseTo(1.15, 6);
  });

  it('rejects a non-positive leading', () => {
    expect(toMultiplier(m(0, '%'))).toBeUndefined();
    expect(toMultiplier(m(-1, '%'))).toBeUndefined();
  });
});

describe('toPercent', () => {
  it('reads fo:text-scale, the one property whose `%` tag is honest', () => {
    expect(toPercent(m(80, '%'))).toBe(80);
    expect(toPercent(m(100, '%'))).toBe(100);
  });

  it('does not confuse it with a fraction', () => {
    expect(toPercent(m(80, '%'))).not.toBe(0.8);
  });
});

describe('toInt', () => {
  it('reads the untagged counts librevenge uses for rows, columns and spans', () => {
    expect(toInt(m(0, ''))).toBe(0);
    expect(toInt(m(3, ''))).toBe(3);
    expect(toInt(m(2.0, ''))).toBe(2);
    expect(toInt(undefined)).toBeUndefined();
  });
});

describe('inchesToPoints', () => {
  it('is the one place the 72 lives', () => {
    expect(inchesToPoints(0.5)).toBe(36);
  });
});
