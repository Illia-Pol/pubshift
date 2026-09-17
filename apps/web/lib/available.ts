/**
 * Which output formats this build can actually produce.
 *
 * Answered from a build-time constant rather than by importing the emitters,
 * because importing them from a page component would drag the PDF writer, the
 * OOXML writer and the zip library into the landing page's first download — for
 * every visitor who came to read about the deadline and may never convert
 * anything. `next.config.mjs` works the answer out while it is already deciding
 * which `@emit/*` modules exist, and hands it over as a string.
 *
 * The emitters themselves live behind the worker, which is the only place they
 * are needed. `convert.ts` still guards at the moment of use; this is only what
 * the picker is allowed to advertise.
 */

import { TARGET_FORMATS, type TargetFormat } from '@/lib/types';

const RAW = process.env.NEXT_PUBLIC_PUBSHIFT_EMITTERS ?? '';

export function availableFormats(): Record<TargetFormat, boolean> {
  let parsed: Record<string, unknown> = {};
  try {
    if (RAW) parsed = JSON.parse(RAW) as Record<string, unknown>;
  } catch {
    parsed = {};
  }

  const out = {} as Record<TargetFormat, boolean>;
  for (const id of TARGET_FORMATS) {
    // Absence means "nobody told us", which must not silently disable the whole
    // page. Only an explicit `false` greys a format out.
    out[id] = parsed[id] !== false;
  }
  return out;
}
