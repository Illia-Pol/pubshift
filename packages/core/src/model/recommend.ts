/**
 * A hint about which format suits this document — deliberately a small claim.
 *
 * The obvious idea is to pick the best format automatically from the document's shape.
 * That was tried and measured against the corpus (tools/fidelity/compare.mjs, 24 files),
 * and a full heuristic chose the better of PPTX/DOCX on 13 of 24 files — a coin flip.
 * With a 0.05 margin to discount ties it was 9 clear wins against 5 clear losses: real
 * signal, nowhere near enough to decide for somebody.
 *
 * Rather than ship a clever-looking guess, this returns `confident: true` only for the
 * two patterns where the measurements are unambiguous AND there is a mechanical reason
 * for them, and otherwise declines to recommend and just explains the default.
 *
 * Tables, PPTX over DOCX:          tables.pub 0.960/0.494 · table-merged.pub 0.841/0.689
 * Short single frame, DOCX over PPTX: text-style 0.998/0.792 · bold-style 1.000/0.867
 *                                   underline-style 0.998/0.892 · langs 0.975/0.829
 *                                   fonts 0.910/0.841
 *
 * Those margins are large and one-directional. Everything in between is genuinely close,
 * and is reported as such. If the corpus grows, re-run the comparison before widening
 * any of this — the temptation to fit more rules to 24 documents is exactly the mistake
 * this comment exists to prevent.
 */

import type { Doc, TargetFormat } from './types';

export interface Recommendation {
  format: TargetFormat;
  /** True only where the corpus shows a large, one-directional difference. */
  confident: boolean;
  /** One sentence for someone who has never heard of a text frame. */
  because: string;
}

/** Below this, a document is a notice or a letter rather than a layout. */
const SHORT_DOCUMENT_CHARS = 400;

export function recommendFormat(doc: Doc): Recommendation {
  let textBoxes = 0;
  let tables = 0;
  let images = 0;
  let chars = 0;

  for (const page of doc.pages) {
    const walk = (els: typeof page.elements): void => {
      for (const el of els) {
        if (el.kind === 'group') { walk(el.children); continue; }
        if (el.style?.fill?.type === 'image') images++;
        if (el.kind === 'image') images++;
        else if (el.kind === 'table') tables++;
        else if (el.kind === 'text') {
          textBoxes++;
          for (const p of el.paragraphs) for (const r of p.runs) chars += r.text.trim().length;
        }
      }
    };
    walk(page.elements);
  }

  // Only when the table *is* the document. fdo68259-2.pub is a four-page newsletter with
  // one table among 138 elements, and there DOCX measured better (0.900 against 0.747):
  // an incidental table says nothing about how the publication as a whole should travel.
  if (tables > 0 && textBoxes <= 2) {
    return {
      format: 'pptx',
      confident: true,
      because:
        'This publication contains a table. Tables keep their shape in PowerPoint and tend ' +
        'to come apart in Word, so PowerPoint is the safer choice here.',
    };
  }

  if (textBoxes === 1 && images === 0 && chars > 0 && chars < SHORT_DOCUMENT_CHARS) {
    return {
      format: 'docx',
      confident: true,
      because:
        'This is a short piece of text rather than a layout, so Word reproduces it almost ' +
        'exactly and is the easier place to keep editing it.',
    };
  }

  return {
    format: 'pptx',
    confident: false,
    because:
      'PowerPoint keeps each piece of the page where it sits, which is usually what you want ' +
      'from a publication — but for this file Word comes out close, so it is worth trying ' +
      'both and keeping whichever looks right.',
  };
}
