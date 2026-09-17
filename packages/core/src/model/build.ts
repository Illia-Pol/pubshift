/**
 * Event stream -> Doc.
 *
 * librevenge hands us a flat, ordered callback stream with no tree in it: a
 * `setStyle` applies to whatever primitive comes next, `startTextObject` opens a
 * region that the following paragraphs belong to, `openGroup` nests. So this is
 * a small stack machine, and the only interesting thing about it is how careful
 * it is about what it refuses to invent.
 *
 * Everything it cannot carry across is recorded as a Warning rather than
 * dropped quietly — being straight about what was lost is the product.
 */

import {
  propStr, propVec,
  type IREnvelope, type IREvent, type IRPropList,
} from '../ir/types';
import { toDegrees, toFraction, toInt, toMultiplier, toPercent, toPoints } from '../ir/units';
import type {
  Asset, Doc, DocMeta, Element, Fill, Geometry, GradientStop, Group, Image, Page,
  Paragraph, PathCommand, Point, Run, Shadow, Shape, ShapeStyle, Stroke, Table,
  TableCell, TableRow, TextBox, Warning, WarningCode,
} from './types';

/** US Letter. Only used when a page arrives with no usable size at all. */
const FALLBACK_PAGE = { width: 612, height: 792 };

// `+ 0` folds -0 to 0: the extractor really does emit `-0`, and JSON.parse keeps
// it, which would then leak a negative zero into every emitter's output.
const r3 = (n: number): number => Math.round(n * 1000) / 1000 + 0;
const r2 = (n: number): number => Math.round(n * 100) / 100 + 0;

type ParaProps = Omit<Paragraph, 'runs'>;
type RunFormat = Omit<Run, 'text'>;

const RUN_KEYS = [
  'font', 'size', 'bold', 'italic', 'underline', 'strike',
  'smallCaps', 'allCaps', 'color', 'baselineShift', 'link', 'lang',
  'outline', 'relief', 'textShadow', 'textScale',
] as const;

function sameFormat(a: RunFormat, b: RunFormat): boolean {
  return RUN_KEYS.every((k) => a[k] === b[k]);
}

interface TextCtx {
  sink: Paragraph[];
  /** null when no paragraph is open. */
  props: ParaProps | null;
  runs: Run[];
  /** Format of the open span — kept after closeSpan so stray whitespace inherits it. */
  fmt: RunFormat;
}

interface Box { x: number; y: number; width: number; height: number }

/**
 * FNV-1a paired with a second 32-bit mix, to match the extractor's `a<16 hex>`
 * asset-key shape. Dedup only — never a security boundary.
 */
function assetKey(data: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = (Math.imul(b + c, 0x85ebca6b) ^ (b >>> 13)) >>> 0;
  }
  return 'a' + a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

function bboxOf(xs: number[], ys: number[]): Box {
  if (xs.length === 0 || ys.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  return { x: r3(x0), y: r3(y0), width: r3(x1 - x0), height: r3(y1 - y0) };
}

function bboxOfPoints(points: Point[]): Box {
  return bboxOf(points.map((p) => p.x), points.map((p) => p.y));
}

/** Control points included: conservative, and the only box available without flattening curves. */
function bboxOfPath(cmds: PathCommand[]): Box {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const c of cmds) {
    if (c.op === 'Z') continue;
    xs.push(c.x); ys.push(c.y);
    if (c.op === 'C') { xs.push(c.x1, c.x2); ys.push(c.y1, c.y2); }
    else if (c.op === 'Q') { xs.push(c.x1); ys.push(c.y1); }
  }
  return bboxOf(xs, ys);
}

function repeatOf(v: string | undefined): 'stretch' | 'repeat' | 'none' {
  switch (v) {
    case 'repeat': return 'repeat';
    case 'no-repeat': case 'none': return 'none';
    default: return 'stretch';
  }
}

function alignOf(v: string | undefined): ParaProps['align'] {
  switch (v) {
    case 'center': return 'center';
    case 'right': case 'end': return 'right';
    case 'justify': return 'justify';
    case 'left': case 'start': return 'left';
    default: return undefined;
  }
}

const METAFILE_MIMES = new Set(['image/wmf', 'image/x-wmf', 'image/emf', 'image/x-emf']);

class Builder {
  private readonly pages: Page[] = [];
  private readonly assets: Record<string, Asset> = {};
  private readonly meta: DocMeta = {};
  private readonly warnings = new Map<string, Warning & { pageIndex?: number }>();

  private page: Page | null = null;
  private pageIndex = -1;
  /** Innermost group last; elements land in the deepest open container. */
  private readonly groups: Group[] = [];
  /** Raw props of the last setStyle, parsed only when a primitive consumes them. */
  private pendingStyle: IRPropList | null = null;
  private text: TextCtx | null = null;
  /** Publisher cannot nest tables, so one open table is enough. */
  private table: Table | null = null;
  private row: TableRow | null = null;
  private cell: TableCell | null = null;
  private readonly lists: Array<'ordered' | 'unordered'> = [];

  constructor(private readonly ir: IREnvelope) {}

  build(): Doc {
    for (const e of this.ir.events) this.handle(e);
    this.endPage();

    const trimmed = this.trimEmptyEdges();
    return {
      pages: trimmed.pages,
      meta: this.meta,
      assets: this.assets,
      warnings: this.finalizeWarnings(trimmed.dropped, trimmed.pages.length),
    };
  }

  // ---------------------------------------------------------------- dispatch

  private handle(e: IREvent): void {
    const p = e.p;
    switch (e.t) {
      case 'metaData': this.readMeta(p); break;

      case 'startPage': this.startPage(p); break;
      case 'endPage': this.endPage(); break;

      case 'setStyle': this.pendingStyle = p ?? null; break;

      case 'openGroup': this.openGroup(p); break;
      case 'closeGroup': this.closeGroup(); break;

      case 'startTextObject': this.startTextObject(p); break;
      case 'endTextObject': this.endTextObject(); break;

      case 'openParagraph': case 'openListElement': this.openParagraph(p); break;
      case 'closeParagraph': case 'closeListElement': this.closeParagraph(); break;
      case 'openSpan': this.openSpan(p); break;

      case 'openOrderedList': this.lists.push('ordered'); break;
      case 'openUnorderedList': this.lists.push('unordered'); break;
      case 'closeOrderedList': case 'closeUnorderedList': this.lists.pop(); break;

      case 'text': this.pushText((e.s ?? '').replace(/\r/g, '')); break;
      case 'insertSpace': this.pushText(' '); break;
      case 'insertTab': this.pushText('\t'); break;
      case 'insertLineBreak': this.pushText('\n'); break;
      case 'insertField': this.pushText(propStr(p, 'librevenge:field-content') ?? ''); break;

      case 'startTableObject': this.startTable(p); break;
      case 'openTableRow': this.openRow(p); break;
      case 'closeTableRow': this.closeRow(); break;
      case 'openTableCell': this.openCell(p, false); break;
      case 'closeTableCell': this.closeCell(); break;
      case 'coveredTableCell': this.openCell(p, true); this.closeCell(); break;
      case 'endTableObject': this.endTable(); break;

      case 'drawRectangle': this.drawRect(p); break;
      case 'drawEllipse': this.drawEllipse(p); break;
      case 'drawPolygon': this.drawPoly(p, 'polygon'); break;
      case 'drawPolyline': this.drawPoly(p, 'polyline'); break;
      case 'drawPath': case 'drawConnector': this.drawPath(p); break;
      case 'drawGraphicObject': this.drawGraphic(p); break;

      default: break; // startDocument, layers, style definitions: no document content
    }
  }

  // ------------------------------------------------------------------ pages

  private startPage(p: IRPropList | undefined): void {
    this.endPage();
    const w = toPoints(p?.['svg:width']);
    const h = toPoints(p?.['svg:height']);
    this.pageIndex++;
    this.page = {
      width: w !== undefined && w > 0 ? r3(w) : FALLBACK_PAGE.width,
      height: h !== undefined && h > 0 ? r3(h) : FALLBACK_PAGE.height,
      elements: [],
    };
  }

  private endPage(): void {
    if (!this.page) return;
    this.endTable();
    this.endTextObject();
    this.groups.length = 0;
    this.pages.push(this.page);
    this.page = null;
    this.pendingStyle = null;
  }

  /**
   * Publisher writes its master page out as a leading page with no content, and
   * some files trail one too. Only blank *edges* go; a blank page between two
   * full ones is part of the document.
   */
  private trimEmptyEdges(): { pages: Page[]; dropped: number } {
    let start = 0;
    let end = this.pages.length;
    while (start < end && this.pages[start]!.elements.length === 0) start++;
    while (end > start && this.pages[end - 1]!.elements.length === 0) end--;
    return { pages: this.pages.slice(start, end), dropped: start };
  }

  // --------------------------------------------------------------- warnings

  private warn(code: WarningCode, message: string): void {
    const key = `${code}|${this.pageIndex}`;
    const prev = this.warnings.get(key);
    if (prev) { prev.count = (prev.count ?? 1) + 1; return; }
    this.warnings.set(key, {
      code,
      message,
      count: 1,
      ...(this.pageIndex >= 0 ? { pageIndex: this.pageIndex } : {}),
    });
  }

  private finalizeWarnings(dropped: number, kept: number): Warning[] {
    const out: Warning[] = [];
    for (const w of this.warnings.values()) {
      const { pageIndex, ...rest } = w;
      const n = pageIndex === undefined ? undefined : pageIndex - dropped + 1;
      out.push(n !== undefined && n >= 1 && n <= kept ? { ...rest, page: n } : rest);
    }
    return out;
  }

  // ------------------------------------------------------------------ style

  /** Consumes the pending setStyle; `own` (the primitive's own props) wins on rotation. */
  private takeStyle(own?: IRPropList): { style?: ShapeStyle; rotation?: number } {
    const p = this.pendingStyle;
    this.pendingStyle = null;
    const rot = toDegrees(own?.['librevenge:rotate'])
      ?? (p ? toDegrees(p['librevenge:rotate']) : undefined);
    const style = p ? this.parseStyle(p) : undefined;
    const out: { style?: ShapeStyle; rotation?: number } = {};
    if (style) out.style = style;
    if (rot !== undefined && rot !== 0) out.rotation = r3(rot);
    return out;
  }

  private parseStyle(p: IRPropList): ShapeStyle | undefined {
    const style: ShapeStyle = {};

    const fill = this.parseFill(p);
    if (fill) style.fill = fill;

    const stroke = this.parseStroke(p);
    if (stroke) style.stroke = stroke;

    const shadow = this.parseShadow(p);
    if (shadow) style.shadow = shadow;

    const opacity = toFraction(p['draw:opacity']);
    if (opacity !== undefined && opacity < 1) style.opacity = opacity;

    return Object.keys(style).length > 0 ? style : undefined;
  }

  private parseFill(p: IRPropList): Fill | undefined {
    switch (propStr(p, 'draw:fill')) {
      case 'none': return { type: 'none' };
      case 'solid': return { type: 'solid', color: propStr(p, 'draw:fill-color') ?? '#000000' };
      case 'gradient': return this.parseGradient(p);
      case 'bitmap': return this.parseImageFill(p);
      default: return undefined;
    }
  }

  private parseGradient(p: IRPropList): Fill {
    const stops: GradientStop[] = [];
    const raw = propVec(p, 'svg:linearGradient');
    for (const s of raw) {
      const color = propStr(s, 'svg:stop-color');
      if (!color) continue;
      const offset = toFraction(s['svg:offset']) ?? (stops.length === 0 ? 0 : 1);
      const opacity = toFraction(s['svg:stop-opacity']);
      stops.push(opacity !== undefined && opacity < 1
        ? { offset: r3(offset), color, opacity }
        : { offset: r3(offset), color });
    }
    if (stops.length >= 2) {
      return { type: 'gradient', angle: r3(toDegrees(p['draw:angle']) ?? 0), stops };
    }
    this.warn('GRADIENT_FLATTENED',
      'A gradient fill did not carry enough colour stops to rebuild, so it became a flat colour.');
    return { type: 'solid', color: propStr(p, 'draw:fill-color') ?? stops[0]?.color ?? '#ffffff' };
  }

  private parseImageFill(p: IRPropList): Fill | undefined {
    const data = propStr(p, 'draw:fill-image');
    if (!data) return undefined;
    const mime = propStr(p, 'librevenge:mime-type') ?? '';

    if (METAFILE_MIMES.has(mime)) {
      // Word, PowerPoint and every browser refuse to render a raw WMF/EMF here.
      // Emitting it would produce a visible hole, so say so instead.
      this.warn('WMF_IMAGE_NOT_CONVERTED',
        'A picture is stored as a Windows metafile (WMF/EMF). Word, PowerPoint and web browsers cannot display that format, so it was left out rather than shown as a broken image.');
      return undefined;
    }

    const ref = assetKey(data);
    this.assets[ref] = { data, mime: mime || 'application/octet-stream' };
    return { type: 'image', assetRef: ref, repeat: repeatOf(propStr(p, 'style:repeat')) };
  }

  private parseStroke(p: IRPropList): Stroke | undefined {
    const kind = propStr(p, 'draw:stroke');
    if (!kind || kind === 'none') return undefined;
    const stroke: Stroke = {
      color: propStr(p, 'svg:stroke-color') ?? '#000000',
      width: r3(toPoints(p['svg:stroke-width']) ?? 1),
    };
    if (kind === 'dash') {
      const dash = this.parseDash(p);
      if (dash.length > 0) stroke.dash = dash;
    }
    return stroke;
  }

  private parseDash(p: IRPropList): number[] {
    const gap = r3(toPoints(p['draw:distance']) ?? 0);
    const out: number[] = [];
    const groups = [
      ['draw:dots1', 'draw:dots1-length'],
      ['draw:dots2', 'draw:dots2-length'],
    ] as const;
    for (const [countKey, lenKey] of groups) {
      const n = toInt(p[countKey]) ?? 0;
      const len = toPoints(p[lenKey]);
      if (n <= 0 || len === undefined) continue;
      for (let i = 0; i < n; i++) out.push(r3(len), gap);
    }
    return out;
  }

  private parseShadow(p: IRPropList): Shadow | undefined {
    if (propStr(p, 'draw:shadow') !== 'visible') return undefined;
    const color = propStr(p, 'draw:shadow-color');
    const dx = toPoints(p['draw:shadow-offset-x']);
    const dy = toPoints(p['draw:shadow-offset-y']);
    if (color === undefined && dx === undefined && dy === undefined) {
      this.warn('SHADOW_DROPPED', 'A drop shadow carried no colour or offset we could read, so it was dropped.');
      return undefined;
    }
    return {
      color: color ?? '#808080',
      offsetX: r3(dx ?? 0),
      offsetY: r3(dy ?? 0),
      opacity: toFraction(p['draw:shadow-opacity']) ?? 1,
    };
  }

  // --------------------------------------------------------------- geometry

  private rect(p: IRPropList | undefined): Box {
    return {
      x: r3(toPoints(p?.['svg:x']) ?? 0),
      y: r3(toPoints(p?.['svg:y']) ?? 0),
      width: r3(toPoints(p?.['svg:width']) ?? 0),
      height: r3(toPoints(p?.['svg:height']) ?? 0),
    };
  }

  private points(p: IRPropList | undefined): Point[] {
    const out: Point[] = [];
    for (const q of propVec(p, 'svg:points')) {
      const x = toPoints(q['svg:x']);
      const y = toPoints(q['svg:y']);
      if (x === undefined || y === undefined) continue;
      out.push({ x: r3(x), y: r3(y) });
    }
    return out;
  }

  private pathCommands(p: IRPropList | undefined): PathCommand[] {
    const out: PathCommand[] = [];
    for (const c of propVec(p, 'svg:d')) {
      const action = propStr(c, 'librevenge:path-action');
      if (action === 'Z') { out.push({ op: 'Z' }); continue; }

      const x = toPoints(c['svg:x']);
      const y = toPoints(c['svg:y']);
      if (x === undefined || y === undefined) continue;

      switch (action) {
        case 'M': case 'L':
          out.push({ op: action, x: r3(x), y: r3(y) });
          break;
        case 'C': {
          const x1 = toPoints(c['svg:x1']), y1 = toPoints(c['svg:y1']);
          const x2 = toPoints(c['svg:x2']), y2 = toPoints(c['svg:y2']);
          if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) break;
          out.push({ op: 'C', x1: r3(x1), y1: r3(y1), x2: r3(x2), y2: r3(y2), x: r3(x), y: r3(y) });
          break;
        }
        case 'Q': {
          const x1 = toPoints(c['svg:x1']), y1 = toPoints(c['svg:y1']);
          if (x1 === undefined || y1 === undefined) break;
          out.push({ op: 'Q', x1: r3(x1), y1: r3(y1), x: r3(x), y: r3(y) });
          break;
        }
        case 'A': {
          const rx = toPoints(c['svg:rx']), ry = toPoints(c['svg:ry']);
          if (rx === undefined || ry === undefined) break;
          // librevenge's own SVG generator defaults both arc flags to 1 when absent.
          out.push({
            op: 'A',
            rx: r3(rx), ry: r3(ry),
            rotation: r3(toDegrees(c['librevenge:rotate']) ?? 0),
            largeArc: (toInt(c['librevenge:large-arc']) ?? 1) !== 0,
            sweep: (toInt(c['librevenge:sweep']) ?? 1) !== 0,
            x: r3(x), y: r3(y),
          });
          break;
        }
        default: break;
      }
    }
    return out;
  }

  // --------------------------------------------------------------- elements

  private container(): Element[] | null {
    const g = this.groups[this.groups.length - 1];
    if (g) return g.children;
    return this.page ? this.page.elements : null;
  }

  private place(el: Element): void {
    this.container()?.push(el);
  }

  private openGroup(p: IRPropList | undefined): void {
    const { style, rotation } = this.takeStyle(p);
    const group: Group = { kind: 'group', ...this.rect(p), children: [] };
    if (rotation !== undefined) group.rotation = rotation;
    if (style) group.style = style;
    this.place(group);
    this.groups.push(group);
  }

  private closeGroup(): void {
    const g = this.groups.pop();
    if (!g || g.width > 0 || g.height > 0) return;
    // librevenge often opens a group with no geometry of its own; the children
    // define it.
    const xs: number[] = [], ys: number[] = [];
    for (const c of g.children) { xs.push(c.x, c.x + c.width); ys.push(c.y, c.y + c.height); }
    Object.assign(g, bboxOf(xs, ys));
  }

  private drawRect(p: IRPropList | undefined): void {
    const { style, rotation } = this.takeStyle(p);
    const rx = toPoints(p?.['svg:rx']);
    const ry = toPoints(p?.['svg:ry']);
    const geometry: Extract<Geometry, { type: 'rect' }> = { type: 'rect' };
    if (rx !== undefined && rx > 0) geometry.rx = r3(rx);
    if (ry !== undefined && ry > 0) geometry.ry = r3(ry);
    this.placeShape({ kind: 'shape', ...this.rect(p), geometry }, style, rotation);
  }

  private drawEllipse(p: IRPropList | undefined): void {
    const { style, rotation } = this.takeStyle(p);
    // librevenge gives an ellipse as centre + radii.
    const cx = toPoints(p?.['svg:cx']), cy = toPoints(p?.['svg:cy']);
    const rx = toPoints(p?.['svg:rx']), ry = toPoints(p?.['svg:ry']);
    const box = cx !== undefined && cy !== undefined && rx !== undefined && ry !== undefined
      ? { x: r3(cx - rx), y: r3(cy - ry), width: r3(rx * 2), height: r3(ry * 2) }
      : this.rect(p);
    this.placeShape({ kind: 'shape', ...box, geometry: { type: 'ellipse' } }, style, rotation);
  }

  private drawPoly(p: IRPropList | undefined, type: 'polygon' | 'polyline'): void {
    const { style, rotation } = this.takeStyle(p);
    const points = this.points(p);
    if (points.length < 2) {
      this.warn('SHAPE_APPROXIMATED', 'A shape had no usable outline and was left out.');
      return;
    }
    this.placeShape(
      { kind: 'shape', ...bboxOfPoints(points), geometry: { type, points } },
      style, rotation,
    );
  }

  private drawPath(p: IRPropList | undefined): void {
    const { style, rotation } = this.takeStyle(p);
    const d = this.pathCommands(p);
    if (d.length === 0) {
      this.warn('SHAPE_APPROXIMATED', 'A shape had no usable outline and was left out.');
      return;
    }
    this.placeShape(
      { kind: 'shape', ...bboxOfPath(d), geometry: { type: 'path', d } },
      style, rotation,
    );
  }

  private placeShape(shape: Shape, style: ShapeStyle | undefined, rotation: number | undefined): void {
    if (rotation !== undefined) shape.rotation = rotation;
    if (style) shape.style = style;
    this.place(shape);
  }

  private drawGraphic(p: IRPropList | undefined): void {
    const { style, rotation } = this.takeStyle(p);
    const ref = propStr(p, 'assetRef');
    const mime = propStr(p, 'librevenge:mime-type') ?? '';

    if (METAFILE_MIMES.has(mime)) {
      this.warn('WMF_IMAGE_NOT_CONVERTED',
        'A picture is stored as a Windows metafile (WMF/EMF). Word, PowerPoint and web browsers cannot display that format, so it was left out rather than shown as a broken image.');
      return;
    }

    const data = ref === undefined ? undefined : this.ir.assets[ref];
    if (ref === undefined || data === undefined) {
      this.warn('SHAPE_APPROXIMATED', 'A picture carried no image data and was left out.');
      return;
    }

    this.assets[ref] = { data, mime: mime || 'application/octet-stream' };
    const image: Image = { kind: 'image', ...this.rect(p), assetRef: ref };
    if (rotation !== undefined) image.rotation = rotation;
    if (style) image.style = style;
    this.place(image);
  }

  // ------------------------------------------------------------------- text

  private startTextObject(p: IRPropList | undefined): void {
    this.endTextObject();
    const { style, rotation } = this.takeStyle(p);
    const box: TextBox = { kind: 'text', ...this.rect(p), paragraphs: [] };

    const pad = {
      top: toPoints(p?.['fo:padding-top']),
      right: toPoints(p?.['fo:padding-right']),
      bottom: toPoints(p?.['fo:padding-bottom']),
      left: toPoints(p?.['fo:padding-left']),
    };
    if (Object.values(pad).some((v) => v !== undefined)) {
      box.padding = {
        top: r3(pad.top ?? 0), right: r3(pad.right ?? 0),
        bottom: r3(pad.bottom ?? 0), left: r3(pad.left ?? 0),
      };
    }

    const valign = propStr(p, 'draw:textarea-vertical-align');
    if (valign === 'middle' || valign === 'bottom' || valign === 'top') box.verticalAlign = valign;

    const columns = toInt(p?.['fo:column-count']) ?? toInt(p?.['style:column-count']);
    if (columns !== undefined && columns > 1) {
      box.columns = { count: columns, gap: r3(toPoints(p?.['fo:column-gap']) ?? 0) };
    }

    if (rotation !== undefined) {
      box.rotation = rotation;
      // Every target we emit to places rotated text by bounding box, not by
      // Publisher's rotated text flow, so the line breaks can move.
      this.warn('ROTATED_TEXT_APPROXIMATED',
        'A rotated text box was placed by its bounding box; the text may wrap at different points than in Publisher.');
    }
    if (style) box.style = style;

    this.place(box);
    this.text = { sink: box.paragraphs, props: null, runs: [], fmt: {} };
  }

  private endTextObject(): void {
    if (!this.text) return;
    this.closeParagraph();
    this.text = null;
  }

  private openParagraph(p: IRPropList | undefined): void {
    const t = this.text;
    if (!t) return;
    if (t.props !== null) this.closeParagraph();

    const props: ParaProps = {};
    const align = alignOf(propStr(p, 'fo:text-align'));
    if (align) props.align = align;

    const lh = toMultiplier(p?.['fo:line-height']);
    if (lh !== undefined) props.lineHeight = r3(lh);

    const spacing = [
      ['marginTop', 'fo:margin-top'],
      ['marginBottom', 'fo:margin-bottom'],
      ['marginLeft', 'fo:margin-left'],
      ['marginRight', 'fo:margin-right'],
      ['textIndent', 'fo:text-indent'],
    ] as const;
    for (const [field, key] of spacing) {
      const v = toPoints(p?.[key]);
      if (v !== undefined && v !== 0) props[field] = r3(v);
    }

    const list = this.lists[this.lists.length - 1];
    if (list) props.list = { type: list, level: this.lists.length };

    t.props = props;
    t.runs = [];
  }

  private closeParagraph(): void {
    const t = this.text;
    if (!t || t.props === null) return;
    t.sink.push({ ...t.props, runs: t.runs });
    t.props = null;
    t.runs = [];
  }

  private openSpan(p: IRPropList | undefined): void {
    const t = this.text;
    if (!t) return;
    t.fmt = spanFormat(p);
  }

  /**
   * Appends to the run in progress when the formatting is identical, so a
   * paragraph built from hundreds of `text`/`insertSpace` callbacks comes out as
   * a handful of runs rather than one run per character.
   */
  private pushText(s: string): void {
    const t = this.text;
    if (!t || s === '') return;
    if (t.props === null) this.openParagraph(undefined);

    const last = t.runs[t.runs.length - 1];
    if (last && sameFormat(last, t.fmt)) { last.text += s; return; }
    t.runs.push({ ...t.fmt, text: s });
  }

  // ----------------------------------------------------------------- tables

  private startTable(p: IRPropList | undefined): void {
    this.endTable();
    const { style, rotation } = this.takeStyle(p);
    const columnWidths: number[] = [];
    for (const c of propVec(p, 'librevenge:table-columns')) {
      columnWidths.push(r3(toPoints(c['style:column-width']) ?? 0));
    }
    const table: Table = { kind: 'table', ...this.rect(p), columnWidths, rows: [] };
    if (rotation !== undefined) table.rotation = rotation;
    if (style) table.style = style;
    this.place(table);
    this.table = table;
  }

  private endTable(): void {
    if (!this.table) return;
    this.closeRow();
    this.table = null;
  }

  private openRow(p: IRPropList | undefined): void {
    if (!this.table) return;
    this.closeRow();
    const height = toPoints(p?.['librevenge:row-height']);
    this.row = height !== undefined ? { height: r3(height), cells: [] } : { cells: [] };
  }

  private closeRow(): void {
    if (!this.row) return;
    this.closeCell();
    this.table?.rows.push(this.row);
    this.row = null;
  }

  private openCell(p: IRPropList | undefined, covered: boolean): void {
    if (!this.row) this.openRow(undefined);
    const row = this.row;
    if (!row) return;
    this.closeCell();

    const cell: TableCell = {
      row: toInt(p?.['librevenge:row']) ?? this.table?.rows.length ?? 0,
      column: toInt(p?.['librevenge:column']) ?? row.cells.length,
      rowSpan: covered ? 1 : Math.max(1, toInt(p?.['table:number-rows-spanned']) ?? 1),
      colSpan: covered ? 1 : Math.max(1, toInt(p?.['table:number-columns-spanned']) ?? 1),
      covered,
      paragraphs: [],
    };
    const style = this.pendingStyle ? this.parseStyle(this.pendingStyle) : undefined;
    if (style) cell.style = style;

    this.cell = cell;
    // A covered cell never carries text; leaving the text sink shut keeps any
    // stray callback from landing in it.
    if (!covered) this.text = { sink: cell.paragraphs, props: null, runs: [], fmt: {} };
  }

  private closeCell(): void {
    const cell = this.cell;
    if (!cell) return;
    this.endTextObject();
    this.row?.cells.push(cell);
    this.cell = null;
  }

  // --------------------------------------------------------------- metadata

  private readMeta(p: IRPropList | undefined): void {
    if (!p) return;
    const set = (field: keyof DocMeta, ...keys: string[]): void => {
      for (const k of keys) {
        const v = propStr(p, k);
        if (v) { this.meta[field] = v; return; }
      }
    };
    set('title', 'dc:title');
    set('creator', 'dc:creator', 'meta:initial-creator');
    set('subject', 'dc:subject');
    set('description', 'dc:description');
    set('keywords', 'meta:keyword', 'librevenge:keywords');
    set('created', 'meta:creation-date', 'dc:date');
  }
}

function spanFormat(p: IRPropList | undefined): RunFormat {
  const f: RunFormat = {};
  if (!p) return f;

  const font = propStr(p, 'style:font-name');
  if (font) f.font = font;

  const size = toPoints(p['fo:font-size']);
  if (size !== undefined && size > 0) f.size = r2(size);

  if (propStr(p, 'fo:font-weight') === 'bold') f.bold = true;
  if (propStr(p, 'fo:font-style') === 'italic') f.italic = true;

  const underline = propStr(p, 'style:text-underline-style');
  if (underline && underline !== 'none') f.underline = true;

  const strike = propStr(p, 'style:text-line-through-style');
  if (strike && strike !== 'none') f.strike = true;

  if (propStr(p, 'fo:font-variant') === 'small-caps') f.smallCaps = true;
  if (propStr(p, 'fo:text-transform') === 'uppercase') f.allCaps = true;

  const color = propStr(p, 'fo:color');
  if (color) f.color = color;

  // "50% 67%" — vertical offset first, relative font size second.
  const position = propStr(p, 'style:text-position');
  if (position) {
    const shift = Number.parseFloat(position);
    if (Number.isFinite(shift) && shift !== 0) f.baselineShift = shift;
  }

  if (propStr(p, 'style:text-outline') === 'true') f.outline = true;
  if (propStr(p, 'fo:text-shadow')) f.textShadow = true;

  const relief = propStr(p, 'style:font-relief');
  if (relief === 'embossed' || relief === 'engraved') f.relief = relief;

  const scale = toPercent(p['fo:text-scale']);
  if (scale !== undefined && scale > 0 && scale !== 100) f.textScale = r2(scale);

  const link = propStr(p, 'xlink:href');
  if (link) f.link = link;

  const lang = propStr(p, 'fo:language');
  if (lang) {
    const country = propStr(p, 'fo:country');
    f.lang = country ? `${lang}-${country}` : lang;
  }

  return f;
}

export function buildDoc(ir: IREnvelope): Doc {
  return new Builder(ir).build();
}
