/**
 * PPTX emitter unit tests.
 *
 * Two things are being checked throughout. First, that the model's geometry and styling
 * arrive in the deck as the exact OOXML a reader expects — EMU, 60000ths of a degree,
 * 1000ths of a percent — because "close enough" in any of those units is a visibly wrong
 * slide. Second, that the package holds together: every part is well-formed, every
 * `r:id` resolves, and every relationship target exists. A dangling relationship is the
 * classic way a generated deck opens as a repair dialog rather than as a document.
 */

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { emitPPTX, emitPPTXWithReport } from '../src/emit/pptx';
import type {
  Doc, Element, Fill, Page, Paragraph, PathCommand, Run, Shape, ShapeStyle, Table, TableRow,
} from '../src/model/types';
import { allText, findAll, findFirst, parseXML, type XNode } from './helpers/xml';

const EMU_PER_POINT = 12700;
const pt = (points: number) => String(Math.round(points * EMU_PER_POINT));

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
  return { kind: 'text', x: 10, y: 20, width: 300, height: 100, paragraphs, ...over } as Element;
}

function shape(geometry: Shape['geometry'], over: Partial<Shape> = {}): Shape {
  return { kind: 'shape', x: 0, y: 0, width: 100, height: 50, geometry, ...over };
}

/** A one-pixel PNG; only its bytes matter, never its contents. */
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// --- package access ---------------------------------------------------------

async function open(d: Doc): Promise<Map<string, string>> {
  const zip = await JSZip.loadAsync(await emitPPTX(d));
  const parts = new Map<string, string>();
  for (const path of Object.keys(zip.files)) {
    const file = zip.files[path];
    if (!file || file.dir) continue;
    parts.set(path, path.endsWith('.xml') || path.endsWith('.rels') ? await file.async('string') : '');
  }
  return parts;
}

function xml(parts: Map<string, string>, path: string): XNode {
  const source = parts.get(path);
  expect(source, `missing part ${path}`).toBeDefined();
  return parseXML(source as string);
}

async function slide(d: Doc, index = 0): Promise<XNode> {
  return xml(await open(d), `ppt/slides/slide${index + 1}.xml`);
}

/** The painted shapes of a slide, skipping the shape tree's own header elements. */
function painted(tree: XNode): XNode[] {
  const spTree = findFirst(tree, 'p:spTree') as XNode;
  return spTree.children.filter((c) => c.name !== 'p:nvGrpSpPr' && c.name !== 'p:grpSpPr');
}

async function firstShape(d: Doc): Promise<XNode> {
  return painted(await slide(d))[0] as XNode;
}

function attr(node: XNode | undefined, name: string): string | undefined {
  return node?.attrs[name];
}

// --- the package ------------------------------------------------------------

describe('package', () => {
  it('writes every part a presentation needs', async () => {
    const parts = await open(doc([]));
    for (const path of [
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'docProps/app.xml',
      'ppt/presentation.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/presProps.xml',
      'ppt/tableStyles.xml',
      'ppt/theme/theme1.xml',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      'ppt/slides/slide1.xml',
      'ppt/slides/_rels/slide1.xml.rels',
    ]) {
      expect(parts.has(path), `missing ${path}`).toBe(true);
    }
  });

  it('parses every part as well-formed XML', async () => {
    const d = doc([
      text([para([run('a & b <c>')])]),
      shape({ type: 'ellipse' }, { style: { fill: { type: 'solid', color: '#ff0000' } } }),
    ]);
    const parts = await open(d);
    for (const [path, source] of parts) {
      if (source === '') continue;
      expect(() => parseXML(source), `malformed ${path}`).not.toThrow();
    }
  });

  it('declares a content type for every part', async () => {
    const parts = await open(doc([{ kind: 'image', x: 0, y: 0, width: 10, height: 10, assetRef: 'a' }], {
      assets: { a: { data: PNG_1PX, mime: 'image/png' } },
    }));
    const types = xml(parts, '[Content_Types].xml');
    const defaults = new Set(findAll(types, 'Default').map((d) => d.attrs.Extension));
    const overrides = new Set(findAll(types, 'Override').map((o) => o.attrs.PartName));

    for (const path of parts.keys()) {
      if (path === '[Content_Types].xml') continue;
      const extension = path.slice(path.lastIndexOf('.') + 1);
      const covered = defaults.has(extension) || overrides.has(`/${path}`);
      expect(covered, `no content type for ${path}`).toBe(true);
    }
    expect(defaults.has('png')).toBe(true);
    expect(defaults.has('rels')).toBe(true);
  });

  it('resolves every relationship it references, and every target it declares', async () => {
    const d = doc([
      { kind: 'image', x: 0, y: 0, width: 10, height: 10, assetRef: 'a' },
      text([para([run('link', { link: 'https://example.org/x?a=1&b=2' })])]),
    ], { assets: { a: { data: PNG_1PX, mime: 'image/png' } } });
    const parts = await open(d);

    for (const [path, source] of parts) {
      if (source === '' || path.endsWith('.rels')) continue;
      const relsPath = path.replace(/([^/]+)$/, '_rels/$1.rels');
      const declared = new Map<string, { target: string; external: boolean }>();
      const relsSource = parts.get(relsPath);
      if (relsSource) {
        for (const r of findAll(parseXML(relsSource), 'Relationship')) {
          declared.set(r.attrs.Id as string, {
            target: r.attrs.Target as string,
            external: r.attrs.TargetMode === 'External',
          });
        }
      }
      // Every r:id / r:embed the part uses must be declared.
      for (const match of source.matchAll(/r:(?:id|embed)="([^"]+)"/g)) {
        expect(declared.has(match[1] as string), `${path} uses undeclared ${match[1]}`).toBe(true);
      }
      // Every internal target must be a part that is actually in the package.
      const base = path.slice(0, path.lastIndexOf('/') + 1);
      for (const { target, external } of declared.values()) {
        if (external) continue;
        const resolved = new URL(target, `file:///${base}`).pathname.replace(/^\//, '');
        expect(parts.has(decodeURIComponent(resolved)), `${path} points at missing ${target}`).toBe(true);
      }
    }
  });

  it('lists one slide per page, in page order', async () => {
    const d = doc([]);
    d.pages = [
      { width: 612, height: 792, elements: [text([para([run('one')])])] },
      { width: 612, height: 792, elements: [text([para([run('two')])])] },
      { width: 612, height: 792, elements: [text([para([run('three')])])] },
    ];
    const parts = await open(d);
    const presentation = xml(parts, 'ppt/presentation.xml');
    const ids = findAll(presentation, 'p:sldId');
    expect(ids).toHaveLength(3);
    expect(ids.map((s) => s.attrs.id)).toEqual(['256', '257', '258']);

    const rels = xml(parts, 'ppt/_rels/presentation.xml.rels');
    const byId = new Map(findAll(rels, 'Relationship').map((r) => [r.attrs.Id, r.attrs.Target]));
    expect(ids.map((s) => byId.get(s.attrs['r:id'] as string))).toEqual([
      'slides/slide1.xml', 'slides/slide2.xml', 'slides/slide3.xml',
    ]);
    expect(allText(xml(parts, 'ppt/slides/slide2.xml'))).toContain('two');
  });

  it('sets the slide size from the page size, in EMU', async () => {
    const d = doc([]);
    (d.pages[0] as Page).width = 419.5;
    (d.pages[0] as Page).height = 595.25;
    const size = findFirst(xml(await open(d), 'ppt/presentation.xml'), 'p:sldSz') as XNode;
    expect(size.attrs.cx).toBe(pt(419.5));
    expect(size.attrs.cy).toBe(pt(595.25));
  });

  it('refuses to build a deck from a document with no pages', async () => {
    await expect(emitPPTX({ pages: [], meta: {}, assets: {}, warnings: [] })).rejects.toThrow(RangeError);
  });

  it('produces the same bytes for the same document', async () => {
    const build = () => emitPPTX(doc([text([para([run('stable')])])]));
    expect(Buffer.from(await build()).equals(Buffer.from(await build()))).toBe(true);
  });

  it('stamps every entry with a fixed date and adds no directory entries', async () => {
    // Timestamps are the way a zip stops being reproducible: jszip dates an implicit
    // directory entry with the current time, so two builds a second apart differ. Checking
    // the entries directly catches that whatever the clock happens to be doing.
    const zip = await JSZip.loadAsync(await emitPPTX(doc([text([para([run('x')])])])));
    const entries = Object.values(zip.files);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.dir, entry.name).toBe(false);
      expect(entry.date.getUTCFullYear(), entry.name).toBe(2020);
    }
  });

  it('carries the document title into the core properties', async () => {
    const parts = await open(doc([], { meta: { title: 'Spring & Summer <2026>' } }));
    const core = xml(parts, 'docProps/core.xml');
    expect(findFirst(core, 'dc:title')?.text).toBe('Spring & Summer <2026>');
  });

  it('keeps two different losses apart even when they share a code', async () => {
    // The model's WarningCode union is fixed and narrower than the set of things
    // PowerPoint cannot express, so the message is what tells the two apart.
    const d = doc([text([para([
      run('a', { relief: 'embossed' }),
      run('b', { textScale: 80 }),
    ])])]);
    const { warnings } = await emitPPTXWithReport(d);
    expect(warnings).toHaveLength(2);
    expect(new Set(warnings.map((w) => w.code))).toEqual(new Set(['SHAPE_APPROXIMATED']));
    expect(warnings.map((w) => w.message).join(' ')).toMatch(/emboss/i);
    expect(warnings.map((w) => w.message).join(' ')).toMatch(/width/i);
  });

  it('reports a page whose size differs from the first, rather than rescaling it', async () => {
    const d = doc([]);
    d.pages = [
      { width: 612, height: 792, elements: [] },
      { width: 842, height: 595, elements: [] },
    ];
    const { warnings } = await emitPPTXWithReport(d);
    expect(warnings.map((w) => w.page)).toContain(2);
    expect(warnings[0]?.message).toMatch(/one slide size/);
  });
});

// --- text -------------------------------------------------------------------

describe('text boxes', () => {
  it('places the box at its own coordinates and size', async () => {
    const sp = await firstShape(doc([text([para([run('hi')])], { x: 72, y: 144, width: 200, height: 50 })]));
    expect(sp.name).toBe('p:sp');
    const off = findFirst(sp, 'a:off') as XNode;
    const ext = findFirst(sp, 'a:ext') as XNode;
    expect([off.attrs.x, off.attrs.y]).toEqual([pt(72), pt(144)]);
    expect([ext.attrs.cx, ext.attrs.cy]).toEqual([pt(200), pt(50)]);
  });

  it('turns padding into body insets and vertical alignment into an anchor', async () => {
    const el = text([para([run('hi')])], {
      padding: { top: 1, right: 2, bottom: 3, left: 4 },
      verticalAlign: 'middle',
    });
    const body = findFirst(await firstShape(doc([el])), 'a:bodyPr') as XNode;
    expect(body.attrs.tIns).toBe(pt(1));
    expect(body.attrs.rIns).toBe(pt(2));
    expect(body.attrs.bIns).toBe(pt(3));
    expect(body.attrs.lIns).toBe(pt(4));
    expect(body.attrs.anchor).toBe('ctr');
    expect(findFirst(body, 'a:normAutofit')).toBeDefined();
  });

  it('maps columns onto real PowerPoint columns rather than flattening them', async () => {
    const el = text([para([run('hi')])], { columns: { count: 3, gap: 12 } });
    const body = findFirst(await firstShape(doc([el])), 'a:bodyPr') as XNode;
    expect(body.attrs.numCol).toBe('3');
    expect(body.attrs.spcCol).toBe(pt(12));
  });

  it('writes paragraph properties in the units OOXML uses', async () => {
    const p = para([run('x')], {
      align: 'justify',
      lineHeight: 1.15,
      marginTop: 6,
      marginBottom: 3,
      marginLeft: 18,
      textIndent: -9,
    });
    const pPr = findFirst(await firstShape(doc([text([p])])), 'a:pPr') as XNode;
    expect(pPr.attrs.algn).toBe('just');
    expect(pPr.attrs.marL).toBe(pt(18));
    expect(pPr.attrs.indent).toBe(pt(-9));
    expect(attr(findFirst(pPr, 'a:spcPct'), 'val')).toBe('115000');
    expect(attr(findFirst(findFirst(pPr, 'a:spcBef') as XNode, 'a:spcPts'), 'val')).toBe('600');
    expect(attr(findFirst(findFirst(pPr, 'a:spcAft') as XNode, 'a:spcPts'), 'val')).toBe('300');
  });

  it('maps each alignment', async () => {
    const aligns: Array<[NonNullable<Paragraph['align']>, string]> = [
      ['left', 'l'], ['center', 'ctr'], ['right', 'r'], ['justify', 'just'],
    ];
    for (const [align, expected] of aligns) {
      const sp = await firstShape(doc([text([para([run('x')], { align })])]));
      expect(attr(findFirst(sp, 'a:pPr'), 'algn')).toBe(expected);
    }
  });

  it('suppresses an inherited bullet unless the paragraph is a list', async () => {
    const plain = await firstShape(doc([text([para([run('x')])])]));
    expect(findFirst(plain, 'a:buNone')).toBeDefined();

    const bulleted = await firstShape(doc([text([para([run('x')], { list: { type: 'unordered', level: 0 } })])]));
    expect(findFirst(bulleted, 'a:buNone')).toBeUndefined();
    expect(findFirst(bulleted, 'a:buChar')).toBeDefined();

    const numbered = await firstShape(doc([text([para([run('x')], { list: { type: 'ordered', level: 2 } })])]));
    expect(attr(findFirst(numbered, 'a:buAutoNum'), 'type')).toBe('arabicPeriod');
    expect(attr(findFirst(numbered, 'a:pPr'), 'lvl')).toBe('2');
  });

  it('writes run properties, including the ones with awkward units', async () => {
    const r = run('x', {
      size: 13.5, bold: true, italic: true, underline: true, strike: true,
      color: '#123456', baselineShift: 30, font: 'Georgia',
    });
    const rPr = findFirst(await firstShape(doc([text([para([r])])])), 'a:rPr') as XNode;
    expect(rPr.attrs.sz).toBe('1350');
    expect(rPr.attrs.b).toBe('1');
    expect(rPr.attrs.i).toBe('1');
    expect(rPr.attrs.u).toBe('sng');
    expect(rPr.attrs.strike).toBe('sngStrike');
    expect(rPr.attrs.baseline).toBe('30000');
    expect(attr(findFirst(rPr, 'a:srgbClr'), 'val')).toBe('123456');
    expect(attr(findFirst(rPr, 'a:latin'), 'typeface')).toBe('Georgia');
  });

  it('maps small caps and all caps onto the one attribute OOXML has', async () => {
    const small = await firstShape(doc([text([para([run('x', { smallCaps: true })])])]));
    expect(attr(findFirst(small, 'a:rPr'), 'cap')).toBe('small');

    const all = await firstShape(doc([text([para([run('x', { allCaps: true })])])]));
    expect(attr(findFirst(all, 'a:rPr'), 'cap')).toBe('all');

    // Both at once: all caps is the stronger of the two and there is only one attribute.
    const both = await firstShape(doc([text([para([run('x', { smallCaps: true, allCaps: true })])])]));
    expect(attr(findFirst(both, 'a:rPr'), 'cap')).toBe('all');
  });

  it('leaves the text itself alone when it sets a caps attribute', async () => {
    const sp = await firstShape(doc([text([para([run('Quiet', { allCaps: true })])])]));
    // PowerPoint applies the capitalisation; uppercasing here too would lose the original.
    expect(allText(sp)).toContain('Quiet');
  });

  it('breaks a run on its newlines instead of losing them', async () => {
    const sp = await firstShape(doc([text([para([run('one\ntwo')])])]));
    const p = findFirst(sp, 'a:p') as XNode;
    expect(findAll(p, 'a:br')).toHaveLength(1);
    expect(findAll(p, 'a:t').map((t) => t.text)).toEqual(['one', 'two']);
  });

  it('keeps an empty paragraph, with the height its formatting gives it', async () => {
    const sp = await firstShape(doc([text([para([run('x')]), para([run('', { size: 24 })])])]));
    const paragraphs = findAll(sp, 'a:p');
    expect(paragraphs).toHaveLength(2);
    const endPr = findFirst(paragraphs[1] as XNode, 'a:endParaRPr') as XNode;
    expect(endPr.attrs.sz).toBe('2400');
  });

  it('escapes the characters that would otherwise break the part', async () => {
    const d = doc([text([para([run(String.raw`R&D <tag> "quoted" it's`, { font: 'Arial & Sons' })])])]);
    const parts = await open(d);
    const source = parts.get('ppt/slides/slide1.xml') as string;
    expect(source).not.toMatch(/&(?!(amp|lt|gt|quot|apos);)/);
    const sp = painted(parseXML(source))[0] as XNode;
    expect(findFirst(sp, 'a:t')?.text).toBe(String.raw`R&D <tag> "quoted" it's`);
    expect(attr(findFirst(sp, 'a:latin'), 'typeface')).toBe('Arial & Sons');
  });

  it('strips the control characters Publisher leaves in real text', async () => {
    const dirty = `before${String.fromCharCode(0x0b)}${String.fromCharCode(0x1e)}after`;
    const sp = await firstShape(doc([text([para([run(dirty)])])]));
    expect(findFirst(sp, 'a:t')?.text).toBe('beforeafter');
  });

  it('relates a hyperlink externally', async () => {
    const parts = await open(doc([text([para([run('here', { link: 'https://example.org/a?x=1&y=2' })])])]));
    const rPr = findFirst(parseXML(parts.get('ppt/slides/slide1.xml') as string), 'a:rPr') as XNode;
    const rId = attr(findFirst(rPr, 'a:hlinkClick'), 'r:id');
    const rel = findAll(xml(parts, 'ppt/slides/_rels/slide1.xml.rels'), 'Relationship')
      .find((r) => r.attrs.Id === rId);
    expect(rel?.attrs.TargetMode).toBe('External');
    expect(rel?.attrs.Target).toBe('https://example.org/a?x=1&y=2');
  });
});

// --- geometry ---------------------------------------------------------------

describe('shapes', () => {
  it('uses preset geometry where one maps cleanly', async () => {
    const rect = await firstShape(doc([shape({ type: 'rect' })]));
    expect(attr(findFirst(rect, 'a:prstGeom'), 'prst')).toBe('rect');

    const ellipse = await firstShape(doc([shape({ type: 'ellipse' })]));
    expect(attr(findFirst(ellipse, 'a:prstGeom'), 'prst')).toBe('ellipse');
  });

  it('turns a corner radius into the single adjust value roundRect has', async () => {
    const sp = await firstShape(doc([shape({ type: 'rect', rx: 10, ry: 10 }, { width: 100, height: 40 })]));
    expect(attr(findFirst(sp, 'a:prstGeom'), 'prst')).toBe('roundRect');
    // 10pt of a 40pt short side is a quarter of it.
    expect(attr(findFirst(sp, 'a:gd'), 'fmla')).toBe('val 25000');
  });

  it('reports a rounded rectangle whose two radii differ', async () => {
    const { warnings } = await emitPPTXWithReport(doc([shape({ type: 'rect', rx: 10, ry: 2 })]));
    expect(warnings.map((w) => w.code)).toContain('SHAPE_APPROXIMATED');
  });

  it('draws a polygon in path-local coordinates, sized to the frame', async () => {
    const el = shape(
      { type: 'polygon', points: [{ x: 50, y: 100 }, { x: 150, y: 100 }, { x: 150, y: 200 }] },
      { x: 50, y: 100, width: 100, height: 100 },
    );
    const sp = await firstShape(doc([el]));
    const path = findFirst(sp, 'a:path') as XNode;
    expect([path.attrs.w, path.attrs.h]).toEqual([pt(100), pt(100)]);
    // Page coordinates minus the frame's corner: the scale is the identity.
    const points = findAll(path, 'a:pt').map((p) => [p.attrs.x, p.attrs.y]);
    expect(points).toEqual([[pt(0), pt(0)], [pt(100), pt(0)], [pt(100), pt(100)]]);
    expect(findFirst(path, 'a:close')).toBeDefined();
  });

  it('never fills an open outline', async () => {
    const el = shape(
      { type: 'polyline', points: [{ x: 0, y: 0 }, { x: 100, y: 50 }] },
      { style: { fill: { type: 'solid', color: '#ff0000' } } },
    );
    const path = findFirst(await firstShape(doc([el])), 'a:path') as XNode;
    expect(path.attrs.fill).toBe('none');
    expect(findFirst(path, 'a:close')).toBeUndefined();
  });

  it('implements every path command', async () => {
    const d: PathCommand[] = [
      { op: 'M', x: 0, y: 0 },
      { op: 'L', x: 50, y: 0 },
      { op: 'C', x1: 60, y1: 0, x2: 70, y2: 10, x: 70, y: 20 },
      { op: 'Q', x1: 70, y1: 40, x: 50, y: 40 },
      { op: 'A', rx: 25, ry: 25, rotation: 0, largeArc: false, sweep: true, x: 0, y: 40 },
      { op: 'Z' },
    ];
    const path = findFirst(await firstShape(doc([shape({ type: 'path', d })])), 'a:path') as XNode;
    const ops = path.children.map((c) => c.name);
    expect(ops[0]).toBe('a:moveTo');
    expect(ops).toContain('a:lnTo');
    expect(ops).toContain('a:cubicBezTo');
    expect(ops).toContain('a:quadBezTo');
    expect(ops[ops.length - 1]).toBe('a:close');
    // The arc is approximated with cubics, so there are more than the one the model had.
    expect(ops.filter((o) => o === 'a:cubicBezTo').length).toBeGreaterThan(1);
  });

  it('lands an arc exactly on its commanded endpoint', async () => {
    const d: PathCommand[] = [
      { op: 'M', x: 0, y: 50 },
      { op: 'A', rx: 50, ry: 50, rotation: 0, largeArc: true, sweep: true, x: 100, y: 50 },
    ];
    const el = shape({ type: 'path', d }, { x: 0, y: 0, width: 100, height: 100 });
    const path = findFirst(await firstShape(doc([el])), 'a:path') as XNode;
    const last = findAll(path, 'a:pt').at(-1) as XNode;
    expect([last.attrs.x, last.attrs.y]).toEqual([pt(100), pt(50)]);
  });

  it('keeps an arc on its ellipse between the endpoints', async () => {
    // A half circle of radius 50 centred at (50,50): every point must be 50 from the centre.
    const d: PathCommand[] = [
      { op: 'M', x: 0, y: 50 },
      { op: 'A', rx: 50, ry: 50, rotation: 0, largeArc: false, sweep: true, x: 100, y: 50 },
    ];
    const el = shape({ type: 'path', d }, { x: 0, y: 0, width: 100, height: 100 });
    const path = findFirst(await firstShape(doc([el])), 'a:path') as XNode;
    const cubics = findAll(path, 'a:cubicBezTo');
    for (const cubic of cubics) {
      const pts = findAll(cubic, 'a:pt');
      const end = pts.at(-1) as XNode;
      const x = Number(end.attrs.x) / EMU_PER_POINT;
      const y = Number(end.attrs.y) / EMU_PER_POINT;
      expect(Math.hypot(x - 50, y - 50)).toBeCloseTo(50, 3);
    }
    expect(cubics.length).toBeGreaterThanOrEqual(2);
  });
});

// --- paint ------------------------------------------------------------------

describe('fill, stroke, shadow and rotation', () => {
  const styled = (style: ShapeStyle) => doc([shape({ type: 'rect' }, { style })]);

  it('writes a solid fill', async () => {
    const sp = await firstShape(styled({ fill: { type: 'solid', color: '#ABcdef' } }));
    expect(attr(findFirst(findFirst(sp, 'a:solidFill') as XNode, 'a:srgbClr'), 'val')).toBe('ABCDEF');
  });

  it('writes no fill as noFill rather than leaving it to the theme', async () => {
    const sp = await firstShape(styled({ fill: { type: 'none' } }));
    expect(findFirst(findFirst(sp, 'p:spPr') as XNode, 'a:noFill')).toBeDefined();
  });

  it('keeps a gradient as a gradient, with its stops and its angle', async () => {
    const fill: Fill = {
      type: 'gradient',
      angle: 45,
      stops: [
        { offset: 1, color: '#000000' },
        { offset: 0, color: '#ffffff' },
        { offset: 0.5, color: '#ff0000', opacity: 0.5 },
      ],
    };
    const sp = await firstShape(styled({ fill }));
    const grad = findFirst(sp, 'a:gradFill') as XNode;
    const stops = findAll(grad, 'a:gs');
    // Sorted by position, because OOXML requires increasing offsets.
    expect(stops.map((s) => s.attrs.pos)).toEqual(['0', '50000', '100000']);
    expect(attr(findFirst(stops[2] as XNode, 'a:srgbClr'), 'val')).toBe('000000');
    expect(attr(findFirst(stops[1] as XNode, 'a:alpha'), 'val')).toBe('50000');
    expect(attr(findFirst(grad, 'a:lin'), 'ang')).toBe(String(45 * 60000));
  });

  it('folds element opacity into the paint, which is where DrawingML keeps it', async () => {
    const sp = await firstShape(styled({ fill: { type: 'solid', color: '#000000' }, opacity: 0.5 }));
    expect(attr(findFirst(sp, 'a:alpha'), 'val')).toBe('50000');
  });

  it('writes a stroke with its width and its dash pattern', async () => {
    const sp = await firstShape(styled({ stroke: { color: '#00ff00', width: 2.25, dash: [9, 6.75] } }));
    const ln = findFirst(findFirst(sp, 'p:spPr') as XNode, 'a:ln') as XNode;
    expect(ln.attrs.w).toBe(pt(2.25));
    const ds = findFirst(ln, 'a:ds') as XNode;
    // Dash lengths are percentages of the line width: 9pt is 400% of 2.25pt.
    expect([ds.attrs.d, ds.attrs.sp]).toEqual(['400000', '300000']);
  });

  it('writes a shadow as an offset and a direction', async () => {
    const sp = await firstShape(styled({
      shadow: { color: '#808080', offsetX: 3, offsetY: 3, opacity: 0.4 },
    }));
    const shadow = findFirst(sp, 'a:outerShdw') as XNode;
    expect(shadow.attrs.dist).toBe(pt(Math.hypot(3, 3)));
    expect(shadow.attrs.dir).toBe(String(45 * 60000));
    expect(attr(findFirst(shadow, 'a:alpha'), 'val')).toBe('40000');
  });

  it('rotates exactly, including backwards', async () => {
    const forward = await firstShape(doc([shape({ type: 'rect' }, { rotation: 90 })]));
    expect(attr(findFirst(forward, 'a:xfrm'), 'rot')).toBe(String(90 * 60000));

    const backward = await firstShape(doc([shape({ type: 'rect' }, { rotation: -46 })]));
    expect(attr(findFirst(backward, 'a:xfrm'), 'rot')).toBe(String((360 - 46) * 60000));
  });
});

// --- pictures ---------------------------------------------------------------

describe('pictures', () => {
  const picture = (assetRef: string): Element => ({
    kind: 'image', x: 10, y: 10, width: 50, height: 50, assetRef,
  });

  it('embeds an image and wires it through a relationship', async () => {
    const parts = await open(doc([picture('a')], { assets: { a: { data: PNG_1PX, mime: 'image/png' } } }));
    expect(parts.has('ppt/media/image1.png')).toBe(true);

    const pic = painted(parseXML(parts.get('ppt/slides/slide1.xml') as string))[0] as XNode;
    expect(pic.name).toBe('p:pic');
    const rId = attr(findFirst(pic, 'a:blip'), 'r:embed');
    const rel = findAll(xml(parts, 'ppt/slides/_rels/slide1.xml.rels'), 'Relationship')
      .find((r) => r.attrs.Id === rId);
    expect(rel?.attrs.Target).toBe('../media/image1.png');
  });

  it('writes one media part for an asset used twice', async () => {
    const d = doc([picture('a'), picture('a')], { assets: { a: { data: PNG_1PX, mime: 'image/png' } } });
    const parts = await open(d);
    expect([...parts.keys()].filter((p) => p.startsWith('ppt/media/'))).toHaveLength(1);
  });

  it('leaves a metafile out, says so, and still shows where it was', async () => {
    const d = doc([picture('a')], { assets: { a: { data: PNG_1PX, mime: 'image/wmf' } } });
    const { bytes, warnings } = await emitPPTXWithReport(d);
    expect(warnings.map((w) => w.code)).toEqual(['WMF_IMAGE_NOT_CONVERTED']);

    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).some((p) => p.startsWith('ppt/media/'))).toBe(false);
    // The frame is still drawn, with a label, so the gap is visible rather than silent.
    const sp = painted(parseXML(await (zip.file('ppt/slides/slide1.xml') as JSZip.JSZipObject).async('string')))[0] as XNode;
    expect(sp.name).toBe('p:sp');
    expect(allText(sp)).toContain('image/wmf');
  });

  it('uses an image fill on a shape', async () => {
    const d = doc(
      [shape({ type: 'rect' }, { style: { fill: { type: 'image', assetRef: 'a', repeat: 'stretch' } } })],
      { assets: { a: { data: PNG_1PX, mime: 'image/jpeg' } } },
    );
    const parts = await open(d);
    expect(parts.has('ppt/media/image1.jpeg')).toBe(true);
    const sp = painted(parseXML(parts.get('ppt/slides/slide1.xml') as string))[0] as XNode;
    expect(findFirst(sp, 'a:blipFill')).toBeDefined();
    expect(findFirst(sp, 'a:stretch')).toBeDefined();
  });

  it('makes a picture transparent on the blip, where DrawingML keeps it', async () => {
    const d = doc(
      [{ kind: 'image', x: 0, y: 0, width: 10, height: 10, assetRef: 'a', style: { opacity: 0.25 } }],
      { assets: { a: { data: PNG_1PX, mime: 'image/png' } } },
    );
    const pic = await firstShape(d);
    expect(attr(findFirst(pic, 'a:alphaModFix'), 'amt')).toBe('25000');
  });

  it('tiles a repeating fill instead of stretching it', async () => {
    const d = doc(
      [shape({ type: 'rect' }, { style: { fill: { type: 'image', assetRef: 'a', repeat: 'repeat' } } })],
      { assets: { a: { data: PNG_1PX, mime: 'image/png' } } },
    );
    const sp = await firstShape(d);
    expect(findFirst(sp, 'a:tile')).toBeDefined();
  });
});

// --- tables -----------------------------------------------------------------

describe('tables', () => {
  /** A grid of `rows` x `columns` whose cells are labelled r0c0, r0c1 ... */
  function grid(rows: number, columns: number): TableRow[] {
    return Array.from({ length: rows }, (_, r) => ({
      height: 20,
      cells: Array.from({ length: columns }, (_, c) => ({
        row: r, column: c, rowSpan: 1, colSpan: 1, covered: false,
        paragraphs: [para([run(`r${r}c${c}`)])],
      })),
    }));
  }

  function table(rows: TableRow[], columnWidths: number[]): Table {
    return {
      kind: 'table', x: 10, y: 20, width: columnWidths.reduce((a, b) => a + b, 0),
      height: rows.length * 20, columnWidths, rows,
    };
  }

  it('writes a graphic frame with the grid the model describes', async () => {
    const frame = await firstShape(doc([table(grid(2, 3), [60, 70, 80])]));
    expect(frame.name).toBe('p:graphicFrame');
    expect(findAll(frame, 'a:gridCol').map((g) => g.attrs.w)).toEqual([pt(60), pt(70), pt(80)]);
    expect(findAll(frame, 'a:tr').map((r) => r.attrs.h)).toEqual([pt(20), pt(20)]);
    const off = findFirst(frame, 'a:off') as XNode;
    expect([off.attrs.x, off.attrs.y]).toEqual([pt(10), pt(20)]);
  });

  it('gives every row a cell for every column', async () => {
    const rows = grid(2, 3);
    // A 2x2 merge anchored at (0,0).
    (rows[0] as TableRow).cells[0] = {
      row: 0, column: 0, rowSpan: 2, colSpan: 2, covered: false,
      paragraphs: [para([run('merged')])],
    };
    for (const [r, c] of [[0, 1], [1, 0], [1, 1]] as Array<[number, number]>) {
      (rows[r] as TableRow).cells[c] = {
        row: r, column: c, rowSpan: 1, colSpan: 1, covered: true, paragraphs: [],
      };
    }
    const frame = await firstShape(doc([table(rows, [60, 60, 60])]));
    const trs = findAll(frame, 'a:tr');
    // The grid stays complete: a row with fewer cells than columns is what makes
    // PowerPoint offer to repair the file.
    for (const tr of trs) expect(tr.children.filter((c) => c.name === 'a:tc')).toHaveLength(3);

    const firstRow = (trs[0] as XNode).children;
    expect(firstRow[0]?.attrs).toMatchObject({ gridSpan: '2', rowSpan: '2' });
    expect(firstRow[1]?.attrs).toMatchObject({ hMerge: '1' });
    expect(firstRow[2]?.attrs.hMerge).toBeUndefined();

    const secondRow = (trs[1] as XNode).children;
    expect(secondRow[0]?.attrs).toMatchObject({ vMerge: '1' });
    expect(secondRow[1]?.attrs).toMatchObject({ hMerge: '1', vMerge: '1' });
  });

  it('writes merged content once, on the cell that owns it', async () => {
    const rows = grid(1, 2);
    (rows[0] as TableRow).cells[0] = {
      row: 0, column: 0, rowSpan: 1, colSpan: 2, covered: false,
      paragraphs: [para([run('wide')])],
    };
    (rows[0] as TableRow).cells[1] = {
      row: 0, column: 1, rowSpan: 1, colSpan: 1, covered: true, paragraphs: [para([run('ghost')])],
    };
    const frame = await firstShape(doc([table(rows, [60, 60])]));
    const all = allText(frame);
    expect(all).toContain('wide');
    expect(all).not.toContain('ghost');
  });

  it('keeps cell text as real paragraphs', async () => {
    const frame = await firstShape(doc([table(grid(1, 2), [60, 60])]));
    const cells = findAll(frame, 'a:tc');
    expect(cells.map((c) => allText(c))).toEqual(['r0c0', 'r0c1']);
    expect(findFirst(cells[0] as XNode, 'a:tcPr')?.attrs.anchor).toBe('t');
  });

  it('draws no cell border the publication did not have', async () => {
    const frame = await firstShape(doc([table(grid(1, 1), [60])]));
    const tcPr = findFirst(frame, 'a:tcPr') as XNode;
    for (const side of ['a:lnL', 'a:lnR', 'a:lnT', 'a:lnB']) {
      expect(findFirst(findFirst(tcPr, side) as XNode, 'a:noFill'), side).toBeDefined();
    }
  });

  it('reports the shadow a table cannot carry', async () => {
    const t = table(grid(1, 1), [60]);
    t.style = { shadow: { color: '#000000', offsetX: 2, offsetY: 2, opacity: 0.5 } };
    const { warnings } = await emitPPTXWithReport(doc([t]));
    expect(warnings.map((w) => w.code)).toContain('SHADOW_DROPPED');
  });
});

// --- groups -----------------------------------------------------------------

describe('groups', () => {
  it('declares a child space that matches the page coordinates its children use', async () => {
    const child = shape({ type: 'rect' }, { x: 120, y: 60, width: 40, height: 20 });
    const group: Element = {
      kind: 'group', x: 100, y: 50, width: 200, height: 100, rotation: 30, children: [child],
    };
    const sp = await firstShape(doc([group]));
    expect(sp.name).toBe('p:grpSp');

    const xfrm = findFirst(sp, 'a:xfrm') as XNode;
    expect(xfrm.attrs.rot).toBe(String(30 * 60000));
    expect([attr(findFirst(xfrm, 'a:off'), 'x'), attr(findFirst(xfrm, 'a:off'), 'y')]).toEqual([pt(100), pt(50)]);
    expect([attr(findFirst(xfrm, 'a:chOff'), 'x'), attr(findFirst(xfrm, 'a:chOff'), 'y')]).toEqual([pt(100), pt(50)]);
    expect(attr(findFirst(xfrm, 'a:chExt'), 'cx')).toBe(pt(200));

    // The child keeps the page coordinates the model gave it.
    const inner = sp.children.find((c) => c.name === 'p:sp') as XNode;
    expect(attr(findFirst(inner, 'a:off'), 'x')).toBe(pt(120));
  });

  it('nests groups', async () => {
    const inner: Element = {
      kind: 'group', x: 0, y: 0, width: 10, height: 10,
      children: [shape({ type: 'ellipse' })],
    };
    const outer: Element = { kind: 'group', x: 0, y: 0, width: 20, height: 20, children: [inner] };
    const sp = await firstShape(doc([outer]));
    expect(findAll(sp, 'p:grpSp')).toHaveLength(2);
    expect(findAll(sp, 'a:prstGeom').map((g) => g.attrs.prst)).toContain('ellipse');
  });
});

// --- z-order ----------------------------------------------------------------

describe('z-order', () => {
  it('paints elements in the order the model lists them', async () => {
    const d = doc([
      text([para([run('under')])]),
      shape({ type: 'rect' }),
      text([para([run('over')])]),
    ]);
    const shapes = painted(await slide(d));
    expect(shapes.map((s) => s.name)).toEqual(['p:sp', 'p:sp', 'p:sp']);
    expect(allText(shapes[0] as XNode)).toContain('under');
    expect(allText(shapes[2] as XNode)).toContain('over');
  });

  it('gives every shape on a slide a unique id', async () => {
    const d = doc([
      text([para([run('a')])]),
      shape({ type: 'rect' }),
      { kind: 'group', x: 0, y: 0, width: 10, height: 10, children: [shape({ type: 'ellipse' })] },
    ]);
    const ids = findAll(await slide(d), 'p:cNvPr').map((p) => p.attrs.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('1');
  });
});
