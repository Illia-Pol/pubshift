import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';

import { DOCX_MODE_DESCRIPTIONS, emitDOCX, type DocxMode } from '../src/emit/docx';
import type {
  Doc, Element, Geometry, Page, Paragraph, Run, ShapeStyle, Table, TableCell, TableRow, Warning,
} from '../src/model/types';
import { allText, findAll, findFirst, parseXML, type XNode } from './helpers/xml';

// --- fixture builders -------------------------------------------------------

function doc(elements: Element[], over: Partial<Doc> = {}): Doc {
  const page: Page = { width: 612, height: 792, elements };
  return { pages: [page], meta: {}, assets: {}, warnings: [], ...over };
}

function run(text: string, over: Partial<Run> = {}): Run {
  return { text, font: 'Arial', size: 12, ...over };
}

function para(runs: Run[], over: Partial<Paragraph> = {}): Paragraph {
  return { runs, ...over };
}

function text(paragraphs: Paragraph[], over: Partial<Element> = {}): Element {
  return { kind: 'text', x: 10, y: 20, width: 200, height: 50, paragraphs, ...over } as Element;
}

function shape(geometry: Geometry, over: Record<string, unknown> = {}): Element {
  return { kind: 'shape', x: 0, y: 0, width: 100, height: 60, geometry, ...over } as Element;
}

function cell(row: number, column: number, body: string, over: Partial<TableCell> = {}): TableCell {
  return {
    row, column, rowSpan: 1, colSpan: 1, covered: false,
    paragraphs: body === '' ? [] : [para([run(body)])],
    ...over,
  };
}

function table(rows: TableRow[], columnWidths: number[], over: Partial<Table> = {}): Element {
  return {
    kind: 'table', x: 0, y: 0, width: columnWidths.reduce((s, w) => s + w, 0), height: 60,
    columnWidths, rows, ...over,
  } as Element;
}

/** A 1x1 red PNG. Only the magic bytes matter to the emitter. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// --- package access ---------------------------------------------------------

interface Package {
  parts: Record<string, string>;
  files: string[];
  binary: Record<string, Uint8Array>;
  warnings: Warning[];
  /** Parsed `word/document.xml`. */
  document: XNode;
  part(name: string): XNode;
}

async function open(source: Doc, mode?: DocxMode): Promise<Package> {
  const warnings: Warning[] = [];
  const bytes = await emitDOCX(source, {
    ...(mode ? { mode } : {}),
    onWarning: (w) => warnings.push(w),
  });
  const zip = await JSZip.loadAsync(bytes);

  const parts: Record<string, string> = {};
  const binary: Record<string, Uint8Array> = {};
  const files: string[] = [];
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    files.push(name);
    if (name.endsWith('.xml') || name.endsWith('.rels')) parts[name] = await file.async('string');
    else binary[name] = await file.async('uint8array');
  }
  files.sort();

  const part = (name: string): XNode => {
    const body = parts[name];
    expect(body, `missing part ${name}`).toBeDefined();
    return parseXML(body as string);
  };
  return { parts, files, binary, warnings, document: part('word/document.xml'), part };
}

/** Every `wp:anchor` in document order. */
function anchors(pkg: Package): XNode[] {
  return findAll(pkg.document, 'wp:anchor');
}

/** Every `w:drawing` that is an inline picture. */
function inlines(pkg: Package): XNode[] {
  return findAll(pkg.document, 'wp:inline');
}

function attr(node: XNode | undefined, name: string): string | undefined {
  return node?.attrs[name];
}

/**
 * The content of the first text box.
 *
 * Layout mode hangs every drawing off a near-empty host paragraph, which has run
 * properties of its own; searching the whole document for the "first" run would find that
 * one rather than the document's text.
 */
function firstBox(pkg: Package): XNode {
  const node = findFirst(pkg.document, 'w:txbxContent');
  expect(node, 'no text box in the document').toBeDefined();
  return node as XNode;
}

// ---------------------------------------------------------------------------

describe('modes', () => {
  it('describes each mode in one sentence, for the UI to reuse', () => {
    expect(Object.keys(DOCX_MODE_DESCRIPTIONS).sort()).toEqual(['flow', 'layout']);
    for (const [mode, sentence] of Object.entries(DOCX_MODE_DESCRIPTIONS)) {
      expect(sentence.length, mode).toBeGreaterThan(40);
      // One sentence: a single terminating full stop, at the end.
      expect(sentence.trimEnd().endsWith('.'), mode).toBe(true);
      expect(sentence.trimEnd().slice(0, -1).includes('. '), mode).toBe(false);
    }
    expect(DOCX_MODE_DESCRIPTIONS.layout).not.toBe(DOCX_MODE_DESCRIPTIONS.flow);
  });

  it('defaults to layout, which anchors rather than flows', async () => {
    const source = doc([text([para([run('hello')])])]);
    const implicit = await open(source);
    const explicit = await open(source, 'layout');
    expect(anchors(implicit)).toHaveLength(1);
    expect(implicit.parts['word/document.xml']).toBe(explicit.parts['word/document.xml']);
  });
});

describe('package', () => {
  it('writes the parts a .docx is required to have', async () => {
    const pkg = await open(doc([text([para([run('x')])])]));
    expect(pkg.files).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/app.xml',
      'docProps/core.xml',
      'word/_rels/document.xml.rels',
      'word/document.xml',
      'word/styles.xml',
    ]);
  });

  it('parses as XML in every part', async () => {
    const pkg = await open(doc([text([para([run('a & b < c > d "e" \'f\'')])])]));
    for (const [name, body] of Object.entries(pkg.parts)) {
      expect(() => parseXML(body), name).not.toThrow();
    }
  });

  it('declares the content type of every part it writes', async () => {
    const pkg = await open(doc([
      text([para([run('x')], { list: { type: 'unordered', level: 0 } })]),
      { kind: 'image', x: 0, y: 0, width: 10, height: 10, assetRef: 'a1' } as Element,
    ], { assets: { a1: { data: PNG_BASE64, mime: 'image/png' } } }));

    const types = pkg.part('[Content_Types].xml');
    const defaults = findAll(types, 'Default').map((d) => d.attrs.Extension);
    const overrides = findAll(types, 'Override').map((o) => o.attrs.PartName);
    expect(defaults).toContain('rels');
    expect(defaults).toContain('xml');
    expect(defaults).toContain('png');
    expect(overrides).toContain('/word/document.xml');
    expect(overrides).toContain('/word/styles.xml');
    expect(overrides).toContain('/word/numbering.xml');
    expect(overrides).toContain('/docProps/core.xml');
    expect(overrides).toContain('/docProps/app.xml');
  });

  it('points the package relationship at the document', async () => {
    const pkg = await open(doc([]));
    const rels = findAll(pkg.part('_rels/.rels'), 'Relationship');
    const main = rels.find((r) => r.attrs.Type?.endsWith('/officeDocument'));
    expect(main?.attrs.Target).toBe('word/document.xml');
  });

  it('leaves out the numbering part when nothing is a list', async () => {
    const pkg = await open(doc([text([para([run('x')])])]));
    expect(pkg.files).not.toContain('word/numbering.xml');
    expect(findAll(pkg.document, 'w:numPr')).toHaveLength(0);
  });

  it('carries the document metadata in the order the schema demands', async () => {
    const pkg = await open(doc([], {
      meta: {
        title: 'Spring Bulletin', creator: 'A. Secretary', subject: 'News',
        description: 'Monthly', keywords: 'church, news', created: '2019-04-02T10:11:12Z',
      },
    }));
    const core = pkg.part('docProps/core.xml');
    expect(core.children.map((c) => c.name)).toEqual([
      'dcterms:created', 'dc:creator', 'dc:description', 'cp:keywords', 'dc:subject', 'dc:title',
    ]);
    expect(findFirst(core, 'dc:title')?.text).toBe('Spring Bulletin');
    expect(findFirst(core, 'dcterms:created')?.text).toBe('2019-04-02T10:11:12Z');
  });

  it('drops a creation date it cannot turn into a valid instant', async () => {
    const pkg = await open(doc([], { meta: { created: 'sometime in the spring' } }));
    expect(findAll(pkg.part('docProps/core.xml'), 'dcterms:created')).toHaveLength(0);
  });

  it('zeroes Word’s default paragraph spacing, which would push every line down', async () => {
    const pkg = await open(doc([]));
    const spacing = findFirst(pkg.part('word/styles.xml'), 'w:spacing');
    expect(spacing?.attrs['w:after']).toBe('0');
    expect(spacing?.attrs['w:before']).toBe('0');
    expect(spacing?.attrs['w:line']).toBe('240');
  });
});

describe('sections', () => {
  it('states the page size in twips', async () => {
    const pkg = await open(doc([]));
    const size = findFirst(pkg.document, 'w:pgSz');
    expect(size?.attrs['w:w']).toBe('12240'); // 612pt
    expect(size?.attrs['w:h']).toBe('15840'); // 792pt
  });

  it('rounds a fractional page size rather than truncating it', async () => {
    const source = doc([]);
    (source.pages[0] as Page).width = 595.276;
    (source.pages[0] as Page).height = 841.889;
    const size = findFirst((await open(source)).document, 'w:pgSz');
    expect(size?.attrs['w:w']).toBe('11906');
    expect(size?.attrs['w:h']).toBe('16838');
  });

  it('marks a wider-than-tall page as landscape', async () => {
    const source = doc([]);
    (source.pages[0] as Page).width = 841.889;
    (source.pages[0] as Page).height = 595.276;
    expect(findFirst((await open(source)).document, 'w:pgSz')?.attrs['w:orient']).toBe('landscape');
    expect(findFirst((await open(doc([]))).document, 'w:pgSz')?.attrs['w:orient']).toBeUndefined();
  });

  it('writes an oversized page at its true size rather than clamping it', async () => {
    const source = doc([]);
    (source.pages[0] as Page).width = 2834.878; // a 39in banner, beyond Word's own limit
    (source.pages[0] as Page).height = 3968.64;
    const size = findFirst((await open(source)).document, 'w:pgSz');
    expect(size?.attrs['w:w']).toBe('56698');
    expect(size?.attrs['w:h']).toBe('79373');
  });

  it('gives layout mode no margins, because the model measures from the paper corner', async () => {
    const margin = findFirst((await open(doc([]), 'layout')).document, 'w:pgMar');
    for (const side of ['w:top', 'w:right', 'w:bottom', 'w:left']) {
      expect(margin?.attrs[side], side).toBe('0');
    }
  });

  it('gives flow mode a readable margin, clamped so it cannot swallow a small page', async () => {
    const letter = findFirst((await open(doc([]), 'flow')).document, 'w:pgMar');
    expect(letter?.attrs['w:left']).toBe('720'); // 36pt

    const tiny = doc([]);
    (tiny.pages[0] as Page).width = 120;
    (tiny.pages[0] as Page).height = 90;
    const small = findFirst((await open(tiny, 'flow')).document, 'w:pgMar');
    expect(Number(small?.attrs['w:left'])).toBe(Math.floor(90 * 20 * 0.2));
  });

  it('gives every page its own section, so sizes can differ down the document', async () => {
    const source: Doc = {
      pages: [
        { width: 612, height: 792, elements: [] },
        { width: 792, height: 612, elements: [] },
        { width: 420, height: 595, elements: [] },
      ],
      meta: {}, assets: {}, warnings: [],
    };
    const pkg = await open(source);
    const sizes = findAll(pkg.document, 'w:pgSz').map((s) => `${s.attrs['w:w']}x${s.attrs['w:h']}`);
    expect(sizes).toEqual(['12240x15840', '15840x12240', '8400x11900']);
  });

  it('puts the last section in the body and every other one in its page’s last paragraph', async () => {
    const source: Doc = {
      pages: [{ width: 612, height: 792, elements: [] }, { width: 612, height: 792, elements: [] }],
      meta: {}, assets: {}, warnings: [],
    };
    const body = findFirst((await open(source)).document, 'w:body') as XNode;
    expect(body.children[body.children.length - 1]?.name).toBe('w:sectPr');
    // The first page's paragraph carries its own break.
    const first = body.children[0] as XNode;
    expect(first.name).toBe('w:p');
    expect(findAll(first, 'w:sectPr')).toHaveLength(1);
  });

  it('still produces a document Word can open when the model has no pages', async () => {
    const pkg = await open({ pages: [], meta: {}, assets: {}, warnings: [] });
    expect(findAll(pkg.document, 'w:p').length).toBeGreaterThan(0);
    expect(findFirst(pkg.document, 'w:pgSz')?.attrs['w:w']).toBe('12240');
  });
});

describe('runs', () => {
  /** The run properties of the first run of the document's text. */
  async function rPr(r: Run): Promise<XNode> {
    const pkg = await open(doc([text([para([r])])]));
    const node = findFirst(firstBox(pkg), 'w:rPr');
    expect(node, 'no w:rPr').toBeDefined();
    return node as XNode;
  }

  it('states the size in half-points', async () => {
    expect(findFirst(await rPr(run('x', { size: 11 })), 'w:sz')?.attrs['w:val']).toBe('22');
    expect(findFirst(await rPr(run('x', { size: 7.5 })), 'w:sz')?.attrs['w:val']).toBe('15');
  });

  it('names the font on all four scripts, so a run does not change face mid-word', async () => {
    const fonts = findFirst(await rPr(run('x', { font: 'Garamond' })), 'w:rFonts');
    expect(fonts?.attrs['w:ascii']).toBe('Garamond');
    expect(fonts?.attrs['w:hAnsi']).toBe('Garamond');
    expect(fonts?.attrs['w:cs']).toBe('Garamond');
    expect(fonts?.attrs['w:eastAsia']).toBe('Garamond');
  });

  it('carries bold, italic, underline and strike', async () => {
    const props = await rPr(run('x', { bold: true, italic: true, underline: true, strike: true }));
    const names = props.children.map((c) => c.name);
    expect(names).toContain('w:b');
    expect(names).toContain('w:i');
    expect(names).toContain('w:strike');
    expect(findFirst(props, 'w:u')?.attrs['w:val']).toBe('single');
  });

  it('prefers all-caps over small-caps, which Word treats as exclusive', async () => {
    const both = (await rPr(run('x', { allCaps: true, smallCaps: true }))).children.map((c) => c.name);
    expect(both).toContain('w:caps');
    expect(both).not.toContain('w:smallCaps');
    const small = (await rPr(run('x', { smallCaps: true }))).children.map((c) => c.name);
    expect(small).toContain('w:smallCaps');
  });

  it('strips the hash from a colour', async () => {
    expect(findFirst(await rPr(run('x', { color: '#1a2B3c' })), 'w:color')?.attrs['w:val']).toBe('1A2B3C');
  });

  it('carries Publisher’s outline, relief and shadow effects', async () => {
    expect((await rPr(run('x', { outline: true }))).children.map((c) => c.name)).toContain('w:outline');
    expect((await rPr(run('x', { textShadow: true }))).children.map((c) => c.name)).toContain('w:shadow');
    expect((await rPr(run('x', { relief: 'embossed' }))).children.map((c) => c.name)).toContain('w:emboss');
    expect((await rPr(run('x', { relief: 'engraved' }))).children.map((c) => c.name)).toContain('w:imprint');
  });

  it('carries character width scaling as a whole percentage', async () => {
    expect(findFirst(await rPr(run('x', { textScale: 80 })), 'w:w')?.attrs['w:val']).toBe('80');
  });

  it('reads a real shift as a superscript and a small one as a raised baseline', async () => {
    const up = await rPr(run('x', { baselineShift: 33, size: 12 }));
    expect(findFirst(up, 'w:vertAlign')?.attrs['w:val']).toBe('superscript');
    expect(findAll(up, 'w:position')).toHaveLength(0);

    const down = await rPr(run('x', { baselineShift: -33 }));
    expect(findFirst(down, 'w:vertAlign')?.attrs['w:val']).toBe('subscript');

    // 5% of 12pt is 0.6pt, which is kerning, not a superscript.
    const nudge = await rPr(run('x', { baselineShift: 5, size: 12 }));
    expect(findAll(nudge, 'w:vertAlign')).toHaveLength(0);
    expect(findFirst(nudge, 'w:position')?.attrs['w:val']).toBe('1');
  });

  it('carries a language tag it recognises and drops one it does not', async () => {
    expect(findFirst(await rPr(run('x', { lang: 'de-DE' })), 'w:lang')?.attrs['w:val']).toBe('de-DE');
    expect(findAll(await rPr(run('x', { lang: 'not a language' })), 'w:lang')).toHaveLength(0);
  });

  it('orders run properties the way the schema does, which Word enforces', async () => {
    const props = await rPr(run('x', {
      bold: true, italic: true, allCaps: true, strike: true, outline: true, textShadow: true,
      relief: 'embossed', color: '#112233', textScale: 90, underline: true, baselineShift: 40,
      lang: 'en-GB', size: 10,
    }));
    expect(props.children.map((c) => c.name)).toEqual([
      'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps', 'w:strike', 'w:outline', 'w:shadow',
      'w:emboss', 'w:color', 'w:w', 'w:sz', 'w:szCs', 'w:u', 'w:vertAlign', 'w:lang',
    ]);
  });

  it('turns tabs and newlines into the elements Word has for them', async () => {
    const pkg = await open(doc([text([para([run('a\tb\nc\r\nd')])])]));
    const r = findFirst(firstBox(pkg), 'w:r') as XNode;
    expect(r.children.map((c) => c.name)).toEqual([
      'w:rPr', 'w:t', 'w:tab', 'w:t', 'w:br', 'w:t', 'w:br', 'w:t',
    ]);
    expect(findAll(r, 'w:t').map((t) => t.text)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('treats Publisher’s vertical tab as the line break it is', async () => {
    const pkg = await open(doc([text([para([run('ab')])])]));
    expect(findAll(firstBox(pkg), 'w:br')).toHaveLength(1);
  });

  it('preserves the spaces at the edges of a run', async () => {
    const pkg = await open(doc([text([para([run('  padded  ')])])]));
    const t = findFirst(firstBox(pkg), 'w:t');
    expect(t?.attrs['xml:space']).toBe('preserve');
    expect(t?.text).toBe('  padded  ');
  });

  it('escapes the characters that would otherwise end the part', async () => {
    const pkg = await open(doc([text([para([run('Ben & Jerry <3 "quotes"')])])]));
    expect(findFirst(firstBox(pkg), 'w:t')?.text).toBe('Ben & Jerry <3 "quotes"');
    expect(pkg.parts['word/document.xml']).toContain('Ben &amp; Jerry &lt;3');
  });

  it('strips the control characters Publisher leaves in its text', async () => {
    const pkg = await open(doc([text([para([run('abcd')])])]));
    expect(findAll(firstBox(pkg), 'w:t').map((t) => t.text).join('')).toBe('abcd');
  });

  it('keeps a run that is only whitespace and drops one that is only control codes', async () => {
    const spaces = await open(doc([text([para([run(' ')])])]));
    expect(findAll(firstBox(spaces), 'w:r')).toHaveLength(1);
    const control = await open(doc([text([para([run('')])])]));
    expect(findAll(firstBox(control), 'w:r')).toHaveLength(0);
  });
});

describe('paragraphs', () => {
  async function pPr(p: Paragraph): Promise<XNode> {
    const pkg = await open(doc([text([p])]));
    const node = findFirst(findFirst(pkg.document, 'w:txbxContent') as XNode, 'w:pPr');
    expect(node, 'no w:pPr').toBeDefined();
    return node as XNode;
  }

  it('maps alignment onto Word’s names, including justify', async () => {
    for (const [align, val] of [['left', 'left'], ['center', 'center'], ['right', 'right'], ['justify', 'both']] as const) {
      const node = await pPr(para([run('x')], { align }));
      expect(findFirst(node, 'w:jc')?.attrs['w:val'], align).toBe(val);
    }
  });

  it('states a line-height multiplier as a multiple of a single line', async () => {
    const spacing = findFirst(await pPr(para([run('x')], { lineHeight: 1.15 })), 'w:spacing');
    expect(spacing?.attrs['w:line']).toBe('276'); // 240 * 1.15
    expect(spacing?.attrs['w:lineRule']).toBe('auto');
  });

  it('states paragraph space before and after in twips', async () => {
    const spacing = findFirst(await pPr(para([run('x')], { marginTop: 6, marginBottom: 3 })), 'w:spacing');
    expect(spacing?.attrs['w:before']).toBe('120');
    expect(spacing?.attrs['w:after']).toBe('60');
  });

  it('splits the one indent field into Word’s two', async () => {
    const first = findFirst(await pPr(para([run('x')], { textIndent: 18 })), 'w:ind');
    expect(first?.attrs['w:firstLine']).toBe('360');
    expect(first?.attrs['w:hanging']).toBeUndefined();

    const hanging = findFirst(await pPr(para([run('x')], { textIndent: -18 })), 'w:ind');
    expect(hanging?.attrs['w:hanging']).toBe('360');
    expect(hanging?.attrs['w:firstLine']).toBeUndefined();
  });

  it('carries left and right indents', async () => {
    const ind = findFirst(await pPr(para([run('x')], { marginLeft: 36, marginRight: 9 })), 'w:ind');
    expect(ind?.attrs['w:left']).toBe('720');
    expect(ind?.attrs['w:right']).toBe('180');
  });

  it('orders paragraph properties the way the schema does', async () => {
    const node = await pPr(para([run('x')], {
      list: { type: 'ordered', level: 1 }, lineHeight: 1.5, marginLeft: 12, align: 'center',
    }));
    expect(node.children.map((c) => c.name)).toEqual(['w:numPr', 'w:spacing', 'w:ind', 'w:jc']);
  });

  it('builds real Word lists rather than typing a bullet character', async () => {
    const pkg = await open(doc([text([
      para([run('one')], { list: { type: 'unordered', level: 0 } }),
      para([run('two')], { list: { type: 'ordered', level: 2 } }),
    ])]));
    expect(pkg.files).toContain('word/numbering.xml');
    const numPr = findAll(pkg.document, 'w:numPr');
    expect(findFirst(numPr[0] as XNode, 'w:ilvl')?.attrs['w:val']).toBe('0');
    expect(findFirst(numPr[0] as XNode, 'w:numId')?.attrs['w:val']).toBe('1');
    expect(findFirst(numPr[1] as XNode, 'w:ilvl')?.attrs['w:val']).toBe('2');
    expect(findFirst(numPr[1] as XNode, 'w:numId')?.attrs['w:val']).toBe('2');
    // The bullet is a list marker, not text in the run.
    expect(allText(pkg.document)).not.toContain('•');

    const numbering = pkg.part('word/numbering.xml');
    expect(findAll(numbering, 'w:abstractNum')).toHaveLength(2);
    const formats = new Set(findAll(numbering, 'w:numFmt').map((f) => f.attrs['w:val']));
    expect(formats).toEqual(new Set(['bullet', 'decimal']));
    // The numbering part must actually be reachable from the document.
    const rels = findAll(pkg.part('word/_rels/document.xml.rels'), 'Relationship');
    expect(rels.some((r) => r.attrs.Target === 'numbering.xml')).toBe(true);
  });

  it('gives an empty text box the paragraph Word requires it to have', async () => {
    const pkg = await open(doc([text([])]));
    expect(findAll(findFirst(pkg.document, 'w:txbxContent') as XNode, 'w:p')).toHaveLength(1);
  });
});

describe('layout mode', () => {
  it('anchors to the page, so margins cannot move the content', async () => {
    const pkg = await open(doc([text([para([run('x')])], { x: 72, y: 144 })]));
    const [anchor] = anchors(pkg);
    expect(attr(findFirst(anchor as XNode, 'wp:positionH'), 'relativeFrom')).toBe('page');
    expect(attr(findFirst(anchor as XNode, 'wp:positionV'), 'relativeFrom')).toBe('page');
    const offsets = findAll(anchor as XNode, 'wp:posOffset').map((o) => o.text);
    expect(offsets).toEqual(['914400', '1828800']); // 72pt and 144pt in EMU
  });

  it('sizes the drawing in EMU', async () => {
    const pkg = await open(doc([text([para([run('x')])], { width: 100, height: 25 })]));
    const extent = findFirst(anchors(pkg)[0] as XNode, 'wp:extent');
    expect(extent?.attrs.cx).toBe('1270000');
    expect(extent?.attrs.cy).toBe('317500');
  });

  it('gives a zero-sized element a hairline, because nothing is painted at zero', async () => {
    const pkg = await open(doc([shape({ type: 'polyline', points: [{ x: 0, y: 40 }, { x: 200, y: 40 }] },
      { x: 0, y: 40, width: 200, height: 0 })]));
    const extent = findFirst(anchors(pkg)[0] as XNode, 'wp:extent');
    expect(extent?.attrs.cx).toBe('2540000');
    expect(Number(extent?.attrs.cy)).toBeGreaterThan(0);
  });

  it('lets boxes overlap and does not wrap text round them', async () => {
    const pkg = await open(doc([text([para([run('x')])])]));
    const [anchor] = anchors(pkg);
    expect((anchor as XNode).attrs.allowOverlap).toBe('1');
    expect((anchor as XNode).attrs.behindDoc).toBe('0');
    expect(findAll(anchor as XNode, 'wp:wrapNone')).toHaveLength(1);
  });

  it('numbers the z-order from Word’s own base, which readers honour', async () => {
    const pkg = await open(doc([
      shape({ type: 'rect' }), text([para([run('over')])]), shape({ type: 'ellipse' }),
    ]));
    const heights = anchors(pkg).map((a) => Number(a.attrs.relativeHeight));
    expect(heights[0]).toBe(0x0f000000);
    expect(heights).toEqual([...heights].sort((a, b) => a - b));
    expect(new Set(heights).size).toBe(heights.length);
  });

  it('gives every shape a text body, so shapes and text boxes share one z-order', async () => {
    const pkg = await open(doc([
      shape({ type: 'rect' }), text([para([run('over')])]), shape({ type: 'ellipse' }),
    ]));
    const shapes = findAll(pkg.document, 'wps:wsp');
    expect(shapes).toHaveLength(3);
    for (const s of shapes) {
      expect(findAll(s, 'wps:txbx'), 'a shape with no text body jumps the z-order').toHaveLength(1);
      expect(findFirst(s, 'wps:cNvSpPr')?.attrs.txBox).toBe('1');
    }
  });

  it('gives each drawing a unique, non-zero id', async () => {
    const pkg = await open(doc([shape({ type: 'rect' }), text([para([run('x')])])]));
    const ids = findAll(pkg.document, 'wp:docPr').map((d) => Number(d.attrs.id));
    expect(ids.every((i) => i > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rotates about the box centre, in sixty-thousandths of a degree', async () => {
    const clockwise = await open(doc([text([para([run('x')])], { rotation: 30 })]));
    expect(findFirst(clockwise.document, 'a:xfrm')?.attrs.rot).toBe('1800000');
    // A negative angle is normalised into the positive turn Word expects.
    const back = await open(doc([text([para([run('x')])], { rotation: -30 })]));
    expect(findFirst(back.document, 'a:xfrm')?.attrs.rot).toBe('19800000');
  });

  it('carries the text insets and the vertical anchor', async () => {
    const pkg = await open(doc([text([para([run('x')])], {
      padding: { top: 1, right: 2, bottom: 3, left: 4 }, verticalAlign: 'middle',
    })]));
    const body = findFirst(pkg.document, 'wps:bodyPr');
    expect(body?.attrs.tIns).toBe('12700');
    expect(body?.attrs.rIns).toBe('25400');
    expect(body?.attrs.bIns).toBe('38100');
    expect(body?.attrs.lIns).toBe('50800');
    expect(body?.attrs.anchor).toBe('ctr');
  });

  it('anchors to the bottom when the model says so', async () => {
    const pkg = await open(doc([text([para([run('x')])], { verticalAlign: 'bottom' })]));
    expect(findFirst(pkg.document, 'wps:bodyPr')?.attrs.anchor).toBe('b');
  });

  it('keeps the columns of a multi-column text box, and says who will honour them', async () => {
    const pkg = await open(doc([text([para([run('x')])], { columns: { count: 3, gap: 12 } })]));
    const body = findFirst(pkg.document, 'wps:bodyPr');
    expect(body?.attrs.numCol).toBe('3');
    expect(body?.attrs.spcCol).toBe('152400');
    expect(pkg.warnings.map((w) => w.code)).toContain('COLUMNS_FLATTENED');
  });

  it('flattens a group into its children, which already carry page coordinates', async () => {
    const pkg = await open(doc([{
      kind: 'group', x: 0, y: 0, width: 200, height: 100,
      children: [text([para([run('a')])], { x: 10, y: 10 }), text([para([run('b')])], { x: 60, y: 10 })],
    } as Element]));
    // Two children, no wrapper: a group with no fill of its own adds no drawing.
    expect(anchors(pkg)).toHaveLength(2);
    expect(allText(pkg.document)).toContain('a');
    expect(allText(pkg.document)).toContain('b');
  });

  it('keeps a group’s own backing fill behind its children', async () => {
    const pkg = await open(doc([{
      kind: 'group', x: 0, y: 0, width: 200, height: 100,
      style: { fill: { type: 'solid', color: '#ff0000' } },
      children: [text([para([run('a')])], { x: 10, y: 10 })],
    } as Element]));
    expect(anchors(pkg)).toHaveLength(2);
    expect(findFirst(pkg.document, 'a:srgbClr')?.attrs.val).toBe('FF0000');
  });
});

describe('shapes', () => {
  async function spPr(geometry: Geometry, style?: ShapeStyle, box?: Record<string, number>): Promise<XNode> {
    const pkg = await open(doc([shape(geometry, { ...(style ? { style } : {}), ...box })]));
    return findFirst(pkg.document, 'wps:spPr') as XNode;
  }

  it('uses Word’s built-in geometries where there is one', async () => {
    expect(findFirst(await spPr({ type: 'rect' }), 'a:prstGeom')?.attrs.prst).toBe('rect');
    expect(findFirst(await spPr({ type: 'ellipse' }), 'a:prstGeom')?.attrs.prst).toBe('ellipse');
  });

  it('turns a corner radius into the rounded rectangle’s adjustment', async () => {
    // 15pt radius on a 60pt-tall box: 15/60 of the full 100000.
    const node = await spPr({ type: 'rect', rx: 15, ry: 15 });
    expect(findFirst(node, 'a:prstGeom')?.attrs.prst).toBe('roundRect');
    expect(findFirst(node, 'a:gd')?.attrs.fmla).toBe('val 25000');
  });

  it('caps the corner radius at a full round', async () => {
    const node = await spPr({ type: 'rect', rx: 500, ry: 500 });
    expect(findFirst(node, 'a:gd')?.attrs.fmla).toBe('val 50000');
  });

  it('draws a polygon as a closed custom path in the box’s own space', async () => {
    const node = await spPr(
      { type: 'polygon', points: [{ x: 10, y: 10 }, { x: 60, y: 10 }, { x: 35, y: 50 }] },
      undefined, { x: 10, y: 10, width: 50, height: 40 });
    const path = findFirst(node, 'a:path') as XNode;
    expect(path.attrs.w).toBe('635000'); // 50pt
    expect(path.attrs.h).toBe('508000'); // 40pt
    expect(path.children.map((c) => c.name)).toEqual(['a:moveTo', 'a:lnTo', 'a:lnTo', 'a:close']);
    const first = findFirst(path.children[0] as XNode, 'a:pt');
    expect(first?.attrs.x).toBe('0'); // the box corner, not the page's
    expect(first?.attrs.y).toBe('0');
  });

  it('leaves a polyline open and unfilled, whatever the style says', async () => {
    const node = await spPr(
      { type: 'polyline', points: [{ x: 0, y: 0 }, { x: 100, y: 60 }] },
      { fill: { type: 'solid', color: '#ff0000' } });
    const path = findFirst(node, 'a:path') as XNode;
    expect(path.attrs.fill).toBe('none');
    expect(path.children.map((c) => c.name)).toEqual(['a:moveTo', 'a:lnTo']);
  });

  it('carries every curve command a path can hold', async () => {
    const node = await spPr({
      type: 'path',
      d: [
        { op: 'M', x: 0, y: 0 },
        { op: 'L', x: 50, y: 0 },
        { op: 'C', x1: 60, y1: 10, x2: 70, y2: 20, x: 80, y: 30 },
        { op: 'Q', x1: 90, y1: 40, x: 100, y: 50 },
        { op: 'Z' },
      ],
    });
    expect((findFirst(node, 'a:path') as XNode).children.map((c) => c.name))
      .toEqual(['a:moveTo', 'a:lnTo', 'a:cubicBezTo', 'a:quadBezTo', 'a:close']);
  });

  it('rebuilds an arc out of cubics, since Word parameterises arcs differently', async () => {
    const node = await spPr({
      type: 'path',
      d: [
        { op: 'M', x: 0, y: 30 },
        { op: 'A', rx: 30, ry: 30, rotation: 0, largeArc: true, sweep: true, x: 60, y: 30 },
        { op: 'Z' },
      ],
    }, undefined, { x: 0, y: 0, width: 60, height: 60 });
    const path = findFirst(node, 'a:path') as XNode;
    const kinds = path.children.map((c) => c.name);
    expect(kinds[0]).toBe('a:moveTo');
    expect(kinds.filter((k) => k === 'a:cubicBezTo').length).toBeGreaterThanOrEqual(2);
    // A half-turn of a 30pt circle passes through the top of the box.
    const ys = findAll(path, 'a:pt').map((p) => Number(p.attrs.y));
    expect(Math.min(...ys)).toBeLessThan(12700 * 5);
  });

  it('treats a zero-radius arc as the straight line the SVG rule makes it', async () => {
    const node = await spPr({
      type: 'path',
      d: [{ op: 'M', x: 0, y: 0 }, { op: 'A', rx: 0, ry: 0, rotation: 0, largeArc: false, sweep: false, x: 50, y: 50 }],
    });
    expect(findAll(findFirst(node, 'a:path') as XNode, 'a:cubicBezTo')).toHaveLength(1);
  });

  it('falls back to the frame when a geometry carries no points at all', async () => {
    const node = await spPr({ type: 'polygon', points: [] });
    expect(findFirst(node, 'a:prstGeom')?.attrs.prst).toBe('rect');
    expect(findAll(node, 'a:custGeom')).toHaveLength(0);
  });

  it('gives an unstyled shape no fill and no line, rather than Word’s defaults', async () => {
    const node = await spPr({ type: 'rect' });
    expect(findAll(node, 'a:noFill')).toHaveLength(2); // one for the fill, one inside a:ln
  });

  it('carries a gradient with its angle and stops', async () => {
    const node = await spPr({ type: 'rect' }, {
      fill: {
        type: 'gradient', angle: 45,
        stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }],
      },
    });
    const gradient = findFirst(node, 'a:gradFill') as XNode;
    expect(findFirst(gradient, 'a:lin')?.attrs.ang).toBe('2700000');
    expect(findAll(gradient, 'a:gs').map((g) => g.attrs.pos)).toEqual(['0', '100000']);
    expect(findAll(gradient, 'a:srgbClr').map((c) => c.attrs.val)).toEqual(['FF0000', '0000FF']);
  });

  it('sorts gradient stops, which DrawingML expects in order', async () => {
    const node = await spPr({ type: 'rect' }, {
      fill: {
        type: 'gradient', angle: 0,
        stops: [{ offset: 1, color: '#0000ff' }, { offset: 0.5, color: '#00ff00' }, { offset: 0, color: '#ff0000' }],
      },
    });
    expect(findAll(node, 'a:gs').map((g) => Number(g.attrs.pos))).toEqual([0, 50000, 100000]);
  });

  it('flattens a gradient that has too few stops to be one, and says so', async () => {
    const pkg = await open(doc([shape({ type: 'rect' }, {
      style: { fill: { type: 'gradient', angle: 0, stops: [{ offset: 0, color: '#123456' }] } },
    })]));
    expect(findFirst(pkg.document, 'a:solidFill')).toBeDefined();
    expect(findFirst(pkg.document, 'a:srgbClr')?.attrs.val).toBe('123456');
    expect(pkg.warnings.map((w) => w.code)).toContain('GRADIENT_FLATTENED');
  });

  it('folds element opacity into the colours it paints with', async () => {
    const node = await spPr({ type: 'rect' }, {
      fill: { type: 'solid', color: '#ff0000' }, opacity: 0.4,
    });
    expect(findFirst(node, 'a:alpha')?.attrs.val).toBe('40000');
  });

  it('carries a stroke with its width in EMU', async () => {
    const node = await spPr({ type: 'rect' }, { stroke: { color: '#003366', width: 1.5 } });
    const line = findFirst(node, 'a:ln') as XNode;
    expect(line.attrs.w).toBe('19050');
    expect(findFirst(line, 'a:srgbClr')?.attrs.val).toBe('003366');
  });

  it('matches a dash pattern to the nearest of Word’s presets', async () => {
    const dotted = await spPr({ type: 'rect' }, { stroke: { color: '#000000', width: 2, dash: [1, 2] } });
    expect(findFirst(dotted, 'a:prstDash')?.attrs.val).toBe('dot');
    const dashed = await spPr({ type: 'rect' }, { stroke: { color: '#000000', width: 1, dash: [4, 3] } });
    expect(findFirst(dashed, 'a:prstDash')?.attrs.val).toBe('dash');
    const long = await spPr({ type: 'rect' }, { stroke: { color: '#000000', width: 1, dash: [12, 4] } });
    expect(findFirst(long, 'a:prstDash')?.attrs.val).toBe('lgDash');
    const dashDot = await spPr({ type: 'rect' }, { stroke: { color: '#000000', width: 1, dash: [4, 2, 1, 2] } });
    expect(findFirst(dashDot, 'a:prstDash')?.attrs.val).toBe('dashDot');
  });

  it('turns a shadow offset into a distance and a direction', async () => {
    // 3pt right and 3pt down is 45 degrees clockwise.
    const node = await spPr({ type: 'rect' }, {
      fill: { type: 'solid', color: '#ffffff' },
      shadow: { color: '#808080', offsetX: 3, offsetY: 3, opacity: 0.5 },
    });
    const shadow = findFirst(node, 'a:outerShdw') as XNode;
    expect(shadow.attrs.dir).toBe('2700000');
    expect(Number(shadow.attrs.dist)).toBe(Math.round(Math.hypot(3, 3) * 12700));
    expect(findFirst(shadow, 'a:alpha')?.attrs.val).toBe('50000');
  });
});

describe('tables', () => {
  const grid = [72, 72, 72];

  it('declares the column grid in twips', async () => {
    const pkg = await open(doc([table([{ height: 20, cells: [cell(0, 0, 'a'), cell(0, 1, 'b'), cell(0, 2, 'c')] }], grid)]));
    expect(findAll(pkg.document, 'w:gridCol').map((c) => c.attrs['w:w'])).toEqual(['1440', '1440', '1440']);
    expect(findFirst(pkg.document, 'w:tblW')?.attrs['w:w']).toBe('4320');
  });

  it('keeps the measured widths instead of letting Word re-balance them', async () => {
    const pkg = await open(doc([table([{ cells: [cell(0, 0, 'a'), cell(0, 1, 'b'), cell(0, 2, 'c')] }], grid)]));
    expect(findFirst(pkg.document, 'w:tblLayout')?.attrs['w:type']).toBe('fixed');
  });

  it('turns a column span into gridSpan and drops the covered cells', async () => {
    const pkg = await open(doc([table([{
      cells: [
        cell(0, 0, 'wide', { colSpan: 2 }),
        cell(0, 1, '', { covered: true }),
        cell(0, 2, 'c'),
      ],
    }], grid)]));
    const cells = findAll(pkg.document, 'w:tc');
    expect(cells).toHaveLength(2);
    expect(findFirst(cells[0] as XNode, 'w:gridSpan')?.attrs['w:val']).toBe('2');
    expect(findFirst(cells[0] as XNode, 'w:tcW')?.attrs['w:w']).toBe('2880');
    expect(allText(cells[0] as XNode)).toBe('wide');
  });

  it('turns a row span into a vMerge that starts once and continues after', async () => {
    const pkg = await open(doc([table([
      { cells: [cell(0, 0, 'tall', { rowSpan: 2 }), cell(0, 1, 'b'), cell(0, 2, 'c')] },
      { cells: [cell(1, 0, '', { covered: true }), cell(1, 1, 'e'), cell(1, 2, 'f')] },
    ], grid)]));
    const rows = findAll(pkg.document, 'w:tr');
    expect(rows).toHaveLength(2);
    // Word needs a cell in every row of the merge, or the row comes up short.
    expect(findAll(rows[0] as XNode, 'w:tc')).toHaveLength(3);
    expect(findAll(rows[1] as XNode, 'w:tc')).toHaveLength(3);
    expect(findFirst(findAll(rows[0] as XNode, 'w:tc')[0] as XNode, 'w:vMerge')?.attrs['w:val']).toBe('restart');
    const continuation = findFirst(findAll(rows[1] as XNode, 'w:tc')[0] as XNode, 'w:vMerge') as XNode;
    expect(continuation.attrs['w:val']).toBeUndefined();
    // The text belongs to the row the merge started in.
    expect(allText(findAll(rows[1] as XNode, 'w:tc')[0] as XNode)).toBe('');
  });

  it('handles a cell that spans in both directions at once', async () => {
    const pkg = await open(doc([table([
      { cells: [cell(0, 0, 'block', { rowSpan: 2, colSpan: 2 }), cell(0, 1, '', { covered: true }), cell(0, 2, 'c')] },
      {
        cells: [
          cell(1, 0, '', { covered: true }), cell(1, 1, '', { covered: true }), cell(1, 2, 'f'),
        ],
      },
    ], grid)]));
    const rows = findAll(pkg.document, 'w:tr');
    const first = findAll(rows[0] as XNode, 'w:tc');
    const second = findAll(rows[1] as XNode, 'w:tc');
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(findFirst(first[0] as XNode, 'w:gridSpan')?.attrs['w:val']).toBe('2');
    expect(findFirst(second[0] as XNode, 'w:gridSpan')?.attrs['w:val']).toBe('2');
    expect(findFirst(second[0] as XNode, 'w:vMerge')?.attrs['w:val']).toBeUndefined();
  });

  it('fills a grid position no cell claims, so the row is not short', async () => {
    const pkg = await open(doc([table([{ cells: [cell(0, 0, 'a'), cell(0, 2, 'c')] }], grid)]));
    const cells = findAll(findFirst(pkg.document, 'w:tr') as XNode, 'w:tc');
    expect(cells).toHaveLength(3);
    expect(allText(cells[1] as XNode)).toBe('');
  });

  it('widens the grid to fit a cell that reaches past the declared columns', async () => {
    const pkg = await open(doc([table([{ cells: [cell(0, 0, 'a'), cell(0, 1, 'b'), cell(0, 2, 'c')] }], [72, 72])]));
    expect(findAll(pkg.document, 'w:gridCol')).toHaveLength(3);
  });

  it('states a row height as a floor, so text is never clipped to reach it', async () => {
    const pkg = await open(doc([table([{ height: 17.7, cells: [cell(0, 0, 'a'), cell(0, 1, 'b'), cell(0, 2, 'c')] }], grid)]));
    const height = findFirst(pkg.document, 'w:trHeight');
    expect(height?.attrs['w:val']).toBe('354');
    expect(height?.attrs['w:hRule']).toBe('atLeast');
  });

  it('draws the table borders from the table’s stroke', async () => {
    const pkg = await open(doc([table([{ cells: [cell(0, 0, 'a')] }], [72], {
      style: { stroke: { color: '#112233', width: 1 } },
    })]));
    const borders = findFirst(pkg.document, 'w:tblBorders') as XNode;
    expect(borders.children.map((c) => c.name))
      .toEqual(['w:top', 'w:left', 'w:bottom', 'w:right', 'w:insideH', 'w:insideV']);
    expect(borders.children[0]?.attrs['w:sz']).toBe('8'); // eighths of a point
    expect(borders.children[0]?.attrs['w:color']).toBe('112233');
  });

  it('insets cell text vertically without inflating the row', async () => {
    // A vertical w:tblCellMar is added on top of w:trHeight rather than inside it, so the
    // inset goes on the cell's paragraphs. Putting it back in tblCellMar makes every row
    // 5.8pt too tall and slides the rest of the table down the page.
    const pkg = await open(doc([table([
      { height: 17.7, cells: [cell(0, 0, 'a')] },
      { height: 17.7, cells: [cell(1, 0, 'b')] },
    ], [72])]));
    const margins = findFirst(pkg.document, 'w:tblCellMar') as XNode;
    expect(findFirst(margins, 'w:top')?.attrs['w:w']).toBe('0');
    expect(findFirst(margins, 'w:bottom')?.attrs['w:w']).toBe('0');
    expect(findFirst(margins, 'w:left')?.attrs['w:w']).toBe('58'); // 2.9pt
    const spacing = findFirst(findFirst(pkg.document, 'w:tc') as XNode, 'w:spacing');
    expect(spacing?.attrs['w:before']).toBe('58');
    expect(spacing?.attrs['w:after']).toBe('58');
  });

  it('adds the cell inset to the paragraph’s own spacing rather than replacing it', async () => {
    const pkg = await open(doc([table([{
      cells: [cell(0, 0, '', { paragraphs: [para([run('a')], { marginTop: 6, marginBottom: 3 })] })],
    }], [72])]));
    const spacing = findFirst(findFirst(pkg.document, 'w:tc') as XNode, 'w:spacing');
    expect(spacing?.attrs['w:before']).toBe('178'); // (6 + 2.9)pt
    expect(spacing?.attrs['w:after']).toBe('118'); // (3 + 2.9)pt
  });

  it('insets only the outermost paragraphs of a cell', async () => {
    const pkg = await open(doc([table([{
      cells: [cell(0, 0, '', {
        paragraphs: [para([run('a')]), para([run('b')]), para([run('c')])],
      })],
    }], [72])]));
    const spacings = findAll(findFirst(pkg.document, 'w:tc') as XNode, 'w:spacing');
    expect(spacings).toHaveLength(2);
    expect(spacings[0]?.attrs['w:before']).toBe('58');
    expect(spacings[0]?.attrs['w:after']).toBeUndefined();
    expect(spacings[1]?.attrs['w:after']).toBe('58');
    expect(spacings[1]?.attrs['w:before']).toBeUndefined();
  });

  it('shades a cell from its own fill', async () => {
    const pkg = await open(doc([table([{
      cells: [cell(0, 0, 'a', { style: { fill: { type: 'solid', color: '#ffee00' } } })],
    }], [72])]));
    expect(findFirst(pkg.document, 'w:shd')?.attrs['w:fill']).toBe('FFEE00');
  });

  it('orders cell properties the way the schema does', async () => {
    const pkg = await open(doc([table([
      {
        cells: [cell(0, 0, 'a', {
          colSpan: 2, rowSpan: 2,
          style: { fill: { type: 'solid', color: '#ffffff' }, stroke: { color: '#000000', width: 1 } },
        }), cell(0, 1, '', { covered: true })],
      },
      { cells: [cell(1, 0, '', { covered: true }), cell(1, 1, '', { covered: true })] },
    ], [72, 72])]));
    expect((findFirst(pkg.document, 'w:tcPr') as XNode).children.map((c) => c.name))
      .toEqual(['w:tcW', 'w:gridSpan', 'w:vMerge', 'w:tcBorders', 'w:shd']);
  });

  it('gives an empty cell the paragraph Word requires it to have', async () => {
    const pkg = await open(doc([table([{ cells: [cell(0, 0, '')] }], [72])]));
    expect(findAll(findFirst(pkg.document, 'w:tc') as XNode, 'w:p')).toHaveLength(1);
  });

  it('frames a table in an anchored text box, the only way Word can pin one to a page', async () => {
    const pkg = await open(doc([table([{ cells: [cell(0, 0, 'a')] }], [72], { x: 90, y: 100 })]));
    const [anchor] = anchors(pkg);
    expect(findAll(anchor as XNode, 'w:tbl')).toHaveLength(1);
    expect(findAll(anchor as XNode, 'wp:posOffset').map((o) => o.text)).toEqual(['1143000', '1270000']);
    // A text box may not end with a table; Word refuses to open the document if it does.
    const content = findFirst(anchor as XNode, 'w:txbxContent') as XNode;
    expect(content.children[content.children.length - 1]?.name).toBe('w:p');
  });
});

describe('pictures', () => {
  const withAsset = (mime: string, data = PNG_BASE64): Doc => doc(
    [{ kind: 'image', x: 36, y: 48, width: 72, height: 54, assetRef: 'a1' } as Element],
    { assets: { a1: { data, mime } } },
  );

  it('writes the bytes into the package and points a relationship at them', async () => {
    const pkg = await open(withAsset('image/png'));
    expect(pkg.files).toContain('word/media/image1.png');
    expect(pkg.binary['word/media/image1.png']?.length).toBeGreaterThan(20);

    const rel = findAll(pkg.part('word/_rels/document.xml.rels'), 'Relationship')
      .find((r) => r.attrs.Target === 'media/image1.png');
    expect(rel?.attrs.Id).toBeDefined();
    expect(findFirst(pkg.document, 'a:blip')?.attrs['r:embed']).toBe(rel?.attrs.Id);
  });

  it('writes one part per asset, however many elements use it', async () => {
    const source = doc([
      { kind: 'image', x: 0, y: 0, width: 10, height: 10, assetRef: 'a1' } as Element,
      { kind: 'image', x: 20, y: 0, width: 10, height: 10, assetRef: 'a1' } as Element,
    ], { assets: { a1: { data: PNG_BASE64, mime: 'image/png' } } });
    const pkg = await open(source);
    expect(pkg.files.filter((f) => f.startsWith('word/media/'))).toEqual(['word/media/image1.png']);
    expect(findAll(pkg.document, 'a:blip').map((b) => b.attrs['r:embed'])).toEqual(
      findAll(pkg.document, 'a:blip').map(() => findFirst(pkg.document, 'a:blip')?.attrs['r:embed']));
  });

  it('anchors a picture at its own position in layout mode', async () => {
    const pkg = await open(withAsset('image/png'), 'layout');
    expect(findAll(pkg.document, 'pic:pic')).toHaveLength(1);
    expect(findAll(anchors(pkg)[0] as XNode, 'wp:posOffset').map((o) => o.text)).toEqual(['457200', '609600']);
    const extent = findFirst(anchors(pkg)[0] as XNode, 'wp:extent');
    expect(extent?.attrs.cx).toBe('914400');
  });

  it('places a picture in the text in flow mode', async () => {
    const pkg = await open(withAsset('image/png'), 'flow');
    expect(anchors(pkg)).toHaveLength(0);
    expect(inlines(pkg)).toHaveLength(1);
  });

  it('scales a picture down to the text column rather than off the page', async () => {
    const source = doc(
      [{ kind: 'image', x: 0, y: 0, width: 1000, height: 500, assetRef: 'a1' } as Element],
      { assets: { a1: { data: PNG_BASE64, mime: 'image/png' } } },
    );
    const extent = findFirst((await open(source, 'flow')).document, 'wp:extent');
    // 612pt page less two 36pt margins is 540pt of column.
    expect(Number(extent?.attrs.cx)).toBe(540 * 12700);
    expect(Number(extent?.attrs.cy)).toBe(270 * 12700);
  });

  it('paints an image-filled shape as the picture it is', async () => {
    const pkg = await open(doc([shape({ type: 'ellipse' }, {
      style: { fill: { type: 'image', assetRef: 'a1', repeat: 'stretch' } },
    })], { assets: { a1: { data: PNG_BASE64, mime: 'image/png' } } }));
    expect(findFirst(pkg.document, 'a:prstGeom')?.attrs.prst).toBe('ellipse');
    expect(findAll(pkg.document, 'a:blipFill')).toHaveLength(1);
    expect(findAll(pkg.document, 'a:stretch')).toHaveLength(1);
  });

  it('tiles a repeating fill and stretches every other kind', async () => {
    const tiled = await open(doc([shape({ type: 'rect' }, {
      style: { fill: { type: 'image', assetRef: 'a1', repeat: 'repeat' } },
    })], { assets: { a1: { data: PNG_BASE64, mime: 'image/png' } } }));
    expect(findAll(tiled.document, 'a:tile')).toHaveLength(1);

    const once = await open(doc([shape({ type: 'rect' }, {
      style: { fill: { type: 'image', assetRef: 'a1', repeat: 'none' } },
    })], { assets: { a1: { data: PNG_BASE64, mime: 'image/png' } } }));
    expect(findAll(once.document, 'a:stretch')).toHaveLength(1);
  });

  it('leaves a Windows metafile out, marks its place and says why', async () => {
    const pkg = await open(withAsset('image/wmf', 'zRUAAAAA'));
    expect(pkg.files.some((f) => f.startsWith('word/media/'))).toBe(false);
    expect(findAll(pkg.document, 'pic:pic')).toHaveLength(0);
    // The reader sees the gap in the document, not only in a callback.
    expect(allText(pkg.document)).toContain('Windows metafile');
    const warning = pkg.warnings.find((w) => w.code === 'WMF_IMAGE_NOT_CONVERTED');
    expect(warning?.message).toContain('Word cannot display');
  });

  it('says so in the text in flow mode too', async () => {
    const pkg = await open(withAsset('image/emf', 'AQAAAGwAAAA='), 'flow');
    expect(allText(pkg.document)).toContain('Windows metafile');
    expect(pkg.warnings.map((w) => w.code)).toContain('WMF_IMAGE_NOT_CONVERTED');
  });

  it('recognises a picture whose format the extractor could not name', async () => {
    const pkg = await open(withAsset('application/octet-stream'));
    expect(pkg.files).toContain('word/media/image1.png');
    expect(pkg.warnings).toEqual([]);
  });

  it('refuses to write image data it cannot decode', async () => {
    const pkg = await open(withAsset('image/png', 'not base64 at all !!!'));
    expect(pkg.files.some((f) => f.startsWith('word/media/'))).toBe(false);
    expect(pkg.warnings.map((w) => w.code)).toContain('SHAPE_APPROXIMATED');
  });

  it('marks the place of a picture whose data is missing entirely', async () => {
    const pkg = await open(doc([{ kind: 'image', x: 0, y: 0, width: 10, height: 10, assetRef: 'gone' } as Element]));
    expect(allText(pkg.document)).toContain('picture missing');
    expect(pkg.warnings.map((w) => w.code)).toContain('SHAPE_APPROXIMATED');
  });
});

describe('flow mode', () => {
  it('puts the content in the body rather than in anchored boxes', async () => {
    const pkg = await open(doc([text([para([run('hello')])])]), 'flow');
    expect(anchors(pkg)).toHaveLength(0);
    expect(findAll(pkg.document, 'wps:wsp')).toHaveLength(0);
    expect(allText(pkg.document)).toContain('hello');
  });

  it('reads top to bottom, then left to right within a row', async () => {
    const pkg = await open(doc([
      text([para([run('right column')])], { x: 300, y: 100 }),
      text([para([run('below')])], { x: 0, y: 400 }),
      text([para([run('left column')])], { x: 0, y: 102 }),
      text([para([run('headline')])], { x: 0, y: 20 }),
    ]), 'flow');
    const said = findAll(pkg.document, 'w:t').map((t) => t.text);
    expect(said).toEqual(['headline', 'left column', 'right column', 'below']);
  });

  it('keeps boxes whose tops differ by less than half a line on one row', async () => {
    const pkg = await open(doc([
      text([para([run('second')])], { x: 200, y: 100 }),
      text([para([run('first')])], { x: 10, y: 104 }),
    ]), 'flow');
    expect(findAll(pkg.document, 'w:t').map((t) => t.text)).toEqual(['first', 'second']);
  });

  it('does not merge blocks that are a real distance apart', async () => {
    const pkg = await open(doc([
      text([para([run('lower left')])], { x: 10, y: 140 }),
      text([para([run('upper right')])], { x: 200, y: 100 }),
    ]), 'flow');
    expect(findAll(pkg.document, 'w:t').map((t) => t.text)).toEqual(['upper right', 'lower left']);
  });

  it('keeps a table a real table, at body level', async () => {
    const pkg = await open(doc([table([{ cells: [cell(0, 0, 'a'), cell(0, 1, 'b')] }], [72, 72])]), 'flow');
    const body = findFirst(pkg.document, 'w:body') as XNode;
    expect(body.children.some((c) => c.name === 'w:tbl')).toBe(true);
    expect(allText(pkg.document)).toContain('a');
  });

  it('follows a table with a paragraph, so two tables cannot merge', async () => {
    const pkg = await open(doc([
      table([{ cells: [cell(0, 0, 'a')] }], [72], { y: 10 }),
      table([{ cells: [cell(0, 0, 'b')] }], [72], { y: 200 }),
    ]), 'flow');
    const body = findFirst(pkg.document, 'w:body') as XNode;
    const names = body.children.map((c) => c.name);
    const firstTable = names.indexOf('w:tbl');
    expect(names[firstTable + 1]).toBe('w:p');
    expect(findAll(pkg.document, 'w:tbl')).toHaveLength(2);
  });

  it('drops decorative shapes, which is the trade the mode exists to make', async () => {
    const pkg = await open(doc([
      shape({ type: 'rect' }, { style: { fill: { type: 'solid', color: '#8fb3dd' } } }),
      text([para([run('the words')])]),
    ]), 'flow');
    expect(findAll(pkg.document, 'a:srgbClr')).toHaveLength(0);
    expect(allText(pkg.document)).toContain('the words');
    expect(pkg.warnings.map((w) => w.code)).toContain('SHAPE_APPROXIMATED');
  });

  it('keeps a picture that arrived as a shape fill', async () => {
    const pkg = await open(doc([shape({ type: 'rect' }, {
      style: { fill: { type: 'image', assetRef: 'a1', repeat: 'stretch' } },
    })], { assets: { a1: { data: PNG_BASE64, mime: 'image/png' } } }), 'flow');
    expect(inlines(pkg)).toHaveLength(1);
  });

  it('sets rotated text upright and says it did', async () => {
    const pkg = await open(doc([text([para([run('sideways')])], { rotation: 45 })]), 'flow');
    expect(findAll(pkg.document, 'a:xfrm')).toHaveLength(0);
    expect(pkg.warnings.map((w) => w.code)).toContain('ROTATED_TEXT_APPROXIMATED');
  });

  it('runs a multi-column box together and says it did', async () => {
    const pkg = await open(doc([text([para([run('x')])], { columns: { count: 2, gap: 12 } })]), 'flow');
    expect(pkg.warnings.map((w) => w.code)).toContain('COLUMNS_FLATTENED');
  });

  it('starts each page on a page of its own', async () => {
    const source: Doc = {
      pages: [
        { width: 612, height: 792, elements: [text([para([run('one')])])] },
        { width: 612, height: 792, elements: [text([para([run('two')])])] },
      ],
      meta: {}, assets: {}, warnings: [],
    };
    const pkg = await open(source, 'flow');
    expect(findAll(pkg.document, 'w:sectPr')).toHaveLength(2);
    expect(findAll(pkg.document, 'w:t').map((t) => t.text)).toEqual(['one', 'two']);
  });

  it('flattens groups into the reading order rather than nesting them', async () => {
    const pkg = await open(doc([
      text([para([run('after')])], { x: 0, y: 200 }),
      {
        kind: 'group', x: 0, y: 0, width: 200, height: 100,
        children: [text([para([run('inside')])], { x: 0, y: 10 })],
      } as Element,
    ]), 'flow');
    expect(findAll(pkg.document, 'w:t').map((t) => t.text)).toEqual(['inside', 'after']);
  });
});

describe('warnings', () => {
  it('reports a repeated loss once, with a count', async () => {
    const pkg = await open(doc([
      shape({ type: 'rect' }, { style: { fill: { type: 'solid', color: '#111111' } } }),
      shape({ type: 'rect' }, { style: { fill: { type: 'solid', color: '#222222' } } }),
      shape({ type: 'rect' }, { style: { fill: { type: 'solid', color: '#333333' } } }),
    ]), 'flow');
    const dropped = pkg.warnings.filter((w) => w.code === 'SHAPE_APPROXIMATED');
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.count).toBe(3);
  });

  it('says nothing when nothing was lost', async () => {
    const pkg = await open(doc([text([para([run('plain text')])])]));
    expect(pkg.warnings).toEqual([]);
  });

  it('does not repeat what the parser already told the user', async () => {
    const pkg = await open(doc([text([para([run('x')])])], {
      warnings: [{ code: 'WMF_IMAGE_NOT_CONVERTED', message: 'from the parser' }],
    }));
    expect(pkg.warnings).toEqual([]);
  });

  it('emits a file with no callback at all', async () => {
    const bytes = await emitDOCX(doc([shape({ type: 'rect' })]), { mode: 'flow' });
    expect(bytes.length).toBeGreaterThan(0);
  });
});

describe('robustness', () => {
  it('never lets a non-finite number into the output', async () => {
    const source = doc([
      text([para([run('x', { size: Number.NaN, baselineShift: Number.POSITIVE_INFINITY })],
        { lineHeight: Number.NaN, marginTop: Number.NaN })],
      { x: Number.NaN, y: Number.POSITIVE_INFINITY, width: Number.NaN, height: 10 }),
      shape({ type: 'rect' }, { rotation: Number.NaN, style: { opacity: Number.NaN } }),
    ]);
    const pkg = await open(source);
    expect(pkg.parts['word/document.xml']).not.toMatch(/NaN|Infinity/);
  });

  it('opens a document that is nothing but an empty page', async () => {
    const pkg = await open(doc([]));
    expect(findAll(pkg.document, 'w:body')).toHaveLength(1);
    expect(findAll(pkg.document, 'w:p').length).toBeGreaterThan(0);
  });

  it('survives a table with no rows and one with no columns', async () => {
    await expect(open(doc([table([], [])]))).resolves.toBeDefined();
    await expect(open(doc([table([{ cells: [] }], [])]))).resolves.toBeDefined();
  });

  it('produces a zip whose first bytes are a zip’s', async () => {
    const bytes = await emitDOCX(doc([text([para([run('x')])])]));
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]);
  });
});

describe('determinism', () => {
  let first: Uint8Array;
  let second: Uint8Array;

  beforeAll(async () => {
    const source = doc([
      text([para([run('a')])]), shape({ type: 'ellipse' }),
      table([{ cells: [cell(0, 0, 'b')] }], [72]),
    ], { assets: { a1: { data: PNG_BASE64, mime: 'image/png' } } });
    first = await emitDOCX(source);
    second = await emitDOCX(source);
  });

  it('gives the same document the same bytes twice', () => {
    expect(Array.from(first)).toEqual(Array.from(second));
  });
});
