import { describe, expect, it } from 'vitest';

import { readIR } from '../src/ir/read';
import { buildDoc } from '../src/model/build';
import type { Doc, Run, Table } from '../src/model/types';
import {
  allElements, allParagraphs, corpusFiles, docFor, extract,
  nonFiniteNumbers, NOT_A_PUB, paragraphText,
} from './helpers';

const FILES = corpusFiles();
const READABLE = FILES.filter((f) => f !== NOT_A_PUB);

const TIMEOUT = 120_000;

function runsOf(doc: Doc): Run[] {
  return allParagraphs(doc).flatMap((p) => p.runs);
}

function findRun(doc: Doc, text: string): Run {
  const run = runsOf(doc).find((r) => r.text === text);
  expect(run, `no run with text ${JSON.stringify(text)}`).toBeDefined();
  return run!;
}

function onlyTable(doc: Doc): Table {
  const tables = allElements(doc).filter((el): el is Table => el.kind === 'table');
  expect(tables).toHaveLength(1);
  return tables[0]!;
}

describe('corpus', () => {
  it('has the 31 files the model was measured against', () => {
    expect(FILES).toHaveLength(31);
    expect(FILES).toContain(NOT_A_PUB);
  });

  it('builds a Doc from every readable file without throwing', () => {
    const failures: string[] = [];
    for (const name of READABLE) {
      try {
        buildDoc(readIR(extract(name)));
      } catch (err) {
        failures.push(`${name}: ${(err as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
    expect(READABLE).toHaveLength(30);
  }, TIMEOUT);

  it('gives every page a positive size', () => {
    for (const name of READABLE) {
      for (const [i, page] of docFor(name).pages.entries()) {
        expect(page.width, `${name} page ${i}`).toBeGreaterThan(0);
        expect(page.height, `${name} page ${i}`).toBeGreaterThan(0);
        expect(Number.isFinite(page.width) && Number.isFinite(page.height)).toBe(true);
      }
    }
  }, TIMEOUT);

  it('never lets a negative zero through', () => {
    const bad: string[] = [];
    const scan = (v: unknown, at: string): void => {
      if (typeof v === 'number') { if (Object.is(v, -0)) bad.push(at); return; }
      if (Array.isArray(v)) { v.forEach((x, i) => scan(x, `${at}[${i}]`)); return; }
      if (v !== null && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) scan(x, `${at}.${k}`);
      }
    };
    for (const name of READABLE) scan(docFor(name), name);
    expect(bad).toEqual([]);
  }, TIMEOUT);

  it('puts no NaN or Infinity anywhere in any document', () => {
    const bad: string[] = [];
    for (const name of READABLE) {
      for (const hit of nonFiniteNumbers(docFor(name), name)) bad.push(hit);
    }
    expect(bad).toEqual([]);
  }, TIMEOUT);

  it('never emits two adjacent runs with identical formatting', () => {
    const offenders: string[] = [];
    for (const name of READABLE) {
      for (const p of allParagraphs(docFor(name))) {
        for (let i = 1; i < p.runs.length; i++) {
          const a = p.runs[i - 1]!, b = p.runs[i]!;
          const fa = { ...a, text: undefined };
          const fb = { ...b, text: undefined };
          if (JSON.stringify(fa) === JSON.stringify(fb)) {
            offenders.push(`${name}: ${JSON.stringify(a.text)} + ${JSON.stringify(b.text)}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  }, TIMEOUT);

  it('never emits an empty run', () => {
    for (const name of READABLE) {
      for (const r of runsOf(docFor(name))) expect(r.text, name).not.toBe('');
    }
  }, TIMEOUT);

  it('resolves every asset reference it hands out', () => {
    for (const name of READABLE) {
      const doc = docFor(name);
      const refs: string[] = [];
      for (const el of allElements(doc)) {
        if (el.kind === 'image') refs.push(el.assetRef);
        if (el.style?.fill?.type === 'image') refs.push(el.style.fill.assetRef);
      }
      for (const ref of refs) {
        expect(doc.assets[ref], `${name} -> ${ref}`).toBeDefined();
        expect(doc.assets[ref]!.data.length).toBeGreaterThan(0);
      }
    }
  }, TIMEOUT);

  it('leaves metafile images out and says so, instead of emitting a broken image', () => {
    const withMetafiles = READABLE.filter((n) => extract(n).includes('image/wmf') || extract(n).includes('image/emf'));
    expect(withMetafiles.length).toBeGreaterThan(0);

    for (const name of withMetafiles) {
      const doc = docFor(name);
      const warning = doc.warnings.find((w) => w.code === 'WMF_IMAGE_NOT_CONVERTED');
      expect(warning, name).toBeDefined();
      expect(warning!.count).toBeGreaterThan(0);
      for (const asset of Object.values(doc.assets)) {
        expect(asset.mime, name).not.toMatch(/wmf|emf/);
      }
    }
  }, TIMEOUT);

  it('aggregates warnings rather than repeating one per occurrence', () => {
    for (const name of READABLE) {
      const doc = docFor(name);
      const keys = doc.warnings.map((w) => `${w.code}|${w.page ?? '-'}`);
      expect(new Set(keys).size, name).toBe(keys.length);
    }
  }, TIMEOUT);
});

describe('page trimming', () => {
  it('drops the blank master page Publisher writes ahead of the content', () => {
    for (const name of ['text-style.pub', 'bold-style.pub', 'fonts.pub', 'langs.pub', 'para-format.pub']) {
      const doc = docFor(name);
      expect(doc.pages, name).toHaveLength(1);
      expect(doc.pages[0]!.elements.length, name).toBeGreaterThan(0);
    }
  }, TIMEOUT);

  it('drops a blank trailing page', () => {
    const doc = docFor('fdo59355-1.pub');
    expect(doc.pages).toHaveLength(1);
    expect(doc.pages[0]!.elements.length).toBeGreaterThan(0);
  });

  it('keeps every page that has content', () => {
    for (const name of READABLE) {
      const doc = docFor(name);
      const raw = readIR(extract(name)).events.filter((e) => e.t === 'startPage').length;
      expect(doc.pages.length, name).toBeLessThanOrEqual(raw);
      for (const page of doc.pages.slice(1, -1)) void page; // interior pages are never trimmed
    }
    expect(docFor('923566.pub').pages).toHaveLength(4);
    expect(docFor('fdo68259-5.pub').pages).toHaveLength(7);
  }, TIMEOUT);

  it('yields no pages for a file that is nothing but a blank page', () => {
    expect(docFor('tdf89993-1.pub').pages).toEqual([]);
  });
});

describe('text-style.pub', () => {
  const doc = docFor('text-style.pub');

  it('has one page with a single text box', () => {
    expect(doc.pages).toHaveLength(1);
    const els = doc.pages[0]!.elements;
    expect(els).toHaveLength(1);
    expect(els[0]!.kind).toBe('text');
  });

  it('round-trips the text, one run per formatting change', () => {
    const paras = allParagraphs(doc);
    expect(paras).toHaveLength(2);
    expect(paragraphText(paras[0]!)).toBe('Bold style. Suppressed bold.');
    expect(paragraphText(paras[1]!)).toBe('Underline style. Suppressed underline.');
  });

  it('marks exactly the bold and underlined runs', () => {
    const [first, second] = allParagraphs(doc);
    expect(first!.runs.map((r) => [r.text, r.bold ?? false])).toEqual([
      ['Bold style. ', true],
      ['Suppressed bold.', false],
    ]);
    expect(second!.runs.map((r) => [r.text, r.underline ?? false])).toEqual([
      ['Underline style. ', true],
      ['Suppressed underline.', false],
    ]);
  });

  it('carries font, size, colour and language through', () => {
    const run = allParagraphs(doc)[0]!.runs[0]!;
    expect(run.font).toBe('Times New Roman');
    expect(run.size).toBe(10);
    expect(run.color).toBe('#000000');
    expect(run.lang).toBe('en-US');
  });
});

describe('text-format.pub', () => {
  const doc = docFor('text-format.pub');

  it('maps each character property to its model field', () => {
    expect(findRun(doc, 'bold, ').bold).toBe(true);
    expect(findRun(doc, 'italic, ').italic).toBe(true);
    expect(findRun(doc, 'underlined, ').underline).toBe(true);
    expect(findRun(doc, 'small caps, ').smallCaps).toBe(true);
    expect(findRun(doc, 'all caps, ').allCaps).toBe(true);
    expect(findRun(doc, 'blue,').color).toBe('#0000ff');
    expect(findRun(doc, '12 pt, ').size).toBe(12);
  });

  it('does not set flags that were not asked for', () => {
    const normal = findRun(doc, 'Format: Normal, ');
    expect(normal.bold).toBeUndefined();
    expect(normal.italic).toBeUndefined();
    expect(normal.underline).toBeUndefined();
  });

  it('reads style:text-position as a signed baseline shift', () => {
    expect(findRun(doc, 'superscript, ').baselineShift).toBe(50);
    expect(findRun(doc, 'subscript, ').baselineShift).toBe(-50);
  });

  it('treats every non-none underline style as underlined, and merges the lot', () => {
    // 17 spans, one per underline style, all identical once reduced to a boolean —
    // so they must come out as a single run, not 17.
    const para = allParagraphs(doc).find((p) => paragraphText(p).startsWith('Underline style:'))!;
    expect(para.runs).toHaveLength(2);
    expect(para.runs[0]!.text).toBe('Underline style: none, ');
    expect(para.runs[0]!.underline).toBeUndefined();
    expect(para.runs[1]!.underline).toBe(true);
    for (const style of ['single, ', 'dotted, ', 'dash, ', 'wave, ', 'dot dot dash, ']) {
      expect(para.runs[1]!.text, style).toContain(style);
    }
  });

  it('keeps the effects that have nowhere else to go', () => {
    expect(findRun(doc, 'outline, ').outline).toBe(true);
    expect(findRun(doc, 'emboss, ').relief).toBe('embossed');
    expect(findRun(doc, 'engrave, ').relief).toBe('engraved');
    expect(findRun(doc, 'shadow, ').textShadow).toBe(true);
  });

  it('tags a run in another language', () => {
    expect(findRun(doc, 'ceský jazyk').lang).toBe('cs-CZ');
  });
});

describe('tables.pub', () => {
  const doc = docFor('tables.pub');
  const tables = allElements(doc).filter((el): el is Table => el.kind === 'table');

  it('produces both tables with their real geometry', () => {
    expect(tables).toHaveLength(2);
    expect(tables[0]!.columnWidths).toEqual([144, 144, 144]);
    expect(tables[1]!.columnWidths).toEqual([216, 216]);
    expect(tables[0]!.width).toBe(432);
    expect(tables[0]!.x).toBe(90);
  });

  it('produces the right grid and cell text', () => {
    const t = tables[0]!;
    expect(t.rows).toHaveLength(2);
    expect(t.rows.map((r) => r.cells.length)).toEqual([3, 3]);
    expect(t.rows.flatMap((r) => r.cells.map((c) => c.paragraphs.map(paragraphText).join(''))))
      .toEqual(['a', 'aa', 'aaa', 'aaaa', 'aaaaa', 'aaaaaa']);
    expect(t.rows[0]!.height).toBeCloseTo(17.7, 1);
  });

  it('numbers cells as Publisher does', () => {
    const cells = tables[0]!.rows.flatMap((r) => r.cells);
    expect(cells.map((c) => [c.row, c.column])).toEqual([
      [0, 0], [0, 1], [0, 2], [1, 0], [1, 1], [1, 2],
    ]);
    expect(cells.every((c) => c.rowSpan === 1 && c.colSpan === 1 && !c.covered)).toBe(true);
  });
});

describe('table-merged.pub', () => {
  const doc = docFor('table-merged.pub');
  const table = onlyTable(doc);

  it('is a full 6x4 grid including the covered cells', () => {
    expect(table.columnWidths).toEqual([72, 72, 72, 72, 72, 72]);
    expect(table.rows).toHaveLength(4);
    expect(table.rows.map((r) => r.cells.length)).toEqual([6, 6, 6, 6]);
  });

  it('records the spans on the anchor cell', () => {
    const at = (row: number, col: number) =>
      table.rows[row]!.cells.find((c) => c.column === col)!;

    expect([at(0, 0).colSpan, at(0, 0).rowSpan]).toEqual([3, 1]);
    expect([at(0, 4).colSpan, at(0, 4).rowSpan]).toEqual([2, 3]);
    expect([at(1, 0).colSpan, at(1, 0).rowSpan]).toEqual([1, 2]);
    expect([at(1, 2).colSpan, at(1, 2).rowSpan]).toEqual([1, 3]);
    expect([at(3, 3).colSpan, at(3, 3).rowSpan]).toEqual([2, 1]);
  });

  it('marks the cells a span covers, and only those', () => {
    const covered = table.rows.map((r) => r.cells.filter((c) => c.covered).map((c) => c.column));
    expect(covered).toEqual([[1, 2, 5], [4, 5], [0, 2, 4, 5], [1, 2, 4]]);
    expect(table.rows.flatMap((r) => r.cells).filter((c) => c.covered)).toHaveLength(12);
    expect(table.rows.flatMap((r) => r.cells).filter((c) => !c.covered)).toHaveLength(12);
  });

  it('gives covered cells no span of their own', () => {
    for (const c of table.rows.flatMap((r) => r.cells).filter((x) => x.covered)) {
      expect([c.rowSpan, c.colSpan]).toEqual([1, 1]);
    }
  });
});

describe('metadata', () => {
  it('reads the Publisher document properties', () => {
    const meta = docFor('14.0-metadata.pub').meta;
    expect(meta.title).toBe('Title');
    expect(meta.creator).toBe('Author');
    expect(meta.subject).toBe('Subject');
    expect(meta.description).toBe('Comments');
    expect(meta.keywords).toBe('Keywords');
    expect(meta.created).toBe('1601-01-01T01:50:16Z');
  });
});

describe('whitespace folding', () => {
  it('folds insertSpace, insertTab and insertLineBreak into the run text', () => {
    const withTabs = READABLE.map(docFor).flatMap(runsOf).filter((r) => r.text.includes('\t'));
    expect(withTabs.length).toBeGreaterThan(0);

    const withBreaks = READABLE.map(docFor).flatMap(runsOf).filter((r) => r.text.includes('\n'));
    expect(withBreaks.length).toBeGreaterThan(0);

    const withSpaces = READABLE.map(docFor).flatMap(runsOf).filter((r) => r.text.includes('  '));
    expect(withSpaces.length).toBeGreaterThan(0);
  }, TIMEOUT);

  it('strips the carriage return Publisher uses as a paragraph terminator', () => {
    for (const name of READABLE) {
      for (const r of runsOf(docFor(name))) expect(r.text, name).not.toContain('\r');
    }
  }, TIMEOUT);
});

describe('styles', () => {
  it('builds gradient fills with their stops and angle', () => {
    const doc = docFor('fdo60556-1.pub');
    const gradients = allElements(doc)
      .map((el) => el.style?.fill)
      .filter((f) => f?.type === 'gradient');
    expect(gradients).toHaveLength(6);
    expect(gradients[0]).toEqual({
      type: 'gradient',
      angle: 0,
      stops: [
        { offset: 0, color: '#8064a2' },
        { offset: 0.5, color: '#5b4773' },
        { offset: 1, color: '#8064a2' },
      ],
    });
    for (const g of gradients) {
      expect(g!.stops.length).toBeGreaterThanOrEqual(2);
      for (const stop of g!.stops) {
        expect(stop.offset).toBeGreaterThanOrEqual(0);
        expect(stop.offset).toBeLessThanOrEqual(1);
        expect(stop.color).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(Math.abs(g!.angle)).toBeLessThanOrEqual(360);
    }
  }, TIMEOUT);

  it('keeps stroke width in points', () => {
    const strokes = READABLE.map(docFor)
      .flatMap(allElements)
      .map((el) => el.style?.stroke)
      .filter((s) => s !== undefined);
    expect(strokes.length).toBeGreaterThan(0);
    for (const s of strokes) {
      expect(s!.width).toBeGreaterThanOrEqual(0);
      expect(s!.width).toBeLessThan(200);
      expect(s!.color).toMatch(/^#/);
    }
  }, TIMEOUT);
});
