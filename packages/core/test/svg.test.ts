import { describe, expect, it } from 'vitest';
import { emitSVG, emitSVGPages, estimateTextWidth } from '../src/emit/svg';
import type {
  Doc, Element, Fill, Page, Paragraph, PathCommand, Run, ShapeStyle,
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

/** A PNG whose IHDR declares `w`x`h`; only the header is read by the emitter. */
function pngHeader(w: number, h: number): string {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString('base64');
}

function parse(svg: string): XNode {
  return parseXML(svg);
}

/** Direct element children of the root, skipping metadata, defs and the page backdrop. */
function painted(root: XNode): XNode[] {
  return root.children.filter((c) => !['title', 'desc', 'defs'].includes(c.name)).slice(1);
}

// --- page -------------------------------------------------------------------

describe('page', () => {
  it('renders at true size with a matching viewBox', () => {
    const root = parse(emitSVG(doc([])));
    expect(root.name).toBe('svg');
    expect(root.attrs.width).toBe('612pt');
    expect(root.attrs.height).toBe('792pt');
    expect(root.attrs.viewBox).toBe('0 0 612 792');
    expect(root.attrs.xmlns).toBe('http://www.w3.org/2000/svg');
  });

  it('renders non-integer page sizes without losing precision', () => {
    const d = doc([]);
    (d.pages[0] as Page).width = 419.5;
    (d.pages[0] as Page).height = 595.25;
    const root = parse(emitSVG(d));
    expect(root.attrs.width).toBe('419.5pt');
    expect(root.attrs.viewBox).toBe('0 0 419.5 595.25');
  });

  it('paints a white page backdrop before any element', () => {
    const root = parse(emitSVG(doc([])));
    const first = root.children.find((c) => c.name === 'rect');
    expect(first?.attrs.fill).toBe('#ffffff');
    expect(first?.attrs.width).toBe('612');
  });

  it('emits one document per page, in order', () => {
    const d = doc([]);
    d.pages.push({ width: 100, height: 200, elements: [] });
    const pages = emitSVGPages(d);
    expect(pages).toHaveLength(2);
    expect(parse(pages[0] as string).attrs.width).toBe('612pt');
    expect(parse(pages[1] as string).attrs.width).toBe('100pt');
  });

  it('selects a page by zero-based index and rejects one that is not there', () => {
    const d = doc([]);
    d.pages.push({ width: 100, height: 200, elements: [] });
    expect(parse(emitSVG(d, { page: 1 })).attrs.height).toBe('200pt');
    expect(() => emitSVG(d, { page: 2 })).toThrow(RangeError);
    expect(() => emitSVG({ pages: [], meta: {}, assets: {}, warnings: [] })).toThrow(RangeError);
  });

  it('preserves array order as paint order', () => {
    const mk = (color: string): Element => ({
      kind: 'shape', x: 0, y: 0, width: 10, height: 10,
      geometry: { type: 'rect' }, style: { fill: { type: 'solid', color } },
    });
    const root = parse(emitSVG(doc([mk('#111111'), mk('#222222'), mk('#333333')])));
    const fills = findAll(root, 'rect').map((r) => r.attrs.fill);
    expect(fills).toEqual(['#ffffff', '#111111', '#222222', '#333333']);
  });
});

// --- transforms -------------------------------------------------------------

describe('rotation', () => {
  it('rotates about the element centre', () => {
    const el: Element = {
      kind: 'shape', x: 100, y: 50, width: 80, height: 40, rotation: 30,
      geometry: { type: 'rect' },
    };
    const root = parse(emitSVG(doc([el])));
    const g = findFirst(root, 'g');
    expect(g?.attrs.transform).toBe('rotate(30, 140, 70)');
    expect(findFirst(g as XNode, 'rect')?.attrs.x).toBe('100');
  });

  it('omits the wrapper entirely when nothing needs one', () => {
    const el: Element = { kind: 'shape', x: 0, y: 0, width: 5, height: 5, geometry: { type: 'rect' } };
    expect(findAll(parse(emitSVG(doc([el]))), 'g')).toHaveLength(0);
  });

  it('carries opacity and a shadow filter on the same wrapper', () => {
    const style: ShapeStyle = {
      fill: { type: 'solid', color: '#ff0000' },
      opacity: 0.4,
      shadow: { color: '#000000', offsetX: 3, offsetY: 4, opacity: 0.5 },
    };
    const root = parse(emitSVG(doc([
      { kind: 'shape', x: 0, y: 0, width: 10, height: 10, geometry: { type: 'rect' }, style },
    ])));
    const g = findFirst(root, 'g') as XNode;
    expect(g.attrs.opacity).toBe('0.4');
    expect(g.attrs.filter).toMatch(/^url\(#ps\d+\)$/);
    const drop = findFirst(root, 'feDropShadow') as XNode;
    expect(drop.attrs.dx).toBe('3');
    expect(drop.attrs.dy).toBe('4');
    expect(drop.attrs['flood-color']).toBe('#000000');
    expect(drop.attrs['flood-opacity']).toBe('0.5');
    // The filter must be referenced by the id it was defined with.
    expect(g.attrs.filter).toBe(`url(#${(findFirst(root, 'filter') as XNode).attrs.id})`);
  });
});

// --- text -------------------------------------------------------------------

describe('text runs', () => {
  const box = (paragraphs: Paragraph[], over: Partial<Element> = {}): Element =>
    ({ kind: 'text', x: 10, y: 20, width: 400, height: 200, paragraphs, ...over } as Element);

  it('maps every run property onto the tspan', () => {
    const root = parse(emitSVG(doc([box([para([
      run('a', { bold: true, italic: true, underline: true, strike: true, color: '#00ff00', size: 18 }),
    ])])])));
    const t = findFirst(root, 'tspan') as XNode;
    expect(t.attrs['font-family']).toBe('Arial, sans-serif');
    expect(t.attrs['font-size']).toBe('18');
    expect(t.attrs['font-weight']).toBe('bold');
    expect(t.attrs['font-style']).toBe('italic');
    expect(t.attrs['text-decoration']).toBe('underline line-through');
    expect(t.attrs.fill).toBe('#00ff00');
  });

  it('picks a generic fallback family that matches the face', () => {
    const root = parse(emitSVG(doc([box([para([
      run('a', { font: 'Times New Roman' }),
      run('b', { font: 'Courier New' }),
      run('c', { font: 'Gill Sans' }),
    ])])])));
    const fams = findAll(root, 'tspan').map((t) => t.attrs['font-family']);
    expect(fams).toEqual(['Times New Roman, serif', 'Courier New, monospace', 'Gill Sans, sans-serif']);
  });

  it('marks small caps and uppercases allCaps text in the string itself', () => {
    const root = parse(emitSVG(doc([box([para([
      run('quiet', { smallCaps: true }),
      run(' loud', { allCaps: true }),
    ])])])));
    const [sc, ac] = findAll(root, 'tspan') as [XNode, XNode];
    expect(sc.attrs['font-variant']).toBe('small-caps');
    expect(sc.text).toBe('quiet');
    expect(ac.text).toBe(' LOUD');
    expect(ac.attrs.style).toBe('text-transform:uppercase');
  });

  it('applies baselineShift as a dy and undoes it on the next run', () => {
    const root = parse(emitSVG(doc([box([para([
      run('x'), run('2', { baselineShift: 33, size: 10 }), run(' m'),
    ])])])));
    const [base, sup, after] = findAll(root, 'tspan') as [XNode, XNode, XNode];
    expect(base.attrs.dy).toBeUndefined();
    expect(sup.attrs.dy).toBe('-3.3'); // 33% of 10pt, up
    expect(after.attrs.dy).toBe('3.3'); // back to the baseline
  });

  it('places the baseline below the top of the box', () => {
    const root = parse(emitSVG(doc([box([para([run('hello', { size: 20 })])])])));
    const t = findFirst(root, 'text') as XNode;
    expect(t.attrs.x).toBe('10');
    expect(Number(t.attrs.y)).toBeCloseTo(20 + 20 * 0.8, 6);
  });

  it('honours padding and vertical alignment', () => {
    const pad = { top: 6, right: 6, bottom: 6, left: 9 };
    const top = parse(emitSVG(doc([box([para([run('hi')])], { padding: pad })])));
    expect((findFirst(top, 'text') as XNode).attrs.x).toBe('19');
    expect(Number((findFirst(top, 'text') as XNode).attrs.y)).toBeCloseTo(26 + 9.6, 6);

    const bottom = parse(emitSVG(doc([box([para([run('hi')])], { verticalAlign: 'bottom' })])));
    const middle = parse(emitSVG(doc([box([para([run('hi')])], { verticalAlign: 'middle' })])));
    const yTop = Number((findFirst(top, 'text') as XNode).attrs.y);
    const yMid = Number((findFirst(middle, 'text') as XNode).attrs.y);
    const yBot = Number((findFirst(bottom, 'text') as XNode).attrs.y);
    expect(yMid).toBeGreaterThan(yTop);
    expect(yBot).toBeGreaterThan(yMid);
    // bottom-aligned single line sits one line-height above the box bottom
    expect(yBot).toBeCloseTo(20 + 200 - 12 * 1.2 + 12 * 0.8, 6);
  });
});

describe('paragraph layout', () => {
  const box = (paragraphs: Paragraph[], width = 200): Element =>
    ({ kind: 'text', x: 0, y: 0, width, height: 400, paragraphs } as Element);

  it('anchors each alignment at the right edge of the span', () => {
    const p = (align: Paragraph['align']) => para([run('x')], { align });
    const root = parse(emitSVG(doc([box([p('left'), p('center'), p('right')])])));
    const [l, c, r] = findAll(root, 'text') as [XNode, XNode, XNode];
    expect(l.attrs['text-anchor']).toBeUndefined(); // start is the SVG default
    expect(l.attrs.x).toBe('0');
    expect(c.attrs['text-anchor']).toBe('middle');
    expect(c.attrs.x).toBe('100');
    expect(r.attrs['text-anchor']).toBe('end');
    expect(r.attrs.x).toBe('200');
  });

  it('wraps at the box width and stacks lines by line height', () => {
    const words =
      'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar';
    const root = parse(emitSVG(doc([box([para([run(words, { size: 12 })], { lineHeight: 2 })])])));
    const lines = findAll(root, 'text');
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) {
      expect(estimateTextWidth(allText(line), run('', { size: 12 }))).toBeLessThanOrEqual(200);
    }
    const ys = lines.map((l) => Number(l.attrs.y));
    expect((ys[1] as number) - (ys[0] as number)).toBeCloseTo(24, 6); // 12pt * 2
    // Nothing is dropped by wrapping.
    expect(lines.map(allText).join(' ')).toBe(words);
  });

  it('indents only the first line and insets by paragraph margins', () => {
    const root = parse(emitSVG(doc([box([
      para([run('one two three four five six seven eight nine ten')],
        { textIndent: 24, marginLeft: 10, marginRight: 10 }),
    ])])));
    const lines = findAll(root, 'text');
    expect(lines.length).toBeGreaterThan(1);
    expect((lines[0] as XNode).attrs.x).toBe('34');
    expect((lines[1] as XNode).attrs.x).toBe('10');
  });

  it('adds paragraph margins between blocks', () => {
    const tight = parse(emitSVG(doc([box([para([run('a')]), para([run('b')])])])));
    const loose = parse(emitSVG(doc([box([
      para([run('a')], { marginBottom: 20 }), para([run('b')], { marginTop: 10 }),
    ])])));
    const gapOf = (r: XNode) => {
      const [a, b] = findAll(r, 'text') as [XNode, XNode];
      return Number(b.attrs.y) - Number(a.attrs.y);
    };
    expect(gapOf(loose) - gapOf(tight)).toBeCloseTo(30, 6);
  });

  it('spreads justified lines with word-spacing, except the last', () => {
    const root = parse(emitSVG(doc([box([
      para([run('alpha bravo charlie delta echo foxtrot golf hotel')], { align: 'justify' }),
    ])])));
    const lines = findAll(root, 'text');
    expect(lines.length).toBeGreaterThan(1);
    expect(Number((lines[0] as XNode).attrs['word-spacing'])).toBeGreaterThan(0);
    expect((lines[lines.length - 1] as XNode).attrs['word-spacing']).toBeUndefined();
  });

  it('breaks hard on a newline without justifying that line', () => {
    const root = parse(emitSVG(doc([box([para([run('a\nb')], { align: 'justify' })])])));
    const lines = findAll(root, 'text');
    expect(lines.map(allText)).toEqual(['a', 'b']);
    expect((lines[0] as XNode).attrs['word-spacing']).toBeUndefined();
  });

  it('flows lines into columns', () => {
    const el = {
      kind: 'text', x: 0, y: 0, width: 200, height: 30,
      columns: { count: 2, gap: 20 },
      paragraphs: [para([run('one two three four five six seven eight nine ten eleven')])],
    } as Element;
    const root = parse(emitSVG(doc([el])));
    const xs = findAll(root, 'text').map((t) => Number(t.attrs.x));
    expect(new Set(xs)).toEqual(new Set([0, 110])); // (200 - 20) / 2 = 90 wide, second at 110
    expect(Math.max(...xs)).toBe(110);
  });

  it('prefixes an unordered list item with a bullet', () => {
    const root = parse(emitSVG(doc([box([
      para([run('item')], { list: { type: 'unordered', level: 0 } }),
    ])])));
    expect(allText(findFirst(root, 'text') as XNode)).toBe('• item');
  });
});

// --- escaping ---------------------------------------------------------------

describe('escaping', () => {
  it('survives every XML metacharacter in text and round-trips it', () => {
    const nasty = `Tom & Jerry <b> "quoted" 'single' ]]> --> 100% > 50%`;
    const root = parse(emitSVG(doc([
      { kind: 'text', x: 0, y: 0, width: 4000, height: 50, paragraphs: [para([run(nasty)])] },
    ])));
    expect(allText(findFirst(root, 'text') as XNode)).toBe(nasty);
  });

  it('escapes metacharacters that arrive through attributes', () => {
    const svg = emitSVG(doc(
      [{ kind: 'text', x: 0, y: 0, width: 100, height: 20, paragraphs: [para([run('x', { font: 'He&<Sans>' })])] }],
      { meta: { title: 'A & B', description: '<not a tag>' } },
    ));
    const root = parse(svg); // throws if anything leaked unescaped
    expect((findFirst(root, 'title') as XNode).text).toBe('A & B');
    expect((findFirst(root, 'desc') as XNode).text).toBe('<not a tag>');
    expect((findFirst(root, 'tspan') as XNode).attrs['font-family']).toBe('He&<Sans>, sans-serif');
  });

  it('quotes a family name that would otherwise split the CSS font list', () => {
    const root = parse(emitSVG(doc([
      { kind: 'text', x: 0, y: 0, width: 100, height: 20, paragraphs: [para([run('x', { font: 'Foo, Bar' })])] },
    ])));
    expect((findFirst(root, 'tspan') as XNode).attrs['font-family']).toBe("'Foo, Bar', sans-serif");
  });

  it('strips control characters that would make the document unparseable', () => {
    const root = parse(emitSVG(doc([
      { kind: 'text', x: 0, y: 0, width: 400, height: 50, paragraphs: [para([run('abc')])] },
    ])));
    expect(allText(findFirst(root, 'text') as XNode)).toBe('abc');
  });
});

// --- tables -----------------------------------------------------------------

describe('tables', () => {
  const cell = (row: number, column: number, text: string, over = {}) => ({
    row, column, rowSpan: 1, colSpan: 1, covered: false,
    paragraphs: [para([run(text)])], ...over,
  });

  it('lays cells out on the column and row grid', () => {
    const el: Element = {
      kind: 'table', x: 100, y: 50, width: 180, height: 60,
      columnWidths: [60, 120],
      rows: [
        { height: 20, cells: [cell(0, 0, 'a'), cell(0, 1, 'b')] },
        { height: 40, cells: [cell(1, 0, 'c'), cell(1, 1, 'd')] },
      ],
    };
    const root = parse(emitSVG(doc([el])));
    const cells = findAll(root, 'rect').slice(1); // skip the page backdrop
    expect(cells.map((r) => [r.attrs.x, r.attrs.y, r.attrs.width, r.attrs.height])).toEqual([
      ['100', '50', '60', '20'],
      ['160', '50', '120', '20'],
      ['100', '70', '60', '40'],
      ['160', '70', '120', '40'],
    ]);
    expect(findAll(root, 'text').map(allText)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('spans merged cells and skips the cells they cover', () => {
    const el: Element = {
      kind: 'table', x: 0, y: 0, width: 200, height: 80,
      columnWidths: [100, 100],
      rows: [
        { height: 40, cells: [cell(0, 0, 'wide', { colSpan: 2, rowSpan: 2 }), cell(0, 1, '', { covered: true })] },
        { height: 40, cells: [cell(1, 0, '', { covered: true }), cell(1, 1, '', { covered: true })] },
      ],
    };
    const root = parse(emitSVG(doc([el])));
    const cells = findAll(root, 'rect').slice(1);
    expect(cells).toHaveLength(1);
    expect([cells[0]?.attrs.width, cells[0]?.attrs.height]).toEqual(['200', '80']);
    expect(findAll(root, 'text').map(allText)).toEqual(['wide']);
  });

  it('falls back to an even row split when a row has no height', () => {
    const el: Element = {
      kind: 'table', x: 0, y: 0, width: 100, height: 90,
      columnWidths: [100],
      rows: [{ cells: [cell(0, 0, 'a')] }, { cells: [cell(1, 0, 'b')] }, { cells: [cell(2, 0, 'c')] }],
    };
    const root = parse(emitSVG(doc([el])));
    expect(findAll(root, 'rect').slice(1).map((r) => [r.attrs.y, r.attrs.height])).toEqual([
      ['0', '30'], ['30', '30'], ['60', '30'],
    ]);
  });

  it('prefers a cell style over the table style', () => {
    const el: Element = {
      kind: 'table', x: 0, y: 0, width: 100, height: 20,
      style: { fill: { type: 'solid', color: '#eeeeee' } },
      columnWidths: [50, 50],
      rows: [{
        height: 20,
        cells: [
          cell(0, 0, 'a'),
          cell(0, 1, 'b', { style: { fill: { type: 'solid', color: '#ff0000' } } }),
        ],
      }],
    };
    const root = parse(emitSVG(doc([el])));
    expect(findAll(root, 'rect').slice(1).map((r) => r.attrs.fill)).toEqual(['#eeeeee', '#ff0000']);
  });
});

// --- images -----------------------------------------------------------------

describe('images', () => {
  it('embeds a renderable bitmap as a data URI filling its frame', () => {
    const d = doc(
      [{ kind: 'image', x: 5, y: 6, width: 70, height: 80, assetRef: 'a1' }],
      { assets: { a1: { data: pngHeader(4, 2), mime: 'image/png' } } },
    );
    const img = findFirst(parse(emitSVG(d)), 'image') as XNode;
    expect(img.attrs.href).toBe(`data:image/png;base64,${pngHeader(4, 2)}`);
    expect(img.attrs['xlink:href']).toBe(img.attrs.href);
    expect(img.attrs.preserveAspectRatio).toBe('none');
    expect([img.attrs.x, img.attrs.y, img.attrs.width, img.attrs.height]).toEqual(['5', '6', '70', '80']);
  });

  it('draws a labelled placeholder for WMF instead of an empty hole', () => {
    const d = doc(
      [{ kind: 'image', x: 10, y: 10, width: 100, height: 40, assetRef: 'w1' }],
      { assets: { w1: { data: 'AAAA', mime: 'image/wmf' } } },
    );
    const root = parse(emitSVG(d));
    expect(findAll(root, 'image')).toHaveLength(0);
    expect(allText(findFirst(root, 'text') as XNode)).toBe('image/wmf not renderable');
    const frame = findAll(root, 'rect')[1] as XNode;
    expect(frame.attrs['stroke-dasharray']).toBe('4 3');
    expect([frame.attrs.x, frame.attrs.width]).toEqual(['10', '100']);
  });

  it('labels a dangling asset reference rather than emitting a broken href', () => {
    const root = parse(emitSVG(doc([{ kind: 'image', x: 0, y: 0, width: 10, height: 10, assetRef: 'gone' }])));
    expect(findAll(root, 'image')).toHaveLength(0);
    expect(allText(findFirst(root, 'text') as XNode)).toBe('missing image');
  });

  it('rotates an image about its own centre', () => {
    const d = doc(
      [{ kind: 'image', x: 0, y: 0, width: 40, height: 20, rotation: -90, assetRef: 'a1' }],
      { assets: { a1: { data: pngHeader(1, 1), mime: 'image/png' } } },
    );
    expect((findFirst(parse(emitSVG(d)), 'g') as XNode).attrs.transform).toBe('rotate(-90, 20, 10)');
  });
});

// --- shapes and geometry ----------------------------------------------------

describe('geometry', () => {
  const shape = (geometry: Element extends never ? never : any, over = {}): Element =>
    ({ kind: 'shape', x: 10, y: 20, width: 100, height: 50, geometry, ...over } as Element);

  it('emits a rect with corner radii', () => {
    const r = findAll(parse(emitSVG(doc([shape({ type: 'rect', rx: 4, ry: 6 })]))), 'rect')[1] as XNode;
    expect([r.attrs.x, r.attrs.y, r.attrs.width, r.attrs.height, r.attrs.rx, r.attrs.ry])
      .toEqual(['10', '20', '100', '50', '4', '6']);
  });

  it('emits an ellipse inscribed in the frame', () => {
    const e = findFirst(parse(emitSVG(doc([shape({ type: 'ellipse' })]))), 'ellipse') as XNode;
    expect([e.attrs.cx, e.attrs.cy, e.attrs.rx, e.attrs.ry]).toEqual(['60', '45', '50', '25']);
  });

  it('emits polygons and never fills a polyline', () => {
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 5 }, { x: 20, y: 0 }];
    const style = { fill: { type: 'solid', color: '#ff0000' } as Fill };
    const root = parse(emitSVG(doc([
      shape({ type: 'polygon', points: pts }, { style }),
      shape({ type: 'polyline', points: pts }, { style }),
    ])));
    expect((findFirst(root, 'polygon') as XNode).attrs.points).toBe('0,0 10,5 20,0');
    expect((findFirst(root, 'polygon') as XNode).attrs.fill).toBe('#ff0000');
    expect((findFirst(root, 'polyline') as XNode).attrs.points).toBe('0,0 10,5 20,0');
    expect((findFirst(root, 'polyline') as XNode).attrs.fill).toBe('none');
  });

  it('round-trips every path command', () => {
    const d: PathCommand[] = [
      { op: 'M', x: 0, y: 0 },
      { op: 'L', x: 10, y: 0 },
      { op: 'C', x1: 12, y1: 0, x2: 14, y2: 2, x: 14, y: 4 },
      { op: 'Q', x1: 14, y1: 8, x: 10, y: 8 },
      { op: 'A', rx: 5, ry: 3, rotation: 45, largeArc: true, sweep: false, x: 0, y: 8 },
      { op: 'Z' },
    ];
    const path = findFirst(parse(emitSVG(doc([shape({ type: 'path', d })]))), 'path') as XNode;
    expect(path.attrs.d).toBe('M 0 0 L 10 0 C 12 0 14 2 14 4 Q 14 8 10 8 A 5 3 45 1 0 0 8 Z');
  });

  it('encodes arc flags as 0/1 in both directions', () => {
    const d: PathCommand[] = [
      { op: 'A', rx: 1, ry: 1, rotation: 0, largeArc: false, sweep: true, x: 2, y: 2 },
    ];
    expect((findFirst(parse(emitSVG(doc([shape({ type: 'path', d })]))), 'path') as XNode).attrs.d)
      .toBe('A 1 1 0 0 1 2 2');
  });

  it('rounds coordinates without emitting exponent or -0 notation', () => {
    const d: PathCommand[] = [{ op: 'M', x: 1 / 3, y: -0.0001 }];
    expect((findFirst(parse(emitSVG(doc([shape({ type: 'path', d })]))), 'path') as XNode).attrs.d)
      .toBe('M 0.333 0');
  });
});

// --- fills and strokes ------------------------------------------------------

describe('fills', () => {
  const shape = (style: ShapeStyle): Element =>
    ({ kind: 'shape', x: 0, y: 0, width: 100, height: 100, geometry: { type: 'rect' }, style });

  it('writes none and solid straight onto the element', () => {
    const root = parse(emitSVG(doc([
      shape({ fill: { type: 'none' } }),
      shape({ fill: { type: 'solid', color: '#123456' } }),
    ])));
    expect(findAll(root, 'rect').slice(1).map((r) => r.attrs.fill)).toEqual(['none', '#123456']);
  });

  it('defaults to no fill when an element has no style at all', () => {
    const root = parse(emitSVG(doc([
      { kind: 'shape', x: 0, y: 0, width: 10, height: 10, geometry: { type: 'rect' } },
    ])));
    expect((findAll(root, 'rect')[1] as XNode).attrs.fill).toBe('none');
  });

  it('builds a real linearGradient and references it by id', () => {
    const fill: Fill = {
      type: 'gradient', angle: 90,
      stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000', opacity: 0.5 }],
    };
    const root = parse(emitSVG(doc([shape({ fill })])));
    const grad = findFirst(root, 'linearGradient') as XNode;
    expect(grad.attrs.id).toBeTruthy();
    expect((findAll(root, 'rect')[1] as XNode).attrs.fill).toBe(`url(#${grad.attrs.id})`);
    // 90 degrees clockwise from left-to-right is top-to-bottom.
    expect([grad.attrs.x1, grad.attrs.y1, grad.attrs.x2, grad.attrs.y2]).toEqual(['0.5', '0', '0.5', '1']);
    const stops = findAll(grad, 'stop');
    expect(stops.map((s) => [s.attrs.offset, s.attrs['stop-color'], s.attrs['stop-opacity']])).toEqual([
      ['0', '#ffffff', undefined],
      ['1', '#000000', '0.5'],
    ]);
  });

  it('points a zero-degree gradient left to right', () => {
    const fill: Fill = { type: 'gradient', angle: 0, stops: [{ offset: 0, color: '#000000' }] };
    const grad = findFirst(parse(emitSVG(doc([shape({ fill })]))), 'linearGradient') as XNode;
    expect([grad.attrs.x1, grad.attrs.y1, grad.attrs.x2, grad.attrs.y2]).toEqual(['0', '0.5', '1', '0.5']);
  });

  it('gives every distinct definition its own id and reuses identical ones', () => {
    const a: Fill = { type: 'gradient', angle: 0, stops: [{ offset: 0, color: '#aaaaaa' }] };
    const b: Fill = { type: 'gradient', angle: 0, stops: [{ offset: 0, color: '#bbbbbb' }] };
    const root = parse(emitSVG(doc([shape({ fill: a }), shape({ fill: b }), shape({ fill: a })])));
    const ids = findAll(root, 'linearGradient').map((g) => g.attrs.id);
    expect(new Set(ids).size).toBe(2);
    const used = findAll(root, 'rect').slice(1).map((r) => r.attrs.fill);
    expect(used[0]).toBe(used[2]);
    expect(used[0]).not.toBe(used[1]);
  });

  it('stretches an image fill over the bounding box', () => {
    const fill: Fill = { type: 'image', assetRef: 'a1', repeat: 'stretch' };
    const d = doc([shape({ fill })], { assets: { a1: { data: pngHeader(8, 8), mime: 'image/png' } } });
    const root = parse(emitSVG(d));
    const pat = findFirst(root, 'pattern') as XNode;
    expect(pat.attrs.patternUnits).toBe('objectBoundingBox');
    expect(pat.attrs.patternContentUnits).toBe('objectBoundingBox');
    expect((findFirst(pat, 'image') as XNode).attrs.preserveAspectRatio).toBe('none');
    expect((findAll(root, 'rect')[1] as XNode).attrs.fill).toBe(`url(#${pat.attrs.id})`);
  });

  it('tiles a repeating image fill at the bitmap size, anchored to the element', () => {
    const fill: Fill = { type: 'image', assetRef: 'a1', repeat: 'repeat' };
    const el = { ...(shape({ fill }) as any), x: 30, y: 40 } as Element;
    const d = doc([el], { assets: { a1: { data: pngHeader(96, 48), mime: 'image/png' } } });
    const pat = findFirst(parse(emitSVG(d)), 'pattern') as XNode;
    expect(pat.attrs.patternUnits).toBe('userSpaceOnUse');
    // 96x48 px at 96dpi is 72x36 pt.
    expect([pat.attrs.x, pat.attrs.y, pat.attrs.width, pat.attrs.height]).toEqual(['30', '40', '72', '36']);
  });

  it('falls back to no fill when an image fill points at an unrenderable asset', () => {
    const fill: Fill = { type: 'image', assetRef: 'w1', repeat: 'stretch' };
    const d = doc([shape({ fill })], { assets: { w1: { data: 'AAAA', mime: 'image/wmf' } } });
    const root = parse(emitSVG(d));
    expect(findAll(root, 'pattern')).toHaveLength(0);
    expect((findAll(root, 'rect')[1] as XNode).attrs.fill).toBe('none');
  });

  it('writes stroke width and dash array', () => {
    const root = parse(emitSVG(doc([
      shape({ stroke: { color: '#0000ff', width: 2.5, dash: [4, 2, 1, 2] } }),
      shape({ stroke: { color: '#00ff00', width: 1 } }),
    ])));
    const [dashed, plain] = findAll(root, 'rect').slice(1) as [XNode, XNode];
    expect(dashed.attrs.stroke).toBe('#0000ff');
    expect(dashed.attrs['stroke-width']).toBe('2.5');
    expect(dashed.attrs['stroke-dasharray']).toBe('4 2 1 2');
    expect(plain.attrs['stroke-dasharray']).toBeUndefined();
  });
});

// --- groups -----------------------------------------------------------------

describe('groups', () => {
  it('nests children and keeps their page coordinates', () => {
    const el: Element = {
      kind: 'group', x: 0, y: 0, width: 200, height: 100, rotation: 15,
      children: [
        { kind: 'shape', x: 20, y: 30, width: 10, height: 10, geometry: { type: 'ellipse' } },
        { kind: 'text', x: 50, y: 60, width: 100, height: 20, paragraphs: [para([run('inside')])] },
      ],
    };
    const root = parse(emitSVG(doc([el])));
    const g = findFirst(root, 'g') as XNode;
    expect(g.attrs.transform).toBe('rotate(15, 100, 50)');
    expect((findFirst(g, 'ellipse') as XNode).attrs.cx).toBe('25');
    expect(allText(findFirst(g, 'text') as XNode)).toBe('inside');
  });

  it('recurses through nested groups', () => {
    const inner: Element = {
      kind: 'group', x: 0, y: 0, width: 10, height: 10,
      children: [{ kind: 'shape', x: 1, y: 2, width: 3, height: 4, geometry: { type: 'rect' } }],
    };
    const outer: Element = { kind: 'group', x: 0, y: 0, width: 10, height: 10, children: [inner] };
    const root = parse(emitSVG(doc([outer])));
    expect(findAll(root, 'rect').slice(1)).toHaveLength(1);
  });
});

// --- width estimation -------------------------------------------------------

describe('width estimation', () => {
  it('scales linearly with font size', () => {
    const a = estimateTextWidth('Hamburgefonstiv', run('', { size: 10 }));
    const b = estimateTextWidth('Hamburgefonstiv', run('', { size: 20 }));
    expect(b / a).toBeCloseTo(2, 6);
  });

  it('knows capitals are wider than lowercase and that i is narrow', () => {
    expect(estimateTextWidth('WWWW', run(''))).toBeGreaterThan(estimateTextWidth('wwww', run('')));
    expect(estimateTextWidth('iiii', run(''))).toBeLessThan(estimateTextWidth('oooo', run('')));
  });

  it('measures a monospaced face at a fixed advance', () => {
    const mono = (s: string) => estimateTextWidth(s, run('', { font: 'Courier New', size: 10 }));
    expect(mono('iiii')).toBeCloseTo(mono('MMMM'), 6);
    expect(mono('abcd')).toBeCloseTo(24, 6);
  });

  it('measures allCaps text as the capitals it will render', () => {
    expect(estimateTextWidth('abc', run('', { allCaps: true })))
      .toBeCloseTo(estimateTextWidth('ABC', run('')), 6);
  });

  it('treats CJK as full-width', () => {
    expect(estimateTextWidth('漢字', run('', { size: 10 }))).toBeCloseTo(20, 6);
  });
});

// --- output shape -----------------------------------------------------------

describe('document integrity', () => {
  it('is well-formed with every element kind on one page', () => {
    const d = doc(
      [
        { kind: 'shape', x: 0, y: 0, width: 50, height: 50, geometry: { type: 'ellipse' },
          style: { fill: { type: 'gradient', angle: 45, stops: [{ offset: 0, color: '#fff000' }] } } },
        { kind: 'image', x: 60, y: 0, width: 40, height: 40, assetRef: 'a1' },
        { kind: 'text', x: 0, y: 60, width: 300, height: 100, rotation: 12,
          paragraphs: [para([run('A & B <c>', { allCaps: true })])] },
        { kind: 'table', x: 0, y: 200, width: 100, height: 20, columnWidths: [50, 50],
          rows: [{ height: 20, cells: [
            { row: 0, column: 0, rowSpan: 1, colSpan: 1, covered: false, paragraphs: [para([run('x')])] },
            { row: 0, column: 1, rowSpan: 1, colSpan: 1, covered: true, paragraphs: [] },
          ] }] },
        { kind: 'group', x: 0, y: 300, width: 50, height: 50,
          children: [{ kind: 'shape', x: 0, y: 300, width: 10, height: 10, geometry: { type: 'path', d: [{ op: 'Z' }] } }] },
      ],
      { assets: { a1: { data: pngHeader(2, 2), mime: 'image/png' } }, meta: { title: 'Mixed & matched' } },
    );
    const root = parse(emitSVG(d));
    expect(painted(root).length).toBeGreaterThan(0);
    expect(findAll(root, 'linearGradient')).toHaveLength(1);
    expect(allText(findFirst(root, 'title') as XNode)).toBe('Mixed & matched');
  });

  it('starts with an XML declaration so the output is a standalone .svg file', () => {
    expect(emitSVG(doc([]))).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>\n<svg /);
  });

  it('declares the xlink namespace it uses for image hrefs', () => {
    const d = doc(
      [{ kind: 'image', x: 0, y: 0, width: 1, height: 1, assetRef: 'a1' }],
      { assets: { a1: { data: pngHeader(1, 1), mime: 'image/png' } } },
    );
    const root = parse(emitSVG(d));
    expect(root.attrs['xmlns:xlink']).toBe('http://www.w3.org/1999/xlink');
  });
});
