/**
 * SVG emitter.
 *
 * SVG is both a delivery format and the oracle the rest of the project is graded with:
 * correctness of every other emitter is judged by rendering `.pub -> SVG` and comparing
 * against Publisher's own output. So this file optimises for *faithfulness* — nothing is
 * silently dropped, every approximation is named — rather than for terse output.
 *
 * Coordinates come in already flattened to points with the origin at the page's top-left,
 * which is exactly SVG's user space at `viewBox="0 0 w h"`. No coordinate conversion is
 * needed anywhere below; that is the whole reason the model is shaped the way it is.
 */

import type {
  Asset,
  Doc,
  Element,
  Fill,
  Geometry,
  Group,
  Image,
  Page,
  Paragraph,
  PathCommand,
  Point,
  Run,
  Shape,
  ShapeStyle,
  Table,
  TableCell,
  TextBox,
} from '../model/types';

// ---------------------------------------------------------------------------
// Named approximations
//
// Every number here is a place where we are guessing at something Publisher knew and
// the IR does not carry. They are collected at the top so a fidelity regression can be
// traced to a specific guess instead of to a magic number buried in a function.
// ---------------------------------------------------------------------------

/** Leading when a paragraph does not specify one. 1.2em is the CSS/PostScript default. */
const DEFAULT_LINE_HEIGHT = 1.2;

/** Font size assumed for a run with no size. 12pt is Publisher's default body size. */
const DEFAULT_FONT_SIZE = 12;

/** Font assumed for a run with no family. */
const DEFAULT_FONT_FAMILY = 'Times New Roman';

/**
 * Baseline position inside the em box, as a fraction of the font size. Real ascents run
 * 0.75–0.90em depending on family; 0.8 is the middle of that range and keeps text visually
 * centred in its line box for both serif and sans faces.
 */
const ASCENT_RATIO = 0.8;

/** Inset for table cell text. Publisher's default cell margin is 0.04in ~= 2.9pt. */
const CELL_PADDING = 2.9;

/** Small caps are rendered at this fraction of the run size when measuring. */
const SMALL_CAPS_RATIO = 0.8;

/** Bitmap pixels are mapped to points at this resolution (the Windows/GDI assumption). */
const PX_PER_INCH = 96;

/**
 * Raster formats we can hand to a renderer as a `data:` URI. Anything outside this set
 * (in practice WMF and EMF, which Publisher embeds constantly) is drawn as a labelled
 * placeholder so the user can see *where* the graphic was even though we cannot show it.
 */
const RENDERABLE_IMAGE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/bmp',
  'image/tiff',
  'image/svg+xml',
  'image/webp',
]);

// ---------------------------------------------------------------------------
// Glyph width estimation
// ---------------------------------------------------------------------------

/**
 * Per-character advance widths in ems, taken from the Adobe Helvetica AFM (`WX`/1000).
 *
 * We emit SVG without ever loading a font, so line breaking has to estimate. A flat
 * "average glyph width" wraps badly on real documents — headlines are mostly caps, body
 * text is mostly lowercase, and the two differ by ~25% — so this is a real table for the
 * ASCII range and a documented fallback outside it. It is an *approximation*: expect
 * wrap points to be right for the overwhelming majority of lines and off by one word for
 * lines that end within a few percent of the box width.
 */
const ADVANCE_EM: Record<string, number> = {
  ' ': 0.278, '!': 0.278, '"': 0.355, '#': 0.556, $: 0.556, '%': 0.889, '&': 0.667,
  "'": 0.191, '(': 0.333, ')': 0.333, '*': 0.389, '+': 0.584, ',': 0.278, '-': 0.333,
  '.': 0.278, '/': 0.278,
  '0': 0.556, '1': 0.556, '2': 0.556, '3': 0.556, '4': 0.556, '5': 0.556, '6': 0.556,
  '7': 0.556, '8': 0.556, '9': 0.556,
  ':': 0.278, ';': 0.278, '<': 0.584, '=': 0.584, '>': 0.584, '?': 0.556, '@': 1.015,
  A: 0.667, B: 0.667, C: 0.722, D: 0.722, E: 0.667, F: 0.611, G: 0.778, H: 0.722,
  I: 0.278, J: 0.5, K: 0.667, L: 0.556, M: 0.833, N: 0.722, O: 0.778, P: 0.667,
  Q: 0.778, R: 0.722, S: 0.667, T: 0.611, U: 0.722, V: 0.667, W: 0.944, X: 0.667,
  Y: 0.667, Z: 0.611,
  '[': 0.278, '\\': 0.278, ']': 0.278, '^': 0.469, _: 0.556, '`': 0.333,
  a: 0.556, b: 0.556, c: 0.5, d: 0.556, e: 0.556, f: 0.278, g: 0.556, h: 0.556,
  i: 0.222, j: 0.222, k: 0.5, l: 0.222, m: 0.833, n: 0.556, o: 0.556, p: 0.556,
  q: 0.556, r: 0.333, s: 0.5, t: 0.278, u: 0.556, v: 0.5, w: 0.722, x: 0.5,
  y: 0.5, z: 0.5,
  '{': 0.334, '|': 0.26, '}': 0.334, '~': 0.584,
};

/** Advance assumed for a character outside {@link ADVANCE_EM} — the Latin-1 mean. */
const FALLBACK_ADVANCE_EM = 0.55;

/** Advance assumed for a CJK ideograph or fullwidth form: they are square by definition. */
const FULLWIDTH_ADVANCE_EM = 1.0;

/** Serif faces run narrower than Helvetica at the same nominal size. */
const SERIF_WIDTH_FACTOR = 0.92;

/** Every glyph in a monospaced face is this wide, whatever the table says. */
const MONOSPACE_ADVANCE_EM = 0.6;

/** Bold weights add a little sidebearing. */
const BOLD_WIDTH_FACTOR = 1.03;

type FontClass = 'serif' | 'sans' | 'mono';

const MONO_HINTS = ['courier', 'mono', 'consolas', 'menlo', 'lucida console'];
const SERIF_HINTS = [
  'times', 'serif', 'georgia', 'garamond', 'palatino', 'book antiqua', 'cambria',
  'century schoolbook', 'baskerville', 'bookman', 'minion', 'constantia',
];

function classifyFont(family: string): FontClass {
  const f = family.toLowerCase();
  if (MONO_HINTS.some((h) => f.includes(h))) return 'mono';
  // "sans serif" contains "serif", so the sans test has to win.
  if (f.includes('sans')) return 'sans';
  if (SERIF_HINTS.some((h) => f.includes(h))) return 'serif';
  return 'sans';
}

function isFullwidth(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0x303e) || // CJK radicals, symbols
    (code >= 0x3041 && code <= 0x33ff) || // kana, compat
    (code >= 0x3400 && code <= 0x4dbf) || // CJK ext A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified
    (code >= 0xa000 && code <= 0xa4cf) || // Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compat ideographs
    (code >= 0xfe30 && code <= 0xfe6f) || // CJK compat forms
    (code >= 0xff00 && code <= 0xff60) || // fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6)
  );
}

/** Estimated advance of `text` when set in `run`, in points. See {@link ADVANCE_EM}. */
export function estimateTextWidth(text: string, run: Run): number {
  const size = run.size ?? DEFAULT_FONT_SIZE;
  const cls = classifyFont(run.font ?? DEFAULT_FONT_FAMILY);
  const shaped = run.allCaps ? text.toUpperCase() : text;
  let em = 0;
  for (const ch of shaped) {
    const code = ch.codePointAt(0) ?? 0;
    if (cls === 'mono') {
      em += MONOSPACE_ADVANCE_EM;
      continue;
    }
    if (isFullwidth(code)) {
      em += FULLWIDTH_ADVANCE_EM;
      continue;
    }
    // Small caps set lowercase as capitals at a reduced size; measure them that way.
    if (run.smallCaps && ch >= 'a' && ch <= 'z') {
      em += (ADVANCE_EM[ch.toUpperCase()] ?? FALLBACK_ADVANCE_EM) * SMALL_CAPS_RATIO;
      continue;
    }
    em += ADVANCE_EM[ch] ?? FALLBACK_ADVANCE_EM;
  }
  if (cls === 'serif') em *= SERIF_WIDTH_FACTOR;
  if (run.bold) em *= BOLD_WIDTH_FACTOR;
  return em * size;
}

// ---------------------------------------------------------------------------
// XML plumbing
// ---------------------------------------------------------------------------

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
};

/**
 * Escapes text and attribute values, and strips the C0 control characters that are
 * illegal in XML 1.0. Real `.pub` text carries stray 0x0B/0x0C/0x1E from Publisher's
 * own control codes, and a single one of them makes the whole file unparseable — which
 * is the most common way an SVG emitter fails on a real document, not on a test.
 */
function esc(value: string): string {
  return value
    .replace(/[ --]/g, '')
    .replace(/[&<>"']/g, (c) => XML_ESCAPE[c] as string);
}

/** Formats a number for an SVG attribute: finite, at most 3 decimals, no trailing zeros. */
function n(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const r = Math.round(value * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

type Attrs = Record<string, string | number | undefined>;

function attrs(a: Attrs): string {
  let out = '';
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue;
    out += ` ${k}="${typeof v === 'number' ? esc(n(v)) : esc(v)}"`;
  }
  return out;
}

function tag(name: string, a: Attrs, children?: string): string {
  return children === undefined || children === ''
    ? `<${name}${attrs(a)}/>`
    : `<${name}${attrs(a)}>${children}</${name}>`;
}

/** A `<defs>` accumulator that deduplicates identical definitions by body. */
class Defs {
  private readonly byBody = new Map<string, string>();
  private readonly out: string[] = [];
  private seq = 0;

  /** `make` receives the id to embed; returns the id to reference. */
  add(key: string, make: (id: string) => string): string {
    const existing = this.byBody.get(key);
    if (existing !== undefined) return existing;
    const id = `ps${this.seq++}`;
    this.byBody.set(key, id);
    this.out.push(make(id));
    return id;
  }

  render(): string {
    return this.out.length === 0 ? '' : `<defs>${this.out.join('')}</defs>`;
  }
}

// ---------------------------------------------------------------------------
// Bitmap headers
// ---------------------------------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes the first `limit` bytes of a base64 payload without depending on a runtime. */
function decodeBase64Prefix(data: string, limit: number): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of data) {
    const v = B64.indexOf(ch);
    if (v < 0) continue; // whitespace and '=' padding
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
      if (out.length >= limit) break;
    }
  }
  return Uint8Array.from(out);
}

function be16(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
}

function be32(b: Uint8Array, i: number): number {
  return (((b[i] ?? 0) << 24) >>> 0) + ((b[i + 1] ?? 0) << 16) + ((b[i + 2] ?? 0) << 8) + (b[i + 3] ?? 0);
}

/**
 * Intrinsic size of a bitmap in points, read straight out of its header. Only needed to
 * tile an image *fill*; a plain `Image` element is stretched to its frame, which is what
 * Publisher does.
 */
function intrinsicSize(asset: Asset): { w: number; h: number } | undefined {
  const b = decodeBase64Prefix(asset.data, 4096);
  const px = (w: number, h: number) =>
    w > 0 && h > 0 ? { w: (w * 72) / PX_PER_INCH, h: (h * 72) / PX_PER_INCH } : undefined;

  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return px(be32(b, 16), be32(b, 20)); // PNG IHDR
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return px((b[7] ?? 0) * 256 + (b[6] ?? 0), (b[9] ?? 0) * 256 + (b[8] ?? 0)); // GIF, little-endian
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    // JPEG: walk the marker chain to the first frame header.
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      const marker = b[p + 1] ?? 0;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
      const len = be16(b, p + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return px(be16(b, p + 7), be16(b, p + 5));
      if (len < 2) break;
      p += 2 + len;
    }
  }
  if (b.length >= 26 && b[0] === 0x42 && b[1] === 0x4d) {
    // BMP: DIB header is little-endian, width/height at 18/22.
    const le32 = (i: number) =>
      (b[i] ?? 0) + ((b[i + 1] ?? 0) << 8) + ((b[i + 2] ?? 0) << 16) + ((b[i + 3] ?? 0) << 24);
    return px(le32(18), Math.abs(le32(22)));
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

interface Box { x: number; y: number; width: number; height: number }

/**
 * Resolves a {@link Fill} to a `fill` attribute value, registering a gradient or pattern
 * in `defs` when one is needed. `box` is the element's frame, used as the pattern's
 * anchor so a tiled fill starts at the element's corner rather than the page's.
 */
function fillValue(fill: Fill | undefined, defs: Defs, box: Box, doc: Doc): string | undefined {
  if (!fill) return undefined;
  switch (fill.type) {
    case 'none':
      return 'none';
    case 'solid':
      return fill.color;
    case 'gradient': {
      // angle is degrees clockwise: 0 = left-to-right, 90 = top-to-bottom.
      const rad = (fill.angle * Math.PI) / 180;
      const dx = Math.cos(rad) / 2;
      const dy = Math.sin(rad) / 2;
      const stops = fill.stops
        .map((s) =>
          tag('stop', {
            offset: n(s.offset),
            'stop-color': s.color,
            'stop-opacity': s.opacity === undefined ? undefined : n(s.opacity),
          }),
        )
        .join('');
      const geom = attrs({ x1: 0.5 - dx, y1: 0.5 - dy, x2: 0.5 + dx, y2: 0.5 + dy });
      const id = defs.add(`lg|${geom}|${stops}`, (defId) =>
        `<linearGradient id="${defId}"${geom}>${stops}</linearGradient>`,
      );
      return `url(#${id})`;
    }
    case 'image': {
      const href = assetHref(doc, fill.assetRef);
      if (!href) return 'none';
      const natural = intrinsicSize(doc.assets[fill.assetRef] as Asset);
      let body: string;
      let pa: Attrs;
      if (fill.repeat === 'stretch' || !natural) {
        pa = {
          patternUnits: 'objectBoundingBox',
          patternContentUnits: 'objectBoundingBox',
          width: 1,
          height: 1,
        };
        body = tag('image', {
          x: 0, y: 0, width: 1, height: 1, preserveAspectRatio: 'none', href, 'xlink:href': href,
        });
      } else {
        // 'repeat' tiles at the bitmap's natural size; 'none' places a single tile by
        // making the tile as large as the element, so there is nothing left to repeat.
        const tw = fill.repeat === 'repeat' ? natural.w : Math.max(box.width, natural.w);
        const th = fill.repeat === 'repeat' ? natural.h : Math.max(box.height, natural.h);
        pa = {
          patternUnits: 'userSpaceOnUse', x: box.x, y: box.y, width: tw, height: th,
        };
        body = tag('image', {
          x: 0, y: 0, width: natural.w, height: natural.h, href, 'xlink:href': href,
        });
      }
      const geom = attrs(pa);
      const id = defs.add(`pat|${geom}|${body}`, (defId) => `<pattern id="${defId}"${geom}>${body}</pattern>`);
      return `url(#${id})`;
    }
  }
}

function shadowFilter(style: ShapeStyle | undefined, defs: Defs): string | undefined {
  const sh = style?.shadow;
  if (!sh) return undefined;
  const drop = tag('feDropShadow', {
    dx: sh.offsetX, dy: sh.offsetY, stdDeviation: 0,
    'flood-color': sh.color, 'flood-opacity': n(sh.opacity),
  });
  // The default filter region clips at 110% of the bbox, which cuts off any shadow with
  // a meaningful offset; widen it rather than lose the shadow.
  const region = attrs({ x: '-50%', y: '-50%', width: '200%', height: '200%' });
  const id = defs.add(`fil|${region}|${drop}`, (defId) => `<filter id="${defId}"${region}>${drop}</filter>`);
  return `url(#${id})`;
}

/** Paint attributes for a drawable, minus the shadow filter (which belongs on a group). */
function paintAttrs(style: ShapeStyle | undefined, defs: Defs, box: Box, doc: Doc): Attrs {
  const stroke = style?.stroke;
  return {
    fill: fillValue(style?.fill, defs, box, doc) ?? 'none',
    stroke: stroke?.color,
    'stroke-width': stroke ? n(stroke.width) : undefined,
    'stroke-dasharray': stroke?.dash && stroke.dash.length > 0 ? stroke.dash.map(n).join(' ') : undefined,
    'stroke-linejoin': stroke ? 'miter' : undefined,
  };
}

function assetHref(doc: Doc, ref: string): string | undefined {
  const asset = doc.assets[ref];
  if (!asset) return undefined;
  if (!RENDERABLE_IMAGE_MIME.has(asset.mime.toLowerCase())) return undefined;
  return `data:${asset.mime};base64,${asset.data}`;
}

/**
 * Wraps `body` in the transform/opacity/filter group an element needs, or returns it
 * untouched when none of the three applies.
 */
function frame(body: string, el: { rotation?: number; style?: ShapeStyle }, box: Box, defs: Defs): string {
  const a: Attrs = {};
  if (el.rotation) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    a.transform = `rotate(${n(el.rotation)}, ${n(cx)}, ${n(cy)})`;
  }
  if (el.style?.opacity !== undefined && el.style.opacity < 1) a.opacity = n(el.style.opacity);
  const filter = shadowFilter(el.style, defs);
  if (filter) a.filter = filter;
  return Object.keys(a).length === 0 ? body : `<g${attrs(a)}>${body}</g>`;
}

// ---------------------------------------------------------------------------
// Text layout
// ---------------------------------------------------------------------------

interface Seg { text: string; run: Run }

interface Line {
  segs: Seg[];
  /** Estimated advance of the line, points. */
  width: number;
  /** Largest font size on the line — drives the line box. */
  size: number;
  height: number;
  /** Left edge of this line's available span, absolute. */
  left: number;
  right: number;
  align: NonNullable<Paragraph['align']>;
  /** Only true for non-final lines of a justified paragraph. */
  justify: boolean;
  /** Inter-word gaps, used to spread a justified line. */
  gaps: number;
  spaceBefore: number;
  spaceAfter: number;
}

const BULLET = '• ';

/** Tokenises a paragraph into words, runs of spaces and hard breaks. */
function tokenize(para: Paragraph): Array<{ text: string; run: Run; kind: 'word' | 'space' | 'break' }> {
  const out: Array<{ text: string; run: Run; kind: 'word' | 'space' | 'break' }> = [];
  for (const run of para.runs) {
    // \n is the model's hard line break; \r survives from some Publisher 97 files.
    for (const piece of run.text.split(/(\r\n|[\r\n])/)) {
      if (piece === '') continue;
      if (/^(\r\n|[\r\n])$/.test(piece)) {
        out.push({ text: '', run, kind: 'break' });
        continue;
      }
      for (const t of piece.split(/([ \t ]+)/)) {
        if (t === '') continue;
        out.push({ text: t, run, kind: /^[ \t ]+$/.test(t) ? 'space' : 'word' });
      }
    }
  }
  return out;
}

/** Greedy line breaking of one paragraph into the span [left, right]. */
function layoutParagraph(para: Paragraph, left: number, right: number): Line[] {
  const align = para.align ?? 'left';
  const indent = para.textIndent ?? 0;
  const bodyLeft = left + (para.marginLeft ?? 0);
  const bodyRight = right - (para.marginRight ?? 0);
  const lines: Line[] = [];

  let segs: Seg[] = [];
  let width = 0;
  let size = 0;
  let gaps = 0;
  let pendingSpace: Seg | undefined;
  let pendingSpaceWidth = 0;
  let first = true;

  const lineLeft = () => bodyLeft + (first ? indent : 0);
  const avail = () => Math.max(1, bodyRight - lineLeft());

  const flush = (hard: boolean) => {
    lines.push({
      segs,
      width,
      size: size || DEFAULT_FONT_SIZE,
      height: (size || DEFAULT_FONT_SIZE) * (para.lineHeight ?? DEFAULT_LINE_HEIGHT),
      left: lineLeft(),
      right: bodyRight,
      align,
      justify: align === 'justify' && !hard,
      gaps,
      spaceBefore: 0,
      spaceAfter: 0,
    });
    segs = [];
    width = 0;
    size = 0;
    gaps = 0;
    pendingSpace = undefined;
    pendingSpaceWidth = 0;
    first = false;
  };

  const push = (seg: Seg, w: number) => {
    const last = segs[segs.length - 1];
    if (last && last.run === seg.run) last.text += seg.text;
    else segs.push(seg);
    width += w;
    size = Math.max(size, seg.run.size ?? DEFAULT_FONT_SIZE);
  };

  const tokens = tokenize(para);
  if (para.list && tokens.length > 0) {
    const marker = para.list.type === 'unordered' ? BULLET : '';
    const firstRun = tokens[0]?.run;
    if (marker && firstRun) tokens.unshift({ text: marker, run: firstRun, kind: 'word' });
  }

  for (const tok of tokens) {
    if (tok.kind === 'break') {
      flush(true);
      continue;
    }
    if (tok.kind === 'space') {
      if (segs.length === 0) continue; // spaces never open a line
      pendingSpace = { text: tok.text, run: tok.run };
      pendingSpaceWidth = estimateTextWidth(tok.text, tok.run);
      continue;
    }
    const w = estimateTextWidth(tok.text, tok.run);
    if (segs.length > 0 && width + pendingSpaceWidth + w > avail()) {
      flush(false); // the pending space is dropped with the break, as it should be
      push({ text: tok.text, run: tok.run }, w);
      continue;
    }
    if (pendingSpace) {
      push(pendingSpace, pendingSpaceWidth);
      gaps++;
      pendingSpace = undefined;
      pendingSpaceWidth = 0;
    }
    push({ text: tok.text, run: tok.run }, w);
  }
  if (segs.length > 0 || lines.length === 0) flush(true);

  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  if (firstLine) firstLine.spaceBefore = para.marginTop ?? 0;
  if (lastLine) lastLine.spaceAfter = para.marginBottom ?? 0;
  return lines;
}

function anchorFor(line: Line): { x: number; anchor: string } {
  switch (line.align) {
    case 'center':
      return { x: (line.left + line.right) / 2, anchor: 'middle' };
    case 'right':
      return { x: line.right, anchor: 'end' };
    default:
      return { x: line.left, anchor: 'start' };
  }
}

function fontFamilyAttr(run: Run): string {
  const name = run.font ?? DEFAULT_FONT_FAMILY;
  const cls = classifyFont(name);
  const generic = cls === 'mono' ? 'monospace' : cls === 'serif' ? 'serif' : 'sans-serif';
  // A family name containing a comma or a quote would break the CSS font list; quote it.
  const safe = /[",]/.test(name) ? `'${name.replace(/['"]/g, '')}'` : name;
  return `${safe}, ${generic}`;
}

function renderLine(line: Line, baseline: number): string {
  if (line.segs.length === 0) return '';
  const { x, anchor } = anchorFor(line);
  const spread = line.justify && line.gaps > 0 ? (line.right - line.left - line.width) / line.gaps : 0;

  // baseline-shift is unevenly supported; dy is not. We apply the shift as a dy and undo
  // it on the next span so the shift does not accumulate down the line.
  let appliedShift = 0;
  let body = '';
  for (const seg of line.segs) {
    const run = seg.run;
    const size = run.size ?? DEFAULT_FONT_SIZE;
    const wantShift = run.baselineShift ? -(run.baselineShift / 100) * size : 0;
    const dy = wantShift - appliedShift;
    appliedShift = wantShift;

    const decoration = [run.underline ? 'underline' : '', run.strike ? 'line-through' : '']
      .filter(Boolean)
      .join(' ');
    const text = run.allCaps ? seg.text.toUpperCase() : seg.text;
    body += tag(
      'tspan',
      {
        'font-family': fontFamilyAttr(run),
        'font-size': size,
        'font-weight': run.bold ? 'bold' : undefined,
        'font-style': run.italic ? 'italic' : undefined,
        'font-variant': run.smallCaps ? 'small-caps' : undefined,
        'text-decoration': decoration || undefined,
        // The string is already uppercased; the property is belt-and-braces for renderers
        // that re-shape from the source text (and is a no-op for those that do not).
        style: run.allCaps ? 'text-transform:uppercase' : undefined,
        fill: run.color,
        dy: dy !== 0 ? n(dy) : undefined,
        'xml:space': 'preserve',
      },
      esc(text),
    );
  }
  return tag(
    'text',
    {
      x: n(x),
      y: n(baseline),
      'text-anchor': anchor === 'start' ? undefined : anchor,
      'word-spacing': spread > 0 ? n(spread) : undefined,
      'xml:space': 'preserve',
    },
    body,
  );
}

/**
 * Lays paragraphs out inside a content rectangle and returns the SVG for them.
 * Text that does not fit is still emitted — Publisher overflows too, and silently
 * dropping content is worse than overflowing it.
 */
function renderParagraphs(
  paragraphs: Paragraph[],
  content: Box,
  verticalAlign: 'top' | 'middle' | 'bottom',
  columns: { count: number; gap: number } | undefined,
): string {
  const count = Math.max(1, Math.floor(columns?.count ?? 1));
  const gap = count > 1 ? (columns?.gap ?? 0) : 0;
  const colWidth = (content.width - gap * (count - 1)) / count;
  if (colWidth <= 0) return '';

  const lines: Line[] = [];
  for (const para of paragraphs) {
    lines.push(...layoutParagraph(para, 0, colWidth));
  }

  // Pack lines into columns, then place each column's block vertically.
  const perColumn: Line[][] = Array.from({ length: count }, () => []);
  let col = 0;
  let used = 0;
  for (const line of lines) {
    const need = line.spaceBefore + line.height + line.spaceAfter;
    const target = perColumn[col] as Line[];
    if (count > 1 && target.length > 0 && used + need > content.height && col < count - 1) {
      col++;
      used = 0;
    }
    (perColumn[col] as Line[]).push(line);
    used += need;
  }

  let out = '';
  for (let c = 0; c < count; c++) {
    const colLines = perColumn[c] as Line[];
    if (colLines.length === 0) continue;
    const blockHeight = colLines.reduce((s, l) => s + l.spaceBefore + l.height + l.spaceAfter, 0);
    const slack = content.height - blockHeight;
    const offset =
      verticalAlign === 'middle' ? Math.max(0, slack / 2)
      : verticalAlign === 'bottom' ? Math.max(0, slack)
      : 0;
    const colLeft = content.x + c * (colWidth + gap);
    let cursor = content.y + offset;
    for (const line of colLines) {
      cursor += line.spaceBefore;
      // Lines were measured against [0, colWidth]; shift them onto this column.
      const placed: Line = { ...line, left: line.left + colLeft, right: line.right + colLeft };
      out += renderLine(placed, cursor + line.size * ASCENT_RATIO);
      cursor += line.height + line.spaceAfter;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

function boxOf(el: { x: number; y: number; width: number; height: number }): Box {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

function renderTextBox(el: TextBox, defs: Defs, doc: Doc): string {
  const box = boxOf(el);
  const pad = el.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const content: Box = {
    x: box.x + pad.left,
    y: box.y + pad.top,
    width: Math.max(0, box.width - pad.left - pad.right),
    height: Math.max(0, box.height - pad.top - pad.bottom),
  };
  const backing = el.style ? tag('rect', { ...boxRectAttrs(box), ...paintAttrs(el.style, defs, box, doc) }) : '';
  const text = renderParagraphs(el.paragraphs, content, el.verticalAlign ?? 'top', el.columns);
  return frame(backing + text, el, box, defs);
}

function boxRectAttrs(box: Box): Attrs {
  return { x: n(box.x), y: n(box.y), width: n(Math.max(0, box.width)), height: n(Math.max(0, box.height)) };
}

function renderTable(el: Table, defs: Defs, doc: Doc): string {
  const box = boxOf(el);
  const cols = el.columnWidths.length > 0 ? el.columnWidths.slice() : [el.width];
  const colX: number[] = [box.x];
  for (const w of cols) colX.push((colX[colX.length - 1] as number) + w);

  const fallbackRow = el.rows.length > 0 ? box.height / el.rows.length : box.height;
  const rowH = el.rows.map((r) => r.height ?? fallbackRow);
  const rowY: number[] = [box.y];
  for (const h of rowH) rowY.push((rowY[rowY.length - 1] as number) + h);

  const span = (offsets: number[], start: number, count: number, fallback: number): number => {
    const a = offsets[Math.min(start, offsets.length - 1)];
    const b = offsets[Math.min(start + Math.max(1, count), offsets.length - 1)];
    if (a === undefined || b === undefined || b <= a) return fallback;
    return b - a;
  };

  let body = '';
  for (const row of el.rows) {
    for (const cell of row.cells) {
      if (cell.covered) continue; // merged away by a neighbour's span
      body += renderCell(cell, colX, rowY, span, defs, doc, el.style);
    }
  }
  return frame(body, el, box, defs);
}

function renderCell(
  cell: TableCell,
  colX: number[],
  rowY: number[],
  span: (offsets: number[], start: number, count: number, fallback: number) => number,
  defs: Defs,
  doc: Doc,
  tableStyle: ShapeStyle | undefined,
): string {
  const x = colX[Math.min(cell.column, colX.length - 1)] ?? 0;
  const y = rowY[Math.min(cell.row, rowY.length - 1)] ?? 0;
  const width = span(colX, cell.column, cell.colSpan, 0);
  const height = span(rowY, cell.row, cell.rowSpan, 0);
  const box: Box = { x, y, width, height };
  const style = cell.style ?? tableStyle;
  const rect = tag('rect', { ...boxRectAttrs(box), ...paintAttrs(style, defs, box, doc) });
  const content: Box = {
    x: x + CELL_PADDING,
    y: y + CELL_PADDING,
    width: Math.max(0, width - CELL_PADDING * 2),
    height: Math.max(0, height - CELL_PADDING * 2),
  };
  return rect + renderParagraphs(cell.paragraphs, content, 'top', undefined);
}

function renderImage(el: Image, defs: Defs, doc: Doc): string {
  const box = boxOf(el);
  const href = assetHref(doc, el.assetRef);
  if (href) {
    const img = tag('image', {
      ...boxRectAttrs(box),
      href,
      'xlink:href': href,
      // Publisher frames crop/stretch to the box; matching that beats preserving ratio.
      preserveAspectRatio: 'none',
    });
    return frame(img, el, box, defs);
  }
  const asset = doc.assets[el.assetRef];
  const label = asset ? `${asset.mime} not renderable` : 'missing image';
  return frame(placeholder(box, label), el, box, defs);
}

/** A dashed frame with a centred label, so the user sees where a graphic was. */
function placeholder(box: Box, label: string): string {
  const size = Math.max(6, Math.min(11, box.height / 4));
  const rect = tag('rect', {
    ...boxRectAttrs(box),
    fill: '#f2f2f2',
    stroke: '#b0b0b0',
    'stroke-width': 1,
    'stroke-dasharray': '4 3',
  });
  const text = tag(
    'text',
    {
      x: n(box.x + box.width / 2),
      y: n(box.y + box.height / 2 + size * 0.35),
      'text-anchor': 'middle',
      'font-family': 'Helvetica, sans-serif',
      'font-size': n(size),
      fill: '#707070',
    },
    esc(label),
  );
  return rect + text;
}

function pointsAttr(points: Point[]): string {
  return points.map((p) => `${n(p.x)},${n(p.y)}`).join(' ');
}

function pathData(commands: PathCommand[]): string {
  const parts: string[] = [];
  for (const c of commands) {
    switch (c.op) {
      case 'M': parts.push(`M ${n(c.x)} ${n(c.y)}`); break;
      case 'L': parts.push(`L ${n(c.x)} ${n(c.y)}`); break;
      case 'C': parts.push(`C ${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`); break;
      case 'Q': parts.push(`Q ${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`); break;
      case 'A':
        parts.push(
          `A ${n(c.rx)} ${n(c.ry)} ${n(c.rotation)} ${c.largeArc ? 1 : 0} ${c.sweep ? 1 : 0} ${n(c.x)} ${n(c.y)}`,
        );
        break;
      case 'Z': parts.push('Z'); break;
    }
  }
  return parts.join(' ');
}

function renderGeometry(geometry: Geometry, box: Box, paint: Attrs): string {
  switch (geometry.type) {
    case 'rect':
      return tag('rect', {
        ...boxRectAttrs(box),
        rx: geometry.rx === undefined ? undefined : n(geometry.rx),
        ry: geometry.ry === undefined ? undefined : n(geometry.ry),
        ...paint,
      });
    case 'ellipse':
      return tag('ellipse', {
        cx: n(box.x + box.width / 2),
        cy: n(box.y + box.height / 2),
        rx: n(Math.max(0, box.width / 2)),
        ry: n(Math.max(0, box.height / 2)),
        ...paint,
      });
    case 'polygon':
      return tag('polygon', { points: pointsAttr(geometry.points), ...paint });
    case 'polyline':
      // An open run of points is never filled, whatever the style says.
      return tag('polyline', { points: pointsAttr(geometry.points), ...paint, fill: 'none' });
    case 'path':
      return tag('path', { d: pathData(geometry.d), ...paint });
  }
}

function renderShape(el: Shape, defs: Defs, doc: Doc): string {
  const box = boxOf(el);
  return frame(renderGeometry(el.geometry, box, paintAttrs(el.style, defs, box, doc)), el, box, defs);
}

function renderGroup(el: Group, defs: Defs, doc: Doc): string {
  const box = boxOf(el);
  // Children carry page coordinates (the model has one origin, the page's top-left), so a
  // group only contributes its own rotation, opacity and shadow.
  const fill = el.style?.fill;
  const backing = fill && fill.type !== 'none'
    ? tag('rect', { ...boxRectAttrs(box), ...paintAttrs(el.style, defs, box, doc) })
    : '';
  const body = backing + el.children.map((c) => renderElement(c, defs, doc)).join('');
  return frame(body, el, box, defs);
}

function renderElement(el: Element, defs: Defs, doc: Doc): string {
  switch (el.kind) {
    case 'text': return renderTextBox(el, defs, doc);
    case 'table': return renderTable(el, defs, doc);
    case 'image': return renderImage(el, defs, doc);
    case 'shape': return renderShape(el, defs, doc);
    case 'group': return renderGroup(el, defs, doc);
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function renderPage(page: Page, doc: Doc): string {
  const defs = new Defs();
  // Elements are painted in array order: the model's order *is* the z-order.
  const body = page.elements.map((el) => renderElement(el, defs, doc)).join('');

  const width = Math.max(1, page.width);
  const height = Math.max(1, page.height);
  const meta =
    (doc.meta.title ? tag('title', {}, esc(doc.meta.title)) : '') +
    (doc.meta.description ? tag('desc', {}, esc(doc.meta.description)) : '');

  const open =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ` +
    `version="1.1" width="${n(width)}pt" height="${n(height)}pt" ` +
    `viewBox="0 0 ${n(width)} ${n(height)}">`;

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    open +
    meta +
    defs.render() +
    tag('rect', { x: 0, y: 0, width: n(width), height: n(height), fill: '#ffffff' }) +
    body +
    '</svg>'
  );
}

/**
 * Renders one page. `opts.page` is a zero-based index into `doc.pages` and defaults to 0.
 * Throws `RangeError` rather than returning an empty document for an index that is not
 * there — a silently blank page is the kind of failure this emitter exists to catch.
 */
export function emitSVG(doc: Doc, opts?: { page?: number }): string {
  const index = opts?.page ?? 0;
  const page = doc.pages[index];
  if (!page) throw new RangeError(`page ${index} out of range (document has ${doc.pages.length})`);
  return renderPage(page, doc);
}

/** Renders every page, in order. One standalone SVG document per page. */
export function emitSVGPages(doc: Doc): string[] {
  return doc.pages.map((page) => renderPage(page, doc));
}
