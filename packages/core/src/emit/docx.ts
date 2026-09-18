/**
 * DOCX emitter.
 *
 * The honest tension, stated up front, because it decides everything below:
 *
 * Word is a *flow* format and Publisher is not. A `.pub` page is a set of
 * absolutely-positioned boxes on a fixed canvas; a `.docx` body is a stream of
 * paragraphs that reflows when you type. There is no mapping that keeps both
 * properties, so this file implements two, and makes the caller choose:
 *
 *   LAYOUT mode (the default) — every element becomes a floating drawing anchored to
 *     the page at its exact coordinates, wrapping `none`. The page looks like the
 *     original. The cost is that the document is a pinboard, not prose: you edit it
 *     one box at a time, and typing in a box does not push the box below it down.
 *
 *   FLOW mode — elements are sorted into reading order and emitted as ordinary body
 *     paragraphs and tables. The document behaves like a document. The cost is that
 *     the arrangement is gone: columns become sequential, decorative shapes are
 *     dropped, and a caption that sat beside a photo now sits under it.
 *
 * Layout is the default because someone converting a newsletter wants it to still look
 * like the newsletter — see `docs/POSITIONING.md`. Flow exists for the other case, where
 * the words matter more than the arrangement, and its losses are reported through
 * `onWarning` rather than hidden.
 *
 * Everything is written by hand rather than through a library: the anchored floating
 * text box (`wp:anchor` + `wps:wsp` + `wps:txbx`) is the one construct this emitter
 * cannot do without, and it is the one construct the document-building libraries do not
 * express.
 *
 * Geometry arrives in points with the origin at the page's top-left, which is also
 * Word's page origin for `relativeFrom="page"` offsets, so positions need a unit
 * conversion and nothing else.
 */

import JSZip from 'jszip';

import type {
  Asset,
  Doc,
  Element,
  Fill,
  Geometry,
  Image,
  Page,
  Paragraph,
  PathCommand,
  Point,
  Run,
  Shape,
  ShapeStyle,
  Stroke,
  Table,
  TableCell,
  TextBox,
  Warning,
  WarningCode,
} from '../model/types';

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export type DocxMode = 'layout' | 'flow';

/**
 * One plain sentence per mode, exported so the UI can offer the choice without
 * re-inventing (or contradicting) the wording.
 */
export const DOCX_MODE_DESCRIPTIONS: Record<DocxMode, string> = {
  layout:
    'Keeps the page looking like the original by pinning every text box, table and picture to the spot Publisher put it, which means you edit the document box by box instead of as flowing text.',
  flow:
    'Rebuilds the page as ordinary Word paragraphs you can edit and reflow like any other document, which means the original arrangement of the page is lost.',
};

export interface EmitDOCXOptions {
  /** Defaults to `'layout'`. */
  mode?: DocxMode;
  /**
   * Called once per distinct loss, with a `count` when the same loss happened more than
   * once. These are losses introduced *by this emitter*; losses the parser already knew
   * about are on `doc.warnings` and are not repeated here.
   */
  onWarning?: (warning: Warning) => void;
}

// ---------------------------------------------------------------------------
// Unit conversions
//
// These are exact, not approximations: OOXML's units are all integer sub-divisions of
// the point, so every one of them is a multiplication and a round.
// ---------------------------------------------------------------------------

/** Twentieths of a point — Word's unit for page size, margins, indents and spacing. */
const TWIPS_PER_POINT = 20;

/** English Metric Units per point — DrawingML's unit for every offset and extent. */
const EMU_PER_POINT = 12700;

/** Word states font sizes in half-points. */
const HALF_POINTS_PER_POINT = 2;

/** Border widths are in eighths of a point. */
const EIGHTHS_PER_POINT = 8;

/** DrawingML states angles in sixty-thousandths of a degree, clockwise. */
const ANGLE_UNITS_PER_DEGREE = 60000;

/** DrawingML states percentages in thousandths of a percent. */
const PERCENT_UNITS = 100000;

/** `w:line` is a multiple of this when `w:lineRule` is `auto`: 240 twips == one line. */
const TWIPS_PER_LINE = 240;

const twips = (pt: number): number => Math.round(finite(pt) * TWIPS_PER_POINT);
const emu = (pt: number): number => Math.round(finite(pt) * EMU_PER_POINT);
const halfPoints = (pt: number): number => Math.round(finite(pt) * HALF_POINTS_PER_POINT);
const angle60k = (deg: number): number =>
  Math.round((((finite(deg) % 360) + 360) % 360) * ANGLE_UNITS_PER_DEGREE);
const pct = (fraction: number): number =>
  Math.round(clamp(finite(fraction), 0, 1) * PERCENT_UNITS);

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Named approximations
//
// Every number here is a place where Word has no way to say what Publisher meant, or
// where the model does not carry something Word insists on. They live together at the
// top so a fidelity complaint can be traced to a decision instead of to a literal
// buried in a function.
// ---------------------------------------------------------------------------

/** Font size assumed for a run that carries none. Publisher's default body size. */
const DEFAULT_FONT_SIZE_PT = 12;

/** Font assumed for a run that carries none. */
const DEFAULT_FONT_FAMILY = 'Times New Roman';

/**
 * Word's own limits on a font size: `w:sz` is a positive count of half-points, so half a
 * point is the floor, and 1638pt is the ceiling its UI and file format agree on.
 */
const MIN_FONT_SIZE_PT = 0.5;
const MAX_FONT_SIZE_PT = 1638;

/**
 * Inset for text inside a box when the model carries no padding. Publisher's own default
 * text-box inset is 0.04in ~= 2.9pt, the same figure the SVG emitter uses for table cells.
 */
const DEFAULT_TEXT_INSET_PT = 2.9;

/**
 * Inset for table cell text, for the same reason.
 *
 * The horizontal half goes in `w:tblCellMar`, where it belongs. The vertical half goes on
 * the cell's first and last paragraph instead, because measured: LibreOffice adds a
 * vertical cell margin *on top of* `w:trHeight` rather than inside it, so a 17.7pt row
 * asked for with a 2.9pt margin comes back 23.5pt tall and every row after it slides down
 * the page. Spacing on the paragraph insets the text by the same amount without ever
 * being counted twice, and both Word and LibreOffice then land on the row height the
 * model asked for.
 */
const CELL_PADDING_PT = 2.9;

/**
 * Page margin used in flow mode. The model has no margins — a Publisher page is a canvas,
 * not a text frame — so flow mode has to invent one, and 0.5in is Publisher's own default
 * page margin. Clamped below so it never eats a small page.
 */
const FLOW_MARGIN_PT = 36;

/** A flow margin is never allowed to take more than this share of a page dimension. */
const FLOW_MARGIN_MAX_SHARE = 0.2;

/** Layout mode has no margin at all; {@link marginTwipsFor} says why. */
const LAYOUT_MARGIN_TWIPS = 0;

/**
 * Two boxes whose tops differ by less than this are treated as one row when flow mode
 * sorts into reading order — half a typical line, which is enough to absorb the baseline
 * jitter between boxes a human lined up by eye, and not enough to merge stacked blocks.
 */
const FLOW_ROW_TOLERANCE_PT = 6;

/**
 * Line height of the otherwise-empty paragraph that hosts a page's anchors in layout
 * mode. It has to exist — Word anchors hang off a paragraph — so it is made as small as
 * Word allows rather than left to push the first line of the page down.
 */
const HOST_PARAGRAPH_LINE_TWIPS = 20;
const HOST_PARAGRAPH_FONT_HALF_POINTS = 2;

/**
 * A shape with a zero-length side (a rule, a hairline divider) would have a zero extent,
 * and a zero-extent drawing is not painted at all. Give it a hairline instead.
 */
const MIN_SHAPE_EXTENT_PT = 0.5;

/**
 * Below this shift, a raised or lowered run is optical kerning and is emitted as
 * `w:position`, which keeps the glyph size. At or above it, the run is a superscript or
 * a subscript in the sense a reader means, and is emitted as `w:vertAlign`, which is what
 * someone editing the document in Word expects to find on it.
 */
const SUPERSCRIPT_MIN_SHIFT_PCT = 10;

/**
 * Dash patterns are matched to the nearest of Word's presets, measured as the dash length
 * in multiples of the stroke width. DrawingML can express an exact pattern, but only as a
 * percentage of the line width, and the round trip through that is less faithful in
 * practice than picking the preset a human would have picked.
 */
const DOT_MAX_DASH_RATIO = 1.5;
const DASH_MAX_DASH_RATIO = 4.5;

/** Gradients need two stops to be a gradient; with fewer, Word wants a flat colour. */
const MIN_GRADIENT_STOPS = 2;

/** Fallback colour for a gradient that arrived with no usable stops at all. */
const FALLBACK_FILL_COLOR = 'FFFFFF';

/** Placeholder framing for a picture in a format Word cannot show. */
const PLACEHOLDER_FILL = 'F2F2F2';
const PLACEHOLDER_STROKE = 'B0B0B0';
const PLACEHOLDER_TEXT_COLOR = '707070';
const PLACEHOLDER_FONT_SIZE_PT = 9;

/**
 * Z-order numbering for anchored drawings.
 *
 * `relativeHeight` is documented as a plain ordering key — higher is nearer the reader —
 * and Word writes it starting at 0x0F000000 and stepping by 0x400 per object. Measured:
 * LibreOffice's .docx import ignores small values entirely and falls back to an order of
 * its own, which silently buries a page's background under the text that was meant to sit
 * on it. Following Word's own numbering is what makes the model's element order survive,
 * and it is free, so it is not worth being clever about.
 */
const Z_ORDER_BASE = 0x0f000000;
const Z_ORDER_STRIDE = 0x400;

/** `ST_RelativeHeight` is an unsigned 32-bit integer. */
const MAX_RELATIVE_HEIGHT = 0xffffffff;

/** Bullet glyphs by list level, cycled. Word's own three-level default. */
const BULLET_GLYPHS = ['•', '◦', '▪'];

/** Indent per list level, matching Word's built-in list indents. */
const LIST_INDENT_PER_LEVEL_TWIPS = 720;
const LIST_HANGING_TWIPS = 360;

/** The deepest list level Word's numbering definitions go to. */
const LIST_LEVELS = 9;

/** US Letter, used only for a document that arrived with no pages at all. */
const FALLBACK_PAGE: Page = { width: 612, height: 792, elements: [] };

/**
 * Raster formats a Word document can carry directly. Publisher embeds WMF and EMF
 * constantly and neither Word nor any browser will render one out of a `.docx`, so those
 * become a labelled placeholder and a warning instead of a broken picture.
 */
const IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
};

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  webp: 'image/webp',
};

// ---------------------------------------------------------------------------
// XML plumbing
// ---------------------------------------------------------------------------

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
};

/**
 * Escapes text and attribute values, and strips the C0 control characters that are
 * illegal in XML 1.0. Real `.pub` text carries stray 0x0B/0x0C/0x1E from Publisher's own
 * control codes, and one of them makes a whole part unparseable — which is how an OOXML
 * writer fails on a real document rather than on a test. Tabs and newlines are handled
 * before this point, as `w:tab` and `w:br`, so they are stripped here too.
 */
function esc(value: string): string {
  return value
    .replace(/[ -￾￿]/g, '')
    .replace(/[&<>"']/g, (c) => XML_ESCAPE[c] as string);
}

type Attrs = Record<string, string | number | undefined>;

function attrs(a: Attrs): string {
  let out = '';
  for (const [k, v] of Object.entries(a)) {
    if (v === undefined) continue;
    out += ` ${k}="${typeof v === 'number' ? String(v) : esc(v)}"`;
  }
  return out;
}

function tag(name: string, a: Attrs = {}, children?: string): string {
  return children === undefined || children === ''
    ? `<${name}${attrs(a)}/>`
    : `<${name}${attrs(a)}>${children}</${name}>`;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
} as const;

const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_TYPE = `${RELS_NS}/`;
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** `a:graphicData` is versioned by this URI rather than by the element name. */
const GRAPHIC_DATA_WPS = NS.wps;
const GRAPHIC_DATA_PICTURE = NS.pic;

/** Colour as OOXML wants it: six hex digits, no `#`. */
function color(value: string | undefined, fallback: string): string {
  const hex = /^#?([0-9a-fA-F]{6})$/.exec((value ?? '').trim());
  return hex ? (hex[1] as string).toUpperCase() : fallback;
}

/** A BCP-47-ish tag, or nothing: Word rejects `w:lang` values it does not recognise. */
function languageTag(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Warning collection
// ---------------------------------------------------------------------------

/** Aggregates repeats so the caller is told a thing happened 40 times, not 40 times. */
class Warnings {
  private readonly byCode = new Map<WarningCode, { message: string; count: number }>();

  add(code: WarningCode, message: string): void {
    const existing = this.byCode.get(code);
    if (existing) existing.count++;
    else this.byCode.set(code, { message, count: 1 });
  }

  drain(sink: ((w: Warning) => void) | undefined): void {
    if (!sink) return;
    for (const [code, { message, count }] of this.byCode) {
      sink(count > 1 ? { code, message, count } : { code, message });
    }
  }
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes the first `limit` bytes of a base64 payload without depending on a runtime. */
function decodeBase64Prefix(data: string, limit: number): Uint8Array {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of data) {
    const v = BASE64_ALPHABET.indexOf(ch);
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

/**
 * The real format of an asset whose declared mime is missing or useless. The extractor
 * hands us `application/octet-stream` whenever librevenge did not know, and a picture
 * dropped for want of a label is a picture lost for no reason.
 */
function sniffImageMime(asset: Asset): string | undefined {
  const b = decodeBase64Prefix(asset.data, 16);
  const at = (i: number) => b[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return 'image/png';
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return 'image/gif';
  if (at(0) === 0x42 && at(1) === 0x4d) return 'image/bmp';
  if ((at(0) === 0x49 && at(1) === 0x49 && at(2) === 0x2a) || (at(0) === 0x4d && at(1) === 0x4d && at(3) === 0x2a)) {
    return 'image/tiff';
  }
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
      at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) {
    return 'image/webp';
  }
  return undefined;
}

/** Base64 with the whitespace taken out, or nothing when it is not base64 at all. */
function normalizeBase64(data: string): string | undefined {
  const stripped = data.replace(/\s+/g, '');
  if (stripped === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(stripped)) return undefined;
  return stripped;
}

interface MediaPart {
  /** Path inside the package, e.g. `media/image1.png`. */
  path: string;
  extension: string;
  /** Carried on the part so `[Content_Types].xml` cannot disagree with the file. */
  contentType: string;
  base64: string;
}

/**
 * Owns `word/media/*`, the relationships that point at them, and the answer to "can Word
 * show this at all?". One part per distinct asset, however many elements reference it.
 */
class Media {
  private readonly byRef = new Map<string, MediaPart | null>();
  private readonly relIdByRef = new Map<string, string>();
  readonly parts: MediaPart[] = [];

  constructor(
    private readonly doc: Doc,
    private readonly rels: Relationships,
    private readonly warnings: Warnings,
  ) {}

  /** The relationship id for an asset, or nothing when it cannot be carried. */
  relIdFor(ref: string): string | undefined {
    const cached = this.relIdByRef.get(ref);
    if (cached !== undefined) return cached;

    const part = this.partFor(ref);
    if (!part) return undefined;
    const id = this.rels.add(`${OFFICE_REL}/image`, part.path);
    this.relIdByRef.set(ref, id);
    return id;
  }

  /** Why an asset could not be carried, written for the person who uploaded the file. */
  describeMissing(ref: string): string {
    const asset = this.doc.assets[ref];
    if (!asset) return 'picture missing';
    const mime = (asset.mime || '').toLowerCase();
    if (mime.includes('wmf') || mime.includes('emf')) return 'Windows metafile picture — not shown';
    return `${asset.mime || 'unknown format'} — not shown`;
  }

  private partFor(ref: string): MediaPart | null {
    const cached = this.byRef.get(ref);
    if (cached !== undefined) return cached;

    const part = this.build(ref);
    this.byRef.set(ref, part);
    if (part) this.parts.push(part);
    return part;
  }

  private build(ref: string): MediaPart | null {
    const asset = this.doc.assets[ref];
    if (!asset) {
      this.warnings.add('SHAPE_APPROXIMATED',
        'A picture referred to image data that is not in the document, so its place was marked but left empty.');
      return null;
    }

    const declared = (asset.mime || '').toLowerCase();
    const extension = IMAGE_EXTENSION_BY_MIME[declared] ?? IMAGE_EXTENSION_BY_MIME[sniffImageMime(asset) ?? ''];
    const contentType = extension === undefined ? undefined : CONTENT_TYPE_BY_EXTENSION[extension];
    if (!extension || !contentType) {
      if (declared.includes('wmf') || declared.includes('emf')) {
        this.warnings.add('WMF_IMAGE_NOT_CONVERTED',
          'A picture is stored as a Windows metafile (WMF/EMF), which Word cannot display inside a .docx. Its place is marked in the document but the picture itself was left out.');
      } else {
        this.warnings.add('WMF_IMAGE_NOT_CONVERTED',
          `A picture is in a format Word cannot display inside a .docx (${asset.mime || 'unrecognised'}). Its place is marked in the document but the picture itself was left out.`);
      }
      return null;
    }

    const base64 = normalizeBase64(asset.data);
    if (!base64) {
      this.warnings.add('SHAPE_APPROXIMATED',
        'A picture carried image data we could not decode, so its place was marked but left empty.');
      return null;
    }

    return { path: `media/image${this.parts.length + 1}.${extension}`, extension, contentType, base64 };
  }
}

/** `word/_rels/document.xml.rels`. Ids are allocated in the order they are asked for. */
class Relationships {
  private readonly out: string[] = [];
  private seq = 0;

  add(type: string, target: string): string {
    const id = `rId${++this.seq}`;
    this.out.push(tag('Relationship', { Id: id, Type: type, Target: target }));
    return id;
  }

  render(): string {
    return XML_DECLARATION + tag('Relationships', { xmlns: RELS_NS }, this.out.join(''));
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function fontSizePt(run: Run): number {
  return clamp(run.size ?? DEFAULT_FONT_SIZE_PT, MIN_FONT_SIZE_PT, MAX_FONT_SIZE_PT);
}

/**
 * `w:rPr`. The child order is the schema's, not a preference: Word rejects a run whose
 * properties are out of sequence, and the rejection is a "the file is corrupt" dialog
 * rather than a missing bold.
 */
function runProperties(run: Run): string {
  const family = run.font ?? DEFAULT_FONT_FAMILY;
  const size = fontSizePt(run);
  const shift = run.baselineShift ?? 0;
  const useVertAlign = Math.abs(shift) >= SUPERSCRIPT_MIN_SHIFT_PCT;
  const lang = languageTag(run.lang);

  let out = tag('w:rFonts', {
    'w:ascii': family, 'w:hAnsi': family, 'w:cs': family, 'w:eastAsia': family,
  });
  if (run.bold) out += tag('w:b') + tag('w:bCs');
  if (run.italic) out += tag('w:i') + tag('w:iCs');
  // Word treats caps and smallCaps as mutually exclusive; all-caps is the stronger claim.
  if (run.allCaps) out += tag('w:caps');
  else if (run.smallCaps) out += tag('w:smallCaps');
  if (run.strike) out += tag('w:strike');
  if (run.outline) out += tag('w:outline');
  if (run.textShadow) out += tag('w:shadow');
  if (run.relief === 'embossed') out += tag('w:emboss');
  if (run.relief === 'engraved') out += tag('w:imprint');
  if (run.color) out += tag('w:color', { 'w:val': color(run.color, '000000') });
  if (run.textScale !== undefined && run.textScale > 0) {
    // ST_TextScale is a whole percentage of the normal glyph width.
    out += tag('w:w', { 'w:val': Math.round(clamp(run.textScale, 1, 600)) });
  }
  if (!useVertAlign && shift !== 0) {
    // `w:position` raises or lowers the baseline without resizing the glyph, in
    // half-points; the model states the shift as a percentage of the font size.
    out += tag('w:position', { 'w:val': halfPoints((shift / 100) * size) });
  }
  out += tag('w:sz', { 'w:val': halfPoints(size) });
  out += tag('w:szCs', { 'w:val': halfPoints(size) });
  if (run.underline) out += tag('w:u', { 'w:val': 'single' });
  if (useVertAlign) out += tag('w:vertAlign', { 'w:val': shift > 0 ? 'superscript' : 'subscript' });
  if (lang) out += tag('w:lang', { 'w:val': lang });

  return tag('w:rPr', {}, out);
}

/**
 * Splits a run's text into `w:t`, `w:tab` and `w:br`. Word has no way to put a tab or a
 * line break inside a text node, and a `\v` left in the string would make the part
 * unparseable, so the split has to happen here rather than in the escaper.
 */
function runContent(text: string): string {
  let out = '';
  // Keep the separators: each is emitted as its own element.
  for (const piece of text.split(/(\r\n|[\r\n\t])/)) {
    if (piece === '') continue;
    if (piece === '\t') { out += tag('w:tab'); continue; }
    if (/^(\r\n|[\r\n])$/.test(piece)) { out += tag('w:br'); continue; }
    // A piece that was nothing but Publisher control codes escapes to nothing; an empty
    // `w:t` would only be noise in the file, and the run around it is dropped with it.
    const escaped = esc(piece);
    if (escaped !== '') out += tag('w:t', { 'xml:space': 'preserve' }, escaped);
  }
  return out;
}

function renderRun(run: Run): string {
  const content = runContent(run.text);
  if (content === '') return '';
  return tag('w:r', {}, runProperties(run) + content);
}

// ---------------------------------------------------------------------------
// Paragraphs
// ---------------------------------------------------------------------------

const JUSTIFICATION: Record<NonNullable<Paragraph['align']>, string> = {
  left: 'left', center: 'center', right: 'right', justify: 'both',
};

interface ParagraphContext {
  /** Set when the document has lists, so `w:numPr` has a numbering definition to point at. */
  numbering: boolean;
  /** Appended inside `w:pPr`, after everything else: the section break, in flow mode. */
  trailing?: string;
}

/**
 * `w:pPr`. Ordered by the schema, for the same reason `w:rPr` is.
 */
function paragraphProperties(para: Paragraph, ctx: ParagraphContext): string {
  let out = '';

  if (para.list && ctx.numbering) {
    const level = clamp(Math.floor(para.list.level), 0, LIST_LEVELS - 1);
    out += tag('w:numPr', {},
      tag('w:ilvl', { 'w:val': level }) +
      tag('w:numId', { 'w:val': para.list.type === 'ordered' ? ORDERED_NUM_ID : BULLET_NUM_ID }));
  }

  const spacing: Attrs = {};
  if (para.marginTop !== undefined) spacing['w:before'] = Math.max(0, twips(para.marginTop));
  if (para.marginBottom !== undefined) spacing['w:after'] = Math.max(0, twips(para.marginBottom));
  if (para.lineHeight !== undefined && para.lineHeight > 0) {
    // `auto` is the rule that reads `w:line` as a multiple of a single line, which is
    // exactly what the model's multiplier means. `exact` would freeze it in points and
    // clip anything set larger than the line.
    spacing['w:line'] = Math.round(para.lineHeight * TWIPS_PER_LINE);
    spacing['w:lineRule'] = 'auto';
  }
  if (Object.keys(spacing).length > 0) out += tag('w:spacing', spacing);

  const ind: Attrs = {};
  if (para.marginLeft !== undefined) ind['w:left'] = twips(para.marginLeft);
  if (para.marginRight !== undefined) ind['w:right'] = twips(para.marginRight);
  if (para.textIndent !== undefined && para.textIndent !== 0) {
    // Word splits the one model field in two: a positive first line is an indent, a
    // negative one is a hanging indent, and both attributes are unsigned.
    if (para.textIndent > 0) ind['w:firstLine'] = twips(para.textIndent);
    else ind['w:hanging'] = twips(-para.textIndent);
  }
  if (Object.keys(ind).length > 0) out += tag('w:ind', ind);

  if (para.align) out += tag('w:jc', { 'w:val': JUSTIFICATION[para.align] });
  if (ctx.trailing) out += ctx.trailing;

  return out === '' ? '' : tag('w:pPr', {}, out);
}

function renderParagraph(para: Paragraph, ctx: ParagraphContext): string {
  const runs = para.runs.map(renderRun).join('');
  return tag('w:p', {}, paragraphProperties(para, ctx) + runs);
}

/**
 * An empty paragraph, which Word needs in places the model leaves blank — an empty cell,
 * an empty text box, and after a table. `sectPr`, when given, is the section break this
 * paragraph carries.
 */
function emptyParagraph(sectPr?: string): string {
  const pPr = sectPr ? tag('w:pPr', {}, sectPr) : '';
  return tag('w:p', {}, pPr);
}

/**
 * Paragraphs for a container. Word requires at least one paragraph in a table cell and in
 * a text box, so an empty list becomes one empty paragraph rather than nothing.
 */
function renderParagraphs(paragraphs: Paragraph[], ctx: ParagraphContext): string {
  if (paragraphs.length === 0) return emptyParagraph();
  return paragraphs.map((p) => renderParagraph(p, ctx)).join('');
}

/**
 * Paragraphs inside a table cell, held off the cell's top and bottom edges by
 * {@link CELL_PADDING_PT} — see that constant for why the inset lives here and not in
 * `w:tblCellMar`. The model's own paragraph spacing is added to, never replaced.
 */
function renderCellParagraphs(paragraphs: Paragraph[], ctx: ParagraphContext): string {
  if (paragraphs.length === 0) return emptyParagraph();
  return paragraphs
    .map((p, i) => renderParagraph({
      ...p,
      ...(i === 0 ? { marginTop: (p.marginTop ?? 0) + CELL_PADDING_PT } : {}),
      ...(i === paragraphs.length - 1 ? { marginBottom: (p.marginBottom ?? 0) + CELL_PADDING_PT } : {}),
    }, ctx))
    .join('');
}

// ---------------------------------------------------------------------------
// DrawingML: fills, lines, effects
// ---------------------------------------------------------------------------

/** A colour, optionally with the element's opacity folded into it. */
function srgbClr(value: string | undefined, fallback: string, opacity: number | undefined): string {
  const val = color(value, fallback);
  const alpha = opacity !== undefined && opacity < 1 ? tag('a:alpha', { val: pct(opacity) }) : '';
  return tag('a:srgbClr', { val }, alpha);
}

interface FillContext {
  media: Media;
  warnings: Warnings;
}

function fillXml(fill: Fill | undefined, opacity: number | undefined, ctx: FillContext): string {
  if (!fill || fill.type === 'none') return tag('a:noFill');

  if (fill.type === 'solid') {
    return tag('a:solidFill', {}, srgbClr(fill.color, FALLBACK_FILL_COLOR, opacity));
  }

  if (fill.type === 'gradient') {
    const stops = fill.stops
      .map((s) => ({ ...s, offset: clamp(finite(s.offset), 0, 1) }))
      .sort((a, b) => a.offset - b.offset);
    if (stops.length < MIN_GRADIENT_STOPS) {
      const only = stops[0];
      ctx.warnings.add('GRADIENT_FLATTENED',
        'A gradient did not carry enough colour stops to rebuild in Word, so it became a flat colour.');
      return tag('a:solidFill', {}, srgbClr(only?.color, FALLBACK_FILL_COLOR, opacity));
    }
    const gsLst = stops
      .map((s) => tag('a:gs', { pos: pct(s.offset) },
        srgbClr(s.color, FALLBACK_FILL_COLOR,
          s.opacity === undefined ? opacity : s.opacity * (opacity ?? 1))))
      .join('');
    // Both the model and `a:lin` measure the angle clockwise from the positive x-axis,
    // so the angle carries across untouched.
    return tag('a:gradFill', { rotWithShape: 0 },
      tag('a:gsLst', {}, gsLst) + tag('a:lin', { ang: angle60k(fill.angle), scaled: 0 }));
  }

  // Image fill.
  const relId = ctx.media.relIdFor(fill.assetRef);
  if (!relId) return tag('a:noFill');
  const alphaMod = opacity !== undefined && opacity < 1 ? tag('a:alphaModFix', { amt: pct(opacity) }) : '';
  const blip = tag('a:blip', { 'r:embed': relId }, alphaMod);
  // DrawingML has no "draw the bitmap once at its own size and leave the rest blank", so
  // 'none' is approximated by stretching: covering the box once is closer to Publisher's
  // intent than tiling it.
  const placement = fill.repeat === 'repeat'
    ? tag('a:tile', { tx: 0, ty: 0, sx: PERCENT_UNITS, sy: PERCENT_UNITS, flip: 'none', algn: 'tl' })
    : tag('a:stretch', {}, tag('a:fillRect'));
  return tag('a:blipFill', { rotWithShape: 1 }, blip + placement);
}

/** The closest of Word's dash presets to a dash array, measured in stroke widths. */
function dashPreset(dash: number[], width: number): string | undefined {
  const pattern = dash.filter((d) => Number.isFinite(d) && d >= 0);
  if (pattern.length === 0) return undefined;
  const unit = width > 0 ? width : 1;
  const ratio = (pattern[0] as number) / unit;
  const dotted = ratio <= DOT_MAX_DASH_RATIO;
  const long = ratio > DASH_MAX_DASH_RATIO;
  // Four or more entries alternate a long mark with a short one: that is a dash-dot.
  if (pattern.length >= 4) return long ? 'lgDashDot' : 'dashDot';
  return dotted ? 'dot' : long ? 'lgDash' : 'dash';
}

function lineXml(stroke: Stroke | undefined, opacity: number | undefined): string {
  if (!stroke) return tag('a:ln', {}, tag('a:noFill'));
  const preset = stroke.dash ? dashPreset(stroke.dash, stroke.width) : undefined;
  return tag('a:ln', { w: Math.max(0, emu(stroke.width)) },
    tag('a:solidFill', {}, srgbClr(stroke.color, '000000', opacity)) +
    (preset ? tag('a:prstDash', { val: preset }) : ''));
}

function effectXml(style: ShapeStyle | undefined): string {
  const shadow = style?.shadow;
  if (!shadow) return '';
  const dx = finite(shadow.offsetX);
  const dy = finite(shadow.offsetY);
  const distance = Math.hypot(dx, dy);
  // `dir` is measured clockwise from the positive x-axis with y pointing down, which is
  // also the model's convention, so atan2 carries straight across.
  const direction = (Math.atan2(dy, dx) * 180) / Math.PI;
  return tag('a:effectLst', {},
    tag('a:outerShdw',
      { blurRad: 0, dist: emu(distance), dir: angle60k(direction), rotWithShape: 0 },
      srgbClr(shadow.color, '808080', shadow.opacity)));
}

// ---------------------------------------------------------------------------
// DrawingML: geometry
// ---------------------------------------------------------------------------

interface Box { x: number; y: number; width: number; height: number }

function boxOf(el: { x: number; y: number; width: number; height: number }): Box {
  return { x: finite(el.x), y: finite(el.y), width: finite(el.width), height: finite(el.height) };
}

/** The extent a drawing is given: never zero, or Word paints nothing at all. */
function extentOf(box: Box): { cx: number; cy: number } {
  return {
    cx: Math.max(emu(MIN_SHAPE_EXTENT_PT), emu(Math.abs(box.width))),
    cy: Math.max(emu(MIN_SHAPE_EXTENT_PT), emu(Math.abs(box.height))),
  };
}

/** One point of a custom path, in the path's own space: EMU measured from the box corner. */
function pathPoint(p: Point, box: Box): string {
  return tag('a:pt', { x: emu(finite(p.x) - box.x), y: emu(finite(p.y) - box.y) });
}

/**
 * Splits an SVG-style endpoint arc into cubic Béziers.
 *
 * DrawingML does have an arc command, but its centre-and-sweep parameterisation is a
 * different one from the model's endpoint parameterisation, and the conversion between
 * them has more ways to be subtly wrong than this does. Cubics are exact to within the
 * well-known error of the 90-degree circular approximation, which is below a thousandth
 * of the radius — far below anything visible on a page.
 */
function arcToCubics(
  from: Point,
  arc: Extract<PathCommand, { op: 'A' }>,
): Array<{ x1: number; y1: number; x2: number; y2: number; x: number; y: number }> {
  const to = { x: finite(arc.x), y: finite(arc.y) };
  let rx = Math.abs(finite(arc.rx));
  let ry = Math.abs(finite(arc.ry));
  if (rx === 0 || ry === 0) {
    // A degenerate radius is a straight line, by the SVG rule and by common sense.
    return [{ x1: from.x, y1: from.y, x2: to.x, y2: to.y, x: to.x, y: to.y }];
  }

  const phi = (finite(arc.rotation) * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (from.x - to.x) / 2;
  const dy2 = (from.y - to.y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // Grow the radii just enough to reach, when they are too small to span the chord.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const factor = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den)) * (arc.largeArc === arc.sweep ? -1 : 1);
  const cxp = (factor * rx * y1p) / ry;
  const cyp = (-factor * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2;

  const angleOf = (ux: number, uy: number) => Math.atan2(uy, ux);
  const theta1 = angleOf((x1p - cxp) / rx, (y1p - cyp) / ry);
  let delta = angleOf((-x1p - cxp) / rx, (-y1p - cyp) / ry) - theta1;
  if (!arc.sweep && delta > 0) delta -= 2 * Math.PI;
  else if (arc.sweep && delta < 0) delta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2)));
  const step = delta / segments;
  // The control-point distance that makes a cubic match a circular arc of `step` radians.
  const k = (4 / 3) * Math.tan(step / 4);

  const out: Array<{ x1: number; y1: number; x2: number; y2: number; x: number; y: number }> = [];
  let theta = theta1;
  let current = { x: from.x, y: from.y };
  for (let i = 0; i < segments; i++) {
    const next = theta + step;
    const onEllipse = (t: number) => ({
      x: cx + rx * Math.cos(t) * cosPhi - ry * Math.sin(t) * sinPhi,
      y: cy + rx * Math.cos(t) * sinPhi + ry * Math.sin(t) * cosPhi,
    });
    const derivative = (t: number) => ({
      x: -rx * Math.sin(t) * cosPhi - ry * Math.cos(t) * sinPhi,
      y: -rx * Math.sin(t) * sinPhi + ry * Math.cos(t) * cosPhi,
    });
    const end = i === segments - 1 ? to : onEllipse(next);
    const d1 = derivative(theta);
    const d2 = derivative(next);
    out.push({
      x1: current.x + k * d1.x,
      y1: current.y + k * d1.y,
      x2: end.x - k * d2.x,
      y2: end.y - k * d2.y,
      x: end.x,
      y: end.y,
    });
    current = end;
    theta = next;
  }
  return out;
}

function customPath(commands: PathCommand[], box: Box, closed: boolean): string {
  let out = '';
  let cursor: Point = { x: box.x, y: box.y };
  for (const c of commands) {
    switch (c.op) {
      case 'M':
        out += tag('a:moveTo', {}, pathPoint(c, box));
        cursor = { x: finite(c.x), y: finite(c.y) };
        break;
      case 'L':
        out += tag('a:lnTo', {}, pathPoint(c, box));
        cursor = { x: finite(c.x), y: finite(c.y) };
        break;
      case 'C':
        out += tag('a:cubicBezTo', {},
          pathPoint({ x: c.x1, y: c.y1 }, box) + pathPoint({ x: c.x2, y: c.y2 }, box) + pathPoint(c, box));
        cursor = { x: finite(c.x), y: finite(c.y) };
        break;
      case 'Q':
        out += tag('a:quadBezTo', {}, pathPoint({ x: c.x1, y: c.y1 }, box) + pathPoint(c, box));
        cursor = { x: finite(c.x), y: finite(c.y) };
        break;
      case 'A':
        for (const seg of arcToCubics(cursor, c)) {
          out += tag('a:cubicBezTo', {},
            pathPoint({ x: seg.x1, y: seg.y1 }, box) +
            pathPoint({ x: seg.x2, y: seg.y2 }, box) +
            pathPoint({ x: seg.x, y: seg.y }, box));
        }
        cursor = { x: finite(c.x), y: finite(c.y) };
        break;
      case 'Z':
        out += tag('a:close');
        break;
    }
  }
  if (closed && !commands.some((c) => c.op === 'Z')) out += tag('a:close');

  const { cx, cy } = extentOf(box);
  return tag('a:custGeom', {},
    tag('a:avLst') + tag('a:gdLst') + tag('a:ahLst') + tag('a:cxnLst') +
    tag('a:rect', { l: 0, t: 0, r: cx, b: cy }) +
    tag('a:pathLst', {},
      tag('a:path', { w: cx, h: cy, ...(closed ? {} : { fill: 'none' }) }, out)));
}

function geometryXml(geometry: Geometry, box: Box): string {
  if (isEmptyGeometry(geometry)) return tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst'));
  switch (geometry.type) {
    case 'rect': {
      const radius = Math.max(geometry.rx ?? 0, geometry.ry ?? 0);
      if (radius <= 0) return tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst'));
      // `roundRect`'s adjustment is the corner radius as a share of the shorter side,
      // where the whole 100000 would round the corner all the way to half that side.
      const shorter = Math.max(1e-6, Math.min(Math.abs(box.width), Math.abs(box.height)));
      const adj = clamp(Math.round((radius / shorter) * PERCENT_UNITS), 0, PERCENT_UNITS / 2);
      return tag('a:prstGeom', { prst: 'roundRect' },
        tag('a:avLst', {}, tag('a:gd', { name: 'adj', fmla: `val ${adj}` })));
    }
    case 'ellipse':
      return tag('a:prstGeom', { prst: 'ellipse' }, tag('a:avLst'));
    case 'polygon':
      return customPath(polylineCommands(geometry.points), box, true);
    case 'polyline':
      return customPath(polylineCommands(geometry.points), box, false);
    case 'path':
      return customPath(geometry.d, box, geometry.d.some((c) => c.op === 'Z'));
  }
}

/**
 * A geometry with no points at all cannot be written as a custom path — an empty
 * `a:pathLst` is not a shape — so it falls back to the frame it was measured into.
 */
function isEmptyGeometry(geometry: Geometry): boolean {
  switch (geometry.type) {
    case 'polygon': case 'polyline': return geometry.points.length === 0;
    case 'path': return geometry.d.length === 0;
    default: return false;
  }
}

function polylineCommands(points: Point[]): PathCommand[] {
  return points.map((p, i) => ({ op: i === 0 ? 'M' : 'L', x: p.x, y: p.y }) as PathCommand);
}

// ---------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------

/**
 * Allocates the ids Word insists be unique across the whole document, and the z-order
 * that makes the model's element order the painting order.
 */
class DrawingIds {
  private nextDocPr = 1;
  private zIndex = 0;

  docPr(): number {
    return this.nextDocPr++;
  }

  z(): number {
    return Math.min(MAX_RELATIVE_HEIGHT, Z_ORDER_BASE + this.zIndex++ * Z_ORDER_STRIDE);
  }
}

interface DrawingContext extends FillContext {
  ids: DrawingIds;
  numbering: boolean;
}

/**
 * A floating drawing pinned to the page. `relativeFrom="page"` is what makes this work:
 * it measures from the paper's corner, which is exactly where the model measures from,
 * so page margins cannot move the content. `wrapNone` plus `allowOverlap` is what lets
 * Publisher's overlapping boxes stay overlapping instead of being pushed apart.
 */
function anchoredDrawing(box: Box, name: string, graphicData: string, ctx: DrawingContext): string {
  const { cx, cy } = extentOf(box);
  const id = ctx.ids.docPr();
  const body =
    tag('wp:simplePos', { x: 0, y: 0 }) +
    tag('wp:positionH', { relativeFrom: 'page' }, tag('wp:posOffset', {}, String(emu(box.x)))) +
    tag('wp:positionV', { relativeFrom: 'page' }, tag('wp:posOffset', {}, String(emu(box.y)))) +
    tag('wp:extent', { cx, cy }) +
    tag('wp:effectExtent', { l: 0, t: 0, r: 0, b: 0 }) +
    tag('wp:wrapNone') +
    tag('wp:docPr', { id, name: `${name} ${id}` }) +
    tag('wp:cNvGraphicFramePr') +
    tag('a:graphic', {}, graphicData);
  return tag('w:drawing', {},
    tag('wp:anchor', {
      distT: 0, distB: 0, distL: 0, distR: 0,
      simplePos: 0, relativeHeight: ctx.ids.z(), behindDoc: 0, locked: 0,
      layoutInCell: 1, allowOverlap: 1,
    }, body));
}

/** A drawing that sits in the text like a very large character — flow mode's picture. */
function inlineDrawing(width: number, height: number, name: string, graphicData: string, ctx: DrawingContext): string {
  const cx = Math.max(emu(MIN_SHAPE_EXTENT_PT), emu(Math.abs(width)));
  const cy = Math.max(emu(MIN_SHAPE_EXTENT_PT), emu(Math.abs(height)));
  const id = ctx.ids.docPr();
  const body =
    tag('wp:extent', { cx, cy }) +
    tag('wp:effectExtent', { l: 0, t: 0, r: 0, b: 0 }) +
    tag('wp:docPr', { id, name: `${name} ${id}` }) +
    tag('wp:cNvGraphicFramePr', {}, tag('a:graphicFrameLocks', { 'xmlns:a': NS.a, noChangeAspect: 1 })) +
    tag('a:graphic', {}, graphicData);
  return tag('w:drawing', {}, tag('wp:inline', { distT: 0, distB: 0, distL: 0, distR: 0 }, body));
}

interface ShapeOptions {
  /** Degrees clockwise about the box centre. */
  rotation?: number;
  /** `w:txbxContent`. A decorative shape leaves this out and gets an empty body. */
  content?: string;
  /** Text insets and vertical anchoring, for a shape that holds text. */
  bodyPr?: Attrs;
}

/**
 * A `wps:wsp`: the shape that can also hold a body of Word content.
 *
 * Every shape is given a text body, empty when it holds no text, and marked `txBox`.
 * That looks like pointless uniformity and is not: measured against LibreOffice, a `wps`
 * shape with no `wps:txbx` is imported as a drawing object while one with a text body
 * becomes a text frame, and the two are painted in separate stacks — a shape with no text
 * lands in front of *every* text box no matter what `relativeHeight` says. On a Publisher
 * page that means a background panel painted over the article it was sitting behind.
 * Making every shape the same kind puts them all back in one stack, where the z-order we
 * asked for is the z-order we get.
 */
function shapeGraphicData(
  box: Box,
  geometry: string,
  style: ShapeStyle | undefined,
  ctx: DrawingContext,
  opts: ShapeOptions = {},
): string {
  const { cx, cy } = extentOf(box);
  const xfrm = tag('a:xfrm', opts.rotation ? { rot: angle60k(opts.rotation) } : {},
    tag('a:off', { x: 0, y: 0 }) + tag('a:ext', { cx, cy }));

  const spPr = tag('wps:spPr', {},
    xfrm + geometry +
    fillXml(style?.fill, style?.opacity, ctx) +
    lineXml(style?.stroke, style?.opacity) +
    effectXml(style));

  const bodyPr = tag('wps:bodyPr', {
    rot: 0, vert: 'horz', wrap: 'square',
    lIns: 0, tIns: 0, rIns: 0, bIns: 0, anchor: 't', anchorCtr: 0,
    ...opts.bodyPr,
  // `noAutofit` is what stops the empty paragraph above from resizing a decorative shape.
  }, tag('a:noAutofit'));

  return tag('a:graphicData', { uri: GRAPHIC_DATA_WPS },
    tag('wps:wsp', {},
      tag('wps:cNvSpPr', { txBox: 1 }) +
      spPr +
      tag('wps:txbx', {}, tag('w:txbxContent', {}, opts.content ?? emptyParagraph())) +
      bodyPr));
}

/** A `pic:pic`: a bitmap and nothing else. */
function pictureGraphicData(relId: string, width: number, height: number, rotation: number | undefined, ctx: DrawingContext): string {
  const cx = Math.max(emu(MIN_SHAPE_EXTENT_PT), emu(Math.abs(width)));
  const cy = Math.max(emu(MIN_SHAPE_EXTENT_PT), emu(Math.abs(height)));
  const id = ctx.ids.docPr();
  return tag('a:graphicData', { uri: GRAPHIC_DATA_PICTURE },
    tag('pic:pic', {},
      tag('pic:nvPicPr', {},
        tag('pic:cNvPr', { id, name: `Picture ${id}` }) + tag('pic:cNvPicPr')) +
      tag('pic:blipFill', {},
        tag('a:blip', { 'r:embed': relId }) + tag('a:stretch', {}, tag('a:fillRect'))) +
      tag('pic:spPr', {},
        tag('a:xfrm', rotation ? { rot: angle60k(rotation) } : {},
          tag('a:off', { x: 0, y: 0 }) + tag('a:ext', { cx, cy })) +
        tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst')))));
}

/**
 * A dashed frame with a label, standing where a picture we cannot carry was. Publisher
 * users need to see *that* something is missing and *where* — a silent hole is the
 * failure this product exists to avoid.
 */
function placeholderContent(label: string): string {
  const run: Run = {
    text: label,
    font: 'Arial',
    size: PLACEHOLDER_FONT_SIZE_PT,
    italic: true,
    color: `#${PLACEHOLDER_TEXT_COLOR}`,
  };
  return renderParagraph({ runs: [run], align: 'center' }, { numbering: false });
}

const PLACEHOLDER_STYLE: ShapeStyle = {
  fill: { type: 'solid', color: `#${PLACEHOLDER_FILL}` },
  stroke: { color: `#${PLACEHOLDER_STROKE}`, width: 1, dash: [4, 3] },
};

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/**
 * The grid a table's cells actually occupy.
 *
 * The model gives every grid position a cell and marks the ones a neighbour's span
 * swallowed; Word wants the opposite — the spanning cell declares how far it reaches, and
 * a vertical continuation still needs a `w:tc` of its own while a horizontal one must not
 * have one. This resolves the model's view into Word's.
 */
interface TableGrid {
  columnWidths: number[];
  /** `owner[row][column]` is the cell that covers that position, or undefined for a hole. */
  owner: Array<Array<TableCell | undefined>>;
}

function buildTableGrid(table: Table): TableGrid {
  const declared = table.columnWidths.filter((w) => Number.isFinite(w));
  let columns = declared.length;
  for (const row of table.rows) {
    for (const cell of row.cells) {
      columns = Math.max(columns, cell.column + Math.max(1, cell.colSpan));
    }
  }
  columns = Math.max(1, columns);

  // A table whose declared widths do not cover every column it uses gets the shortfall
  // shared out evenly; a table with no widths at all is divided equally.
  const declaredTotal = declared.reduce((s, w) => s + w, 0);
  const remaining = Math.max(0, finite(table.width) - declaredTotal);
  const missing = columns - declared.length;
  const filler = missing > 0
    ? (remaining > 0 ? remaining / missing : (declaredTotal > 0 ? declaredTotal / declared.length : finite(table.width) / columns))
    : 0;
  const columnWidths = Array.from({ length: columns }, (_, i) => Math.max(0, declared[i] ?? filler));

  const owner: Array<Array<TableCell | undefined>> = table.rows.map(() => new Array(columns).fill(undefined));
  for (const [rowIndex, row] of table.rows.entries()) {
    for (const cell of row.cells) {
      if (cell.covered) continue;
      // The model's `row` is authoritative when it is in range; a malformed one falls
      // back to the row the cell was listed in, which is never worse.
      const top = cell.row >= 0 && cell.row < table.rows.length ? cell.row : rowIndex;
      const rowSpan = Math.max(1, cell.rowSpan);
      const colSpan = Math.max(1, cell.colSpan);
      for (let r = top; r < Math.min(table.rows.length, top + rowSpan); r++) {
        for (let c = cell.column; c < Math.min(columns, cell.column + colSpan); c++) {
          const line = owner[r];
          if (line && line[c] === undefined) line[c] = cell;
        }
      }
    }
  }
  return { columnWidths, owner };
}

const BORDER_SIDES = ['top', 'left', 'bottom', 'right'] as const;

function borderXml(container: string, stroke: Stroke | undefined, includeInside: boolean): string {
  if (!stroke) return '';
  // `w:sz` is in eighths of a point, and Word clamps it to a quarter-point hairline at
  // the bottom and six points at the top.
  const size = clamp(Math.round(finite(stroke.width) * EIGHTHS_PER_POINT), 2, 96);
  const val = stroke.dash && stroke.dash.length > 0 ? 'dashed' : 'single';
  const sides = includeInside ? [...BORDER_SIDES, 'insideH', 'insideV'] : [...BORDER_SIDES];
  const body = sides
    .map((side) => tag(`w:${side}`, {
      'w:val': val, 'w:sz': size, 'w:space': 0, 'w:color': color(stroke.color, '000000'),
    }))
    .join('');
  return tag(container, {}, body);
}

function shadingXml(fill: Fill | undefined): string {
  if (!fill || fill.type !== 'solid') return '';
  return tag('w:shd', { 'w:val': 'clear', 'w:color': 'auto', 'w:fill': color(fill.color, 'FFFFFF') });
}

function renderTableXml(table: Table, ctx: DrawingContext): string {
  const grid = buildTableGrid(table);
  const totalWidth = grid.columnWidths.reduce((s, w) => s + w, 0) || finite(table.width);

  const tblPr = tag('w:tblPr', {},
    tag('w:tblW', { 'w:w': Math.max(0, twips(totalWidth)), 'w:type': 'dxa' }) +
    borderXml('w:tblBorders', table.style?.stroke, true) +
    shadingXml(table.style?.fill) +
    // Fixed layout keeps the column widths we measured instead of letting Word
    // re-balance them around the text, which is the whole point of the conversion.
    tag('w:tblLayout', { 'w:type': 'fixed' }) +
    // Horizontal insets only: the vertical ones are on the cells' paragraphs, or the row
    // heights come out too tall. See CELL_PADDING_PT.
    tag('w:tblCellMar', {},
      tag('w:top', { 'w:w': 0, 'w:type': 'dxa' }) +
      tag('w:left', { 'w:w': twips(CELL_PADDING_PT), 'w:type': 'dxa' }) +
      tag('w:bottom', { 'w:w': 0, 'w:type': 'dxa' }) +
      tag('w:right', { 'w:w': twips(CELL_PADDING_PT), 'w:type': 'dxa' })) +
    tag('w:tblLook', {
      'w:val': '0000', 'w:firstRow': 0, 'w:lastRow': 0,
      'w:firstColumn': 0, 'w:lastColumn': 0, 'w:noHBand': 0, 'w:noVBand': 0,
    }));

  const tblGrid = tag('w:tblGrid', {},
    grid.columnWidths.map((w) => tag('w:gridCol', { 'w:w': Math.max(0, twips(w)) })).join(''));

  const rows = table.rows.map((row, rowIndex) => renderRow(row.height, rowIndex, grid, ctx)).join('');
  return tag('w:tbl', {}, tblPr + tblGrid + rows);
}

function renderRow(
  height: number | undefined,
  rowIndex: number,
  grid: TableGrid,
  ctx: DrawingContext,
): string {
  const line = grid.owner[rowIndex] ?? [];
  let cells = '';

  for (let c = 0; c < grid.columnWidths.length; c++) {
    const owner = line[c];
    if (!owner) {
      // A grid position no cell claims still needs a `w:tc`, or the row comes up short
      // and Word re-flows the whole table.
      cells += emptyCell(grid.columnWidths[c] ?? 0);
      continue;
    }
    // Only the leading column of a horizontal span gets a cell; `w:gridSpan` covers the
    // rest, and a second cell for them would widen the row.
    if (owner.column !== c) continue;

    const colSpan = Math.max(1, Math.min(owner.colSpan, grid.columnWidths.length - c));
    const width = grid.columnWidths.slice(c, c + colSpan).reduce((s, w) => s + w, 0);
    const rowSpan = Math.max(1, owner.rowSpan);
    const originRow = grid.owner.findIndex((r) => r[c] === owner);
    const continuation = rowSpan > 1 && originRow !== rowIndex;

    cells += renderCell(owner, width, colSpan, rowSpan, continuation, ctx);
  }

  const trPr = height !== undefined && height > 0
    // `atLeast` rather than `exact`: Publisher rows grow to fit their text, and clipping
    // a line to hold a measured height loses content to gain a millimetre.
    ? tag('w:trPr', {}, tag('w:trHeight', { 'w:val': Math.max(0, twips(height)), 'w:hRule': 'atLeast' }))
    : '';
  return tag('w:tr', {}, trPr + cells);
}

function emptyCell(width: number): string {
  const tcPr = tag('w:tcPr', {}, tag('w:tcW', { 'w:w': Math.max(0, twips(width)), 'w:type': 'dxa' }));
  return tag('w:tc', {}, tcPr + emptyParagraph());
}

function renderCell(
  cell: TableCell,
  width: number,
  colSpan: number,
  rowSpan: number,
  continuation: boolean,
  ctx: DrawingContext,
): string {
  const tcPr = tag('w:tcPr', {},
    tag('w:tcW', { 'w:w': Math.max(0, twips(width)), 'w:type': 'dxa' }) +
    (colSpan > 1 ? tag('w:gridSpan', { 'w:val': colSpan }) : '') +
    (rowSpan > 1 ? tag('w:vMerge', continuation ? {} : { 'w:val': 'restart' }) : '') +
    borderXml('w:tcBorders', cell.style?.stroke, false) +
    shadingXml(cell.style?.fill));

  // The text of a vertically merged cell belongs to the row it started in; a
  // continuation carries the merge and nothing else.
  const content = continuation
    ? emptyParagraph()
    : renderCellParagraphs(cell.paragraphs, { numbering: ctx.numbering });
  return tag('w:tc', {}, tcPr + content);
}

// ---------------------------------------------------------------------------
// Layout mode
// ---------------------------------------------------------------------------

/** Text insets and vertical anchoring for a text box. */
function textBodyPr(el: TextBox, warnings: Warnings): Attrs {
  const pad = el.padding ?? {
    top: DEFAULT_TEXT_INSET_PT, right: DEFAULT_TEXT_INSET_PT,
    bottom: DEFAULT_TEXT_INSET_PT, left: DEFAULT_TEXT_INSET_PT,
  };
  const anchor = el.verticalAlign === 'middle' ? 'ctr' : el.verticalAlign === 'bottom' ? 'b' : 't';
  const out: Attrs = {
    lIns: Math.max(0, emu(pad.left)),
    tIns: Math.max(0, emu(pad.top)),
    rIns: Math.max(0, emu(pad.right)),
    bIns: Math.max(0, emu(pad.bottom)),
    anchor,
  };
  if (el.columns && el.columns.count > 1) {
    out.numCol = Math.floor(el.columns.count);
    out.spcCol = Math.max(0, emu(el.columns.gap));
    // Word honours `numCol`; LibreOffice's .docx import does not, and reads the box as a
    // single column. The columns are written out regardless — degrading in one reader is
    // better than throwing them away for every reader.
    warnings.add('COLUMNS_FLATTENED',
      'A text box was set in multiple columns. Word will show the columns; some other word processors read the box as a single column.');
  }
  return out;
}

function layoutTextBox(el: TextBox, ctx: DrawingContext, warnings: Warnings): string {
  const box = boxOf(el);
  const content = renderParagraphs(el.paragraphs, { numbering: ctx.numbering });
  const graphic = shapeGraphicData(box, tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst')), el.style, ctx, {
    rotation: el.rotation,
    content,
    bodyPr: textBodyPr(el, warnings),
  });
  return anchoredDrawing(box, 'Text Box', graphic, ctx);
}

/**
 * A table becomes an anchored text box holding a real `w:tbl`. Word cannot anchor a table
 * to a position on the page by itself — only a drawing can be anchored — so the text box
 * is the frame and the table inside it is the table.
 */
function layoutTable(el: Table, ctx: DrawingContext): string {
  const box = boxOf(el);
  // A text box's content may not end with a table: Word needs somewhere to put the
  // cursor after it, and refuses to open the document without it.
  const content = renderTableXml(el, ctx) + emptyParagraph();
  const graphic = shapeGraphicData(box, tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst')), el.style, ctx, {
    rotation: el.rotation,
    content,
    bodyPr: { lIns: 0, tIns: 0, rIns: 0, bIns: 0, anchor: 't' },
  });
  return anchoredDrawing(box, 'Table Frame', graphic, ctx);
}

function layoutImage(el: Image, ctx: DrawingContext): string {
  const box = boxOf(el);
  const relId = ctx.media.relIdFor(el.assetRef);
  if (relId) {
    return anchoredDrawing(box, 'Picture',
      pictureGraphicData(relId, box.width, box.height, el.rotation, ctx), ctx);
  }
  const graphic = shapeGraphicData(box, tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst')), PLACEHOLDER_STYLE, ctx, {
    rotation: el.rotation,
    content: placeholderContent(ctx.media.describeMissing(el.assetRef)),
    bodyPr: { lIns: 0, tIns: 0, rIns: 0, bIns: 0, anchor: 'ctr' },
  });
  return anchoredDrawing(box, 'Missing Picture', graphic, ctx);
}

function layoutShape(el: Shape, ctx: DrawingContext): string {
  const box = boxOf(el);
  const graphic = shapeGraphicData(box, geometryXml(el.geometry, box), el.style, ctx, {
    rotation: el.rotation,
  });
  return anchoredDrawing(box, 'Shape', graphic, ctx);
}

/** One element, as the drawings it becomes. A group becomes several; most become one. */
function layoutElement(el: Element, ctx: DrawingContext, warnings: Warnings): string[] {
  switch (el.kind) {
    case 'text': return [layoutTextBox(el, ctx, warnings)];
    case 'table': return [layoutTable(el, ctx)];
    case 'image': return [layoutImage(el, ctx)];
    case 'shape': return [layoutShape(el, ctx)];
    case 'group': {
      // The model gives group children page coordinates, so a group contributes only its
      // own backing fill; its children are drawn at their own absolute positions.
      const box = boxOf(el);
      const backing = el.style?.fill && el.style.fill.type !== 'none'
        ? [anchoredDrawing(box, 'Group Background',
          shapeGraphicData(box, tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst')), el.style, ctx,
            { rotation: el.rotation }), ctx)]
        : [];
      return [...backing, ...el.children.flatMap((c) => layoutElement(c, ctx, warnings))];
    }
  }
}

/** A page's worth of anchors, each in its own run, hanging off one near-invisible paragraph. */
function layoutPage(page: Page, ctx: DrawingContext, warnings: Warnings, sectPr: string): string {
  const runs = page.elements
    .flatMap((el) => layoutElement(el, ctx, warnings))
    .map((drawing) => tag('w:r', {}, drawing))
    .join('');
  // Word hangs anchors off a paragraph, so a page needs one whether or not it holds text.
  // It is made as small as Word allows rather than left to take up a line of the page.
  const pPr = tag('w:pPr', {},
    tag('w:spacing', {
      'w:before': 0, 'w:after': 0,
      'w:line': HOST_PARAGRAPH_LINE_TWIPS, 'w:lineRule': 'exact',
    }) +
    tag('w:rPr', {}, tag('w:sz', { 'w:val': HOST_PARAGRAPH_FONT_HALF_POINTS })) +
    sectPr);
  return tag('w:p', {}, pPr + runs);
}

// ---------------------------------------------------------------------------
// Flow mode
// ---------------------------------------------------------------------------

/**
 * Reading order.
 *
 * Boxes are banded by their tops and each band is read left to right, which is what a
 * person does with a page and what the positions actually support. It is a heuristic and
 * it is allowed to be: the mode's entire premise is that the arrangement is being given
 * up, so the goal is a sensible order, not a recoverable one.
 */
function readingOrder(elements: Element[]): Element[] {
  const flat: Element[] = [];
  const collect = (els: Element[]): void => {
    for (const el of els) {
      if (el.kind === 'group') { collect(el.children); continue; }
      flat.push(el);
    }
  };
  collect(elements);

  const byTop = flat
    .map((el, index) => ({ el, index }))
    .sort((a, b) => (finite(a.el.y) - finite(b.el.y)) || (finite(a.el.x) - finite(b.el.x)) || (a.index - b.index));

  const out: Element[] = [];
  let band: Array<{ el: Element; index: number }> = [];
  let bandTop = 0;
  const flush = () => {
    band.sort((a, b) => (finite(a.el.x) - finite(b.el.x)) || (a.index - b.index));
    for (const item of band) out.push(item.el);
    band = [];
  };
  for (const item of byTop) {
    if (band.length === 0) {
      bandTop = finite(item.el.y);
    } else if (finite(item.el.y) - bandTop > FLOW_ROW_TOLERANCE_PT) {
      flush();
      bandTop = finite(item.el.y);
    }
    band.push(item);
  }
  flush();
  return out;
}

interface FlowContext extends DrawingContext {
  warnings: Warnings;
  /** Width available to content, in points: anything wider is scaled down to fit. */
  contentWidth: number;
}

function flowImage(assetRef: string, box: Box, ctx: FlowContext): string {
  const relId = ctx.media.relIdFor(assetRef);
  // A picture wider than the text column would run off the page in a flow document, so
  // it is scaled down with its aspect ratio kept.
  const scale = box.width > ctx.contentWidth && box.width > 0 ? ctx.contentWidth / box.width : 1;
  if (!relId) {
    const label = ctx.media.describeMissing(assetRef);
    return renderParagraph(
      { runs: [{ text: `[${label}]`, font: 'Arial', size: PLACEHOLDER_FONT_SIZE_PT, italic: true, color: `#${PLACEHOLDER_TEXT_COLOR}` }] },
      { numbering: ctx.numbering });
  }
  const drawing = inlineDrawing(box.width * scale, box.height * scale, 'Picture',
    pictureGraphicData(relId, box.width * scale, box.height * scale, undefined, ctx), ctx);
  return tag('w:p', {}, tag('w:r', {}, drawing));
}

function flowElement(el: Element, ctx: FlowContext): string {
  if (el.rotation) {
    ctx.warnings.add('ROTATED_TEXT_APPROXIMATED',
      'A rotated box was set upright: a flowing Word document has no way to hold text at an angle in the body text.');
  }
  switch (el.kind) {
    case 'text': {
      if (el.columns && el.columns.count > 1) {
        ctx.warnings.add('COLUMNS_FLATTENED',
          'A text box set in multiple columns was run together into a single column.');
      }
      return renderParagraphs(el.paragraphs, { numbering: ctx.numbering });
    }
    case 'table':
      // A table must be followed by a paragraph, both so two tables do not merge into one
      // and so there is somewhere to type after the last one.
      return renderTableXml(el, ctx) + emptyParagraph();
    case 'image':
      return flowImage(el.assetRef, boxOf(el), ctx);
    case 'shape': {
      const fill = el.style?.fill;
      if (fill?.type === 'image') return flowImage(fill.assetRef, boxOf(el), ctx);
      // Rules, panels and decorative outlines carry no words; in a flowing document they
      // would only be noise, and dropping them is the trade the mode exists to make.
      ctx.warnings.add('SHAPE_APPROXIMATED',
        'A decorative shape was left out: a flowing Word document has no place to put it.');
      return '';
    }
    case 'group':
      // `readingOrder` has already flattened these away.
      return el.children.map((c) => flowElement(c, ctx)).join('');
  }
}

function flowPage(page: Page, ctx: FlowContext, sectPr: string): string {
  const body = readingOrder(page.elements).map((el) => flowElement(el, ctx)).join('');
  // The section break lives in the last paragraph of the section. Rather than reach back
  // into whatever that turned out to be — often a table, which cannot carry one — the
  // page always ends with a paragraph of its own to hold it.
  return body + emptyParagraph(sectPr === '' ? undefined : sectPr);
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * The page margin, in twips.
 *
 * Layout mode uses none on purpose: the model's coordinates are measured from the paper's
 * corner, so a margin would be a claim about the document that is not true. Flow mode has
 * to invent one, because the model has none and a Word document with text against the
 * paper's edge is not a document anyone wanted.
 */
function marginTwipsFor(page: Page, mode: DocxMode): number {
  if (mode === 'layout') return LAYOUT_MARGIN_TWIPS;
  const shorter = Math.min(Math.max(1, finite(page.width)), Math.max(1, finite(page.height)));
  return Math.min(twips(FLOW_MARGIN_PT), Math.floor(twips(shorter) * FLOW_MARGIN_MAX_SHARE));
}

/**
 * A section per Publisher page. Pages in one `.pub` can differ in size and orientation,
 * and a section is the only thing in Word that can.
 *
 * Word's own page-size limit is 22 inches a side, and a few Publisher documents (banners,
 * posters) are larger. The true size is written anyway: LibreOffice honours it exactly,
 * and Word clamps the paper while leaving the anchors where they are — which is the same
 * result clamping here would give, minus the fidelity for every reader that can cope.
 */
function sectionProperties(page: Page, mode: DocxMode): string {
  const width = Math.max(1, finite(page.width));
  const height = Math.max(1, finite(page.height));
  const margin = marginTwipsFor(page, mode);

  const body =
    tag('w:type', { 'w:val': 'nextPage' }) +
    tag('w:pgSz', {
      'w:w': twips(width),
      'w:h': twips(height),
      ...(width > height ? { 'w:orient': 'landscape' } : {}),
    }) +
    tag('w:pgMar', {
      'w:top': margin, 'w:right': margin, 'w:bottom': margin, 'w:left': margin,
      'w:header': 0, 'w:footer': 0, 'w:gutter': 0,
    }) +
    tag('w:cols', { 'w:space': 0 }) +
    tag('w:docGrid', { 'w:linePitch': TWIPS_PER_LINE });

  return tag('w:sectPr', {}, body);
}

/** Width available to content, in points — what flow mode scales oversized pictures to. */
function contentWidthFor(page: Page, mode: DocxMode): number {
  const width = Math.max(1, finite(page.width));
  return Math.max(1, width - (2 * marginTwipsFor(page, mode)) / TWIPS_PER_POINT);
}

// ---------------------------------------------------------------------------
// Package parts
// ---------------------------------------------------------------------------

const BULLET_NUM_ID = 1;
const ORDERED_NUM_ID = 2;

function hasLists(doc: Doc): boolean {
  let found = false;
  const scanParagraphs = (paragraphs: Paragraph[]) => {
    for (const p of paragraphs) if (p.list) found = true;
  };
  const walk = (els: Element[]): void => {
    for (const el of els) {
      if (found) return;
      if (el.kind === 'text') scanParagraphs(el.paragraphs);
      else if (el.kind === 'table') {
        for (const row of el.rows) for (const cell of row.cells) scanParagraphs(cell.paragraphs);
      } else if (el.kind === 'group') walk(el.children);
    }
  };
  for (const page of doc.pages) walk(page.elements);
  return found;
}

function numberingXml(): string {
  const level = (ilvl: number, ordered: boolean): string => {
    const indent = LIST_INDENT_PER_LEVEL_TWIPS * (ilvl + 1);
    const text = ordered ? `%${ilvl + 1}.` : (BULLET_GLYPHS[ilvl % BULLET_GLYPHS.length] as string);
    return tag('w:lvl', { 'w:ilvl': ilvl },
      tag('w:start', { 'w:val': 1 }) +
      tag('w:numFmt', { 'w:val': ordered ? 'decimal' : 'bullet' }) +
      tag('w:lvlText', { 'w:val': text }) +
      tag('w:lvlJc', { 'w:val': 'left' }) +
      tag('w:pPr', {}, tag('w:ind', { 'w:left': indent, 'w:hanging': LIST_HANGING_TWIPS })));
  };
  const abstract = (id: number, ordered: boolean): string =>
    tag('w:abstractNum', { 'w:abstractNumId': id },
      tag('w:multiLevelType', { 'w:val': 'hybridMultilevel' }) +
      Array.from({ length: LIST_LEVELS }, (_, i) => level(i, ordered)).join(''));

  return XML_DECLARATION + tag('w:numbering', { 'xmlns:w': NS.w },
    abstract(0, false) + abstract(1, true) +
    tag('w:num', { 'w:numId': BULLET_NUM_ID }, tag('w:abstractNumId', { 'w:val': 0 })) +
    tag('w:num', { 'w:numId': ORDERED_NUM_ID }, tag('w:abstractNumId', { 'w:val': 1 })));
}

/**
 * A minimal style sheet, whose only real job is to zero Word's own defaults. Word's
 * built-in Normal carries eight points of space after every paragraph and a 1.08 line
 * multiplier; applied to a Publisher text box, that silently pushes every line down.
 */
function stylesXml(): string {
  return XML_DECLARATION + tag('w:styles', { 'xmlns:w': NS.w },
    tag('w:docDefaults', {},
      tag('w:rPrDefault', {}, tag('w:rPr', {},
        tag('w:rFonts', {
          'w:ascii': DEFAULT_FONT_FAMILY, 'w:hAnsi': DEFAULT_FONT_FAMILY,
          'w:cs': DEFAULT_FONT_FAMILY, 'w:eastAsia': DEFAULT_FONT_FAMILY,
        }) +
        tag('w:sz', { 'w:val': halfPoints(DEFAULT_FONT_SIZE_PT) }) +
        tag('w:szCs', { 'w:val': halfPoints(DEFAULT_FONT_SIZE_PT) }))) +
      tag('w:pPrDefault', {}, tag('w:pPr', {},
        tag('w:spacing', { 'w:before': 0, 'w:after': 0, 'w:line': TWIPS_PER_LINE, 'w:lineRule': 'auto' })))) +
    tag('w:style', { 'w:type': 'paragraph', 'w:default': 1, 'w:styleId': 'Normal' },
      tag('w:name', { 'w:val': 'Normal' }) + tag('w:qFormat')));
}

/** `dcterms:created` has to be a W3CDTF instant or Word rejects the part. */
function w3cdtf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * `docProps/core.xml`. The element order is the schema's — `CT_CoreProperties` is a
 * sequence, not a bag, and Word treats an out-of-order one as a damaged part.
 */
function corePropertiesXml(doc: Doc): string {
  const meta = doc.meta;
  const field = (name: string, value: string | undefined, a: Attrs = {}): string =>
    value ? tag(name, a, esc(value)) : '';
  return XML_DECLARATION + tag('cp:coreProperties', {
    'xmlns:cp': 'http://schemas.openxmlformats.org/package/2006/metadata/core-properties',
    'xmlns:dc': 'http://purl.org/dc/elements/1.1/',
    'xmlns:dcterms': 'http://purl.org/dc/terms/',
    'xmlns:dcmitype': 'http://purl.org/dc/dcmitype/',
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
  },
    field('dcterms:created', w3cdtf(meta.created), { 'xsi:type': 'dcterms:W3CDTF' }) +
    field('dc:creator', meta.creator) +
    field('dc:description', meta.description) +
    field('cp:keywords', meta.keywords) +
    field('dc:subject', meta.subject) +
    field('dc:title', meta.title));
}

/** `docProps/app.xml`. Ordered by the schema for the same reason as `core.xml`. */
function appPropertiesXml(doc: Doc): string {
  return XML_DECLARATION + tag('Properties', {
    xmlns: 'http://schemas.openxmlformats.org/officeDocument/2006/extended-properties',
    'xmlns:vt': 'http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes',
  },
    (doc.meta.sourceVersion ? tag('Company', {}, esc(doc.meta.sourceVersion)) : '') +
    tag('Pages', {}, String(doc.pages.length)) +
    tag('Application', {}, 'Pubshift'));
}

function contentTypesXml(media: MediaPart[], numbering: boolean): string {
  const byExtension = new Map(media.map((p) => [p.extension, p.contentType]));
  const defaults =
    tag('Default', { Extension: 'rels', ContentType: 'application/vnd.openxmlformats-package.relationships+xml' }) +
    tag('Default', { Extension: 'xml', ContentType: 'application/xml' }) +
    [...byExtension.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([extension, contentType]) => tag('Default', { Extension: extension, ContentType: contentType }))
      .join('');

  const wordml = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
  const overrides =
    tag('Override', { PartName: '/word/document.xml', ContentType: `${wordml}.document.main+xml` }) +
    tag('Override', { PartName: '/word/styles.xml', ContentType: `${wordml}.styles+xml` }) +
    (numbering ? tag('Override', { PartName: '/word/numbering.xml', ContentType: `${wordml}.numbering+xml` }) : '') +
    tag('Override', { PartName: '/docProps/core.xml', ContentType: 'application/vnd.openxmlformats-package.core-properties+xml' }) +
    tag('Override', { PartName: '/docProps/app.xml', ContentType: 'application/vnd.openxmlformats-officedocument.extended-properties+xml' });

  return XML_DECLARATION +
    tag('Types', { xmlns: 'http://schemas.openxmlformats.org/package/2006/content-types' }, defaults + overrides);
}

function packageRelsXml(): string {
  return XML_DECLARATION + tag('Relationships', { xmlns: RELS_NS },
    tag('Relationship', { Id: 'rId1', Type: `${OFFICE_REL}/officeDocument`, Target: 'word/document.xml' }) +
    tag('Relationship', { Id: 'rId2', Type: `${REL_TYPE}metadata/core-properties`, Target: 'docProps/core.xml' }) +
    tag('Relationship', { Id: 'rId3', Type: `${OFFICE_REL}/extended-properties`, Target: 'docProps/app.xml' }));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Builds a `.docx` from the document model.
 *
 * Layout mode is the default: see the file header for why, and
 * {@link DOCX_MODE_DESCRIPTIONS} for the sentence to show a user.
 */
export async function emitDOCX(doc: Doc, opts: EmitDOCXOptions = {}): Promise<Uint8Array> {
  const mode: DocxMode = opts.mode ?? 'layout';
  const warnings = new Warnings();
  const rels = new Relationships();
  const numbering = hasLists(doc);

  // Style and numbering relationships are allocated first so the ids stay stable
  // whatever pictures the document turns out to hold.
  rels.add(`${OFFICE_REL}/styles`, 'styles.xml');
  if (numbering) rels.add(`${OFFICE_REL}/numbering`, 'numbering.xml');

  const media = new Media(doc, rels, warnings);
  const ids = new DrawingIds();

  // Every page but the last ends with its own section break, carried by that page's last
  // paragraph; the last page's properties go in the body, which is where Word looks for
  // the final section.
  const body = doc.pages
    .map((page, index) => {
      const sectPr = index === doc.pages.length - 1 ? '' : sectionProperties(page, mode);
      const ctx: FlowContext = {
        media, warnings, ids, numbering, contentWidth: contentWidthFor(page, mode),
      };
      return mode === 'layout' ? layoutPage(page, ctx, warnings, sectPr) : flowPage(page, ctx, sectPr);
    })
    .join('');

  // A document with no pages at all still has to be a document Word can open.
  const lastPage = doc.pages[doc.pages.length - 1] ?? FALLBACK_PAGE;
  const bodyXml = (body === '' ? emptyParagraph() : body) + sectionProperties(lastPage, mode);

  const documentXml = XML_DECLARATION + tag('w:document', {
    'xmlns:w': NS.w,
    'xmlns:r': NS.r,
    'xmlns:wp': NS.wp,
    'xmlns:a': NS.a,
    'xmlns:pic': NS.pic,
    'xmlns:wps': NS.wps,
  }, tag('w:body', {}, bodyXml));

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypesXml(media.parts, numbering));
  zip.file('_rels/.rels', packageRelsXml());
  zip.file('docProps/core.xml', corePropertiesXml(doc));
  zip.file('docProps/app.xml', appPropertiesXml(doc));
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', stylesXml());
  if (numbering) zip.file('word/numbering.xml', numberingXml());
  zip.file('word/_rels/document.xml.rels', rels.render());
  for (const part of media.parts) {
    zip.file(`word/${part.path}`, part.base64, { base64: true });
  }

  warnings.drain(opts.onWarning);

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    // A `.docx` is read by a machine before a person sees it; the middle setting keeps
    // the file small without making conversion of a 200-page newsletter feel slow.
    compressionOptions: { level: 6 },
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}
