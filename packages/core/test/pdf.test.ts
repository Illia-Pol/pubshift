import { deflateSync } from 'node:zlib';
import { PDFDocument, PDFName, type PDFDict } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { emitPDF } from '../src/emit/pdf';
import { emitSVG } from '../src/emit/svg';
import type {
  Doc, Element, Fill, Page, Paragraph, PathCommand, Run, Shadow, ShapeStyle,
} from '../src/model/types';
import {
  annotationCount, contentOf, dictAt, extGStatesOf, extractText, firstLinkURI, fontsOf,
  imageDictsOf, lengthAt, nameAt, numberAt, numbersAt, opsNamed, pageText, parseOps,
  shadingsOf, type Op,
} from './helpers/pdf';

// --- fixture builders -------------------------------------------------------

const PAGE_W = 612;
const PAGE_H = 792;

function doc(elements: Element[], over: Partial<Doc> = {}): Doc {
  const page: Page = { width: PAGE_W, height: PAGE_H, elements };
  return { pages: [page], meta: {}, assets: {}, warnings: [], ...over };
}

function run(text: string, over: Partial<Run> = {}): Run {
  return { text, font: 'Arial', size: 12, ...over };
}

function para(runs: Run[], over: Partial<Paragraph> = {}): Paragraph {
  return { runs, ...over };
}

function textBox(paragraphs: Paragraph[], over: Partial<Element & { kind: 'text' }> = {}): Element {
  return { kind: 'text', x: 0, y: 0, width: 400, height: 200, paragraphs, ...over } as Element;
}

function rect(style: ShapeStyle | undefined, over: Record<string, unknown> = {}): Element {
  return { kind: 'shape', x: 10, y: 20, width: 100, height: 50, geometry: { type: 'rect' }, style, ...over } as Element;
}

async function ops(d: Doc, page = 0): Promise<Op[]> {
  return parseOps(await contentOf(await emitPDF(d), page));
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** A real, decodable 8-bit RGB PNG — pdf-lib refuses anything it cannot actually parse. */
function png(width: number, height: number): string {
  const chunk = (type: string, body: Uint8Array): Uint8Array => {
    const name = new TextEncoder().encode(type);
    const out = new Uint8Array(12 + body.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, body.length);
    out.set(name, 4);
    out.set(body, 8);
    view.setUint32(8 + body.length, crc32(Uint8Array.from([...name, ...body])));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const o = y * (1 + width * 3) + 1 + x * 3;
      raw[o] = 0xff;
      raw[o + 1] = 0x40;
      raw[o + 2] = 0x00;
    }
  }
  const bytes = Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', ihdr),
    ...chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))),
    ...chunk('IEND', new Uint8Array(0)),
  ]);
  return Buffer.from(bytes).toString('base64');
}

/** An uncompressed 24-bit BMP, bottom-up, with the 4-byte row padding BMP requires. */
function bmp(width: number, height: number): string {
  const rowSize = Math.floor((24 * width + 31) / 32) * 4;
  const dataOffset = 54;
  const size = dataOffset + rowSize * height;
  const b = Buffer.alloc(size);
  b.write('BM', 0, 'ascii');
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(dataOffset, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = dataOffset + y * rowSize + x * 3;
      b[o] = 0x00; // blue
      b[o + 1] = 0x80; // green
      b[o + 2] = 0xff; // red
    }
  }
  return b.toString('base64');
}

/**
 * A real GIF, encoded the simple way: a clear code before every pixel keeps the LZW table
 * empty, so the code width never changes and the bytes are obviously right by inspection.
 * That is a legal GIF — decoders must honour a clear code wherever it appears.
 */
function gif(
  width: number,
  height: number,
  pixels: number[],
  palette: Array<[number, number, number]>,
  transparentIndex?: number,
): string {
  const minCodeSize = 2; // smallest the specification allows for a 4-entry table
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const codeSize = minCodeSize + 1;

  const bits: number[] = [];
  const pushCode = (code: number) => {
    for (let i = 0; i < codeSize; i++) bits.push((code >> i) & 1);
  };
  for (const pixel of pixels) {
    pushCode(clearCode);
    pushCode(pixel);
  }
  pushCode(endCode);
  const lzw: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8 && i + b < bits.length; b++) byte |= (bits[i + b] as number) << b;
    lzw.push(byte);
  }

  const out: number[] = [];
  out.push(...new TextEncoder().encode('GIF89a'));
  out.push(width & 0xff, width >> 8, height & 0xff, height >> 8);
  out.push(0x80 | ((minCodeSize - 1) & 0x07), 0, 0); // global table of 1 << minCodeSize
  for (let i = 0; i < clearCode; i++) {
    const entry = palette[i] ?? [0, 0, 0];
    out.push(entry[0], entry[1], entry[2]);
  }
  if (transparentIndex !== undefined) {
    out.push(0x21, 0xf9, 0x04, 0x01, 0, 0, transparentIndex, 0); // graphic control extension
  }
  out.push(0x2c, 0, 0, 0, 0, width & 0xff, width >> 8, height & 0xff, height >> 8, 0);
  out.push(minCodeSize);
  for (let i = 0; i < lzw.length; i += 255) {
    const block = lzw.slice(i, i + 255);
    out.push(block.length, ...block);
  }
  out.push(0, 0x3b);
  return Buffer.from(Uint8Array.from(out)).toString('base64');
}

function codes(d: Doc): string[] {
  return d.warnings.map((w) => w.code);
}

function numbers(op: Op): number[] {
  return op.args.filter((a): a is number => typeof a === 'number');
}

// --- pages ------------------------------------------------------------------

describe('pages', () => {
  it('emits one page per model page, in order, at exact point sizes', async () => {
    const d = doc([]);
    d.pages.push({ width: 419.5, height: 595.25, elements: [] });
    d.pages.push({ width: 841.89, height: 595.276, elements: [] });
    const pdf = await PDFDocument.load(await emitPDF(d));

    expect(pdf.getPageCount()).toBe(3);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(pdf.getPage(1).getSize()).toEqual({ width: 419.5, height: 595.25 });
    expect(pdf.getPage(2).getSize()).toEqual({ width: 841.89, height: 595.276 });
  });

  it('paints a white backdrop, marked as an artifact so it is not content', async () => {
    const list = await ops(doc([]));
    const backdrop = list.findIndex((o) => o.op === 're');
    expect(backdrop).toBeGreaterThan(0);
    expect(list[backdrop - 1]?.op).toBe('rg');
    expect(numbers(list[backdrop - 1] as Op)).toEqual([1, 1, 1]);
    expect(numbers(list[backdrop] as Op)).toEqual([0, 0, 612, 792]);
    expect(list[0]?.op).toBe('BMC');
    expect(list[0]?.args[0]).toBe('/Artifact');
  });

  it('still produces an openable PDF for a document with no pages', async () => {
    const pdf = await PDFDocument.load(await emitPDF(doc([], { pages: [] })));
    expect(pdf.getPageCount()).toBe(1);
  });
});

// --- the coordinate flip ----------------------------------------------------

describe('coordinate flip', () => {
  it('anchors a box at its bottom-left in PDF space', async () => {
    const d = doc([rect({ fill: { type: 'solid', color: '#ff0000' } })]);
    const painted = opsNamed(await ops(d), 're').filter((o) => numbers(o)[2] !== PAGE_W);
    // Model box is (10, 20) 100x50 from the top; its bottom edge is 70 down the page.
    expect(numbers(painted[0] as Op)).toEqual([10, PAGE_H - 70, 100, 50]);
  });

  it('places a baseline below the top of its box, not above it', async () => {
    const d = doc([textBox([para([run('Hi')])], { x: 0, y: 0, width: 400, height: 200 })]);
    const shown = extractText(await contentOf(await emitPDF(d)));
    expect(shown).toHaveLength(1);
    expect(shown[0]?.text).toBe('Hi');
    // Baseline sits ASCENT_RATIO (0.8) of the 12pt size below the box top.
    expect(shown[0]?.y).toBeCloseTo(PAGE_H - 12 * 0.8, 6);
  });

  it('turns a clockwise model rotation into an anticlockwise PDF one', async () => {
    const d = doc([rect({ fill: { type: 'solid', color: '#000000' } }, { rotation: 30 })]);
    const cm = opsNamed(await ops(d), 'cm');
    const rotation = cm.find((o) => numbers(o)[1] !== 0);
    const [a, b, c, dd] = numbers(rotation as Op);
    const rad = (-30 * Math.PI) / 180;
    expect(a).toBeCloseTo(Math.cos(rad), 6);
    expect(b).toBeCloseTo(Math.sin(rad), 6);
    expect(c).toBeCloseTo(-Math.sin(rad), 6);
    expect(dd).toBeCloseTo(Math.cos(rad), 6);
  });

  it('rotates about the box centre', async () => {
    const d = doc([rect(undefined, { rotation: 90 })]);
    const cm = opsNamed(await ops(d), 'cm');
    const first = numbers(cm[0] as Op);
    // Centre of (10,20,100,50) is (60, 45) in model space, (60, 747) in PDF space.
    expect(first).toEqual([1, 0, 0, 1, 60, PAGE_H - 45]);
  });
});

// --- fonts ------------------------------------------------------------------

describe('fonts', () => {
  const cases: Array<[string, Partial<Run>, string]> = [
    ['Times New Roman', {}, 'Times-Roman'],
    ['Times New Roman', { bold: true }, 'Times-Bold'],
    ['Times New Roman', { italic: true }, 'Times-Italic'],
    ['Times New Roman', { bold: true, italic: true }, 'Times-BoldItalic'],
    ['Arial', {}, 'Helvetica'],
    ['Arial', { bold: true }, 'Helvetica-Bold'],
    ['Arial', { italic: true }, 'Helvetica-Oblique'],
    ['Helvetica', {}, 'Helvetica'],
    ['Courier New', {}, 'Courier'],
    ['Courier New', { bold: true, italic: true }, 'Courier-BoldOblique'],
  ];

  for (const [family, over, expected] of cases) {
    it(`maps ${family}${over.bold ? ' bold' : ''}${over.italic ? ' italic' : ''} to ${expected} without warning`, async () => {
      const d = doc([textBox([para([run('Text', { font: family, ...over })])])]);
      const bytes = await emitPDF(d);
      expect(await fontsOf(bytes)).toEqual([expected]);
      expect(codes(d)).not.toContain('FONT_NOT_EMBEDDED');
    });
  }

  it('substitutes an unavailable family and says which one', async () => {
    const d = doc([textBox([para([run('Text', { font: 'Calibri' })])])]);
    const bytes = await emitPDF(d);
    expect(await fontsOf(bytes)).toEqual(['Helvetica']);
    const warning = d.warnings.find((w) => w.code === 'FONT_NOT_EMBEDDED');
    expect(warning?.message).toContain('Calibri');
    expect(warning?.message).toContain('could not be embedded');
  });

  it('substitutes a serif family with a serif face, not a sans one', async () => {
    const d = doc([textBox([para([run('Text', { font: 'Garamond' })])])]);
    expect(await fontsOf(await emitPDF(d))).toEqual(['Times-Roman']);
    expect(codes(d)).toContain('FONT_NOT_EMBEDDED');
  });

  it('substitutes a monospaced family with Courier', async () => {
    const d = doc([textBox([para([run('Text', { font: 'Consolas' })])])]);
    expect(await fontsOf(await emitPDF(d))).toEqual(['Courier']);
  });

  it('sets text tagged Symbol in a text face rather than encoding it to nothing', async () => {
    // The Symbol font is one of the standard 14, but its encoding holds Greek letters, so
    // the ASCII Publisher stores for a symbol bullet would become a row of '?'.
    const d = doc([textBox([para([run('Text', { font: 'Symbol' })])])]);
    const bytes = await emitPDF(d);
    expect(await fontsOf(bytes)).toEqual(['Helvetica']);
    expect(pageText(await contentOf(bytes))).toBe('Text');
    expect(codes(d)).toContain('FONT_NOT_EMBEDDED');
  });

  it('does not report a substitution for a run with no visible text', async () => {
    const d = doc([textBox([para([run('   ', { font: 'Webdings' })])])]);
    await emitPDF(d);
    expect(codes(d)).not.toContain('FONT_NOT_EMBEDDED');
  });

  it('names every substituted family once, however many runs used it', async () => {
    const d = doc([
      textBox([para([run('a', { font: 'Calibri' }), run('b', { font: 'Calibri' })])]),
      textBox([para([run('c', { font: 'Tahoma' })])], { y: 300 }),
    ]);
    await emitPDF(d);
    const warnings = d.warnings.filter((w) => w.code === 'FONT_NOT_EMBEDDED');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('Calibri');
    expect(warnings[0]?.message).toContain('Tahoma');
    expect(warnings[0]?.message).toContain('2 fonts');
  });
});

// --- character encoding -----------------------------------------------------

describe('character encoding', () => {
  it('does not throw on characters WinAnsi cannot encode, and says so', async () => {
    const d = doc([textBox([para([run('a中中b')])])]);
    const bytes = await emitPDF(d);
    expect(pageText(await contentOf(bytes))).toBe('a??b');
    const warning = d.warnings.find((w) => w.message.includes('WinAnsi'));
    expect(warning?.code).toBe('FONT_NOT_EMBEDDED');
  });

  it('keeps the punctuation WinAnsi does have', async () => {
    const d = doc([textBox([para([run('“quoted” — café • €5')])])]);
    const bytes = await emitPDF(d);
    expect(pageText(await contentOf(bytes))).toBe('“quoted” — café • €5');
    expect(codes(d)).not.toContain('FONT_NOT_EMBEDDED');
  });

  it('renders a tab as a space and drops the control codes Publisher leaves behind', async () => {
    const d = doc([textBox([para([run('a\tbcd')])])]);
    expect(pageText(await contentOf(await emitPDF(d)))).toBe('a bcd');
  });

  it('uppercases an allCaps run, expanding the characters that need it', async () => {
    const d = doc([textBox([para([run('straße', { allCaps: true })])])]);
    expect(pageText(await contentOf(await emitPDF(d)))).toBe('STRASSE');
  });

  it('sets small caps as capitals at a reduced size', async () => {
    const d = doc([textBox([para([run('Ab', { smallCaps: true, size: 20 })])])]);
    const sizes = opsNamed(await ops(d), 'Tf').map((o) => numbers(o)[0]);
    expect(sizes).toEqual([20, 16]); // 'A' at full size, 'B' at SMALL_CAPS_RATIO
    expect(pageText(await contentOf(await emitPDF(d)))).toBe('AB');
  });
});

// --- text layout ------------------------------------------------------------

describe('text layout', () => {
  const LOREM =
    'The quick brown fox jumps over the lazy dog and then keeps running until it is tired';

  it('breaks lines at exactly the same words as the SVG emitter for a sans face', async () => {
    // The SVG emitter's advance table IS the Helvetica AFM table, and this emitter draws
    // with Tj, which does not kern — so for an unbolded sans run the two measure the same
    // string to the same number and must therefore break it in the same places.
    const d = doc([textBox([para([run(LOREM)])], { width: 150 })]);
    const svgLines = (emitSVG(d).match(/<text /g) ?? []).length;
    const pdfLines = extractText(await contentOf(await emitPDF(d))).length;
    expect(pdfLines).toBeGreaterThan(1);
    expect(pdfLines).toBe(svgLines);
  });

  it('honours a hard line break', async () => {
    const d = doc([textBox([para([run('one\ntwo\nthree')])])]);
    expect(extractText(await contentOf(await emitPDF(d))).map((t) => t.text))
      .toEqual(['one', 'two', 'three']);
  });

  it('centres and right-aligns a line against its box', async () => {
    const left = doc([textBox([para([run('word')], { align: 'left' })], { width: 200 })]);
    const centre = doc([textBox([para([run('word')], { align: 'center' })], { width: 200 })]);
    const right = doc([textBox([para([run('word')], { align: 'right' })], { width: 200 })]);
    const xOf = async (d: Doc) => (extractText(await contentOf(await emitPDF(d)))[0] as { x: number }).x;

    const [l, c, r] = [await xOf(left), await xOf(centre), await xOf(right)];
    expect(l).toBe(0);
    expect(c).toBeGreaterThan(l);
    expect(r).toBeGreaterThan(c);
    // The centre offset is exactly half the right offset, whatever the measured width is.
    expect(c).toBeCloseTo(r / 2, 6);
  });

  it('spreads a justified line with word spacing, and leaves its last line alone', async () => {
    const d = doc([textBox([para([run(LOREM)], { align: 'justify' })], { width: 150 })]);
    const list = await ops(d);
    const spacings = opsNamed(list, 'Tw').map((o) => numbers(o)[0] as number);
    expect(spacings.length).toBeGreaterThan(0);
    for (const s of spacings) expect(s).toBeGreaterThan(0);
    // The final line is not justified, so there are fewer Tw than lines.
    expect(spacings.length).toBeLessThan(extractText(await contentOf(await emitPDF(d))).length);
  });

  it('moves the block down for middle and bottom vertical alignment', async () => {
    const yOf = async (align: 'top' | 'middle' | 'bottom') => {
      const d = doc([textBox([para([run('x')])], { height: 200, verticalAlign: align })]);
      return (extractText(await contentOf(await emitPDF(d)))[0] as { y: number }).y;
    };
    const [top, middle, bottom] = [await yOf('top'), await yOf('middle'), await yOf('bottom')];
    expect(middle).toBeLessThan(top);
    expect(bottom).toBeLessThan(middle);
    // Half the slack for middle, all of it for bottom.
    expect(top - middle).toBeCloseTo((top - bottom) / 2, 6);
  });

  it('packs lines into columns, side by side', async () => {
    const paragraphs = Array.from({ length: 12 }, () => para([run('line')]));
    const d = doc([textBox(paragraphs, { width: 300, height: 60, columns: { count: 2, gap: 20 } })]);
    const shown = extractText(await contentOf(await emitPDF(d)));
    const xs = [...new Set(shown.map((s) => s.x))].sort((a, b) => a - b);
    expect(xs).toHaveLength(2);
    expect((xs[1] as number) - (xs[0] as number)).toBeCloseTo(300 / 2 - 20 / 2 + 20, 6);
  });

  it('adds a bullet to an unordered list item', async () => {
    const d = doc([textBox([para([run('item')], { list: { type: 'unordered', level: 0 } })])]);
    expect(pageText(await contentOf(await emitPDF(d)))).toBe('• item');
  });

  it('keeps the text of a box far too small to wrap into, and reports the overflow', async () => {
    // tdf78739-3.pub in the corpus reports a 5.5pt frame around 3,911 characters.
    const d = doc([
      textBox([para([run('several words that cannot possibly fit', { size: 20 })])], {
        width: 5.4, height: 5.6, padding: { top: 2.8, right: 2.8, bottom: 2.8, left: 2.8 },
      }),
    ]);
    const bytes = await emitPDF(d);
    expect(pageText(await contentOf(bytes))).toBe('several words that cannot possibly fit');
    expect(extractText(await contentOf(bytes))).toHaveLength(1); // unwrapped, one line
    expect(codes(d)).toContain('OVERLAP_MAY_REFLOW');
  });

  it('does not report an overflow for a tiny box with nothing in it', async () => {
    const d = doc([textBox([para([run('')])], { width: 2, height: 2 })]);
    await emitPDF(d);
    expect(codes(d)).not.toContain('OVERLAP_MAY_REFLOW');
  });

  it('applies superscript as a text rise and character scaling as a squeeze', async () => {
    const d = doc([textBox([para([
      run('x'), run('2', { baselineShift: 33 }), run('wide', { textScale: 80 }),
    ])])]);
    const list = await ops(d);
    expect(opsNamed(list, 'Ts').map((o) => numbers(o)[0])).toEqual([0.33 * 12]);
    expect(opsNamed(list, 'Tz').map((o) => numbers(o)[0])).toEqual([80]);
  });

  it('draws an underline below the baseline and a strike above it', async () => {
    const d = doc([textBox([para([run('word', { underline: true, strike: true })])])]);
    const list = await ops(d);
    const rules = opsNamed(list, 're').filter((o) => (numbers(o)[3] as number) < 2);
    expect(rules).toHaveLength(2);
    const ys = rules.map((o) => numbers(o)[1] as number).sort((a, b) => a - b);
    const baseline = PAGE_H - 12 * 0.8;
    expect(ys[0]).toBeLessThan(baseline); // underline
    expect(ys[1]).toBeGreaterThan(baseline); // strike
  });

  it('draws outlined text in outline rendering mode', async () => {
    const d = doc([textBox([para([run('O', { outline: true })])])]);
    expect(opsNamed(await ops(d), 'Tr').map((o) => numbers(o)[0])).toEqual([1]);
  });

  it('draws an embossed run as one ghost copy, marked as an artifact', async () => {
    const d = doc([textBox([para([run('Relief', { relief: 'embossed' })])])]);
    const content = await contentOf(await emitPDF(d));
    // Two copies are drawn, but a reader extracting text must only see one.
    expect(opsNamed(parseOps(content), 'Tj')).toHaveLength(2);
    expect(pageText(content)).toBe('Relief');
  });

  it('adds a link annotation over a linked run', async () => {
    const d = doc([textBox([para([run('click', { link: 'https://example.org/a' })])])]);
    const bytes = await emitPDF(d);
    expect(await annotationCount(bytes)).toBe(1);
    expect(await firstLinkURI(bytes)).toBe('https://example.org/a');
  });
});

// --- shapes -----------------------------------------------------------------

describe('shapes', () => {
  const solid: ShapeStyle = { fill: { type: 'solid', color: '#3366cc' } };

  it('draws a plain rectangle as a rectangle', async () => {
    const list = await ops(doc([rect(solid)]));
    expect(opsNamed(list, 're').filter((o) => numbers(o)[2] === 100)).toHaveLength(1);
    expect(opsNamed(list, 'c')).toHaveLength(0);
  });

  it('draws a rounded rectangle as four corner curves', async () => {
    const list = await ops(doc([rect(solid, { geometry: { type: 'rect', rx: 8, ry: 8 } })]));
    expect(opsNamed(list, 'c')).toHaveLength(4);
    expect(opsNamed(list, 'l')).toHaveLength(4);
    expect(opsNamed(list, 're').filter((o) => numbers(o)[2] === 100)).toHaveLength(0);
  });

  it('draws an ellipse as four curves round the box centre', async () => {
    const list = await ops(doc([rect(solid, { geometry: { type: 'ellipse' } })]));
    expect(opsNamed(list, 'c')).toHaveLength(4);
    const start = numbers(opsNamed(list, 'm')[0] as Op);
    expect(start).toEqual([110, PAGE_H - 45]); // rightmost point of (10,20,100,50)
  });

  it('closes a polygon and does not close or fill a polyline', async () => {
    const points = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }];
    const polygon = await ops(doc([rect(solid, { geometry: { type: 'polygon', points } })]));
    expect(opsNamed(polygon, 'h')).toHaveLength(1);
    expect(opsNamed(polygon, 'f')).toHaveLength(2); // the page backdrop, and the polygon

    const polyline = await ops(doc([rect(solid, { geometry: { type: 'polyline', points } })]));
    expect(opsNamed(polyline, 'h')).toHaveLength(0);
    expect(opsNamed(polyline, 'f')).toHaveLength(1); // the backdrop only
  });

  it('emits every path command, turning a quadratic into its exact cubic', async () => {
    const d: PathCommand[] = [
      { op: 'M', x: 0, y: 0 },
      { op: 'L', x: 30, y: 0 },
      { op: 'C', x1: 40, y1: 0, x2: 50, y2: 10, x: 50, y: 20 },
      { op: 'Q', x1: 50, y1: 40, x: 30, y: 40 },
      { op: 'Z' },
    ];
    const list = await ops(doc([rect(solid, { geometry: { type: 'path', d } })]));
    expect(opsNamed(list, 'm')).toHaveLength(1);
    expect(opsNamed(list, 'l')).toHaveLength(1);
    expect(opsNamed(list, 'c')).toHaveLength(2); // the cubic, and the converted quadratic
    expect(opsNamed(list, 'h')).toHaveLength(1);

    // Control points of a quadratic lifted to a cubic sit two thirds of the way along.
    const quadratic = numbers(opsNamed(list, 'c')[1] as Op);
    expect(quadratic[0]).toBeCloseTo(50, 6);
    expect(quadratic[1]).toBeCloseTo(PAGE_H - (20 + (2 / 3) * 20), 6);
  });

  it('approximates an arc with Béziers whose endpoints lie on the true ellipse', async () => {
    const rx = 80;
    const ry = 40;
    const d: PathCommand[] = [
      { op: 'M', x: 100, y: 200 },
      { op: 'A', rx, ry, rotation: 0, largeArc: true, sweep: true, x: 100 + 2 * rx, y: 200 },
    ];
    const list = await ops(doc([rect(solid, { geometry: { type: 'path', d } })]));
    const curves = opsNamed(list, 'c');
    // A 180-degree sweep splits into two 90-degree segments at MAX_ARC_SEGMENT_DEG.
    expect(curves).toHaveLength(2);

    // Centre of that arc is (180, 200) model / (180, 592) PDF.
    const cx = 100 + rx;
    const cy = PAGE_H - 200;
    for (const curve of curves) {
      const [, , , , x, y] = numbers(curve);
      const on = ((x as number) - cx) ** 2 / rx ** 2 + ((y as number) - cy) ** 2 / ry ** 2;
      expect(on).toBeCloseTo(1, 6);
    }
    // The midpoint control net must not bulge more than the documented 2.7e-4 of r.
    const [x1, y1] = numbers(curves[0] as Op);
    expect(Math.abs((x1 as number) - (cx - rx))).toBeLessThan(0.5);
    expect((y1 as number) - cy).toBeGreaterThan(0);
  });

  it('degenerates a zero-radius arc to a straight segment rather than dividing by zero', async () => {
    const d: PathCommand[] = [
      { op: 'M', x: 0, y: 0 },
      { op: 'A', rx: 0, ry: 0, rotation: 0, largeArc: false, sweep: false, x: 40, y: 40 },
    ];
    const list = await ops(doc([rect(solid, { geometry: { type: 'path', d } })]));
    const curve = numbers(opsNamed(list, 'c')[0] as Op);
    expect(curve.every((n) => Number.isFinite(n))).toBe(true);
    expect(curve.slice(4)).toEqual([40, PAGE_H - 40]);
  });
});

// --- fills ------------------------------------------------------------------

describe('fills', () => {
  it('sets a solid fill from the model colour', async () => {
    const d = doc([rect({ fill: { type: 'solid', color: '#3366cc' } })]);
    const fills = opsNamed(await ops(d), 'rg').map(numbers);
    expect(fills).toContainEqual([0x33 / 255, 0x66 / 255, 0xcc / 255]);
  });

  it('builds a real axial shading for a two-stop gradient', async () => {
    const fill: Fill = {
      type: 'gradient', angle: 90,
      stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }],
    };
    const bytes = await emitPDF(doc([rect({ fill })]));
    const shadings = await shadingsOf(bytes);
    expect(shadings.size).toBe(1);

    const shading = [...shadings.values()][0]!;
    expect(numberAt(shading, 'ShadingType')).toBe(2);
    expect(nameAt(shading, 'ColorSpace')).toBe('DeviceRGB');

    // 90 degrees is top-to-bottom in the model, so the axis runs down the page: in PDF
    // space that means the second point is the lower y.
    const coords = numbersAt(shading, 'Coords');
    expect(coords[0]).toBeCloseTo(60, 6);
    expect(coords[2]).toBeCloseTo(60, 6);
    expect(coords[1]).toBeGreaterThan(coords[3] as number);

    expect(numberAt(dictAt(shading, 'Function'), 'FunctionType')).toBe(2);

    const list = await ops(doc([rect({ fill })]));
    expect(opsNamed(list, 'sh')).toHaveLength(1);
    expect(opsNamed(list, 'W')).toHaveLength(1); // the shape becomes the clip
  });

  it('stitches a function per interval for a multi-stop gradient', async () => {
    const fill: Fill = {
      type: 'gradient', angle: 0,
      stops: [
        { offset: 0, color: '#8064a2' },
        { offset: 0.5, color: '#5b4773' },
        { offset: 1, color: '#8064a2' },
      ],
    };
    const shading = [...(await shadingsOf(await emitPDF(doc([rect({ fill })])))).values()][0]!;
    const fn = dictAt(shading, 'Function');
    expect(numberAt(fn, 'FunctionType')).toBe(3);
    expect(lengthAt(fn, 'Functions')).toBe(2);
    expect(numbersAt(fn, 'Bounds')).toEqual([0.5]);
    expect(lengthAt(fn, 'Encode')).toBe(4);
  });

  it('completes a gradient whose stops do not reach both ends of the ramp', async () => {
    const fill: Fill = {
      type: 'gradient', angle: 0,
      stops: [{ offset: 0.25, color: '#ff0000' }, { offset: 0.75, color: '#00ff00' }],
    };
    const shading = [...(await shadingsOf(await emitPDF(doc([rect({ fill })])))).values()][0]!;
    // Stops at 0 and 1 are added, so the two-stop list becomes a three-interval stitch.
    const fn = dictAt(shading, 'Function');
    expect(numberAt(fn, 'FunctionType')).toBe(3);
    expect(lengthAt(fn, 'Functions')).toBe(3);
  });

  it('flattens a gradient that fades in and out of transparency, and says so', async () => {
    const fill: Fill = {
      type: 'gradient', angle: 0,
      stops: [
        { offset: 0, color: '#ff0000', opacity: 0 },
        { offset: 1, color: '#ff0000', opacity: 1 },
      ],
    };
    const d = doc([rect({ fill })]);
    const bytes = await emitPDF(d);
    expect(codes(d)).toContain('GRADIENT_FLATTENED');
    expect([...(await extGStatesOf(bytes)).values()].map((g) => numberAt(g, 'ca'))).toContain(0.5);
  });

  it('does not flatten a gradient whose stops are all opaque', async () => {
    const d = doc([rect({
      fill: {
        type: 'gradient', angle: 0,
        stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }],
      },
    })]);
    await emitPDF(d);
    expect(codes(d)).not.toContain('GRADIENT_FLATTENED');
  });

  it('embeds a PNG and places it over the element box', async () => {
    const d = doc(
      [{ kind: 'image', x: 10, y: 20, width: 100, height: 50, assetRef: 'p' } as Element],
      { assets: { p: { data: png(4, 3), mime: 'image/png' } } },
    );
    const list = await ops(d);
    expect(opsNamed(list, 'Do')).toHaveLength(1);
    const cm = opsNamed(list, 'cm').map(numbers);
    expect(cm).toContainEqual([100, 0, 0, 50, 10, PAGE_H - 70]);
  });

  it('decodes a BMP, which PDF cannot carry and pdf-lib will not embed', async () => {
    const d = doc(
      [{ kind: 'image', x: 0, y: 0, width: 40, height: 40, assetRef: 'b' } as Element],
      { assets: { b: { data: bmp(3, 2), mime: 'image/bmp' } } },
    );
    const bytes = await emitPDF(d);
    expect(opsNamed(parseOps(await contentOf(bytes)), 'Do')).toHaveLength(1);
    expect(codes(d)).not.toContain('WMF_IMAGE_NOT_CONVERTED');

    const images = await imageDictsOf(bytes);
    expect(images).toHaveLength(1);
    expect(numberAt(images[0] as PDFDict, 'Width')).toBe(3);
    expect(numberAt(images[0] as PDFDict, 'Height')).toBe(2);
    expect(nameAt(images[0] as PDFDict, 'ColorSpace')).toBe('DeviceRGB');
  });


  it('decodes a GIF, which PDF cannot carry either', async () => {
    const d = doc(
      [{ kind: 'image', x: 0, y: 0, width: 40, height: 40, assetRef: 'g' } as Element],
      { assets: { g: { data: gif(2, 2, [0, 1, 2, 3], [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]), mime: 'image/gif' } } },
    );
    const bytes = await emitPDF(d);
    expect(codes(d)).not.toContain('WMF_IMAGE_NOT_CONVERTED');
    const images = await imageDictsOf(bytes);
    expect(images).toHaveLength(1);
    expect(numberAt(images[0] as PDFDict, 'Width')).toBe(2);
    expect(numberAt(images[0] as PDFDict, 'Height')).toBe(2);
    expect(nameAt(images[0] as PDFDict, 'ColorSpace')).toBe('DeviceRGB');
  });

  it('carries a GIF transparent colour across as a soft mask', async () => {
    const opaque = gif(2, 2, [0, 1, 0, 1], [[255, 0, 0], [0, 0, 255]]);
    const masked = gif(2, 2, [0, 1, 0, 1], [[255, 0, 0], [0, 0, 255]], 1);

    const withoutMask = await imageDictsOf(await emitPDF(doc(
      [{ kind: 'image', x: 0, y: 0, width: 9, height: 9, assetRef: 'g' } as Element],
      { assets: { g: { data: opaque, mime: 'image/gif' } } },
    )));
    const withMask = await imageDictsOf(await emitPDF(doc(
      [{ kind: 'image', x: 0, y: 0, width: 9, height: 9, assetRef: 'g' } as Element],
      { assets: { g: { data: masked, mime: 'image/gif' } } },
    )));
    expect(withoutMask[0]?.has(PDFName.of('SMask'))).toBe(false);
    expect(withMask[0]?.has(PDFName.of('SMask'))).toBe(true);
  });

  it('believes the bytes rather than the declared type', async () => {
    // Two corpus files store GIFs that libmspub reports as image/png. Browsers sniff, so
    // the SVG emitter never notices; pdf-lib's PNG decoder correctly refuses them.
    const d = doc(
      [{ kind: 'image', x: 0, y: 0, width: 40, height: 40, assetRef: 'g' } as Element],
      { assets: { g: { data: gif(2, 2, [0, 1, 0, 1], [[255, 0, 0], [0, 0, 255]]), mime: 'image/png' } } },
    );
    const bytes = await emitPDF(d);
    expect(codes(d)).not.toContain('WMF_IMAGE_NOT_CONVERTED');
    expect(await imageDictsOf(bytes)).toHaveLength(1);
  });

  it('tiles a repeating image fill and stretches a stretching one', async () => {
    const asset = { assets: { p: { data: png(8, 8), mime: 'image/png' } } };
    const tiled = await ops(doc([rect({ fill: { type: 'image', assetRef: 'p', repeat: 'repeat' } })], asset));
    const stretched = await ops(doc([rect({ fill: { type: 'image', assetRef: 'p', repeat: 'stretch' } })], asset));
    // An 8px tile is 6pt at 96dpi, so a 100x50pt box takes 17 x 9 of them.
    expect(opsNamed(tiled, 'Do').length).toBe(17 * 9);
    expect(opsNamed(stretched, 'Do')).toHaveLength(1);
  });

  it('marks where a metafile was instead of pretending it converted', async () => {
    const d = doc(
      [{ kind: 'image', x: 0, y: 0, width: 80, height: 40, assetRef: 'w' } as Element],
      { assets: { w: { data: 'AAAA', mime: 'image/wmf' } } },
    );
    const content = await contentOf(await emitPDF(d));
    expect(codes(d)).toContain('WMF_IMAGE_NOT_CONVERTED');
    expect(opsNamed(parseOps(content), 'Do')).toHaveLength(0);
    // The label explains an absence, so it is an artifact and not part of the text.
    expect(pageText(content)).toBe('');
    expect(opsNamed(parseOps(content), 'd').length).toBeGreaterThan(0); // dashed frame
  });

  it('survives a picture whose bytes do not decode', async () => {
    const d = doc(
      [{ kind: 'image', x: 0, y: 0, width: 80, height: 40, assetRef: 'p' } as Element],
      { assets: { p: { data: 'bm90IGEgcG5n', mime: 'image/png' } } },
    );
    await expect(emitPDF(d)).resolves.toBeInstanceOf(Uint8Array);
    expect(codes(d)).toContain('WMF_IMAGE_NOT_CONVERTED');
  });
});

// --- strokes, opacity, shadows ---------------------------------------------

describe('strokes, opacity and shadows', () => {
  it('sets stroke width and dash pattern', async () => {
    const d = doc([rect({ stroke: { color: '#112233', width: 2.5, dash: [4, 3] } })]);
    const list = await ops(d);
    expect(opsNamed(list, 'w').map((o) => numbers(o)[0])).toEqual([2.5]);
    expect(opsNamed(list, 'd')[0]?.args[0]).toEqual([4, 3]);
    expect(opsNamed(list, 'RG').map(numbers)).toContainEqual([0x11 / 255, 0x22 / 255, 0x33 / 255]);
    expect(opsNamed(list, 'S')).toHaveLength(1);
  });

  it('draws no stroke at all for a zero width, which PDF would render as a hairline', async () => {
    const d = doc([rect({ stroke: { color: '#000000', width: 0 } })]);
    expect(opsNamed(await ops(d), 'S')).toHaveLength(0);
  });

  it('ignores an all-zero dash array, which PDF rejects', async () => {
    const d = doc([rect({ stroke: { color: '#000000', width: 1, dash: [0, 0] } })]);
    expect(opsNamed(await ops(d), 'd')).toHaveLength(0);
  });

  it('applies element opacity as a graphics state on both fill and stroke', async () => {
    const d = doc([rect({ fill: { type: 'solid', color: '#ff0000' }, opacity: 0.4 })]);
    const bytes = await emitPDF(d);
    const states = [...(await extGStatesOf(bytes)).values()];
    expect(states).toHaveLength(1);
    expect(numberAt(states[0]!, 'ca')).toBe(0.4);
    expect(numberAt(states[0]!, 'CA')).toBe(0.4);
    expect(opsNamed(parseOps(await contentOf(bytes)), 'gs')).toHaveLength(1);
  });

  it('draws a drop shadow as an offset copy of the shape behind it', async () => {
    const shadow: Shadow = { color: '#808080', offsetX: 3, offsetY: 4, opacity: 0.5 };
    const d = doc([rect({ fill: { type: 'solid', color: '#ff0000' }, shadow })]);
    const list = await ops(d);
    const boxes = opsNamed(list, 're').filter((o) => numbers(o)[2] === 100).map(numbers);
    expect(boxes).toHaveLength(2);
    const [first, second] = boxes as [number[], number[]];
    // The shadow is painted first, offset right and down.
    expect(first[0]).toBe(13);
    expect(first[1]).toBe(PAGE_H - 74);
    expect(second[0]).toBe(10);
    expect(second[1]).toBe(PAGE_H - 70);
    expect(opsNamed(list, 'rg').map(numbers)).toContainEqual([0.5019607843137255, 0.5019607843137255, 0.5019607843137255]);
  });

  it('reports a shadow it cannot cast because the shape has no fill', async () => {
    const d = doc([rect({ stroke: { color: '#000000', width: 1 }, shadow: { color: '#000000', offsetX: 2, offsetY: 2, opacity: 1 } })]);
    await emitPDF(d);
    expect(codes(d)).toContain('SHADOW_DROPPED');
  });

  it('shadows unfilled text with the letters themselves, as an artifact', async () => {
    const d = doc([textBox([para([run('Sale')])], {
      style: { shadow: { color: '#000000', offsetX: 2, offsetY: 2, opacity: 1 } },
    })]);
    const content = await contentOf(await emitPDF(d));
    expect(opsNamed(parseOps(content), 'Tj')).toHaveLength(2);
    expect(pageText(content)).toBe('Sale'); // read once, not twice
    expect(codes(d)).not.toContain('SHADOW_DROPPED');
  });
});

// --- tables -----------------------------------------------------------------

describe('tables', () => {
  function table(): Element {
    return {
      kind: 'table', x: 100, y: 200, width: 200, height: 40,
      columnWidths: [100, 100],
      rows: [
        {
          height: 20,
          cells: [
            { row: 0, column: 0, rowSpan: 1, colSpan: 2, covered: false, paragraphs: [para([run('wide')])], style: { fill: { type: 'solid', color: '#eeeeee' } } },
            { row: 0, column: 1, rowSpan: 1, colSpan: 1, covered: true, paragraphs: [para([run('hidden')])] },
          ],
        },
        {
          height: 20,
          cells: [
            { row: 1, column: 0, rowSpan: 1, colSpan: 1, covered: false, paragraphs: [para([run('a')])] },
            { row: 1, column: 1, rowSpan: 1, colSpan: 1, covered: false, paragraphs: [para([run('b')])] },
          ],
        },
      ],
    } as Element;
  }

  it('skips the cells a span covers and draws the anchor across both columns', async () => {
    const content = await contentOf(await emitPDF(doc([table()])));
    expect(pageText(content)).toBe('wideab');
    // Only the spanning cell has a fill of its own; a cell with no style paints nothing,
    // exactly as the SVG emitter's `fill="none"` rectangle does.
    const boxes = opsNamed(parseOps(content), 're').filter((o) => numbers(o)[2] !== PAGE_W).map(numbers);
    expect(boxes).toEqual([[100, PAGE_H - 220, 200, 20]]);
  });

  it('places cell text at its own row and column, inset by the cell margin', async () => {
    const shown = extractText(await contentOf(await emitPDF(doc([table()]))));
    expect(shown.map((s) => s.text)).toEqual(['wide', 'a', 'b']);
    expect(shown.map((s) => [s.x, s.y])).toEqual([
      [102.9, PAGE_H - 202.9 - 12 * 0.8],
      [102.9, PAGE_H - 222.9 - 12 * 0.8],
      [202.9, PAGE_H - 222.9 - 12 * 0.8],
    ]);
  });
});

// --- groups -----------------------------------------------------------------

describe('groups', () => {
  it('draws children in page coordinates and gives the group its own rotation', async () => {
    const child = rect({ fill: { type: 'solid', color: '#ff0000' } });
    const group: Element = {
      kind: 'group', x: 0, y: 0, width: 200, height: 200, rotation: 45, children: [child],
    } as Element;
    const list = await ops(doc([group]));
    const boxes = opsNamed(list, 're').filter((o) => numbers(o)[2] === 100).map(numbers);
    expect(boxes).toEqual([[10, PAGE_H - 70, 100, 50]]);
    expect(opsNamed(list, 'cm').some((o) => numbers(o)[1] !== 0)).toBe(true);
  });
});

// --- metadata ---------------------------------------------------------------

describe('metadata', () => {
  it('carries the document properties across', async () => {
    const d = doc([], {
      meta: {
        title: 'Spring Newsletter',
        creator: 'A. Secretary',
        subject: 'Parish news',
        keywords: 'church, bulletin; spring',
        created: '2009-04-01T10:11:12Z',
        sourceVersion: '2010',
      },
    });
    // pdf-lib stamps its own Producer and ModDate on load unless told not to, which would
    // overwrite the very fields under test.
    const pdf = await PDFDocument.load(await emitPDF(d), { updateMetadata: false });
    expect(pdf.getTitle()).toBe('Spring Newsletter');
    expect(pdf.getAuthor()).toBe('A. Secretary');
    expect(pdf.getSubject()).toBe('Parish news');
    expect(pdf.getKeywords()).toBe('church bulletin spring');
    expect(pdf.getCreator()).toBe('Microsoft Publisher 2010');
    expect(pdf.getProducer()).toBe('Pubshift');
    expect(pdf.getCreationDate()?.toISOString()).toBe('2009-04-01T10:11:12.000Z');
  });

  it('ignores a creation date the file gives us that is not a date', async () => {
    const d = doc([], { meta: { created: 'not a date' } });
    await expect(emitPDF(d)).resolves.toBeInstanceOf(Uint8Array);
  });

  it('produces the same bytes twice for the same document', async () => {
    const build = () => doc([textBox([para([run('stable')])])], { meta: { title: 'T' } });
    const a = await emitPDF(build());
    const b = await emitPDF(build());
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });
});

// --- warnings ---------------------------------------------------------------

describe('warnings', () => {
  it('counts repeats rather than repeating itself', async () => {
    const d = doc([
      { kind: 'image', x: 0, y: 0, width: 10, height: 10, assetRef: 'w' } as Element,
      { kind: 'image', x: 0, y: 20, width: 10, height: 10, assetRef: 'w' } as Element,
    ], { assets: { w: { data: 'AAAA', mime: 'image/emf' } } });
    await emitPDF(d);
    const metafile = d.warnings.filter((w) => w.code === 'WMF_IMAGE_NOT_CONVERTED');
    // Both elements share one asset, so it is embedded — and reported — once.
    expect(metafile).toHaveLength(1);
  });

  it('does not duplicate its warnings when the same document is emitted twice', async () => {
    const d = doc([textBox([para([run('x', { font: 'Calibri' })])])]);
    await emitPDF(d);
    const first = d.warnings.length;
    await emitPDF(d);
    expect(d.warnings.length).toBe(first);
  });

  it('leaves the warnings the model builder already recorded alone', async () => {
    const d = doc([textBox([para([run('x')])])]);
    d.warnings.push({ code: 'COLUMNS_FLATTENED', message: 'from the builder', page: 1 });
    await emitPDF(d);
    expect(d.warnings[0]).toEqual({ code: 'COLUMNS_FLATTENED', message: 'from the builder', page: 1 });
  });

  it('reports rotated text but not a rotated picture', async () => {
    const rotatedText = doc([textBox([para([run('tilted')])], { rotation: 15 })]);
    await emitPDF(rotatedText);
    expect(codes(rotatedText)).toContain('ROTATED_TEXT_APPROXIMATED');

    const rotatedShape = doc([rect({ fill: { type: 'solid', color: '#000000' } }, { rotation: 15 })]);
    await emitPDF(rotatedShape);
    expect(codes(rotatedShape)).not.toContain('ROTATED_TEXT_APPROXIMATED');
  });
});
