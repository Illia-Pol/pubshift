/**
 * Was the conversion actually any good?
 *
 * libmspub parses most Publisher files but not all of them, and when it gives up
 * it does so *quietly*: `parse()` returns true and the callback stream contains
 * nothing but startDocument/metaData/endDocument. Measured on the 31-file corpus,
 * 5 files take this path (border1, multipara, table1, tdf89993-1, 14.0-metadata) —
 * same OLE stream layout as files that work, so it cannot be predicted up front.
 *
 * Handing someone a blank .docx and calling it a success is the exact failure this
 * product exists to prevent, so every conversion goes through this gate first.
 */

import type { Doc } from './types';

export type Verdict = 'ok' | 'partial' | 'empty';

export interface Assessment {
  verdict: Verdict;
  /** Written for the person who uploaded the file. Empty when the verdict is 'ok'. */
  message: string;
  pages: number;
  elements: number;
  textLength: number;
  images: number;
}

/**
 * A page that holds nothing but a full-bleed background rectangle is, to a reader,
 * a blank page. Counting raw elements would call that a success.
 */
function isMeaningful(doc: Doc): { elements: number; text: number; images: number } {
  let elements = 0;
  let text = 0;
  let images = 0;

  const walk = (els: Doc['pages'][number]['elements']): void => {
    for (const el of els) {
      if (el.kind === 'group') { walk(el.children); continue; }
      elements++;
      if (el.style?.fill?.type === 'image') images++;
      if (el.kind === 'image') images++;
      if (el.kind === 'text') {
        for (const p of el.paragraphs) for (const r of p.runs) text += r.text.trim().length;
      }
      if (el.kind === 'table') {
        for (const row of el.rows) for (const c of row.cells) {
          for (const p of c.paragraphs) for (const r of p.runs) text += r.text.trim().length;
        }
      }
    }
  };

  for (const page of doc.pages) walk(page.elements);
  return { elements, text, images };
}

const CANNOT_READ =
  'We could not read the contents of this file. It is a Publisher document, but it uses ' +
  'something our reader does not yet understand, so we have nothing to convert — and we ' +
  'would rather tell you that than hand you an empty document. Until 1 October 2026 you can ' +
  'still open it in Publisher and save it as PDF from there.';

const THIN =
  'We read this file but found very little in it. Please check the result against the ' +
  'original before you rely on it.';

export function assess(doc: Doc): Assessment {
  const { elements, text, images } = isMeaningful(doc);
  const base = { pages: doc.pages.length, elements, textLength: text, images };

  if (doc.pages.length === 0 || elements === 0) {
    return { verdict: 'empty', message: CANNOT_READ, ...base };
  }
  // Some shapes but no text and no pictures: technically content, but for a bulletin
  // or a newsletter it almost certainly means the interesting part did not come through.
  if (text === 0 && images === 0) {
    return { verdict: 'partial', message: THIN, ...base };
  }
  return { verdict: 'ok', message: '', ...base };
}
