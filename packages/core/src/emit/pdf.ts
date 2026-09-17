/**
 * PDF emitter.
 *
 * PDF is the "exact but not editable" target: the file a user archives rather than the
 * one they keep working in. So this emitter optimises for exactness above everything
 * else. That is achievable here in a way it is not for DOCX, because the model and PDF
 * agree about what a page *is* — a fixed-size canvas of absolutely-positioned boxes.
 * There is nothing in the model that PDF cannot hold in the right place.
 *
 * Where a Publisher construct has no PDF primitive at all (arcs, tiled fills, the
 * character reliefs) the approximation is named as a constant at the top of this file,
 * in the same style as the SVG emitter, and — where the loss is visible to a reader —
 * reported through `doc.warnings` instead of being hidden.
 *
 * Drawing goes through raw content-stream operators (`page.pushOperators`) rather than
 * pdf-lib's `drawText`/`drawRectangle`/`drawSvgPath` helpers. The helpers re-derive their
 * own coordinate conventions and cannot express a text matrix, a clipping path, a shading
 * or a horizontal glyph squeeze, and this emitter needs all four.
 */

import {
  LineCapStyle,
  LineJoinStyle,
  PDFDict,
  PDFDocument,
  PDFFont,
  PDFName,
  PDFOperator,
  PDFOperatorNames,
  PDFPage,
  PDFRef,
  PDFString,
  StandardFonts,
  TextRenderingMode,
  appendBezierCurve,
  beginMarkedContent,
  beginText,
  closePath,
  endMarkedContent,
  concatTransformationMatrix,
  drawObject,
  endPath,
  endText,
  fill as fillPath,
  lineTo,
  moveTo,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  rotateDegrees,
  setCharacterSqueeze,
  setDashPattern,
  setFillingRgbColor,
  setFontAndSize,
  setGraphicsState,
  setLineCap,
  setLineJoin,
  setLineWidth,
  setStrokingRgbColor,
  setTextMatrix,
  setTextRenderingMode,
  setTextRise,
  setWordSpacing,
  showText,
  stroke as strokePath,
  translate,
} from 'pdf-lib';

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
  Shadow,
  Shape,
  ShapeStyle,
  Table,
  TableCell,
  TextBox,
  Warning,
  WarningCode,
} from '../model/types';
import { estimateTextWidth } from './svg';

// ---------------------------------------------------------------------------
// Named approximations
//
// Every number here is a place where we are guessing at something Publisher knew and
// the IR does not carry, or where PDF has no primitive for what the model describes.
// They are collected at the top so a fidelity regression can be traced to a specific
// guess instead of to a magic number buried in a function. The first block is shared
// with the SVG emitter on purpose: the two must lay text out identically.
// ---------------------------------------------------------------------------

/** Leading when a paragraph does not specify one. 1.2em is the CSS/PostScript default. */
const DEFAULT_LINE_HEIGHT = 1.2;

/** Font size assumed for a run with no size. 12pt is Publisher's default body size. */
const DEFAULT_FONT_SIZE = 12;

/** Font assumed for a run with no family. */
const DEFAULT_FONT_FAMILY = 'Times New Roman';

/**
 * Baseline position inside the em box, as a fraction of the font size. Real ascents run
 * 0.75–0.90em depending on family; 0.8 is the middle of that range and keeps text
 * visually centred in its line box for both serif and sans faces.
 */
const ASCENT_RATIO = 0.8;

/** Inset for table cell text. Publisher's default cell margin is 0.04in ~= 2.9pt. */
const CELL_PADDING = 2.9;

/**
 * Narrowest column worth breaking lines into, in ems of the box's own largest text.
 *
 * A column narrower than one em cannot hold a single character, so wrapping into it
 * produces one glyph per line, which is noise rather than a layout. Below this the box is
 * treated as unusable and the text is wrapped to the page instead, which keeps the words
 * present, readable, selectable and searchable — and the overflow is reported, because the
 * text will then run over whatever else is on the page.
 *
 * This is not hypothetical. `tdf78739-3.pub` in the corpus reports a 5.5pt-wide frame for
 * a text box holding 3,911 characters at 20pt; LibreOffice's own converter drops every one
 * of them, and so did this emitter until the fallback existed. Silently losing the text of
 * a page the model says has text is the exact failure the product exists to prevent.
 */
const MIN_COLUMN_EM = 1;

/** Margin kept at the page edge when text has to be wrapped to the page instead of a box. */
const PAGE_FALLBACK_MARGIN = 18;

/** Small caps are set at this fraction of the run size. Matches the SVG emitter. */
const SMALL_CAPS_RATIO = 0.8;

/** Bitmap pixels are mapped to points at this resolution (the Windows/GDI assumption). */
const PX_PER_INCH = 96;

/**
 * Underline and strike-through geometry, in ems below/above the baseline. The standard 14
 * AFM files do carry `UnderlinePosition`, but pdf-lib does not expose it, so these are the
 * conventional values: a rule just under the descender line, and a strike at half the
 * x-height.
 */
const UNDERLINE_OFFSET_EM = 0.11;
const UNDERLINE_THICKNESS_EM = 0.06;
const STRIKE_OFFSET_EM = 0.26;

/** Pen width for outlined text, as a fraction of the font size. */
const OUTLINE_STROKE_EM = 0.022;

/**
 * Publisher's emboss/engrave draws the glyph twice with a light or dark ghost behind it.
 * PDF has no such text effect, so we do exactly that: one offset copy, then the glyphs.
 */
const RELIEF_OFFSET_EM = 0.035;
const EMBOSS_GHOST = { r: 1, g: 1, b: 1 };
const ENGRAVE_GHOST = { r: 0, g: 0, b: 0 };

/** Publisher's per-character shadow, likewise drawn as one offset grey copy. */
const TEXT_SHADOW_OFFSET_EM = 0.07;
const TEXT_SHADOW_COLOR = { r: 0.5, g: 0.5, b: 0.5 };

/**
 * Cubic Bézier approximation of a circular arc. With the control-point distance set to
 * `4/3 * tan(theta/4) * r`, the curve touches the true arc at both ends and at the
 * midpoint; the largest radial error over a 90-degree span is about 2.7e-4 of the radius
 * (0.0002pt on a 1pt radius, 0.02pt on a 72pt one), which is far below anything a reader
 * or a rasteriser can see. Splitting at 90 degrees keeps every segment inside that bound.
 */
const MAX_ARC_SEGMENT_DEG = 90;

/** An ellipse is four such quarter-arcs, so it carries the same 2.7e-4 radial error. */
const ELLIPSE_KAPPA = (4 / 3) * Math.tan(Math.PI / 8);

/**
 * PDF function dictionaries need strictly increasing bounds, but a gradient may legally
 * carry two stops at the same offset to make a hard colour edge. Duplicates are nudged
 * apart by this much, which is 1/10000 of the gradient's length.
 */
const STOP_EPSILON = 1e-4;

/**
 * A `repeat` image fill is drawn as real tiles inside a clip rather than as a PDF tiling
 * pattern, because pattern space is anchored to the page and would not follow a rotated
 * element. A tile smaller than a fraction of a point would therefore produce an unbounded
 * content stream, so past this many tiles the fill is stretched instead and the loss is
 * reported.
 */
const MAX_IMAGE_TILES = 4096;

/** Drawn in place of a character the embedded font cannot encode. */
const SUBSTITUTE_CHARACTER = '?';

/**
 * Size of the single blank page given to a document with no pages at all. US Letter,
 * matching the model builder's own fallback for a page whose size the file did not carry.
 */
const FALLBACK_PAGE: [number, number] = [612, 792];

/** Placeholder styling for an image we cannot embed. Matches the SVG emitter's. */
const PLACEHOLDER_FILL = { r: 0.949, g: 0.949, b: 0.949 };
const PLACEHOLDER_STROKE = { r: 0.69, g: 0.69, b: 0.69 };
const PLACEHOLDER_TEXT = { r: 0.44, g: 0.44, b: 0.44 };
const PLACEHOLDER_DASH = [4, 3];

/** Raster formats PDF can carry directly. Everything else becomes a placeholder. */
const PNG_MIMES = new Set(['image/png']);
const JPEG_MIMES = new Set(['image/jpeg', 'image/jpg']);
const BMP_MIMES = new Set(['image/bmp', 'image/x-bmp', 'image/x-ms-bmp']);
const METAFILE_MIMES = new Set([
  'image/wmf', 'image/x-wmf', 'image/emf', 'image/x-emf',
  'application/x-msmetafile', 'windows/metafile',
]);

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

interface RGB { r: number; g: number; b: number }

const BLACK: RGB = { r: 0, g: 0, b: 0 };
const WHITE: RGB = { r: 1, g: 1, b: 1 };

/** `#rgb` / `#rrggbb` to PDF's 0..1 components. Returns undefined for anything else. */
function parseColor(value: string | undefined): RGB | undefined {
  if (!value) return undefined;
  const hex = value.trim().replace(/^#/, '');
  const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return undefined;
  const int = parseInt(full, 16);
  return { r: ((int >> 16) & 0xff) / 255, g: ((int >> 8) & 0xff) / 255, b: (int & 0xff) / 255 };
}

// ---------------------------------------------------------------------------
// The coordinate flip
// ---------------------------------------------------------------------------

interface Box { x: number; y: number; width: number; height: number }

/**
 * The one place the model's coordinate system becomes PDF's.
 *
 * The model puts the origin at the page's TOP-left with y growing downwards — Publisher's
 * convention, and SVG's. PDF puts it at the BOTTOM-left with y growing upwards. Getting
 * that flip wrong in one branch and right in another is the classic way a PDF emitter
 * produces a page that is subtly, irreproducibly wrong, so it happens here and only here:
 * every y this file hands to a PDF operator has passed through `PageSpace.y` exactly once,
 * and no other function in this file does arithmetic on a y coordinate in order to convert
 * it. x and all lengths are identical in both systems and are never touched.
 *
 * Two consequences fall out of the flip and are handled by the two helpers below:
 *
 *  - A PDF rectangle is given by its bottom-left corner; a model box is given by its
 *    top-left. `rect` converts one to the other.
 *  - A rotation the reader sees as clockwise (what the model means by a positive
 *    `rotation`) is an anticlockwise rotation in PDF's y-up space. `spin` negates it.
 */
class PageSpace {
  constructor(readonly width: number, readonly height: number) {}

  /** The PDF y of a model y. */
  y(modelY: number): number {
    return this.height - modelY;
  }

  /** `[x, y, width, height]` for `rectangle()`, anchored where PDF expects it. */
  rect(box: Box): [number, number, number, number] {
    return [box.x, this.y(box.y + box.height), box.width, box.height];
  }

  /** A model rotation in degrees, as PDF's `cm` rotation wants it. */
  spin(degrees: number): number {
    return -degrees;
  }
}

function boxOf(el: { x: number; y: number; width: number; height: number }): Box {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

// ---------------------------------------------------------------------------
// Warnings
//
// `emitPDF` returns bytes, so the only channel back to the user is `doc.warnings` — the
// same list the model builder fills and the app already displays. Warnings are aggregated
// by (code, message, page) with a count, matching the builder's convention, and merging
// skips anything already present so emitting the same Doc twice does not double them.
// ---------------------------------------------------------------------------

class Warnings {
  private readonly byKey = new Map<string, Warning>();

  add(code: WarningCode, message: string, page?: number): void {
    const key = `${code}|${message}|${page ?? ''}`;
    const prev = this.byKey.get(key);
    if (prev) {
      prev.count = (prev.count ?? 1) + 1;
      return;
    }
    this.byKey.set(key, { code, message, count: 1, ...(page === undefined ? {} : { page }) });
  }

  mergeInto(doc: Doc): void {
    const seen = new Set(doc.warnings.map((w) => `${w.code}|${w.message}|${w.page ?? ''}`));
    for (const [key, warning] of this.byKey) {
      if (!seen.has(key)) doc.warnings.push(warning);
    }
  }
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

type StdFamily = 'Times' | 'Helvetica' | 'Courier';

/**
 * Families that *are* one of the standard 14, so mapping them loses nothing and no
 * warning is due. The metric clones are included because they are, by construction,
 * the same advance widths: Liberation/Tinos/Arimo/Cousine were commissioned as drop-in
 * replacements for Times New Roman, Arial and Courier New.
 *
 * Symbol and ZapfDingbats are *not* here, although they are two of the standard 14. Their
 * built-in encodings map bytes to Greek letters and dingbats, so the Unicode the model
 * carries does not reach them: a run of ordinary text tagged "Symbol" — which is what
 * Publisher writes for a symbol bullet — would encode to nothing at all and come out as a
 * row of question marks. Substituting a text face shows the letters that are in the file
 * and reports the substitution, which is strictly more useful.
 */
const EXACT_FAMILY: Record<string, StdFamily> = {
  'times new roman': 'Times',
  'timesnewroman': 'Times',
  'times new roman ps': 'Times',
  'times roman': 'Times',
  'times': 'Times',
  'tinos': 'Times',
  'liberation serif': 'Times',
  'nimbus roman': 'Times',

  'arial': 'Helvetica',
  'arialmt': 'Helvetica',
  'arial mt': 'Helvetica',
  'helvetica': 'Helvetica',
  'arimo': 'Helvetica',
  'liberation sans': 'Helvetica',
  'nimbus sans': 'Helvetica',

  'courier new': 'Courier',
  'couriernew': 'Courier',
  'courier': 'Courier',
  'cousine': 'Courier',
  'liberation mono': 'Courier',
  'nimbus mono': 'Courier',
};

/**
 * Classification for every other family, so the substitute at least has the right
 * proportions. Kept deliberately identical to the SVG emitter's classifier — if the two
 * disagreed about whether Garamond is a serif they would wrap the same paragraph
 * differently.
 */
const MONO_HINTS = ['courier', 'mono', 'consolas', 'menlo', 'lucida console'];
const SERIF_HINTS = [
  'times', 'serif', 'georgia', 'garamond', 'palatino', 'book antiqua', 'cambria',
  'century schoolbook', 'baskerville', 'bookman', 'minion', 'constantia',
];

function substituteFamily(family: string): StdFamily {
  const f = family.toLowerCase();
  if (MONO_HINTS.some((h) => f.includes(h))) return 'Courier';
  // "sans serif" contains "serif", so the sans test has to win.
  if (f.includes('sans')) return 'Helvetica';
  if (SERIF_HINTS.some((h) => f.includes(h))) return 'Times';
  return 'Helvetica';
}

const VARIANTS: Record<StdFamily, Record<'r' | 'b' | 'i' | 'bi', StandardFonts>> = {
  Times: {
    r: StandardFonts.TimesRoman,
    b: StandardFonts.TimesRomanBold,
    i: StandardFonts.TimesRomanItalic,
    bi: StandardFonts.TimesRomanBoldItalic,
  },
  Helvetica: {
    r: StandardFonts.Helvetica,
    b: StandardFonts.HelveticaBold,
    i: StandardFonts.HelveticaOblique,
    bi: StandardFonts.HelveticaBoldOblique,
  },
  Courier: {
    r: StandardFonts.Courier,
    b: StandardFonts.CourierBold,
    i: StandardFonts.CourierOblique,
    bi: StandardFonts.CourierBoldOblique,
  },
};

function variantKey(bold: boolean, italic: boolean): 'r' | 'b' | 'i' | 'bi' {
  return bold && italic ? 'bi' : bold ? 'b' : italic ? 'i' : 'r';
}

/**
 * One embedded standard-14 face, plus the two things this emitter asks of it constantly:
 * can it encode a character, and how wide is that character.
 */
class ResolvedFont {
  /** Advance per code point, in ems. `null` marks a code point the font cannot encode. */
  private readonly advances = new Map<number, number | null>();

  constructor(
    readonly font: PDFFont,
    /** True when the model asked for a family that is not this one. */
    readonly substituted: boolean,
    private readonly encodable: Set<number>,
  ) {}

  canEncode(text: string): boolean {
    for (const ch of text) if (!this.encodable.has(ch.codePointAt(0) as number)) return false;
    return true;
  }

  canEncodeChar(ch: string): boolean {
    return this.encodable.has(ch.codePointAt(0) as number);
  }

  /**
   * Advance of one character in ems, or `null` if it is outside the encoding.
   *
   * Deliberately per-character rather than `widthOfTextAtSize(wholeString)`: pdf-lib's
   * string measurement adds the AFM kerning pairs, but we show text with `Tj`, which does
   * not kern. Summing single characters gives the advance the viewer will actually
   * produce, which is the number line breaking and underlining must agree with.
   */
  advanceEm(ch: string): number | null {
    const cp = ch.codePointAt(0) as number;
    const cached = this.advances.get(cp);
    if (cached !== undefined) return cached;
    const value = this.encodable.has(cp) ? this.font.widthOfTextAtSize(ch, 1) : null;
    this.advances.set(cp, value);
    return value;
  }
}

/** Document-wide cache of embedded faces, keyed by the standard-14 name we settled on. */
class FontBook {
  private readonly byName = new Map<string, PDFFont>();
  private readonly resolved = new Map<string, ResolvedFont>();

  constructor(private readonly pdf: PDFDocument) {}

  /**
   * The face this run will be drawn in.
   *
   * Real font embedding of the *original* face is impossible here and would contradict
   * the product: the converter runs in a browser tab with no access to the user's font
   * files, and shipping licensed Microsoft faces is not ours to do. So we embed the
   * standard 14 — genuinely embedded, genuinely measurable — and are explicit about it.
   */
  for(run: Run): ResolvedFont {
    const family = run.font ?? DEFAULT_FONT_FAMILY;
    const exact = EXACT_FAMILY[family.trim().toLowerCase()];
    const std = exact ?? substituteFamily(family);
    const name = VARIANTS[std][variantKey(run.bold === true, run.italic === true)];
    const key = `${name}|${exact === undefined ? 'sub' : 'exact'}`;

    const cached = this.resolved.get(key);
    if (cached) return cached;

    let font = this.byName.get(name);
    if (!font) {
      font = this.pdf.embedStandardFont(name);
      this.byName.set(name, font);
    }
    const resolved = new ResolvedFont(font, exact === undefined, new Set(font.getCharacterSet()));
    this.resolved.set(key, resolved);
    return resolved;
  }
}

// ---------------------------------------------------------------------------
// Emitter context
// ---------------------------------------------------------------------------

interface Ctx {
  readonly pdf: PDFDocument;
  readonly page: PDFPage;
  readonly space: PageSpace;
  readonly doc: Doc;
  readonly fonts: FontBook;
  readonly images: Map<string, EmbeddedImage | undefined>;
  readonly warn: Warnings;
  /** 1-based, to match `Warning.page` as the model builder writes it. */
  readonly pageNumber: number;
  readonly ops: PDFOperator[];
  readonly gsNames: Map<string, PDFName>;
  readonly xobjNames: Map<PDFRef, PDFName>;
  readonly shadingNames: Map<string, PDFName>;
  readonly fontNames: Map<PDFRef, PDFName>;
}

function emit(ctx: Ctx, ...ops: PDFOperator[]): void {
  for (const op of ops) ctx.ops.push(op);
}

/**
 * Marks everything `body` draws as a PDF *artifact*: decoration rather than content.
 *
 * Three things on a page are drawn but are not part of the document's text — the white
 * backdrop, the ghost copies that make up a shadow or an embossed letter, and the label on
 * a picture we could not embed. Tagging them means a reader that extracts or reads out the
 * text sees each string once and does not read "Sale!" three times because the word had a
 * shadow. It costs two operators.
 */
function asArtifact(ctx: Ctx, body: () => void): void {
  emit(ctx, beginMarkedContent(PDFName.of('Artifact')));
  body();
  emit(ctx, endMarkedContent());
}

/**
 * Serialises the page's operators into a single compressed content stream.
 *
 * pdf-lib's own `pushOperators` writes the stream uncompressed, which triples the size of
 * a text-heavy page — 466KB for a four-page newsletter in the corpus, against 60KB
 * deflated. For a file whose whole purpose is to be kept, that is worth ten lines.
 */
function flush(ctx: Ctx): void {
  const parts: string[] = [];
  for (const op of ctx.ops) parts.push(op.toString());
  ctx.ops.length = 0;
  // Resources have to exist before Contents is replaced: pdf-lib builds them lazily and
  // normalising afterwards would wrap the stream back into an array.
  ctx.page.node.normalizedEntries();
  const stream = ctx.pdf.context.flateStream(parts.join('\n'));
  ctx.page.node.set(PDFName.of('Contents'), ctx.pdf.context.register(stream));
}

/** A graphics state holding constant fill/stroke alpha, deduplicated per page. */
function alphaState(ctx: Ctx, alpha: number): PDFName {
  const key = alpha.toFixed(4);
  const existing = ctx.gsNames.get(key);
  if (existing) return existing;
  const name = ctx.page.node.newExtGState(
    'GS',
    ctx.pdf.context.obj({ Type: 'ExtGState', ca: alpha, CA: alpha }),
  );
  ctx.gsNames.set(key, name);
  return name;
}

function xobjectName(ctx: Ctx, ref: PDFRef): PDFName {
  const existing = ctx.xobjNames.get(ref);
  if (existing) return existing;
  const name = ctx.page.node.newXObject('Im', ref);
  ctx.xobjNames.set(ref, name);
  return name;
}

/**
 * Registers a shading in the page's `/Shading` resource dictionary. pdf-lib normalises
 * `/Font`, `/XObject` and `/ExtGState` for us but knows nothing about shadings, so this
 * creates the sub-dictionary on first use.
 */
function shadingName(ctx: Ctx, key: string, make: () => PDFDict): PDFName {
  const existing = ctx.shadingNames.get(key);
  if (existing) return existing;
  const resources = ctx.page.node.normalizedEntries().Resources;
  let dict = resources.lookup(PDFName.of('Shading')) as PDFDict | undefined;
  if (!(dict instanceof PDFDict)) {
    dict = ctx.pdf.context.obj({});
    resources.set(PDFName.of('Shading'), dict);
  }
  const name = PDFName.of(`Sh${ctx.shadingNames.size}`);
  dict.set(name, ctx.pdf.context.register(make()));
  ctx.shadingNames.set(key, name);
  return name;
}

// ---------------------------------------------------------------------------
// Text: shaping, measuring, breaking
// ---------------------------------------------------------------------------

/** One stretch of text drawn with one face at one size. */
interface Chunk {
  text: string;
  size: number;
  font: ResolvedFont;
}

/**
 * Publisher leaves control characters in its text — 0x0B/0x0C/0x1E from its own layout
 * codes, and 0x98 turns up fifteen times in the corpus. None of them are printable and
 * none are in WinAnsi. The SVG emitter strips the C0 set for the same reason (they are
 * illegal in XML); we strip C0 and C1 both, because here the failure mode is an exception
 * from the encoder halfway through a document rather than an unparseable file.
 *
 * Tabs survive as a single space. Publisher's tab stops are not in the IR, so neither
 * emitter can honour them; a space is what a browser renders the SVG emitter's literal
 * tab as, so the two agree.
 */
function sanitize(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    if (ch === '\t') { out += ' '; continue; }
    if (ch === '\n' || ch === '\r') { out += ch; continue; }
    if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) continue;
    out += ch;
  }
  return out;
}

/**
 * Splits `text` into the pieces that will actually be drawn, applying the run's casing.
 *
 * Small caps get real treatment rather than a font flag: none of the standard 14 has
 * small-cap glyphs, so lowercase is set as capitals at {@link SMALL_CAPS_RATIO} of the
 * size — which is both what a renderer synthesises for the SVG emitter's
 * `font-variant: small-caps` and exactly what that emitter measures.
 */
function chunksOf(text: string, run: Run, fonts: FontBook): Chunk[] {
  const font = fonts.for(run);
  const size = run.size ?? DEFAULT_FONT_SIZE;
  const shaped = run.allCaps ? text.toUpperCase() : text;
  if (!run.smallCaps) return shaped === '' ? [] : [{ text: shaped, size, font }];

  const out: Chunk[] = [];
  let buffer = '';
  let small = false;
  const flushBuffer = () => {
    if (buffer !== '') out.push({ text: buffer, size: small ? size * SMALL_CAPS_RATIO : size, font });
    buffer = '';
  };
  for (const ch of shaped) {
    const upper = ch.toUpperCase();
    const isSmall = upper !== ch;
    if (isSmall !== small && buffer !== '') flushBuffer();
    small = isSmall;
    buffer += isSmall ? upper : ch;
  }
  flushBuffer();
  return out;
}

/**
 * Advance of a chunk in points.
 *
 * Unlike the SVG emitter — which never loads a font and therefore has to estimate from a
 * table of Helvetica advances — pdf-lib carries the real AFM metrics of the face we embed,
 * so this measures the exact font that will be drawn. That is strictly better and it is
 * the path taken for all ordinary text.
 *
 * `estimateTextWidth` is the fallback for the one case the real metrics cannot answer: a
 * character outside the font's encoding, which has no advance because it has no glyph.
 * Those characters are substituted at draw time and warned about; the estimate keeps line
 * breaking sane in the meantime, and keeps this emitter agreeing with the SVG one about a
 * string neither of them can set properly.
 */
function advanceOfChunk(chunk: Chunk, run: Run): number {
  let em = 0;
  for (const ch of chunk.text) {
    const a = chunk.font.advanceEm(ch);
    if (a === null) return estimateTextWidth(chunk.text, { ...run, size: chunk.size });
    em += a;
  }
  return em * chunk.size;
}

/** Horizontal glyph scaling as a multiplier. 80 in the model means 80% of normal width. */
function scaleOf(run: Run): number {
  const scale = run.textScale;
  if (scale === undefined || !Number.isFinite(scale) || scale <= 0) return 1;
  return scale / 100;
}

/**
 * Advance of `text` when set in `run`, in points — the width this emitter will actually
 * draw, `textScale` included. (The SVG emitter drops `textScale`; PDF can express it as a
 * horizontal squeeze, so here it is honoured and therefore has to be measured.)
 */
function measure(text: string, run: Run, fonts: FontBook): number {
  let total = 0;
  for (const chunk of chunksOf(text, run, fonts)) total += advanceOfChunk(chunk, run);
  return total * scaleOf(run);
}

interface Seg { text: string; run: Run }

interface Line {
  segs: Seg[];
  /** Advance of the line, points. */
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
  spaceBefore: number;
  spaceAfter: number;
}

const BULLET = '• ';

/**
 * Tokenises a paragraph into words, runs of spaces and hard breaks.
 *
 * Structurally identical to the SVG emitter's tokeniser, including the `\r` case that
 * survives from Publisher 97 files, because the two must break lines in the same places.
 */
function tokenize(para: Paragraph): Array<{ text: string; run: Run; kind: 'word' | 'space' | 'break' }> {
  const out: Array<{ text: string; run: Run; kind: 'word' | 'space' | 'break' }> = [];
  for (const run of para.runs) {
    for (const piece of sanitize(run.text).split(/(\r\n|[\r\n])/)) {
      if (piece === '') continue;
      if (/^(\r\n|[\r\n])$/.test(piece)) {
        out.push({ text: '', run, kind: 'break' });
        continue;
      }
      for (const t of piece.split(/([ \u00a0]+)/)) {
        if (t === '') continue;
        out.push({ text: t, run, kind: /^[ \u00a0]+$/.test(t) ? 'space' : 'word' });
      }
    }
  }
  return out;
}

/** Greedy line breaking of one paragraph into the span [left, right]. */
function layoutParagraph(para: Paragraph, left: number, right: number, fonts: FontBook): Line[] {
  const align = para.align ?? 'left';
  const indent = para.textIndent ?? 0;
  const bodyLeft = left + (para.marginLeft ?? 0);
  const bodyRight = right - (para.marginRight ?? 0);
  const lines: Line[] = [];

  let segs: Seg[] = [];
  let width = 0;
  let size = 0;
  let pendingSpace: Seg | undefined;
  let pendingSpaceWidth = 0;
  let first = true;

  const lineLeft = () => bodyLeft + (first ? indent : 0);
  const avail = () => Math.max(1, bodyRight - lineLeft());

  const flushLine = (hard: boolean) => {
    lines.push({
      segs,
      width,
      size: size || DEFAULT_FONT_SIZE,
      height: (size || DEFAULT_FONT_SIZE) * (para.lineHeight ?? DEFAULT_LINE_HEIGHT),
      left: lineLeft(),
      right: bodyRight,
      align,
      justify: align === 'justify' && !hard,
      spaceBefore: 0,
      spaceAfter: 0,
    });
    segs = [];
    width = 0;
    size = 0;
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
      flushLine(true);
      continue;
    }
    if (tok.kind === 'space') {
      if (segs.length === 0) continue; // spaces never open a line
      pendingSpace = { text: tok.text, run: tok.run };
      pendingSpaceWidth = measure(tok.text, tok.run, fonts);
      continue;
    }
    const w = measure(tok.text, tok.run, fonts);
    if (segs.length > 0 && width + pendingSpaceWidth + w > avail()) {
      flushLine(false); // the pending space is dropped with the break, as it should be
      push({ text: tok.text, run: tok.run }, w);
      continue;
    }
    if (pendingSpace) {
      push(pendingSpace, pendingSpaceWidth);
      pendingSpace = undefined;
      pendingSpaceWidth = 0;
    }
    push({ text: tok.text, run: tok.run }, w);
  }
  if (segs.length > 0 || lines.length === 0) flushLine(true);

  const firstLine = lines[0];
  const lastLine = lines[lines.length - 1];
  if (firstLine) firstLine.spaceBefore = para.marginTop ?? 0;
  if (lastLine) lastLine.spaceAfter = para.marginBottom ?? 0;
  return lines;
}

/** A line with its final position on the page, in model coordinates. */
interface PlacedLine {
  line: Line;
  /** x of the first glyph. */
  x: number;
  /** Baseline, model space. */
  baseline: number;
  /** Extra advance added to every space character, for a justified line. */
  wordSpacing: number;
}

function countSpaces(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === ' ') n++;
  return n;
}

/**
 * The largest type in a set of paragraphs — the scale the box has to accommodate — or
 * undefined when there is no text in them at all.
 */
function largestFontSize(paragraphs: Paragraph[]): number | undefined {
  let biggest: number | undefined;
  for (const para of paragraphs) {
    for (const run of para.runs) {
      if (run.text === '') continue;
      biggest = Math.max(biggest ?? 0, run.size ?? DEFAULT_FONT_SIZE);
    }
  }
  return biggest;
}

/**
 * Lays paragraphs out inside a content rectangle and returns the positioned lines.
 *
 * Column packing, vertical alignment and the decision to let text overflow rather than
 * drop it are all the SVG emitter's, deliberately: Publisher overflows too, and silently
 * losing content is worse than showing too much of it.
 */
function placeParagraphs(
  paragraphs: Paragraph[],
  content: Box,
  verticalAlign: 'top' | 'middle' | 'bottom',
  columns: { count: number; gap: number } | undefined,
  ctx: Ctx,
): PlacedLine[] {
  const count = Math.max(1, Math.floor(columns?.count ?? 1));
  const gap = count > 1 ? (columns?.gap ?? 0) : 0;
  const measured = (content.width - gap * (count - 1)) / count;

  // A box too small to break lines into is wrapped to the page rather than dropped. See
  // MIN_COLUMN_EM for why, and for the corpus file that forces the question. An empty box
  // has nothing to lose, so a degenerate one is not worth telling the user about.
  const biggest = largestFontSize(paragraphs);
  const overflowing = biggest !== undefined && measured < biggest * MIN_COLUMN_EM;
  const colWidth = overflowing
    ? Math.max(biggest, ctx.space.width - content.x - PAGE_FALLBACK_MARGIN)
    : measured;
  if (!overflowing && measured <= 0) return [];
  if (overflowing) {
    ctx.warn.add(
      'OVERLAP_MAY_REFLOW',
      'A text box in this file is far too small for the words it holds — Publisher was ' +
      'shrinking or overflowing it. The text is all here and can be selected and searched, ' +
      'but it was laid out across the page instead of inside its box, so it runs over ' +
      'whatever else is there.',
      ctx.pageNumber,
    );
  }

  const lines: Line[] = [];
  for (const para of paragraphs) lines.push(...layoutParagraph(para, 0, colWidth, ctx.fonts));

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

  const out: PlacedLine[] = [];
  for (let c = 0; c < count; c++) {
    const colLines = perColumn[c] as Line[];
    if (colLines.length === 0) continue;
    const blockHeight = colLines.reduce((s, l) => s + l.spaceBefore + l.height + l.spaceAfter, 0);
    const slack = content.height - blockHeight;
    const offset =
      verticalAlign === 'middle' ? Math.max(0, slack / 2)
      : verticalAlign === 'bottom' ? Math.max(0, slack)
      : 0;
    const colLeft = content.x + c * (overflowing ? 0 : colWidth + gap);
    let cursor = content.y + offset;
    for (const line of colLines) {
      cursor += line.spaceBefore;
      if (line.segs.length > 0) {
        // Lines were measured against [0, colWidth]; shift them onto this column.
        const left = line.left + colLeft;
        const right = line.right + colLeft;
        const spaces = line.segs.reduce((s, seg) => s + countSpaces(seg.text), 0);
        // An overflowing box's own alignment is meaningless — it is not the box the text
        // is being set in any more — so those lines simply start at the left.
        const wordSpacing = line.justify && spaces > 0 && !overflowing ? (right - left - line.width) / spaces : 0;
        const x =
          overflowing ? left
          : line.align === 'center' ? (left + right) / 2 - line.width / 2
          : line.align === 'right' ? right - line.width
          : left;
        out.push({
          line: { ...line, left, right },
          x,
          baseline: cursor + line.size * ASCENT_RATIO,
          wordSpacing: Math.max(0, wordSpacing),
        });
      }
      cursor += line.height + line.spaceAfter;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Text: drawing
// ---------------------------------------------------------------------------

/** Replaces characters the face cannot encode, so the encoder never throws mid-document. */
function encodable(text: string, font: ResolvedFont, ctx: Ctx): string {
  if (font.canEncode(text)) return text;
  const replacement = font.canEncodeChar(SUBSTITUTE_CHARACTER) ? SUBSTITUTE_CHARACTER : '';
  let out = '';
  let lost = 0;
  for (const ch of text) {
    if (font.canEncodeChar(ch)) out += ch;
    else { out += replacement; lost++; }
  }
  if (lost > 0) {
    ctx.warn.add(
      'FONT_NOT_EMBEDDED',
      'Some characters are outside the WinAnsi range the built-in PDF fonts can encode, ' +
      'so they were replaced with a question mark. The text is present but those ' +
      'characters are not.',
      ctx.pageNumber,
    );
  }
  return out;
}

interface TextPaint {
  /** Model-space offset applied to every glyph — used for shadow and relief passes. */
  dx: number;
  dy: number;
  /** Overrides every run colour. */
  color?: RGB;
  /** Suppress underline, strike, relief and per-character shadow on a ghost pass. */
  plain?: boolean;
}

const NORMAL_TEXT: TextPaint = { dx: 0, dy: 0 };

function drawPlacedLines(ctx: Ctx, placed: PlacedLine[], paint: TextPaint): void {
  for (const line of placed) drawLine(ctx, line, paint);
}

function drawLine(ctx: Ctx, placed: PlacedLine, paint: TextPaint): void {
  const { line } = placed;
  const baseline = placed.baseline + paint.dy;
  let penX = placed.x + paint.dx;

  for (const seg of line.segs) {
    const run = seg.run;
    const scale = scaleOf(run);
    const size = run.size ?? DEFAULT_FONT_SIZE;
    const rise = run.baselineShift ? (run.baselineShift / 100) * size : 0;
    const color = paint.color ?? parseColor(run.color) ?? BLACK;
    const chunks = chunksOf(seg.text, run, ctx.fonts);
    if (chunks.length === 0) continue;

    // Substitute once, here, rather than inside each pass: a run drawn twice for a relief
    // or a shadow would otherwise be reported as two separate losses.
    const drawable = chunks
      .map((chunk) => ({ ...chunk, text: encodable(chunk.text, chunk.font, ctx) }))
      .filter((chunk) => chunk.text !== '');

    const segStart = penX;

    // Publisher's emboss/engrave/shadow are drawn as one offset ghost behind the glyphs.
    if (!paint.plain && (run.relief || run.textShadow)) {
      const ghost =
        run.relief === 'embossed' ? EMBOSS_GHOST
        : run.relief === 'engraved' ? ENGRAVE_GHOST
        : TEXT_SHADOW_COLOR;
      const step = size * (run.relief ? RELIEF_OFFSET_EM : TEXT_SHADOW_OFFSET_EM);
      // Emboss lifts the highlight up-left; engrave and shadow fall down-right.
      const sign = run.relief === 'embossed' ? -1 : 1;
      asArtifact(ctx, () =>
        showChunks(ctx, drawable, run, segStart + step * sign, baseline + step * sign, {
          color: ghost, rise, scale, wordSpacing: placed.wordSpacing, outline: false,
        }),
      );
    }

    showChunks(ctx, drawable, run, segStart, baseline, {
      color, rise, scale, wordSpacing: placed.wordSpacing, outline: run.outline === true,
    });

    let advance = 0;
    for (const chunk of chunks) advance += advanceOfChunk(chunk, run);
    advance = advance * scale + placed.wordSpacing * countSpaces(seg.text);
    penX += advance;

    if (!paint.plain && (run.underline || run.strike)) {
      drawTextRules(ctx, run, segStart, penX, baseline + rise, color);
    }
    if (!paint.plain && run.link) {
      addLinkAnnotation(ctx, run.link, {
        x: segStart,
        y: baseline + rise - size * ASCENT_RATIO,
        width: Math.max(0, penX - segStart),
        height: size,
      });
    }
  }
}

interface ShowOptions {
  color: RGB;
  rise: number;
  scale: number;
  wordSpacing: number;
  outline: boolean;
}

/**
 * One `BT … ET` block, whose chunks must already be encodable in their own faces.
 *
 * The text matrix is set once and PDF advances the pen itself, from the widths in the
 * embedded font, rather than from the positions we computed. Our own measurements only
 * have to agree with those widths well enough to break and underline lines — and because
 * {@link ResolvedFont.advanceEm} reads the same AFM table and we never emit kerning, they
 * agree exactly rather than merely closely.
 */
function showChunks(
  ctx: Ctx,
  chunks: Chunk[],
  run: Run,
  x: number,
  baseline: number,
  opts: ShowOptions,
): void {
  emit(ctx, pushGraphicsState(), beginText());
  emit(ctx, setFillingRgbColor(opts.color.r, opts.color.g, opts.color.b));
  if (opts.outline) {
    emit(
      ctx,
      setTextRenderingMode(TextRenderingMode.Outline),
      setStrokingRgbColor(opts.color.r, opts.color.g, opts.color.b),
      setLineWidth((run.size ?? DEFAULT_FONT_SIZE) * OUTLINE_STROKE_EM),
    );
  }
  if (opts.scale !== 1) emit(ctx, setCharacterSqueeze(opts.scale * 100));
  if (opts.rise !== 0) emit(ctx, setTextRise(opts.rise));
  // PDF multiplies word spacing by the horizontal scale as well, so a squeezed run has to
  // divide it back out to add the same gap on the page as an unsqueezed one.
  if (opts.wordSpacing > 0) emit(ctx, setWordSpacing(opts.wordSpacing / opts.scale));
  emit(ctx, setTextMatrix(1, 0, 0, 1, x, ctx.space.y(baseline)));

  for (const chunk of chunks) {
    emit(
      ctx,
      setFontAndSize(fontResourceName(ctx, chunk.font.font), chunk.size),
      showText(chunk.font.font.encodeText(chunk.text)),
    );
  }
  emit(ctx, endText(), popGraphicsState());
}

function fontResourceName(ctx: Ctx, font: PDFFont): PDFName {
  const existing = ctx.fontNames.get(font.ref);
  if (existing) return existing;
  const name = ctx.page.node.newFontDictionary('F', font.ref);
  ctx.fontNames.set(font.ref, name);
  return name;
}

function drawTextRules(ctx: Ctx, run: Run, from: number, to: number, baseline: number, color: RGB): void {
  const size = run.size ?? DEFAULT_FONT_SIZE;
  const thickness = size * UNDERLINE_THICKNESS_EM;
  const rules: number[] = [];
  if (run.underline) rules.push(baseline + size * UNDERLINE_OFFSET_EM);
  if (run.strike) rules.push(baseline - size * STRIKE_OFFSET_EM);
  if (rules.length === 0 || to <= from) return;

  emit(ctx, pushGraphicsState(), setFillingRgbColor(color.r, color.g, color.b));
  for (const y of rules) {
    emit(ctx, rectangle(...ctx.space.rect({ x: from, y, width: to - from, height: thickness })), fillPath());
  }
  emit(ctx, popGraphicsState());
}

/**
 * A clickable link over the run's box. PDF hyperlinks are annotations rather than page
 * content, so they sit outside the content stream and outside any rotation applied to it —
 * a link on rotated text keeps its upright bounding box, which is what every PDF producer
 * does and what every viewer expects.
 */
function addLinkAnnotation(ctx: Ctx, uri: string, box: Box): void {
  if (box.width <= 0 || box.height <= 0) return;
  const [x, y, w, h] = ctx.space.rect(box);
  const annotation = ctx.pdf.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [x, y, x + w, y + h],
    // A visible annotation border would draw a box round every link, which Publisher does
    // not; the run's own underline is the only thing that should mark it.
    Border: [0, 0, 0],
    // `context.obj` turns a bare string into a PDF *name*; a URI has to be a string object.
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(uri) },
  });
  ctx.page.node.addAnnot(ctx.pdf.context.register(annotation));
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/**
 * Converts one SVG-style elliptical arc into cubic Béziers, in model space.
 *
 * The whole decomposition is done before the flip, in the y-down space the model's `A`
 * command is defined in, so the `largeArc`/`sweep` flags keep the meaning SVG gives them.
 * See {@link MAX_ARC_SEGMENT_DEG} for the error this costs.
 */
function arcToBeziers(
  from: Point,
  cmd: Extract<PathCommand, { op: 'A' }>,
): Array<{ x1: number; y1: number; x2: number; y2: number; x: number; y: number }> {
  const to = { x: cmd.x, y: cmd.y };
  let rx = Math.abs(cmd.rx);
  let ry = Math.abs(cmd.ry);
  // A zero radius, or a start that equals the end, degenerates to a straight line.
  if (rx === 0 || ry === 0 || (from.x === to.x && from.y === to.y)) {
    return [{ x1: from.x, y1: from.y, x2: to.x, y2: to.y, x: to.x, y: to.y }];
  }

  const phi = (cmd.rotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // F.6.5 of the SVG specification: endpoint parameters to centre parameters.
  const dx2 = (from.x - to.x) / 2;
  const dy2 = (from.y - to.y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // F.6.6: grow radii that are too small to join the endpoints at all.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const denom = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const numer = Math.max(0, rx * rx * ry * ry - denom);
  const coef = (cmd.largeArc === cmd.sweep ? -1 : 1) * Math.sqrt(denom === 0 ? 0 : numer / denom);
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (from.x + to.x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (from.y + to.y) / 2;

  const angleOf = (ux: number, uy: number) => Math.atan2(uy, ux);
  const theta1 = angleOf((x1p - cxp) / rx, (y1p - cyp) / ry);
  const theta2 = angleOf((-x1p - cxp) / rx, (-y1p - cyp) / ry);
  let delta = theta2 - theta1;
  if (!cmd.sweep && delta > 0) delta -= 2 * Math.PI;
  if (cmd.sweep && delta < 0) delta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / ((MAX_ARC_SEGMENT_DEG * Math.PI) / 180)));
  const step = delta / segments;
  // Control-point distance for a Bézier that osculates the arc at both ends.
  const alpha = (4 / 3) * Math.tan(step / 4);

  const point = (theta: number) => ({
    x: cx + rx * Math.cos(theta) * cosPhi - ry * Math.sin(theta) * sinPhi,
    y: cy + rx * Math.cos(theta) * sinPhi + ry * Math.sin(theta) * cosPhi,
  });
  const derivative = (theta: number) => ({
    x: -rx * Math.sin(theta) * cosPhi - ry * Math.cos(theta) * sinPhi,
    y: -rx * Math.sin(theta) * sinPhi + ry * Math.cos(theta) * cosPhi,
  });

  const out: Array<{ x1: number; y1: number; x2: number; y2: number; x: number; y: number }> = [];
  for (let i = 0; i < segments; i++) {
    const a = theta1 + i * step;
    const b = a + step;
    const pa = point(a);
    const pb = point(b);
    const da = derivative(a);
    const db = derivative(b);
    out.push({
      x1: pa.x + alpha * da.x,
      y1: pa.y + alpha * da.y,
      x2: pb.x - alpha * db.x,
      y2: pb.y - alpha * db.y,
      x: pb.x,
      y: pb.y,
    });
  }
  return out;
}

/**
 * Emits the path construction operators for a geometry, in model coordinates.
 *
 * Every vertex goes through `space.y` here and nowhere else. `offsetX`/`offsetY` shift the
 * whole path in model space, which is how the drop-shadow pass reuses the same outline.
 */
function buildPath(ctx: Ctx, geometry: Geometry, box: Box, offsetX = 0, offsetY = 0): void {
  const s = ctx.space;
  const px = (x: number) => x + offsetX;
  const py = (y: number) => s.y(y + offsetY);

  switch (geometry.type) {
    case 'rect': {
      const shifted = { ...box, x: box.x + offsetX, y: box.y + offsetY };
      const rx = Math.min(Math.abs(geometry.rx ?? geometry.ry ?? 0), box.width / 2);
      const ry = Math.min(Math.abs(geometry.ry ?? geometry.rx ?? 0), box.height / 2);
      if (rx <= 0 || ry <= 0) {
        emit(ctx, rectangle(...s.rect(shifted)));
        return;
      }
      // Rounded corners: four quarter-ellipses joined by four straight edges.
      const k = ELLIPSE_KAPPA;
      const l = shifted.x;
      const r = shifted.x + shifted.width;
      const t = shifted.y;
      const b = shifted.y + shifted.height;
      emit(
        ctx,
        moveTo(l + rx, s.y(t)),
        lineTo(r - rx, s.y(t)),
        appendBezierCurve(r - rx + rx * k, s.y(t), r, s.y(t + ry - ry * k), r, s.y(t + ry)),
        lineTo(r, s.y(b - ry)),
        appendBezierCurve(r, s.y(b - ry + ry * k), r - rx + rx * k, s.y(b), r - rx, s.y(b)),
        lineTo(l + rx, s.y(b)),
        appendBezierCurve(l + rx - rx * k, s.y(b), l, s.y(b - ry + ry * k), l, s.y(b - ry)),
        lineTo(l, s.y(t + ry)),
        appendBezierCurve(l, s.y(t + ry - ry * k), l + rx - rx * k, s.y(t), l + rx, s.y(t)),
        closePath(),
      );
      return;
    }
    case 'ellipse': {
      const cx = box.x + box.width / 2 + offsetX;
      const cy = box.y + box.height / 2 + offsetY;
      const rx = Math.max(0, box.width / 2);
      const ry = Math.max(0, box.height / 2);
      const kx = rx * ELLIPSE_KAPPA;
      const ky = ry * ELLIPSE_KAPPA;
      emit(
        ctx,
        moveTo(cx + rx, s.y(cy)),
        appendBezierCurve(cx + rx, s.y(cy + ky), cx + kx, s.y(cy + ry), cx, s.y(cy + ry)),
        appendBezierCurve(cx - kx, s.y(cy + ry), cx - rx, s.y(cy + ky), cx - rx, s.y(cy)),
        appendBezierCurve(cx - rx, s.y(cy - ky), cx - kx, s.y(cy - ry), cx, s.y(cy - ry)),
        appendBezierCurve(cx + kx, s.y(cy - ry), cx + rx, s.y(cy - ky), cx + rx, s.y(cy)),
        closePath(),
      );
      return;
    }
    case 'polygon':
    case 'polyline': {
      const points = geometry.points;
      const head = points[0];
      if (!head) return;
      emit(ctx, moveTo(px(head.x), py(head.y)));
      for (let i = 1; i < points.length; i++) {
        const p = points[i] as Point;
        emit(ctx, lineTo(px(p.x), py(p.y)));
      }
      if (geometry.type === 'polygon') emit(ctx, closePath());
      return;
    }
    case 'path': {
      // The current point and the last subpath start, in MODEL space, so that `A` and `Z`
      // can be resolved with the same coordinates the model states them in.
      let cur: Point | undefined;
      let start: Point | undefined;
      for (const c of geometry.d) {
        switch (c.op) {
          case 'M':
            emit(ctx, moveTo(px(c.x), py(c.y)));
            cur = { x: c.x, y: c.y };
            start = cur;
            break;
          case 'L':
            if (!cur) { emit(ctx, moveTo(px(c.x), py(c.y))); start = { x: c.x, y: c.y }; }
            else emit(ctx, lineTo(px(c.x), py(c.y)));
            cur = { x: c.x, y: c.y };
            break;
          case 'C':
            if (!cur) { emit(ctx, moveTo(px(c.x1), py(c.y1))); start = { x: c.x1, y: c.y1 }; }
            emit(ctx, appendBezierCurve(px(c.x1), py(c.y1), px(c.x2), py(c.y2), px(c.x), py(c.y)));
            cur = { x: c.x, y: c.y };
            break;
          case 'Q': {
            // PDF has no quadratic segment; the exact cubic equivalent is the control
            // point pulled two thirds of the way from each endpoint. No error at all.
            const from = cur ?? { x: c.x1, y: c.y1 };
            if (!cur) { emit(ctx, moveTo(px(from.x), py(from.y))); start = from; }
            emit(
              ctx,
              appendBezierCurve(
                px(from.x + (2 / 3) * (c.x1 - from.x)), py(from.y + (2 / 3) * (c.y1 - from.y)),
                px(c.x + (2 / 3) * (c.x1 - c.x)), py(c.y + (2 / 3) * (c.y1 - c.y)),
                px(c.x), py(c.y),
              ),
            );
            cur = { x: c.x, y: c.y };
            break;
          }
          case 'A': {
            const from = cur ?? { x: c.x, y: c.y };
            if (!cur) { emit(ctx, moveTo(px(from.x), py(from.y))); start = from; }
            for (const b of arcToBeziers(from, c)) {
              emit(ctx, appendBezierCurve(px(b.x1), py(b.y1), px(b.x2), py(b.y2), px(b.x), py(b.y)));
            }
            cur = { x: c.x, y: c.y };
            break;
          }
          case 'Z':
            emit(ctx, closePath());
            if (start) cur = start;
            break;
        }
      }
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

interface EmbeddedImage {
  ref: PDFRef;
  /** Pixels. */
  width: number;
  height: number;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes a base64 payload without depending on a runtime's `atob` or `Buffer`. */
function decodeBase64(data: string, limit = Number.POSITIVE_INFINITY): Uint8Array {
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

function le16(b: Uint8Array, i: number): number {
  return (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
}

function le32(b: Uint8Array, i: number): number {
  return ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0;
}

/**
 * Decodes an uncompressed Windows BMP to 8-bit RGB rows.
 *
 * PDF has no BMP image filter and pdf-lib embeds only PNG and JPEG, so without this a
 * `.pub` that stores a bitmap — one does, in the corpus — would lose it, and the PDF would
 * be *less* faithful than the SVG, which browsers render natively. Covers the formats
 * Publisher actually writes: BI_RGB at 1, 4, 8, 24 and 32 bits per pixel. Returns
 * undefined for RLE-compressed or bitfield BMPs, which then become a placeholder.
 */
function decodeBMP(bytes: Uint8Array): { width: number; height: number; rgb: Uint8Array } | undefined {
  if (bytes.length < 54 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return undefined;
  const dataOffset = le32(bytes, 10);
  const headerSize = le32(bytes, 14);
  if (headerSize < 40) return undefined; // BITMAPCOREHEADER: not worth the code
  const width = le32(bytes, 18) | 0;
  const rawHeight = le32(bytes, 22) | 0;
  const bpp = le16(bytes, 28);
  const compression = le32(bytes, 30);
  if (compression !== 0) return undefined; // BI_RLE*/BI_BITFIELDS
  if (width <= 0 || rawHeight === 0) return undefined;
  if (![1, 4, 8, 24, 32].includes(bpp)) return undefined;

  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  if (width * height > 1 << 26) return undefined; // implausible; refuse rather than hang

  // Palette sits between the header and the pixel data for the indexed depths.
  const paletteEntries = bpp <= 8 ? (le32(bytes, 46) || 1 << bpp) : 0;
  const paletteStart = 14 + headerSize;
  const palette: RGB[] = [];
  for (let i = 0; i < paletteEntries; i++) {
    const p = paletteStart + i * 4;
    palette.push({ r: bytes[p + 2] ?? 0, g: bytes[p + 1] ?? 0, b: bytes[p] ?? 0 });
  }

  const rowSize = Math.floor((bpp * width + 31) / 32) * 4;
  if (dataOffset + rowSize * height > bytes.length) return undefined;

  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    // BMP rows run bottom-up unless the height is negative.
    const srcRow = dataOffset + (topDown ? y : height - 1 - y) * rowSize;
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      if (bpp === 24 || bpp === 32) {
        const p = srcRow + x * (bpp / 8);
        b = bytes[p] ?? 0;
        g = bytes[p + 1] ?? 0;
        r = bytes[p + 2] ?? 0;
      } else {
        const perByte = 8 / bpp;
        const byte = bytes[srcRow + Math.floor(x / perByte)] ?? 0;
        const shift = 8 - bpp - (x % perByte) * bpp;
        const index = (byte >> shift) & ((1 << bpp) - 1);
        const entry = palette[index] ?? { r: 0, g: 0, b: 0 };
        r = entry.r;
        g = entry.g;
        b = entry.b;
      }
      const o = (y * width + x) * 3;
      rgb[o] = r;
      rgb[o + 1] = g;
      rgb[o + 2] = b;
    }
  }
  return { width, height, rgb };
}

/**
 * Embeds every asset the document references, once, before any drawing starts.
 *
 * Done up front because pdf-lib's image embedding is asynchronous while the content
 * stream is built synchronously, and because an asset used on six pages should be one
 * object in the file, not six.
 */
async function embedImages(pdf: PDFDocument, doc: Doc, warn: Warnings): Promise<Map<string, EmbeddedImage | undefined>> {
  const out = new Map<string, EmbeddedImage | undefined>();
  for (const ref of referencedAssets(doc)) {
    const asset = doc.assets[ref];
    if (!asset) {
      out.set(ref, undefined);
      continue;
    }
    out.set(ref, await embedOne(pdf, asset, warn));
  }
  return out;
}

function referencedAssets(doc: Doc): Set<string> {
  const refs = new Set<string>();
  const visit = (el: Element): void => {
    if (el.kind === 'image') refs.add(el.assetRef);
    const fill = el.style?.fill;
    if (fill?.type === 'image') refs.add(fill.assetRef);
    if (el.kind === 'group') el.children.forEach(visit);
    if (el.kind === 'table') {
      for (const row of el.rows) {
        for (const cell of row.cells) {
          const cellFill = cell.style?.fill;
          if (cellFill?.type === 'image') refs.add(cellFill.assetRef);
        }
      }
    }
  };
  for (const page of doc.pages) page.elements.forEach(visit);
  return refs;
}

async function embedOne(pdf: PDFDocument, asset: Asset, warn: Warnings): Promise<EmbeddedImage | undefined> {
  const mime = asset.mime.toLowerCase();

  if (METAFILE_MIMES.has(mime)) {
    warn.add(
      'WMF_IMAGE_NOT_CONVERTED',
      'A picture is stored as a Windows metafile (WMF/EMF). PDF has no way to carry that ' +
      'format, and redrawing it would need a metafile interpreter, so its place on the ' +
      'page is marked but the picture itself is not there.',
    );
    return undefined;
  }

  try {
    if (PNG_MIMES.has(mime)) {
      const image = await pdf.embedPng(decodeBase64(asset.data));
      return { ref: image.ref, width: image.width, height: image.height };
    }
    if (JPEG_MIMES.has(mime)) {
      const image = await pdf.embedJpg(decodeBase64(asset.data));
      return { ref: image.ref, width: image.width, height: image.height };
    }
    if (BMP_MIMES.has(mime)) {
      const decoded = decodeBMP(decodeBase64(asset.data));
      if (!decoded) {
        warn.add(
          'WMF_IMAGE_NOT_CONVERTED',
          'A bitmap uses a compressed BMP variant we do not decode, so its place on the ' +
          'page is marked but the picture itself is not there.',
        );
        return undefined;
      }
      const ref = pdf.context.register(
        pdf.context.flateStream(decoded.rgb, {
          Type: 'XObject',
          Subtype: 'Image',
          Width: decoded.width,
          Height: decoded.height,
          ColorSpace: 'DeviceRGB',
          BitsPerComponent: 8,
        }),
      );
      return { ref, width: decoded.width, height: decoded.height };
    }
  } catch {
    // A malformed or exotic PNG/JPEG must not take the whole document down with it.
    warn.add(
      'WMF_IMAGE_NOT_CONVERTED',
      `A picture (${asset.mime}) could not be decoded, so its place on the page is marked ` +
      'but the picture itself is not there.',
    );
    return undefined;
  }

  warn.add(
    'WMF_IMAGE_NOT_CONVERTED',
    `A picture is stored as ${asset.mime}, which PDF cannot carry, so its place on the ` +
    'page is marked but the picture itself is not there.',
  );
  return undefined;
}

/** Intrinsic size in points, from the pixel size at the Windows/GDI screen resolution. */
function intrinsicSize(image: EmbeddedImage): { w: number; h: number } {
  return { w: (image.width * 72) / PX_PER_INCH, h: (image.height * 72) / PX_PER_INCH };
}

/** Draws an image XObject into an axis-aligned model-space box. */
function drawImageInBox(ctx: Ctx, image: EmbeddedImage, box: Box): void {
  if (box.width <= 0 || box.height <= 0) return;
  const [x, y, w, h] = ctx.space.rect(box);
  emit(
    ctx,
    pushGraphicsState(),
    // An image XObject is painted into the unit square, so the CTM *is* its placement.
    concatTransformationMatrix(w, 0, 0, h, x, y),
    drawObject(xobjectName(ctx, image.ref)),
    popGraphicsState(),
  );
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

function hasVisibleFill(style: ShapeStyle | undefined): boolean {
  const fill = style?.fill;
  return fill !== undefined && fill.type !== 'none';
}

/** A stroke PDF will actually draw. Width 0 means "one device pixel" in PDF, not "none". */
function visibleStroke(style: ShapeStyle | undefined): { color: RGB; width: number; dash: number[] } | undefined {
  const stroke = style?.stroke;
  if (!stroke || !(stroke.width > 0)) return undefined;
  const color = parseColor(stroke.color) ?? BLACK;
  const dash = (stroke.dash ?? []).filter((d) => Number.isFinite(d) && d >= 0);
  return { color, width: stroke.width, dash: dash.some((d) => d > 0) ? dash : [] };
}

function applyStrokeState(ctx: Ctx, stroke: { color: RGB; width: number; dash: number[] }): void {
  emit(
    ctx,
    setStrokingRgbColor(stroke.color.r, stroke.color.g, stroke.color.b),
    setLineWidth(stroke.width),
    setLineJoin(LineJoinStyle.Miter),
    setLineCap(LineCapStyle.Butt),
  );
  if (stroke.dash.length > 0) emit(ctx, setDashPattern(stroke.dash, 0));
}

/**
 * Builds the axial shading for a gradient fill and returns its resource name.
 *
 * PDF *does* have a real gradient — an axial shading with a stitched exponential function
 * — so this is not an approximation and nothing is flattened: the colour ramp is exact and
 * resolution-independent, which is what an archive format should hold. The one thing a
 * bare shading cannot carry is per-stop transparency; that case is handled by the caller.
 */
function gradientShading(ctx: Ctx, fill: Extract<Fill, { type: 'gradient' }>, box: Box): PDFName {
  const stops = normalizeStops(fill.stops);

  // angle is degrees clockwise: 0 = left-to-right, 90 = top-to-bottom, measured in the
  // model's y-down space. The endpoints are taken as fractions of the element's box and
  // then scaled by it, exactly as the SVG emitter's objectBoundingBox gradient is, so a
  // gradient across a wide box tilts the same way in both emitters.
  const rad = (fill.angle * Math.PI) / 180;
  const dx = Math.cos(rad) / 2;
  const dy = Math.sin(rad) / 2;
  const from = { x: box.x + (0.5 - dx) * box.width, y: box.y + (0.5 - dy) * box.height };
  const to = { x: box.x + (0.5 + dx) * box.width, y: box.y + (0.5 + dy) * box.height };
  const coords = [from.x, ctx.space.y(from.y), to.x, ctx.space.y(to.y)];

  const key = JSON.stringify([coords, stops.map((s) => [s.offset, s.color.r, s.color.g, s.color.b])]);
  return shadingName(ctx, key, () =>
    ctx.pdf.context.obj({
      ShadingType: 2,
      ColorSpace: 'DeviceRGB',
      Coords: coords,
      Function: stitchedRamp(ctx, stops),
      // Without Extend the shading paints nothing outside [t0, t1], leaving white slivers
      // at the ends of a box the gradient vector does not quite span.
      Extend: [true, true],
    }),
  );
}

interface NormalStop { offset: number; color: RGB; opacity: number }

/**
 * Sorts, clamps and completes a stop list: PDF functions need a value at both ends of the
 * domain and strictly increasing interior bounds, neither of which the model guarantees.
 */
function normalizeStops(stops: Array<{ offset: number; color: string; opacity?: number }>): NormalStop[] {
  const clean = stops
    .map((s) => ({
      offset: Number.isFinite(s.offset) ? Math.min(1, Math.max(0, s.offset)) : 0,
      color: parseColor(s.color) ?? BLACK,
      opacity: s.opacity === undefined || !Number.isFinite(s.opacity) ? 1 : Math.min(1, Math.max(0, s.opacity)),
    }))
    .sort((a, b) => a.offset - b.offset);

  if (clean.length === 0) return [{ offset: 0, color: BLACK, opacity: 1 }, { offset: 1, color: BLACK, opacity: 1 }];
  if (clean.length === 1) {
    const only = clean[0] as NormalStop;
    return [{ ...only, offset: 0 }, { ...only, offset: 1 }];
  }

  const first = clean[0] as NormalStop;
  const last = clean[clean.length - 1] as NormalStop;
  if (first.offset > 0) clean.unshift({ ...first, offset: 0 });
  if (last.offset < 1) clean.push({ ...last, offset: 1 });

  // Nudge duplicate offsets apart; a hard colour edge is legal in the model but not in a
  // PDF function's Bounds array.
  for (let i = 1; i < clean.length - 1; i++) {
    const prev = clean[i - 1] as NormalStop;
    const cur = clean[i] as NormalStop;
    if (cur.offset <= prev.offset) cur.offset = Math.min(1, prev.offset + STOP_EPSILON);
  }
  return clean;
}

/** A type-3 stitch of type-2 exponentials: one linear ramp between each pair of stops. */
function stitchedRamp(ctx: Ctx, stops: NormalStop[]): PDFDict {
  const ramp = (a: NormalStop, b: NormalStop) =>
    ctx.pdf.context.obj({
      FunctionType: 2,
      Domain: [0, 1],
      C0: [a.color.r, a.color.g, a.color.b],
      C1: [b.color.r, b.color.g, b.color.b],
      N: 1,
    });

  if (stops.length === 2) return ramp(stops[0] as NormalStop, stops[1] as NormalStop);

  const functions = [];
  const bounds = [];
  const encode = [];
  for (let i = 0; i < stops.length - 1; i++) {
    functions.push(ramp(stops[i] as NormalStop, stops[i + 1] as NormalStop));
    if (i > 0) bounds.push((stops[i] as NormalStop).offset);
    encode.push(0, 1);
  }
  return ctx.pdf.context.obj({
    FunctionType: 3,
    Domain: [0, 1],
    Functions: functions,
    Bounds: bounds,
    Encode: encode,
  });
}

/**
 * Paints the current path with an element's fill, then strokes it.
 *
 * `buildPath` is a callback rather than a built path because a gradient or an image fill
 * needs the outline twice — once as a clip, once as a stroke — and PDF discards the
 * current path after every painting operator.
 */
function paintPath(ctx: Ctx, style: ShapeStyle | undefined, box: Box, path: () => void): void {
  const fill = style?.fill;
  const stroke = visibleStroke(style);

  if (fill && fill.type !== 'none') {
    switch (fill.type) {
      case 'solid': {
        const color = parseColor(fill.color);
        if (color) {
          emit(ctx, pushGraphicsState(), setFillingRgbColor(color.r, color.g, color.b));
          path();
          emit(ctx, fillPath(), popGraphicsState());
        }
        break;
      }
      case 'gradient': {
        const alphas = fill.stops.map((s) => (s.opacity === undefined ? 1 : s.opacity));
        const varying = alphas.some((a) => a !== alphas[0]);
        // A gradient with no stops at all is opaque, not invisible: `normalizeStops` gives
        // it a flat colour, and dividing by zero stops would erase it instead.
        const flat = alphas.length === 0 ? 1 : alphas.reduce((a, b) => a + b, 0) / alphas.length;
        emit(ctx, pushGraphicsState());
        if (varying) {
          // A shading carries colour but not alpha; per-stop transparency needs a
          // luminosity soft mask, which viewers implement unevenly. One constant alpha is
          // the honest approximation, and it is reported.
          ctx.warn.add(
            'GRADIENT_FLATTENED',
            'A gradient fades in and out of transparency. PDF shadings carry colour but ' +
            'not a changing transparency, so the fade was drawn at one average opacity.',
            ctx.pageNumber,
          );
          emit(ctx, setGraphicsState(alphaState(ctx, flat)));
        } else if (flat < 1) {
          emit(ctx, setGraphicsState(alphaState(ctx, flat)));
        }
        // `sh` floods the clip region, so the outline becomes the clip.
        path();
        emit(
          ctx,
          PDFOperator.of(PDFOperatorNames.ClipNonZero),
          endPath(),
          PDFOperator.of(PDFOperatorNames.ShadingFill, [gradientShading(ctx, fill, box)]),
          popGraphicsState(),
        );
        break;
      }
      case 'image': {
        const image = ctx.images.get(fill.assetRef);
        if (image) {
          emit(ctx, pushGraphicsState());
          path();
          emit(ctx, PDFOperator.of(PDFOperatorNames.ClipNonZero), endPath());
          drawImageFill(ctx, image, fill.repeat, box);
          emit(ctx, popGraphicsState());
        }
        break;
      }
    }
  }

  if (stroke) {
    emit(ctx, pushGraphicsState());
    applyStrokeState(ctx, stroke);
    path();
    emit(ctx, strokePath(), popGraphicsState());
  }
}

function drawImageFill(
  ctx: Ctx,
  image: EmbeddedImage,
  repeat: 'stretch' | 'repeat' | 'none',
  box: Box,
): void {
  const natural = intrinsicSize(image);
  if (repeat === 'stretch' || natural.w <= 0 || natural.h <= 0) {
    drawImageInBox(ctx, image, box);
    return;
  }
  if (repeat === 'none') {
    // One tile at its natural size, anchored at the box's top-left; the clip trims it.
    drawImageInBox(ctx, image, { x: box.x, y: box.y, width: natural.w, height: natural.h });
    return;
  }
  const cols = Math.ceil(box.width / natural.w);
  const rows = Math.ceil(box.height / natural.h);
  if (cols * rows > MAX_IMAGE_TILES) {
    ctx.warn.add(
      'SHAPE_APPROXIMATED',
      `A tiled picture fill uses a tile so small that repeating it across the shape would ` +
      `need more than ${MAX_IMAGE_TILES} copies, so it was stretched to fit instead.`,
      ctx.pageNumber,
    );
    drawImageInBox(ctx, image, box);
    return;
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      drawImageInBox(ctx, image, {
        x: box.x + c * natural.w,
        y: box.y + r * natural.h,
        width: natural.w,
        height: natural.h,
      });
    }
  }
}

/**
 * A dashed frame with a centred label, so the reader sees where a graphic was.
 *
 * The whole thing is an artifact: the label explains an absence, and a reader copying the
 * text out of the page should not get "image/wmf not embeddable" in the middle of it.
 */
function drawPlaceholder(ctx: Ctx, box: Box, label: string): void {
  asArtifact(ctx, () => drawPlaceholderBody(ctx, box, label));
}

function drawPlaceholderBody(ctx: Ctx, box: Box, label: string): void {
  emit(
    ctx,
    pushGraphicsState(),
    setFillingRgbColor(PLACEHOLDER_FILL.r, PLACEHOLDER_FILL.g, PLACEHOLDER_FILL.b),
    setStrokingRgbColor(PLACEHOLDER_STROKE.r, PLACEHOLDER_STROKE.g, PLACEHOLDER_STROKE.b),
    setLineWidth(1),
    setDashPattern(PLACEHOLDER_DASH, 0),
    rectangle(...ctx.space.rect(box)),
    PDFOperator.of(PDFOperatorNames.FillNonZeroAndStroke),
    popGraphicsState(),
  );

  const size = Math.max(6, Math.min(11, box.height / 4));
  const run: Run = { text: label, font: 'Helvetica', size };
  const font = ctx.fonts.for(run);
  const width = measure(label, run, ctx.fonts);
  showChunks(
    ctx,
    [{ text: encodable(label, font, ctx), size, font }],
    run,
    box.x + (box.width - width) / 2,
    box.y + box.height / 2 + size * 0.35,
    { color: PLACEHOLDER_TEXT, rise: 0, scale: 1, wordSpacing: 0, outline: false },
  );
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

/**
 * Wraps `body` in the rotation and constant-opacity state an element needs.
 *
 * The rotation is about the box centre, as the model specifies, and is applied to the CTM
 * so that everything inside — fills, strokes, glyphs, images — turns together.
 */
function withFrame(ctx: Ctx, el: { rotation?: number; style?: ShapeStyle }, box: Box, body: () => void): void {
  const rotation = el.rotation ?? 0;
  const opacity = el.style?.opacity;
  const needsState = rotation !== 0 || (opacity !== undefined && opacity < 1);
  if (!needsState) {
    body();
    return;
  }
  emit(ctx, pushGraphicsState());
  if (rotation !== 0) {
    const cx = box.x + box.width / 2;
    const cy = ctx.space.y(box.y + box.height / 2);
    emit(ctx, translate(cx, cy), rotateDegrees(ctx.space.spin(rotation)), translate(-cx, -cy));
  }
  if (opacity !== undefined && opacity < 1) emit(ctx, setGraphicsState(alphaState(ctx, opacity)));
  body();
  emit(ctx, popGraphicsState());
}

/**
 * Runs `body` with the drop shadow's colour and opacity in force.
 *
 * The model's `Shadow` carries no blur radius — Publisher's shadow here is a hard offset
 * copy, and the SVG emitter renders it with `stdDeviation: 0` for the same reason — so
 * this is an exact rendering, not an approximation: the silhouette is simply drawn again,
 * offset, in one flat colour.
 */
function withShadow(ctx: Ctx, shadow: Shadow, body: (color: RGB) => void): void {
  const color = parseColor(shadow.color) ?? BLACK;
  const alpha = Number.isFinite(shadow.opacity) ? Math.min(1, Math.max(0, shadow.opacity)) : 1;
  if (alpha <= 0) return;
  emit(ctx, pushGraphicsState());
  if (alpha < 1) emit(ctx, setGraphicsState(alphaState(ctx, alpha)));
  body(color);
  emit(ctx, popGraphicsState());
}

/** Fills a box in one flat colour — the silhouette of anything rectangular. */
function fillBox(ctx: Ctx, box: Box, color: RGB, dx = 0, dy = 0): void {
  if (box.width <= 0 || box.height <= 0) return;
  emit(
    ctx,
    pushGraphicsState(),
    setFillingRgbColor(color.r, color.g, color.b),
    rectangle(...ctx.space.rect({ ...box, x: box.x + dx, y: box.y + dy })),
    fillPath(),
    popGraphicsState(),
  );
}

function drawTextBox(ctx: Ctx, el: TextBox, box: Box): void {
  const pad = el.padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const content: Box = {
    x: box.x + pad.left,
    y: box.y + pad.top,
    width: Math.max(0, box.width - pad.left - pad.right),
    height: Math.max(0, box.height - pad.top - pad.bottom),
  };
  // Columns are reproduced rather than flattened — a PDF page can hold them exactly where
  // Publisher put them — so no COLUMNS_FLATTENED warning is due here.
  const placed = placeParagraphs(el.paragraphs, content, el.verticalAlign ?? 'top', el.columns, ctx);

  const shadow = el.style?.shadow;
  if (shadow) {
    withShadow(ctx, shadow, (color) => {
      if (hasVisibleFill(el.style)) fillBox(ctx, box, color, shadow.offsetX, shadow.offsetY);
      // With no backing to cast it, the shadow is the shadow of the letters themselves.
      else {
        asArtifact(ctx, () =>
          drawPlacedLines(ctx, placed, { dx: shadow.offsetX, dy: shadow.offsetY, color, plain: true }),
        );
      }
    });
  }

  if (hasVisibleFill(el.style) || visibleStroke(el.style)) {
    paintPath(ctx, el.style, box, () => emit(ctx, rectangle(...ctx.space.rect(box))));
  }
  drawPlacedLines(ctx, placed, NORMAL_TEXT);
}

function drawTable(ctx: Ctx, el: Table, box: Box): void {
  const cols = el.columnWidths.length > 0 ? el.columnWidths.slice() : [el.width];
  const colX: number[] = [box.x];
  for (const w of cols) colX.push((colX[colX.length - 1] as number) + w);

  const fallbackRow = el.rows.length > 0 ? box.height / el.rows.length : box.height;
  const rowH = el.rows.map((r) => r.height ?? fallbackRow);
  const rowY: number[] = [box.y];
  for (const h of rowH) rowY.push((rowY[rowY.length - 1] as number) + h);

  const span = (offsets: number[], start: number, count: number): number => {
    const a = offsets[Math.min(start, offsets.length - 1)];
    const b = offsets[Math.min(start + Math.max(1, count), offsets.length - 1)];
    if (a === undefined || b === undefined || b <= a) return 0;
    return b - a;
  };

  const shadow = el.style?.shadow;
  if (shadow) {
    if (hasVisibleFill(el.style)) {
      withShadow(ctx, shadow, (color) => fillBox(ctx, box, color, shadow.offsetX, shadow.offsetY));
    } else {
      ctx.warn.add(
        'SHADOW_DROPPED',
        'A table carries a drop shadow but no background of its own to cast it, so the ' +
        'shadow was left out.',
        ctx.pageNumber,
      );
    }
  }

  for (const row of el.rows) {
    for (const cell of row.cells) {
      if (cell.covered) continue; // merged away by a neighbour's span
      drawCell(ctx, cell, colX, rowY, span, el.style);
    }
  }
}

function drawCell(
  ctx: Ctx,
  cell: TableCell,
  colX: number[],
  rowY: number[],
  span: (offsets: number[], start: number, count: number) => number,
  tableStyle: ShapeStyle | undefined,
): void {
  const box: Box = {
    x: colX[Math.min(cell.column, colX.length - 1)] ?? 0,
    y: rowY[Math.min(cell.row, rowY.length - 1)] ?? 0,
    width: span(colX, cell.column, cell.colSpan),
    height: span(rowY, cell.row, cell.rowSpan),
  };
  const style = cell.style ?? tableStyle;
  paintPath(ctx, style, box, () => emit(ctx, rectangle(...ctx.space.rect(box))));

  const content: Box = {
    x: box.x + CELL_PADDING,
    y: box.y + CELL_PADDING,
    width: Math.max(0, box.width - CELL_PADDING * 2),
    height: Math.max(0, box.height - CELL_PADDING * 2),
  };
  drawPlacedLines(ctx, placeParagraphs(cell.paragraphs, content, 'top', undefined, ctx), NORMAL_TEXT);
}

function drawImageElement(ctx: Ctx, el: Image, box: Box): void {
  const image = ctx.images.get(el.assetRef);
  const shadow = el.style?.shadow;
  if (shadow) {
    // An image fills its frame, so its silhouette is the frame.
    withShadow(ctx, shadow, (color) => fillBox(ctx, box, color, shadow.offsetX, shadow.offsetY));
  }

  if (!image) {
    const asset = ctx.doc.assets[el.assetRef];
    drawPlaceholder(ctx, box, asset ? `${asset.mime} not embeddable` : 'missing image');
    return;
  }
  // Publisher frames crop/stretch a picture to the box; matching that beats preserving
  // the aspect ratio, and it is what the SVG emitter does with preserveAspectRatio="none".
  drawImageInBox(ctx, image, box);
  const stroke = visibleStroke(el.style);
  if (stroke) {
    emit(ctx, pushGraphicsState());
    applyStrokeState(ctx, stroke);
    emit(ctx, rectangle(...ctx.space.rect(box)), strokePath(), popGraphicsState());
  }
}

function drawShape(ctx: Ctx, el: Shape, box: Box): void {
  const geometry = el.geometry;
  const shadow = el.style?.shadow;
  if (shadow && hasVisibleFill(el.style)) {
    withShadow(ctx, shadow, (color) => {
      emit(ctx, pushGraphicsState(), setFillingRgbColor(color.r, color.g, color.b));
      buildPath(ctx, geometry, box, shadow.offsetX, shadow.offsetY);
      emit(ctx, fillPath(), popGraphicsState());
    });
  } else if (shadow) {
    ctx.warn.add(
      'SHADOW_DROPPED',
      'A shape carries a drop shadow but no fill to cast it, so the shadow was left out.',
      ctx.pageNumber,
    );
  }

  // An open run of points is never filled, whatever the style says.
  const style = geometry.type === 'polyline' ? { ...el.style, fill: { type: 'none' as const } } : el.style;
  paintPath(ctx, style, box, () => buildPath(ctx, geometry, box));
}

function drawGroup(ctx: Ctx, el: Group, box: Box): void {
  const shadow = el.style?.shadow;
  if (shadow) {
    if (hasVisibleFill(el.style)) {
      withShadow(ctx, shadow, (color) => fillBox(ctx, box, color, shadow.offsetX, shadow.offsetY));
    } else {
      ctx.warn.add(
        'SHADOW_DROPPED',
        'A group of shapes carries a drop shadow of its own. PDF would need the whole group ' +
        'redrawn as a single silhouette to cast it, so that shadow was left out; shadows on ' +
        'the shapes inside are unaffected.',
        ctx.pageNumber,
      );
    }
  }
  if (hasVisibleFill(el.style) || visibleStroke(el.style)) {
    paintPath(ctx, el.style, box, () => emit(ctx, rectangle(...ctx.space.rect(box))));
  }
  // Children carry page coordinates — the model has one origin, the page's top-left — so
  // a group contributes only its own rotation, opacity and shadow.
  for (const child of el.children) drawElement(ctx, child);
}

function drawElement(ctx: Ctx, el: Element): void {
  const box = boxOf(el);
  withFrame(ctx, el, box, () => {
    switch (el.kind) {
      case 'text': drawTextBox(ctx, el, box); return;
      case 'table': drawTable(ctx, el, box); return;
      case 'image': drawImageElement(ctx, el, box); return;
      case 'shape': drawShape(ctx, el, box); return;
      case 'group': drawGroup(ctx, el, box); return;
    }
  });
  // The geometry of a rotation is exact in PDF; what is not exact is where the lines
  // inside a rotated box break, because they were measured with a substitute face. So the
  // warning belongs to rotated *text*, and only to rotated text.
  if (el.rotation && carriesText(el)) {
    ctx.warn.add(
      'ROTATED_TEXT_APPROXIMATED',
      'Text on this page sits in a rotated box. The rotation itself is exact, but the ' +
      'lines inside it were broken using a substitute font, so they may wrap at slightly ' +
      'different words than in Publisher.',
      ctx.pageNumber,
    );
  }
}

function carriesText(el: Element): boolean {
  const some = (paragraphs: Paragraph[]) =>
    paragraphs.some((p) => p.runs.some((r) => r.text.trim() !== ''));
  switch (el.kind) {
    case 'text': return some(el.paragraphs);
    case 'table': return el.rows.some((r) => r.cells.some((c) => some(c.paragraphs)));
    case 'group': return el.children.some(carriesText);
    default: return false;
  }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** ISO-8601 from the model to a Date, rejecting anything a viewer would choke on. */
function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function applyMetadata(pdf: PDFDocument, doc: Doc): void {
  const meta = doc.meta;
  if (meta.title) pdf.setTitle(meta.title);
  // Publisher's "Author" is a person; PDF's /Creator is the originating application.
  if (meta.creator) pdf.setAuthor(meta.creator);
  if (meta.subject) pdf.setSubject(meta.subject);
  if (meta.keywords) {
    const keywords = meta.keywords.split(/[,;]/).map((k) => k.trim()).filter((k) => k !== '');
    if (keywords.length > 0) pdf.setKeywords(keywords);
  }
  pdf.setCreator(
    meta.sourceVersion ? `Microsoft Publisher ${meta.sourceVersion}` : 'Microsoft Publisher',
  );
  pdf.setProducer('Pubshift');
  const created = parseDate(meta.created);
  if (created) {
    pdf.setCreationDate(created);
    // The conversion has no separate modification time, and stamping "now" would make two
    // conversions of one file differ in bytes for no reason.
    pdf.setModificationDate(created);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Renders the whole document: one PDF page per model page, at exact point dimensions.
 *
 * Fidelity losses discovered along the way are appended to `doc.warnings` — the same list
 * the model builder fills and the app already shows the user — because the function's
 * return value is bytes and a silent loss is the failure this product exists to prevent.
 */
export async function emitPDF(doc: Doc): Promise<Uint8Array> {
  // pdf-lib otherwise stamps its own Producer, Creator and the current time into every
  // file, which would make output non-reproducible and misattribute the converter.
  const pdf = await PDFDocument.create({ updateMetadata: false });
  applyMetadata(pdf, doc);

  const warn = new Warnings();
  const fonts = new FontBook(pdf);
  const images = await embedImages(pdf, doc, warn);
  const substituted = new Set<string>();

  for (const [index, page] of doc.pages.entries()) {
    renderPage(pdf, doc, page, index, fonts, images, warn, substituted);
  }
  // A file with no pages is not a PDF any reader will open, so an empty document still
  // gets one blank page. That is *not* a licence to convert an unreadable file: `assess`
  // gates on the verdict before any of this runs, and a document that reaches here with no
  // pages is one the caller has already decided to write out.
  if (doc.pages.length === 0) pdf.addPage(FALLBACK_PAGE);

  if (substituted.size > 0) {
    const names = [...substituted].sort();
    warn.add(
      'FONT_NOT_EMBEDDED',
      `${names.length === 1 ? 'A font' : `${names.length} fonts`} in this document ` +
      `(${names.slice(0, 6).join(', ')}${names.length > 6 ? ', …' : ''}) ` +
      'could not be embedded, because a converter running in your browser has no access to ' +
      'your font files. The text was set in the closest built-in PDF face instead, so line ' +
      'breaks and spacing may differ from the original.',
    );
  }
  warn.mergeInto(doc);

  return pdf.save();
}

function renderPage(
  pdf: PDFDocument,
  doc: Doc,
  page: Page,
  index: number,
  fonts: FontBook,
  images: Map<string, EmbeddedImage | undefined>,
  warn: Warnings,
  substituted: Set<string>,
): void {
  const width = Math.max(1, page.width);
  const height = Math.max(1, page.height);
  const pdfPage = pdf.addPage([width, height]);

  const ctx: Ctx = {
    pdf,
    page: pdfPage,
    space: new PageSpace(width, height),
    doc,
    fonts,
    images,
    warn,
    pageNumber: index + 1,
    ops: [],
    gsNames: new Map(),
    xobjNames: new Map(),
    shadingNames: new Map(),
    fontNames: new Map(),
  };

  // PDF leaves the page transparent; every viewer happens to show white, but an archive
  // should not depend on that, and the SVG emitter paints the same backdrop.
  asArtifact(ctx, () => fillBox(ctx, { x: 0, y: 0, width, height }, WHITE));

  // Elements are painted in array order: the model's order *is* the z-order.
  for (const el of page.elements) drawElement(ctx, el);
  collectSubstitutions(page.elements, fonts, substituted);
  flush(ctx);
}

/** Records which families we had to swap out, for one aggregated warning at the end. */
function collectSubstitutions(elements: Element[], fonts: FontBook, out: Set<string>): void {
  const note = (paragraphs: Paragraph[]): void => {
    for (const para of paragraphs) {
      for (const run of para.runs) {
        if (run.text.trim() === '') continue;
        if (fonts.for(run).substituted) out.add(run.font ?? DEFAULT_FONT_FAMILY);
      }
    }
  };
  for (const el of elements) {
    if (el.kind === 'text') note(el.paragraphs);
    else if (el.kind === 'table') for (const row of el.rows) for (const c of row.cells) note(c.paragraphs);
    else if (el.kind === 'group') collectSubstitutions(el.children, fonts, out);
  }
}
