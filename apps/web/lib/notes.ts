/**
 * Turning the pipeline's warnings into something a person can act on.
 *
 * Every converter on the market claims perfect fidelity and silently drops things.
 * We carry a warning list through the whole pipeline precisely so we can show it —
 * see docs/POSITIONING.md. Somebody with forty files and a deadline needs to know
 * which three want a human eye, and that is more useful than a promise about all forty.
 *
 * So: grouped by kind, counted, with page numbers, in sentences that do not require
 * knowing what a WMF is.
 */

import type { ConvertNote } from '@/lib/types';

export interface NoteGroup {
  code: string;
  /** What happened, in plain language. */
  title: string;
  /** How many times, across the whole document. */
  count: number;
  /** Pages it happened on, ascending and deduplicated. Empty when document-wide. */
  pages: number[];
}

/**
 * One sentence per warning code from `packages/core/src/model/types.ts`. An
 * unrecognised code falls back to the message the pipeline wrote, which is why
 * adding a code upstream degrades to "wordier" rather than to "silent".
 */
const PLAIN: Record<string, string> = {
  ROTATED_TEXT_APPROXIMATED:
    'Text set at an angle has been placed as close to the original as we could manage.',
  GRADIENT_FLATTENED: 'A colour fade was replaced with a single flat colour.',
  WMF_IMAGE_NOT_CONVERTED:
    'Older Publisher clip art is stored in a Windows-only picture format we cannot read, so it is missing. This is the largest thing we still lose.',
  SHADOW_DROPPED: 'A drop shadow was left off.',
  COLUMNS_FLATTENED: 'Text that ran in columns was straightened into one column.',
  FONT_NOT_EMBEDDED:
    'A font is named but not included in the file, so it will only look right on a computer that has that font.',
  SHAPE_APPROXIMATED: 'An unusual shape was redrawn as closely as we could.',
  TABLE_IN_UNSUPPORTED_TARGET:
    'A table could not stay a table in this format, so its text was laid out instead.',
  OVERLAP_MAY_REFLOW:
    'Some boxes overlap, so they may shift when you start editing the converted file.',
};

export function groupNotes(notes: ConvertNote[] | undefined): NoteGroup[] {
  if (!notes || notes.length === 0) return [];

  const groups = new Map<string, { title: string; count: number; pages: Set<number> }>();

  for (const note of notes) {
    const existing = groups.get(note.code);
    const group = existing ?? {
      title: PLAIN[note.code] ?? note.message,
      count: 0,
      pages: new Set<number>(),
    };
    group.count += note.count ?? 1;
    if (typeof note.page === 'number' && Number.isFinite(note.page)) group.pages.add(note.page);
    if (!existing) groups.set(note.code, group);
  }

  return [...groups.entries()]
    .map(([code, g]) => ({
      code,
      title: g.title,
      count: g.count,
      pages: [...g.pages].sort((a, b) => a - b),
    }))
    // Most frequent first: it is the one most likely to be worth looking at.
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

/** `page 3`, `pages 3 and 4`, `pages 3, 4 and 9`. */
export function pageList(pages: number[]): string {
  if (pages.length === 0) return '';
  if (pages.length === 1) return `page ${pages[0]}`;
  const head = pages.slice(0, -1).join(', ');
  return `pages ${head} and ${pages[pages.length - 1]}`;
}
