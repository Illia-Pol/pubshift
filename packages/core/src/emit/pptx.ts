/**
 * PPTX emitter — the format the product leads with.
 *
 * A Publisher page is a set of absolutely-positioned boxes on a fixed canvas, and so is a
 * PowerPoint slide. That makes the mapping close to one-to-one: an element's frame becomes
 * `a:off`/`a:ext`, its rotation becomes `a:xfrm/@rot`, its text becomes a `p:txBody` that
 * keeps its own alignment and leading. Nothing has to be flattened into a flow, which is
 * the loss every DOCX-first converter takes. Three things that the SVG emitter has to
 * approximate are exact here: rotation, multi-column text (`a:bodyPr/@numCol`) and tables.
 *
 * The OOXML is written by hand rather than through a deck library because the whole value
 * is in the positioning, and because this file ships to a browser: jszip is the only
 * dependency it adds.
 *
 * Geometry arrives in points with the origin at the page's top-left. PowerPoint uses EMU
 * with the same origin and the same axis directions, so every conversion in this file is
 * one multiplication — see {@link EMU_PER_POINT}. The one genuine coordinate change is
 * `a:custGeom`, which is drawn in a path-local space; see {@link customGeometry}.
 */

import JSZip from 'jszip';

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
  Stroke,
  Table,
  TableCell,
  TextBox,
  Warning,
  WarningCode,
} from '../model/types';

// ---------------------------------------------------------------------------
// Units
//
// These are exact definitions, not approximations: OOXML fixes 914400 EMU to the inch
// and the model fixes 72 points to the inch.
// ---------------------------------------------------------------------------

/** English Metric Units per inch, as fixed by ECMA-376. */
const EMU_PER_INCH = 914400;

/** EMU per point. 914400 / 72 — the only conversion this emitter needs. */
const EMU_PER_POINT = EMU_PER_INCH / 72;

/** `a:xfrm/@rot`, `a:lin/@ang` and `a:outerShdw/@dir` are all in 60000ths of a degree. */
const ANGLE_UNITS_PER_DEGREE = 60000;

/** A full turn in OOXML angle units; angles are normalised into [0, this). */
const FULL_TURN = 360 * ANGLE_UNITS_PER_DEGREE;

/** Percentages (`a:alpha`, `a:spcPct`, `a:gs/@pos`) are in 1000ths of a percent. */
const PERCENT_UNITS = 100000;

/** `a:rPr/@sz` is in hundredths of a point. */
const FONT_SIZE_UNITS_PER_POINT = 100;

/** `a:spcBef`/`a:spcAft` as `a:spcPts` are in hundredths of a point. */
const SPACING_UNITS_PER_POINT = 100;

/** `a:rPr/@baseline` is a percentage of the font size, in 1000ths of a percent. */
const BASELINE_UNITS_PER_PERCENT = 1000;

/** Smallest and largest slide edge PowerPoint accepts: 1 inch and 56 inches. */
const MIN_SLIDE_EMU = EMU_PER_INCH;
const MAX_SLIDE_EMU = 56 * EMU_PER_INCH;

/** `a:rPr/@sz` bounds from the schema: 1pt to 4000pt. */
const MIN_FONT_SIZE_UNITS = 100;
const MAX_FONT_SIZE_UNITS = 400000;

/** `a:ln/@w` bounds from the schema: 0 (hairline) to 1584pt. */
const MAX_LINE_WIDTH_EMU = 20116800;

/** ST_Coordinate is a 64-bit EMU value bounded at ±27273042316900. */
const MAX_COORDINATE_EMU = 27273042316900;

// ---------------------------------------------------------------------------
// Named approximations
//
// Every number below is a place where PowerPoint cannot express exactly what Publisher
// meant, or where the model does not carry something PowerPoint wants. They are collected
// here so a fidelity regression traces to a decision rather than to a magic number.
// ---------------------------------------------------------------------------

/** Font size assumed for a run with no size. 12pt is Publisher's default body size. */
const DEFAULT_FONT_SIZE = 12;

/** Font assumed for a run with no family, matching the SVG emitter. */
const DEFAULT_FONT_FAMILY = 'Times New Roman';

/** `a:rPr/@lang` when the run does not say. Affects spell-check, not layout. */
const DEFAULT_LANG = 'en-US';

/** Inset for table cell text. Publisher's default cell margin is 0.04in ~= 2.9pt. */
const CELL_MARGIN_POINTS = 2.9;

/** Indent applied per list level when the paragraph does not carry its own margin. */
const LIST_INDENT_POINTS = 18;

/** Bullet glyph and the font it is taken from, for unordered lists. */
const BULLET_CHAR = '•';
const BULLET_FONT = 'Arial';

/** Deepest list level PowerPoint understands; deeper levels are clamped to it. */
const MAX_LIST_LEVEL = 8;

/**
 * An elliptical arc is emitted as cubic Béziers rather than as `a:arcTo`, because
 * `a:arcTo` is centre-parameterised (start angle + sweep) while the model carries SVG's
 * endpoint parameterisation, and round-tripping through the centre form loses the
 * endpoints exactly where they matter — at the join with the next command. Splitting at
 * no more than a quarter turn keeps the cubic approximation inside ~0.03% of the true
 * ellipse, which at 56 inches is under a thousandth of a point.
 */
const MAX_ARC_SEGMENT_RADIANS = Math.PI / 2;

/**
 * Character-width scaling (Publisher's "Scale") and emboss/engrave have no DrawingML
 * equivalent at all. They are dropped, and reported with the closest code the model's
 * fixed `WarningCode` union offers; the message is what the user actually reads.
 */
const NO_DRAWINGML_EQUIVALENT: WarningCode = 'SHAPE_APPROXIMATED';

/**
 * Image formats PowerPoint renders from an embedded part, mapped to the part extension.
 * Anything outside this set is left out and reported: a picture Office cannot decode is
 * a red X in the middle of the slide, which is worse than a labelled gap.
 */
const IMAGE_PART_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/x-ms-bmp': 'bmp',
  'image/tiff': 'tiff',
};

/** Content type written into `[Content_Types].xml` for each extension above. */
const IMAGE_CONTENT_TYPE: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
};

/** Metafiles. Publisher embeds these constantly and no OOXML consumer we target shows them. */
const METAFILE_MIMES = new Set([
  'image/wmf',
  'image/x-wmf',
  'image/emf',
  'image/x-emf',
  'application/x-msmetafile',
  'application/wmf',
  'application/emf',
]);

/** Grey used for the frame drawn where a picture could not be embedded. */
const PLACEHOLDER_FILL = '#f2f2f2';
const PLACEHOLDER_LINE = '#b0b0b0';
const PLACEHOLDER_TEXT = '#707070';
const PLACEHOLDER_TEXT_SIZE = 9;
const PLACEHOLDER_LINE_WIDTH = 1;

/**
 * Width of the line drawn around outlined characters, as a fraction of the font size.
 * Publisher does not record a width for its outline effect; 1/24 em is the weight a
 * hairline outline has at body sizes and stays visible at display sizes.
 */
const TEXT_OUTLINE_WIDTH_RATIO = 1 / 24;

/**
 * Publisher's character shadow is a fixed, tight offset with no blur and no colour of its
 * own. These reproduce it; PowerPoint's own text shadow is a themed effect we cannot read
 * a definition for, so the numbers are stated here rather than inherited.
 */
const TEXT_SHADOW_OFFSET_POINTS = 1;
const TEXT_SHADOW_ANGLE_DEGREES = 45;
const TEXT_SHADOW_COLOR = '#808080';
const TEXT_SHADOW_OPACITY = 0.6;

/** PowerPoint's built-in "No Style, No Grid" table style. */
const TABLE_STYLE_NO_GRID = '{2D5ABB26-0587-4C30-8999-92F81FD0307C}';

/**
 * Master and layout ids live in their own space above 2147483648; slide ids start at 256.
 * Both are conventions PowerPoint follows and neither may collide inside its own list.
 */
const SLIDE_MASTER_ID = 2147483648;
const SLIDE_LAYOUT_ID = 2147483649;
const FIRST_SLIDE_ID = 256;

/**
 * How every entry goes into the zip.
 *
 * The fixed date makes the same Doc produce the same bytes, which keeps the output
 * diffable and lets a caller cache on its hash. `createFolders: false` is part of that:
 * jszip would otherwise insert a directory entry per path segment and stamp each one with
 * `new Date()`, which alone is enough to make two builds of one document differ. Office's
 * own packages carry no directory entries either.
 */
const ZIP_DATE = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));
const ZIP_OPTIONS = { date: ZIP_DATE, createFolders: false } as const;

// ---------------------------------------------------------------------------
// Namespaces and relationship types
// ---------------------------------------------------------------------------

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** `xmlns` triple carried by presentation.xml, the master, the layouts and every slide. */
const PML_NS = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;

const REL = {
  officeDocument: `${NS_R}/officeDocument`,
  coreProperties: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extendedProperties: `${NS_R}/extended-properties`,
  slideMaster: `${NS_R}/slideMaster`,
  slideLayout: `${NS_R}/slideLayout`,
  slide: `${NS_R}/slide`,
  theme: `${NS_R}/theme`,
  presProps: `${NS_R}/presProps`,
  tableStyles: `${NS_R}/tableStyles`,
  image: `${NS_R}/image`,
  hyperlink: `${NS_R}/hyperlink`,
} as const;

const CONTENT_TYPE = {
  presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  slide: 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
  slideLayout: 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml',
  slideMaster: 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml',
  presProps: 'application/vnd.openxmlformats-officedocument.presentationml.presProps+xml',
  tableStyles: 'application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml',
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
  xml: 'application/xml',
} as const;

// ---------------------------------------------------------------------------
// XML plumbing
// ---------------------------------------------------------------------------

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
};

/**
 * Escapes text and attribute values, and strips the C0 control characters that are
 * illegal in XML 1.0. Real `.pub` text carries stray 0x0B/0x0C/0x1E from Publisher's own
 * control codes; a single one of them makes the part unparseable, and PowerPoint reports
 * that as "repair" rather than as an error anyone can act on.
 */
function esc(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    // XML 1.0 forbids every C0 control except tab, line feed and carriage return.
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) continue;
    out += XML_ESCAPE[ch] ?? ch;
  }
  return out;
}

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** Wraps a part body in the declaration Office writes. */
function part(body: string): string {
  return XML_DECLARATION + body;
}

/** Points to EMU, rounded to an integer and clamped to what ST_Coordinate can hold. */
function emu(points: number): number {
  if (!Number.isFinite(points)) return 0;
  const v = Math.round(points * EMU_PER_POINT);
  return Math.max(-MAX_COORDINATE_EMU, Math.min(MAX_COORDINATE_EMU, v));
}

/** EMU for a length that must be positive (an extent, a path space, a column width). */
function extentEmu(points: number): number {
  return Math.max(1, Math.abs(emu(points)));
}

function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

/** A 0..1 ratio as OOXML's 1000ths of a percent. */
function percent(ratio: number): number {
  return Math.round(clamp(ratio, 0, 1) * PERCENT_UNITS);
}

/** Degrees clockwise to OOXML's 60000ths of a degree, normalised into one turn. */
function angleUnits(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  const raw = Math.round(degrees * ANGLE_UNITS_PER_DEGREE);
  const wrapped = raw % FULL_TURN;
  return wrapped < 0 ? wrapped + FULL_TURN : wrapped;
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

/** `#rrggbb` (or `#rgb`) to the bare uppercase hex `a:srgbClr` wants. */
function srgbHex(color: string | undefined): string {
  const raw = (color ?? '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return raw.toUpperCase();
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return raw.split('').map((c) => c + c).join('').toUpperCase();
  }
  // Eight digits is #rrggbbaa; the alpha is carried separately by the caller that has it.
  if (/^[0-9a-fA-F]{8}$/.test(raw)) return raw.slice(0, 6).toUpperCase();
  return '000000';
}

/** `<a:srgbClr>`, with an `a:alpha` child when the paint is not fully opaque. */
function colorXml(color: string | undefined, opacity?: number): string {
  const alpha = opacity === undefined || opacity >= 1 ? '' : tag('a:alpha', { val: percent(opacity) });
  return tag('a:srgbClr', { val: srgbHex(color) }, alpha);
}

// ---------------------------------------------------------------------------
// Package bookkeeping
// ---------------------------------------------------------------------------

/**
 * One part's relationships. A missing relationship is the classic way a generated pptx
 * opens as a repair dialog, so every `r:id` in this file comes from here and nowhere else.
 */
class Rels {
  private readonly items: Array<{ id: string; type: string; target: string; external: boolean }> = [];
  private readonly byKey = new Map<string, string>();

  add(type: string, target: string, external = false): string {
    const key = `${type}|${target}|${external ? 'x' : 'i'}`;
    const seen = this.byKey.get(key);
    if (seen !== undefined) return seen;
    const id = `rId${this.items.length + 1}`;
    this.items.push({ id, type, target, external });
    this.byKey.set(key, id);
    return id;
  }

  xml(): string {
    const body = this.items
      .map((r) =>
        tag('Relationship', {
          Id: r.id,
          Type: r.type,
          Target: r.target,
          TargetMode: r.external ? 'External' : undefined,
        }),
      )
      .join('');
    return part(
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`,
    );
  }
}

interface MediaFile {
  /** Path inside the package, e.g. `ppt/media/image1.png`. */
  path: string;
  /** Base64, straight from the model — jszip decodes it. */
  base64: string;
}

/**
 * The deck's picture parts. Media is package-level and relationships are per-slide, so an
 * asset used on three slides is written once and related three times.
 */
class MediaLibrary {
  private readonly byRef = new Map<string, string>();
  readonly files: MediaFile[] = [];
  readonly extensions = new Set<string>();

  /** Part path relative to `ppt/`, or undefined when the format cannot be embedded. */
  place(ref: string, asset: Asset): string | undefined {
    const seen = this.byRef.get(ref);
    if (seen !== undefined) return seen;
    const ext = IMAGE_PART_EXTENSION[asset.mime.toLowerCase().trim()];
    if (ext === undefined) return undefined;
    const relative = `media/image${this.files.length + 1}.${ext}`;
    this.files.push({ path: `ppt/${relative}`, base64: asset.data.replace(/\s+/g, '') });
    this.extensions.add(ext);
    this.byRef.set(ref, relative);
    return relative;
  }
}

/**
 * Collects warnings per page, counting repeats rather than listing them one by one.
 *
 * The key includes the message, not just the code: the model's `WarningCode` union is
 * fixed and narrower than the set of things PowerPoint cannot express, so one code carries
 * several distinct losses. Keying on the code alone would report three dropped emboss
 * effects when what actually happened was two emboss effects and a character-width scale.
 */
class WarningLog {
  private readonly byKey = new Map<string, Warning>();

  add(code: WarningCode, message: string, page?: number): void {
    const key = `${code}|${page ?? 0}|${message}`;
    const seen = this.byKey.get(key);
    if (seen) {
      seen.count = (seen.count ?? 1) + 1;
      return;
    }
    this.byKey.set(key, { code, message, count: 1, ...(page === undefined ? {} : { page }) });
  }

  list(): Warning[] {
    return [...this.byKey.values()];
  }
}

/** Everything one slide's element tree needs while it is being written. */
interface SlideContext {
  readonly doc: Doc;
  readonly rels: Rels;
  readonly media: MediaLibrary;
  readonly warnings: WarningLog;
  /** 1-based, for warning messages. */
  readonly page: number;
  /** Shape ids are unique within a slide; 1 belongs to the shape tree itself. */
  nextId(): number;
}

function warn(ctx: SlideContext, code: WarningCode, message: string): void {
  ctx.warnings.add(code, message, ctx.page);
}

// ---------------------------------------------------------------------------
// Frames, fills, lines, effects
// ---------------------------------------------------------------------------

interface Box { x: number; y: number; width: number; height: number }

function boxOf(el: { x: number; y: number; width: number; height: number }): Box {
  return { x: el.x, y: el.y, width: el.width, height: el.height };
}

/**
 * `a:xfrm` for an element. PowerPoint rotates about the centre of the extent, which is
 * exactly what the model means by "degrees clockwise about the box centre", so rotation
 * survives the trip intact — no approximation, unlike the SVG and PDF paths.
 */
function xfrm(
  box: Box,
  rotation: number | undefined,
  opts: { tagName?: string; childSpace?: boolean } = {},
): string {
  const rot = rotation ? angleUnits(rotation) : undefined;
  const off = tag('a:off', { x: emu(box.x), y: emu(box.y) });
  const ext = tag('a:ext', { cx: extentEmu(box.width), cy: extentEmu(box.height) });
  // A group declares the coordinate space its children are drawn in. Ours is the page, so
  // the child space is the group's own frame and the children need no translation.
  const child = opts.childSpace
    ? tag('a:chOff', { x: emu(box.x), y: emu(box.y) }) +
      tag('a:chExt', { cx: extentEmu(box.width), cy: extentEmu(box.height) })
    : '';
  return tag(opts.tagName ?? 'a:xfrm', { rot }, off + ext + child);
}

/** Blip fill for an image asset, or undefined when the asset cannot be embedded. */
function blipFillXml(
  ctx: SlideContext,
  ref: string,
  mode: 'stretch' | 'tile',
  opacity?: number,
): string | undefined {
  const asset = ctx.doc.assets[ref];
  if (!asset) {
    warn(ctx, 'SHAPE_APPROXIMATED', 'A picture carried no image data, so its frame was left empty.');
    return undefined;
  }
  if (METAFILE_MIMES.has(asset.mime.toLowerCase().trim())) {
    warn(
      ctx,
      'WMF_IMAGE_NOT_CONVERTED',
      'A picture is stored as a Windows metafile (WMF/EMF). PowerPoint cannot display that ' +
        'format from a converted file, so the picture was left out rather than shown broken.',
    );
    return undefined;
  }
  const target = ctx.media.place(ref, asset);
  if (target === undefined) {
    warn(
      ctx,
      'WMF_IMAGE_NOT_CONVERTED',
      `A picture is stored as ${asset.mime}, which PowerPoint cannot display, so it was left out.`,
    );
    return undefined;
  }
  const rId = ctx.rels.add(REL.image, `../${target}`);
  const paint = mode === 'tile'
    ? tag('a:tile', { tx: 0, ty: 0, sx: PERCENT_UNITS, sy: PERCENT_UNITS, flip: 'none', algn: 'tl' })
    : tag('a:stretch', {}, tag('a:fillRect'));
  // A picture's transparency lives on the blip, not on the shape.
  const alpha = opacity === undefined || opacity >= 1
    ? ''
    : tag('a:alphaModFix', { amt: percent(opacity) });
  return tag(
    'a:blipFill',
    { rotWithShape: 1 },
    tag('a:blip', { 'r:embed': rId }, alpha) + paint,
  );
}

/**
 * A fill. `opacity` is the element's own 0..1 opacity: DrawingML has no shape-level
 * opacity, so it is folded into the paint's alpha, which is where PowerPoint keeps it.
 */
function fillXml(ctx: SlideContext, fill: Fill | undefined, opacity: number | undefined): string {
  if (!fill) return tag('a:noFill');
  switch (fill.type) {
    case 'none':
      return tag('a:noFill');
    case 'solid':
      return tag('a:solidFill', {}, colorXml(fill.color, opacity));
    case 'gradient': {
      // Both sides measure clockwise from "left to right", so the angle carries over as-is.
      const stops = [...fill.stops]
        .map((s) => ({ ...s, offset: clamp(s.offset, 0, 1) }))
        .sort((a, b) => a.offset - b.offset);
      if (stops.length < 2) {
        warn(
          ctx,
          'GRADIENT_FLATTENED',
          'A gradient had fewer than two colour stops, so it became a flat colour.',
        );
        return tag('a:solidFill', {}, colorXml(stops[0]?.color ?? '#ffffff', opacity));
      }
      const gsLst = stops
        .map((s) =>
          tag(
            'a:gs',
            { pos: percent(s.offset) },
            colorXml(s.color, s.opacity === undefined ? opacity : s.opacity * (opacity ?? 1)),
          ),
        )
        .join('');
      return tag(
        'a:gradFill',
        { flip: 'none', rotWithShape: 1 },
        tag('a:gsLst', {}, gsLst) + tag('a:lin', { ang: angleUnits(fill.angle), scaled: 0 }),
      );
    }
    case 'image': {
      // DrawingML offers exactly two ways to paint a picture into a shape, stretched or
      // tiled. The model's third, 'none' — one copy at its natural size with the rest of
      // the shape left bare — has no equivalent, and stretching covers the same area the
      // publication filled, so it is the closer of the two.
      const blip = blipFillXml(ctx, fill.assetRef, fill.repeat === 'repeat' ? 'tile' : 'stretch', opacity);
      return blip ?? tag('a:noFill');
    }
  }
}

/**
 * `a:ln`. The dash pattern is emitted as `a:custDash`, whose lengths are percentages of
 * the line width — so an exact pattern needs a non-zero width; a hairline falls back to
 * the nearest preset.
 */
function lineXml(
  stroke: Stroke | undefined,
  opacity: number | undefined,
  /** `a:lnL`/`a:lnR`/`a:lnT`/`a:lnB` inside a table cell; `a:ln` everywhere else. */
  name: 'a:ln' | 'a:lnL' | 'a:lnR' | 'a:lnT' | 'a:lnB' = 'a:ln',
): string {
  if (!stroke) return tag(name, {}, tag('a:noFill'));
  const width = clamp(emu(stroke.width), 0, MAX_LINE_WIDTH_EMU);
  let dash = '';
  if (stroke.dash && stroke.dash.length > 0) {
    // SVG's rule: an odd-length pattern repeats to make dashes and gaps alternate.
    const pattern = stroke.dash.length % 2 === 0 ? stroke.dash : [...stroke.dash, ...stroke.dash];
    if (width > 0) {
      let segments = '';
      for (let i = 0; i + 1 < pattern.length; i += 2) {
        const d = Math.max(1, Math.round(((pattern[i] as number) * EMU_PER_POINT * PERCENT_UNITS) / width));
        const sp = Math.max(1, Math.round(((pattern[i + 1] as number) * EMU_PER_POINT * PERCENT_UNITS) / width));
        segments += tag('a:ds', { d, sp });
      }
      dash = tag('a:custDash', {}, segments);
    } else {
      dash = tag('a:prstDash', { val: 'dash' });
    }
  }
  return tag(
    name,
    { w: width, cap: 'flat', cmpd: 'sng', algn: 'ctr' },
    tag('a:solidFill', {}, colorXml(stroke.color, opacity)) + dash + tag('a:round'),
  );
}

/** `a:effectLst` for a drop shadow. The model carries no blur, so `blurRad` is zero. */
function effectXml(shadow: Shadow | undefined): string {
  if (!shadow) return '';
  const dist = Math.hypot(shadow.offsetX, shadow.offsetY);
  // Screen axes: x right, y down — and OOXML's direction is clockwise from east, same axes.
  const dir = (Math.atan2(shadow.offsetY, shadow.offsetX) * 180) / Math.PI;
  return tag(
    'a:effectLst',
    {},
    tag(
      'a:outerShdw',
      { blurRad: 0, dist: emu(dist), dir: angleUnits(dir), rotWithShape: 0 },
      colorXml(shadow.color, shadow.opacity),
    ),
  );
}

/** Fill + line + effects, in the order CT_ShapeProperties requires. */
function paintXml(ctx: SlideContext, style: ShapeStyle | undefined): string {
  return (
    fillXml(ctx, style?.fill, style?.opacity) +
    lineXml(style?.stroke, style?.opacity) +
    effectXml(style?.shadow)
  );
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Turns a point list into the path commands a closed or open outline needs. */
function pointsToCommands(points: Point[], close: boolean): PathCommand[] {
  const out: PathCommand[] = [];
  points.forEach((p, i) => out.push({ op: i === 0 ? 'M' : 'L', x: p.x, y: p.y }));
  if (close && points.length > 0) out.push({ op: 'Z' });
  return out;
}

interface Cubic { x1: number; y1: number; x2: number; y2: number; x: number; y: number }

/**
 * SVG's endpoint-parameterised elliptical arc as a list of cubic Béziers, following the
 * implementation notes in the SVG specification's appendix on arcs. See
 * {@link MAX_ARC_SEGMENT_RADIANS} for why this is a Bézier and not an `a:arcTo`.
 */
function arcToCubics(
  x0: number,
  y0: number,
  arc: Extract<PathCommand, { op: 'A' }>,
): Cubic[] {
  const { x, y, rotation, largeArc, sweep } = arc;
  // Degenerate radii, or no movement at all: the spec says draw a straight line / nothing.
  if (x0 === x && y0 === y) return [];
  let rx = Math.abs(arc.rx);
  let ry = Math.abs(arc.ry);
  if (rx === 0 || ry === 0) return [{ x1: x0, y1: y0, x2: x, y2: y, x, y }];

  const phi = (rotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;

  // Scale the radii up when they are too small to span the two endpoints.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const denominator = rx2 * y1p * y1p + ry2 * x1p * x1p;
  const numerator = rx2 * ry2 - denominator;
  const factor = denominator === 0 ? 0 : Math.sqrt(Math.max(0, numerator / denominator));
  const sign = largeArc === sweep ? -1 : 1;
  const cxp = sign * factor * ((rx * y1p) / ry);
  const cyp = sign * factor * (-(ry * x1p) / rx);
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  const angleBetween = (ux: number, uy: number, vx: number, vy: number): number => {
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    if (len === 0) return 0;
    const a = Math.acos(clamp((ux * vx + uy * vy) / len, -1, 1));
    return ux * vy - uy * vx < 0 ? -a : a;
  };

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta = angleBetween(1, 0, ux, uy);
  let sweepAngle = angleBetween(ux, uy, vx, vy);
  if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
  if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;

  const count = Math.max(1, Math.ceil(Math.abs(sweepAngle) / MAX_ARC_SEGMENT_RADIANS));
  const delta = sweepAngle / count;
  const alpha = (4 / 3) * Math.tan(delta / 4);

  const at = (angle: number) => ({
    x: cx + rx * cosPhi * Math.cos(angle) - ry * sinPhi * Math.sin(angle),
    y: cy + rx * sinPhi * Math.cos(angle) + ry * cosPhi * Math.sin(angle),
  });
  const derivativeAt = (angle: number) => ({
    x: -rx * cosPhi * Math.sin(angle) - ry * sinPhi * Math.cos(angle),
    y: -rx * sinPhi * Math.sin(angle) + ry * cosPhi * Math.cos(angle),
  });

  const out: Cubic[] = [];
  for (let i = 0; i < count; i++) {
    const a1 = theta + i * delta;
    const a2 = a1 + delta;
    const p1 = at(a1);
    const p2 = at(a2);
    const d1 = derivativeAt(a1);
    const d2 = derivativeAt(a2);
    out.push({
      x1: p1.x + alpha * d1.x,
      y1: p1.y + alpha * d1.y,
      x2: p2.x - alpha * d2.x,
      y2: p2.y - alpha * d2.y,
      x: p2.x,
      y: p2.y,
    });
  }
  // Land exactly on the commanded endpoint; the trigonometry above is within a rounding
  // error of it, and a visible gap at a join is the one artefact worth spending code on.
  const last = out[out.length - 1];
  if (last) {
    last.x = x;
    last.y = y;
  }
  return out;
}

/**
 * `a:custGeom` for an arbitrary outline.
 *
 * The model's path coordinates are absolute page coordinates, like SVG's. A custGeom path
 * is drawn in its own space, declared by `a:path/@w` and `@h` and scaled onto the shape's
 * extent. Declaring that space in EMU at exactly the frame's size makes the scale the
 * identity, so the only conversion is the translation from the page origin to the frame's
 * top-left corner — and points that fall outside the frame keep falling outside it, which
 * is what Publisher drew.
 */
function customGeometry(commands: PathCommand[], box: Box, closed: boolean): string {
  const spaceW = extentEmu(box.width);
  const spaceH = extentEmu(box.height);
  const px = (v: number) => emu(v - box.x);
  const py = (v: number) => emu(v - box.y);
  const pt = (x: number, y: number) => tag('a:pt', { x: px(x), y: py(y) });

  let body = '';
  let cursorX = box.x;
  let cursorY = box.y;
  let started = false;
  for (const c of commands) {
    switch (c.op) {
      case 'M':
        body += tag('a:moveTo', {}, pt(c.x, c.y));
        cursorX = c.x;
        cursorY = c.y;
        started = true;
        break;
      case 'L':
        if (!started) {
          body += tag('a:moveTo', {}, pt(c.x, c.y));
          started = true;
        } else {
          body += tag('a:lnTo', {}, pt(c.x, c.y));
        }
        cursorX = c.x;
        cursorY = c.y;
        break;
      case 'C':
        body += tag('a:cubicBezTo', {}, pt(c.x1, c.y1) + pt(c.x2, c.y2) + pt(c.x, c.y));
        cursorX = c.x;
        cursorY = c.y;
        break;
      case 'Q':
        body += tag('a:quadBezTo', {}, pt(c.x1, c.y1) + pt(c.x, c.y));
        cursorX = c.x;
        cursorY = c.y;
        break;
      case 'A':
        for (const cubic of arcToCubics(cursorX, cursorY, c)) {
          body += tag('a:cubicBezTo', {}, pt(cubic.x1, cubic.y1) + pt(cubic.x2, cubic.y2) + pt(cubic.x, cubic.y));
        }
        cursorX = c.x;
        cursorY = c.y;
        break;
      case 'Z':
        body += tag('a:close');
        break;
    }
  }
  if (body === '') return tag('a:custGeom', {}, emptyGuideLists() + tag('a:pathLst'));

  // An open outline is stroked, never filled, whatever the style says — same rule the
  // SVG emitter applies to `polyline`.
  const path = tag('a:path', { w: spaceW, h: spaceH, ...(closed ? {} : { fill: 'none' }) }, body);
  return tag('a:custGeom', {}, emptyGuideLists() + tag('a:pathLst', {}, path));
}

/** The four empty lists PowerPoint expects ahead of `a:pathLst`. */
function emptyGuideLists(): string {
  return tag('a:avLst') + tag('a:gdLst') + tag('a:ahLst') + tag('a:cxnLst');
}

/** Whether a command list ever closes; an unclosed outline must not be filled. */
function isClosed(commands: PathCommand[]): boolean {
  return commands.some((c) => c.op === 'Z');
}

function geometryXml(ctx: SlideContext, geometry: Geometry, box: Box): string {
  switch (geometry.type) {
    case 'rect': {
      if (geometry.rx === undefined && geometry.ry === undefined) {
        return tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst'));
      }
      // roundRect has a single adjust value: one corner radius as a fraction of the
      // shorter side. An x radius that differs from the y radius cannot be expressed.
      const rx = geometry.rx ?? geometry.ry ?? 0;
      const ry = geometry.ry ?? geometry.rx ?? 0;
      if (Math.abs(rx - ry) > 0.01) {
        warn(
          ctx,
          'SHAPE_APPROXIMATED',
          'A rounded rectangle had different horizontal and vertical corner radii; ' +
            'PowerPoint supports one radius, so the corners are slightly different.',
        );
      }
      const shorter = Math.min(Math.abs(box.width), Math.abs(box.height));
      const adjust = shorter === 0 ? 0 : clamp(Math.round(((rx + ry) / 2 / shorter) * PERCENT_UNITS), 0, PERCENT_UNITS / 2);
      return tag(
        'a:prstGeom',
        { prst: 'roundRect' },
        tag('a:avLst', {}, tag('a:gd', { name: 'adj', fmla: `val ${adjust}` })),
      );
    }
    case 'ellipse':
      return tag('a:prstGeom', { prst: 'ellipse' }, tag('a:avLst'));
    case 'polygon':
      return customGeometry(pointsToCommands(geometry.points, true), box, true);
    case 'polyline':
      return customGeometry(pointsToCommands(geometry.points, false), box, false);
    case 'path':
      return customGeometry(geometry.d, box, isClosed(geometry.d));
  }
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** `a:bodyPr`. Columns are a real PowerPoint feature, so nothing is flattened here. */
function bodyPrXml(
  padding: TextBox['padding'],
  verticalAlign: TextBox['verticalAlign'],
  columns: TextBox['columns'],
): string {
  const pad = padding ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const anchor = verticalAlign === 'middle' ? 'ctr' : verticalAlign === 'bottom' ? 'b' : 't';
  const count = columns ? clamp(Math.floor(columns.count), 1, 16) : 1;
  return tag(
    'a:bodyPr',
    {
      wrap: 'square',
      lIns: emu(pad.left),
      tIns: emu(pad.top),
      rIns: emu(pad.right),
      bIns: emu(pad.bottom),
      anchor,
      anchorCtr: 0,
      rtlCol: 0,
      numCol: count > 1 ? count : undefined,
      spcCol: count > 1 ? emu(Math.max(0, columns?.gap ?? 0)) : undefined,
    },
    tag('a:normAutofit'),
  );
}

const ALIGN_TO_ALGN: Record<NonNullable<Paragraph['align']>, string> = {
  left: 'l',
  center: 'ctr',
  right: 'r',
  justify: 'just',
};

/** `a:pPr`, with its children in the order the schema fixes. */
function paragraphPropsXml(p: Paragraph): string {
  const level = p.list ? clamp(Math.floor(p.list.level), 0, MAX_LIST_LEVEL) : 0;
  // A list with no explicit margin gets a hanging indent, which is what a reader expects
  // and what Publisher draws; an explicit margin from the model always wins.
  const marL = p.marginLeft ?? (p.list ? (level + 1) * LIST_INDENT_POINTS : 0);
  const indent = p.textIndent ?? (p.list ? -LIST_INDENT_POINTS : 0);

  let children = '';
  if (p.lineHeight !== undefined && p.lineHeight > 0) {
    children += tag('a:lnSpc', {}, tag('a:spcPct', { val: Math.round(p.lineHeight * PERCENT_UNITS) }));
  }
  if (p.marginTop) {
    children += tag('a:spcBef', {}, tag('a:spcPts', { val: Math.max(0, Math.round(p.marginTop * SPACING_UNITS_PER_POINT)) }));
  }
  if (p.marginBottom) {
    children += tag('a:spcAft', {}, tag('a:spcPts', { val: Math.max(0, Math.round(p.marginBottom * SPACING_UNITS_PER_POINT)) }));
  }
  if (p.list) {
    children += p.list.type === 'ordered'
      ? tag('a:buFont', { typeface: BULLET_FONT }) + tag('a:buAutoNum', { type: 'arabicPeriod' })
      : tag('a:buFont', { typeface: BULLET_FONT }) + tag('a:buChar', { char: BULLET_CHAR });
  } else {
    // Without this the paragraph would inherit a bullet from the master's text styles.
    children += tag('a:buNone');
  }

  return tag(
    'a:pPr',
    {
      marL: marL ? emu(marL) : undefined,
      marR: p.marginRight ? emu(p.marginRight) : undefined,
      lvl: level || undefined,
      indent: indent ? emu(indent) : undefined,
      algn: p.align ? ALIGN_TO_ALGN[p.align] : undefined,
    },
    children,
  );
}

/** `a:rPr`/`a:endParaRPr` for a run. */
function runPropsXml(ctx: SlideContext, run: Run, name: 'a:rPr' | 'a:endParaRPr'): string {
  const size = clamp(
    Math.round((run.size ?? DEFAULT_FONT_SIZE) * FONT_SIZE_UNITS_PER_POINT),
    MIN_FONT_SIZE_UNITS,
    MAX_FONT_SIZE_UNITS,
  );
  const typeface = run.font ?? DEFAULT_FONT_FAMILY;

  if (run.textScale !== undefined && Math.abs(run.textScale - 100) > 0.5) {
    warn(
      ctx,
      NO_DRAWINGML_EQUIVALENT,
      "Publisher's character-width scaling has no PowerPoint equivalent, so some text is " +
        'set at its normal width and may end a line earlier or later than the original.',
    );
  }
  if (run.relief) {
    warn(
      ctx,
      NO_DRAWINGML_EQUIVALENT,
      'Embossed or engraved text has no PowerPoint equivalent and was set flat.',
    );
  }

  let children = '';
  // Outlined characters are a line on the run, which is exactly how PowerPoint models them.
  if (run.outline) {
    children += tag(
      'a:ln',
      { w: emu((size / FONT_SIZE_UNITS_PER_POINT) * TEXT_OUTLINE_WIDTH_RATIO) },
      tag('a:solidFill', {}, colorXml(run.color ?? '#000000')),
    );
  }
  if (run.color) children += tag('a:solidFill', {}, colorXml(run.color));
  if (run.textShadow) {
    children += tag(
      'a:effectLst',
      {},
      tag(
        'a:outerShdw',
        {
          blurRad: 0,
          dist: emu(TEXT_SHADOW_OFFSET_POINTS),
          dir: angleUnits(TEXT_SHADOW_ANGLE_DEGREES),
          rotWithShape: 0,
        },
        colorXml(TEXT_SHADOW_COLOR, TEXT_SHADOW_OPACITY),
      ),
    );
  }
  children += tag('a:latin', { typeface }) + tag('a:cs', { typeface });
  if (run.link) {
    children += tag('a:hlinkClick', { 'r:id': ctx.rels.add(REL.hyperlink, run.link, true) });
  }

  return tag(
    name,
    {
      lang: run.lang ?? DEFAULT_LANG,
      sz: size,
      b: run.bold ? 1 : undefined,
      i: run.italic ? 1 : undefined,
      u: run.underline ? 'sng' : undefined,
      strike: run.strike ? 'sngStrike' : undefined,
      // allCaps wins over smallCaps: OOXML has one attribute and all-caps is the stronger
      // of the two, the same precedence Publisher applies.
      cap: run.allCaps ? 'all' : run.smallCaps ? 'small' : undefined,
      baseline: run.baselineShift
        ? Math.round(run.baselineShift * BASELINE_UNITS_PER_PERCENT)
        : undefined,
      dirty: 0,
    },
    children,
  );
}

/**
 * One paragraph. A `\n` inside a run's text is Publisher's hard line break and becomes
 * `a:br`, because `a:t` cannot carry a newline — PowerPoint would swallow it.
 */
function paragraphXml(ctx: SlideContext, p: Paragraph): string {
  let body = paragraphPropsXml(p);
  let wroteRun = false;

  for (const run of p.runs) {
    const pieces = run.text.split(/\r\n|[\r\n]/);
    pieces.forEach((piece, i) => {
      if (i > 0) {
        body += tag('a:br', {}, runPropsXml(ctx, run, 'a:rPr'));
        wroteRun = true;
      }
      if (piece === '') return;
      body += tag('a:r', {}, runPropsXml(ctx, run, 'a:rPr') + tag('a:t', {}, esc(piece)));
      wroteRun = true;
    });
  }

  // An empty paragraph still occupies a line, and Publisher documents are full of them as
  // spacing. endParaRPr is what gives that line its height.
  if (!wroteRun) {
    const last = p.runs[p.runs.length - 1];
    body += runPropsXml(ctx, last ?? { text: '' }, 'a:endParaRPr');
  }
  return tag('a:p', {}, body);
}

function txBodyXml(
  ctx: SlideContext,
  paragraphs: Paragraph[],
  bodyPr: string,
  tagName: 'p:txBody' | 'a:txBody',
): string {
  const body = paragraphs.length === 0
    ? tag('a:p')
    : paragraphs.map((p) => paragraphXml(ctx, p)).join('');
  return tag(tagName, {}, bodyPr + tag('a:lstStyle') + body);
}

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

function nvSpPr(id: number, name: string, isTextBox: boolean): string {
  return tag(
    'p:nvSpPr',
    {},
    tag('p:cNvPr', { id, name }) +
      tag('p:cNvSpPr', isTextBox ? { txBox: 1 } : {}) +
      tag('p:nvPr'),
  );
}

function textBoxXml(ctx: SlideContext, el: TextBox): string {
  const id = ctx.nextId();
  const box = boxOf(el);
  const spPr = tag(
    'p:spPr',
    {},
    xfrm(box, el.rotation) +
      tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst')) +
      paintXml(ctx, el.style),
  );
  const body = txBodyXml(ctx, el.paragraphs, bodyPrXml(el.padding, el.verticalAlign, el.columns), 'p:txBody');
  return tag('p:sp', {}, nvSpPr(id, `TextBox ${id}`, true) + spPr + body);
}

function shapeXml(ctx: SlideContext, el: Shape): string {
  const id = ctx.nextId();
  const box = boxOf(el);
  const spPr = tag(
    'p:spPr',
    {},
    xfrm(box, el.rotation) + geometryXml(ctx, el.geometry, box) + paintXml(ctx, el.style),
  );
  // Every shape carries an empty text body: PowerPoint adds one the moment the shape is
  // clicked, and writing it up front keeps our file identical to a round-tripped one.
  const body = tag('p:txBody', {}, tag('a:bodyPr') + tag('a:lstStyle') + tag('a:p'));
  return tag('p:sp', {}, nvSpPr(id, `Shape ${id}`, false) + spPr + body);
}

function pictureXml(ctx: SlideContext, el: Image): string {
  const blip = blipFillXml(ctx, el.assetRef, 'stretch', el.style?.opacity);
  const box = boxOf(el);
  if (blip === undefined) return placeholderXml(ctx, box, el.rotation, describeAsset(ctx.doc, el.assetRef));

  const id = ctx.nextId();
  const nv = tag(
    'p:nvPicPr',
    {},
    tag('p:cNvPr', { id, name: `Picture ${id}` }) +
      // Publisher frames crop and stretch to the box, so the aspect ratio is not locked.
      tag('p:cNvPicPr', {}, tag('a:picLocks', { noChangeAspect: 0 })) +
      tag('p:nvPr'),
  );
  const spPr = tag(
    'p:spPr',
    {},
    xfrm(box, el.rotation) +
      tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst')) +
      lineXml(el.style?.stroke, el.style?.opacity) +
      effectXml(el.style?.shadow),
  );
  return tag('p:pic', {}, nv + blip + spPr);
}

function describeAsset(doc: Doc, ref: string): string {
  const asset = doc.assets[ref];
  return asset ? `${asset.mime} not embedded` : 'missing image';
}

/**
 * A dashed frame with a label, drawn where a picture could not be embedded. The layout
 * still shows where the graphic was, and the slide says so in words rather than leaving a
 * hole the user has to discover.
 */
function placeholderXml(ctx: SlideContext, box: Box, rotation: number | undefined, label: string): string {
  const id = ctx.nextId();
  const spPr = tag(
    'p:spPr',
    {},
    xfrm(box, rotation) +
      tag('a:prstGeom', { prst: 'rect' }, tag('a:avLst')) +
      tag('a:solidFill', {}, colorXml(PLACEHOLDER_FILL)) +
      tag(
        'a:ln',
        { w: emu(PLACEHOLDER_LINE_WIDTH), cap: 'flat', cmpd: 'sng', algn: 'ctr' },
        tag('a:solidFill', {}, colorXml(PLACEHOLDER_LINE)) + tag('a:prstDash', { val: 'dash' }),
      ),
  );
  const paragraph: Paragraph = {
    align: 'center',
    runs: [{ text: label, size: PLACEHOLDER_TEXT_SIZE, color: PLACEHOLDER_TEXT, font: 'Arial' }],
  };
  const body = txBodyXml(ctx, [paragraph], bodyPrXml(undefined, 'middle', undefined), 'p:txBody');
  return tag('p:sp', {}, nvSpPr(id, `Picture placeholder ${id}`, true) + spPr + body);
}

interface CellAnchor {
  cell: TableCell;
  row: number;
  column: number;
}

function positionKey(row: number, column: number): string {
  return `${row}|${column}`;
}

/**
 * Which cell owns each grid position. A cell that carries its own content always owns its
 * own position — a span is only allowed to claim positions that nothing else has claimed,
 * so a malformed span can never swallow a neighbour's text.
 */
function coverageMap(table: Table, columns: number): Map<string, CellAnchor> {
  const anchors = new Map<string, CellAnchor>();
  const owners: CellAnchor[] = [];

  table.rows.forEach((row, r) => {
    for (const cell of row.cells) {
      if (cell.covered) continue;
      const c = cell.column;
      if (c < 0 || c >= columns) continue;
      const key = positionKey(r, c);
      if (anchors.has(key)) continue;
      const anchor: CellAnchor = { cell, row: r, column: c };
      anchors.set(key, anchor);
      owners.push(anchor);
    }
  });

  for (const anchor of owners) {
    const lastRow = anchor.row + Math.max(1, anchor.cell.rowSpan);
    const lastColumn = anchor.column + Math.max(1, anchor.cell.colSpan);
    for (let r = anchor.row; r < lastRow && r < table.rows.length; r++) {
      for (let c = anchor.column; c < lastColumn && c < columns; c++) {
        const key = positionKey(r, c);
        if (!anchors.has(key)) anchors.set(key, anchor);
      }
    }
  }
  return anchors;
}

/**
 * A table.
 *
 * Every grid position gets an `a:tc`: DrawingML represents a merge by marking the covered
 * positions with `hMerge`/`vMerge`, not by leaving them out, and a row with fewer cells
 * than the grid has columns is what makes PowerPoint offer to repair the file. The model's
 * `covered` flag says which positions those are, and the content is written only on the
 * cell that owns it.
 */
function tableXml(ctx: SlideContext, el: Table): string {
  const box = boxOf(el);
  const widths = el.columnWidths.length > 0 ? el.columnWidths : [el.width];
  const columns = widths.length;
  const fallbackHeight = el.rows.length > 0 ? box.height / el.rows.length : box.height;

  if (el.style?.shadow) {
    warn(
      ctx,
      'SHADOW_DROPPED',
      'PowerPoint cannot put a drop shadow on a table, so a table shadow was dropped. The ' +
        'table itself came across in full.',
    );
  }
  if (el.rotation) {
    warn(
      ctx,
      'ROTATED_TEXT_APPROXIMATED',
      'PowerPoint cannot rotate a table, so a rotated table is placed upright in the same ' +
        'position.',
    );
  }

  const anchors = coverageMap(el, columns);
  const grid = tag('a:tblGrid', {}, widths.map((w) => tag('a:gridCol', { w: extentEmu(w) })).join(''));

  let rowsXml = '';
  el.rows.forEach((row, r) => {
    let cells = '';
    for (let c = 0; c < columns; c++) {
      const anchor = anchors.get(positionKey(r, c));
      const isOwner = anchor !== undefined && anchor.row === r && anchor.column === c;
      const hMerge = anchor !== undefined && c > anchor.column;
      const vMerge = anchor !== undefined && r > anchor.row;
      const spanColumns = anchor ? Math.max(1, anchor.cell.colSpan) : 1;
      const spanRows = anchor ? Math.max(1, anchor.cell.rowSpan) : 1;

      const style = (isOwner ? anchor.cell.style : undefined) ?? el.style;
      cells += tag(
        'a:tc',
        {
          gridSpan: !hMerge && spanColumns > 1 ? spanColumns : undefined,
          rowSpan: !vMerge && spanRows > 1 ? spanRows : undefined,
          hMerge: hMerge ? 1 : undefined,
          vMerge: vMerge ? 1 : undefined,
        },
        txBodyXml(ctx, isOwner ? anchor.cell.paragraphs : [], tag('a:bodyPr'), 'a:txBody') +
          cellPropsXml(ctx, style),
      );
    }
    rowsXml += tag('a:tr', { h: extentEmu(row.height ?? fallbackHeight) }, cells);
  });

  const tbl = tag(
    'a:tbl',
    {},
    tag('a:tblPr', { firstRow: 0, bandRow: 0 }, tag('a:tableStyleId', {}, TABLE_STYLE_NO_GRID)) +
      grid +
      rowsXml,
  );

  const id = ctx.nextId();
  return tag(
    'p:graphicFrame',
    {},
    tag(
      'p:nvGraphicFramePr',
      {},
      tag('p:cNvPr', { id, name: `Table ${id}` }) +
        tag('p:cNvGraphicFramePr', {}, tag('a:graphicFrameLocks', { noGrp: 1 })) +
        tag('p:nvPr'),
    ) +
      xfrm(box, el.rotation, { tagName: 'p:xfrm' }) +
      tag(
        'a:graphic',
        {},
        tag(
          'a:graphicData',
          { uri: 'http://schemas.openxmlformats.org/drawingml/2006/table' },
          tbl,
        ),
      ),
  );
}

/**
 * `a:tcPr`: cell margins, plus an explicit fill and explicit borders. The borders are
 * emitted even when there are none, because a cell that says nothing inherits the table
 * style's grid — and a grid Publisher never drew is an invented line, not a fidelity win.
 */
function cellPropsXml(ctx: SlideContext, style: ShapeStyle | undefined): string {
  const margin = emu(CELL_MARGIN_POINTS);
  const sides = (['a:lnL', 'a:lnR', 'a:lnT', 'a:lnB'] as const)
    .map((side) => lineXml(style?.stroke, style?.opacity, side))
    .join('');
  return tag(
    'a:tcPr',
    { marL: margin, marR: margin, marT: margin, marB: margin, anchor: 't' },
    sides + fillXml(ctx, style?.fill, style?.opacity),
  );
}

/**
 * A group. The model keeps children in page coordinates, so the group's child coordinate
 * space is declared identical to its own frame: `chOff`/`chExt` mirror `off`/`ext` and
 * the children need no translation. A rotation on the group then turns the whole set
 * about its centre, exactly as the model means it.
 */
function groupXml(ctx: SlideContext, el: Group): string {
  const id = ctx.nextId();
  const box = boxOf(el);
  const frame = xfrm(box, el.rotation, { childSpace: true });

  // A group's own fill is not painted by PowerPoint; the SVG emitter backs it with a
  // rectangle and so do we, so both emitters show the same thing.
  const fill = el.style?.fill;
  const backing = fill && fill.type !== 'none'
    ? shapeXml(ctx, { kind: 'shape', ...box, geometry: { type: 'rect' }, style: el.style })
    : '';

  const children = backing + el.children.map((child) => elementXml(ctx, child)).join('');
  return tag(
    'p:grpSp',
    {},
    tag(
      'p:nvGrpSpPr',
      {},
      tag('p:cNvPr', { id, name: `Group ${id}` }) + tag('p:cNvGrpSpPr') + tag('p:nvPr'),
    ) +
      tag('p:grpSpPr', {}, frame) +
      children,
  );
}

function elementXml(ctx: SlideContext, el: Element): string {
  switch (el.kind) {
    case 'text': return textBoxXml(ctx, el);
    case 'table': return tableXml(ctx, el);
    case 'image': return pictureXml(ctx, el);
    case 'shape': return shapeXml(ctx, el);
    case 'group': return groupXml(ctx, el);
  }
}

// ---------------------------------------------------------------------------
// Slide parts
// ---------------------------------------------------------------------------

/** The header every shape tree starts with; id 1 is the tree itself. */
function shapeTreeHeader(): string {
  return (
    tag(
      'p:nvGrpSpPr',
      {},
      tag('p:cNvPr', { id: 1, name: '' }) + tag('p:cNvGrpSpPr') + tag('p:nvPr'),
    ) +
    tag(
      'p:grpSpPr',
      {},
      tag(
        'a:xfrm',
        {},
        tag('a:off', { x: 0, y: 0 }) +
          tag('a:ext', { cx: 0, cy: 0 }) +
          tag('a:chOff', { x: 0, y: 0 }) +
          tag('a:chExt', { cx: 0, cy: 0 }),
      ),
    )
  );
}

function slideXml(doc: Doc, page: Page, index: number, media: MediaLibrary, warnings: WarningLog): {
  xml: string;
  rels: Rels;
} {
  const rels = new Rels();
  rels.add(REL.slideLayout, '../slideLayouts/slideLayout1.xml');

  let id = 1;
  const ctx: SlideContext = {
    doc,
    rels,
    media,
    warnings,
    page: index + 1,
    nextId: () => ++id,
  };

  // Array order is z-order, in the model and in a shape tree alike.
  const body = page.elements.map((el) => elementXml(ctx, el)).join('');
  const xml = part(
    `<p:sld ${PML_NS}>` +
      tag('p:cSld', {}, tag('p:spTree', {}, shapeTreeHeader() + body)) +
      tag('p:clrMapOvr', {}, tag('a:masterClrMapping')) +
      '</p:sld>',
  );
  return { xml, rels };
}

function slideLayoutXml(): string {
  return part(
    `<p:sldLayout ${PML_NS} type="blank" preserve="1">` +
      tag(
        'p:cSld',
        { name: 'Blank' },
        tag('p:spTree', {}, shapeTreeHeader()),
      ) +
      tag('p:clrMapOvr', {}, tag('a:masterClrMapping')) +
      '</p:sldLayout>',
  );
}

/**
 * The slide master. It holds no placeholders, because a converted page is a set of boxes
 * at fixed positions rather than a title-and-body layout, and a placeholder the user did
 * not ask for would appear on every slide. Its text styles are defaults nothing inherits:
 * every run written by this emitter carries its own size and typeface.
 */
function slideMasterXml(layoutRelId: string): string {
  const textStyle = (size: number) =>
    tag(
      'a:lvl1pPr',
      {},
      tag('a:defRPr', { sz: size * FONT_SIZE_UNITS_PER_POINT }, tag('a:latin', { typeface: '+mn-lt' })),
    );
  return part(
    `<p:sldMaster ${PML_NS}>` +
      tag(
        'p:cSld',
        {},
        tag('p:bg', {}, tag('p:bgPr', {}, tag('a:solidFill', {}, colorXml('#ffffff')) + tag('a:effectLst'))) +
          tag('p:spTree', {}, shapeTreeHeader()),
      ) +
      tag('p:clrMap', {
        bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2',
        accent1: 'accent1', accent2: 'accent2', accent3: 'accent3',
        accent4: 'accent4', accent5: 'accent5', accent6: 'accent6',
        hlink: 'hlink', folHlink: 'folHlink',
      }) +
      tag('p:sldLayoutIdLst', {}, tag('p:sldLayoutId', { id: SLIDE_LAYOUT_ID, 'r:id': layoutRelId })) +
      tag(
        'p:txStyles',
        {},
        tag('p:titleStyle', {}, textStyle(44)) +
          tag('p:bodyStyle', {}, textStyle(18)) +
          tag('p:otherStyle', {}, textStyle(12)),
      ) +
      '</p:sldMaster>',
  );
}

/**
 * The theme.
 *
 * Nothing this emitter writes refers to it: every colour is an explicit `a:srgbClr` and
 * every run names its own typeface, because a converted publication has no theme of its
 * own to map onto and inventing one would change colours the user picked. The part exists
 * because a slide master must relate to a theme, and PowerPoint validates its contents —
 * the three fill, line and effect styles below are required to be exactly three.
 */
function themeXml(): string {
  const color = (name: string, hex: string) => tag(`a:${name}`, {}, colorXml(hex));
  const clrScheme = tag(
    'a:clrScheme',
    { name: 'Pubshift' },
    tag('a:dk1', {}, tag('a:sysClr', { val: 'windowText', lastClr: '000000' })) +
      tag('a:lt1', {}, tag('a:sysClr', { val: 'window', lastClr: 'FFFFFF' })) +
      color('dk2', '#44546a') +
      color('lt2', '#e7e6e6') +
      color('accent1', '#4472c4') +
      color('accent2', '#ed7d31') +
      color('accent3', '#a5a5a5') +
      color('accent4', '#ffc000') +
      color('accent5', '#5b9bd5') +
      color('accent6', '#70ad47') +
      color('hlink', '#0563c1') +
      color('folHlink', '#954f72'),
  );
  const font = (name: 'a:majorFont' | 'a:minorFont', typeface: string) =>
    tag(
      name,
      {},
      tag('a:latin', { typeface }) + tag('a:ea', { typeface: '' }) + tag('a:cs', { typeface: '' }),
    );
  const fontScheme = tag(
    'a:fontScheme',
    { name: 'Pubshift' },
    font('a:majorFont', 'Calibri Light') + font('a:minorFont', 'Calibri'),
  );

  const solid = tag('a:solidFill', {}, tag('a:schemeClr', { val: 'phClr' }));
  const line = (w: number) =>
    tag(
      'a:ln',
      { w, cap: 'flat', cmpd: 'sng', algn: 'ctr' },
      solid + tag('a:prstDash', { val: 'solid' }) + tag('a:miter', { lim: 800000 }),
    );
  const fmtScheme = tag(
    'a:fmtScheme',
    { name: 'Pubshift' },
    tag('a:fillStyleLst', {}, solid + solid + solid) +
      tag('a:lnStyleLst', {}, line(6350) + line(12700) + line(19050)) +
      tag(
        'a:effectStyleLst',
        {},
        tag('a:effectStyle', {}, tag('a:effectLst')).repeat(3),
      ) +
      tag('a:bgFillStyleLst', {}, solid + solid + solid),
  );

  return part(
    `<a:theme xmlns:a="${NS_A}" name="Pubshift">` +
      tag('a:themeElements', {}, clrScheme + fontScheme + fmtScheme) +
      tag('a:objectDefaults') +
      tag('a:extraClrSchemeLst') +
      '</a:theme>',
  );
}

/**
 * `slideRelIds` and `masterRelId` come from the relationship part itself rather than being
 * assumed, because the slide order in `p:sldIdLst` is the deck's page order and a guessed
 * `r:id` is how a deck silently loses or reorders a page.
 */
function presentationXml(
  slideRelIds: string[],
  masterRelId: string,
  size: { cx: number; cy: number },
): string {
  const masterId = tag(
    'p:sldMasterIdLst',
    {},
    tag('p:sldMasterId', { id: SLIDE_MASTER_ID, 'r:id': masterRelId }),
  );
  let sldIdLst = '';
  slideRelIds.forEach((rId, i) => {
    // Slide ids start at 256 by convention and must be unique within the deck.
    sldIdLst += tag('p:sldId', { id: FIRST_SLIDE_ID + i, 'r:id': rId });
  });
  // Notes pages are the slide turned portrait; nothing references them, but the element
  // is required by the schema.
  const notes = tag('p:notesSz', { cx: size.cy, cy: size.cx });
  return part(
    `<p:presentation ${PML_NS} saveSubsetFonts="1">` +
      masterId +
      tag('p:sldIdLst', {}, sldIdLst) +
      tag('p:sldSz', { cx: size.cx, cy: size.cy }) +
      notes +
      '</p:presentation>',
  );
}

function contentTypesXml(slides: number, extensions: Set<string>): string {
  let body =
    tag('Default', { Extension: 'rels', ContentType: CONTENT_TYPE.rels }) +
    tag('Default', { Extension: 'xml', ContentType: CONTENT_TYPE.xml });
  for (const ext of [...extensions].sort()) {
    body += tag('Default', { Extension: ext, ContentType: IMAGE_CONTENT_TYPE[ext] ?? 'application/octet-stream' });
  }
  body +=
    tag('Override', { PartName: '/ppt/presentation.xml', ContentType: CONTENT_TYPE.presentation }) +
    tag('Override', { PartName: '/ppt/slideMasters/slideMaster1.xml', ContentType: CONTENT_TYPE.slideMaster }) +
    tag('Override', { PartName: '/ppt/slideLayouts/slideLayout1.xml', ContentType: CONTENT_TYPE.slideLayout }) +
    tag('Override', { PartName: '/ppt/theme/theme1.xml', ContentType: CONTENT_TYPE.theme }) +
    tag('Override', { PartName: '/ppt/presProps.xml', ContentType: CONTENT_TYPE.presProps }) +
    tag('Override', { PartName: '/ppt/tableStyles.xml', ContentType: CONTENT_TYPE.tableStyles }) +
    tag('Override', { PartName: '/docProps/core.xml', ContentType: CONTENT_TYPE.core }) +
    tag('Override', { PartName: '/docProps/app.xml', ContentType: CONTENT_TYPE.app });
  for (let i = 1; i <= slides; i++) {
    body += tag('Override', { PartName: `/ppt/slides/slide${i}.xml`, ContentType: CONTENT_TYPE.slide });
  }
  return part(
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${body}</Types>`,
  );
}

/** ISO-8601 with a timezone, which `dcterms:W3CDTF` requires — or nothing. */
function w3cdtf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function corePropsXml(doc: Doc): string {
  const meta = doc.meta;
  const created = w3cdtf(meta.created);
  let body = '';
  if (meta.title) body += tag('dc:title', {}, esc(meta.title));
  if (meta.subject) body += tag('dc:subject', {}, esc(meta.subject));
  if (meta.creator) body += tag('dc:creator', {}, esc(meta.creator));
  if (meta.keywords) body += tag('cp:keywords', {}, esc(meta.keywords));
  if (meta.description) body += tag('dc:description', {}, esc(meta.description));
  if (created) {
    body += tag('dcterms:created', { 'xsi:type': 'dcterms:W3CDTF' }, esc(created));
  }
  return part(
    '<cp:coreProperties ' +
      'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
      'xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      body +
      '</cp:coreProperties>',
  );
}

function appPropsXml(doc: Doc): string {
  const source = doc.meta.sourceVersion
    ? tag('Company', {}, esc(`Converted from Microsoft Publisher ${doc.meta.sourceVersion}`))
    : '';
  return part(
    '<Properties ' +
      'xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
      tag('Application', {}, 'Pubshift') +
      tag('PresentationFormat', {}, 'Custom') +
      tag('Slides', {}, String(doc.pages.length)) +
      tag('ScaleCrop', {}, 'false') +
      tag('LinksUpToDate', {}, 'false') +
      tag('SharedDoc', {}, 'false') +
      tag('HyperlinksChanged', {}, 'false') +
      source +
      '</Properties>',
  );
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface PPTXResult {
  bytes: Uint8Array;
  /**
   * What PowerPoint could not be told. These are the emitter's own losses; `doc.warnings`
   * holds the ones the reader already knew about, and a caller shows both.
   */
  warnings: Warning[];
}

/**
 * Converts a document to a PowerPoint deck: one slide per page, at the page's own size.
 *
 * Throws `RangeError` for a document with no pages rather than producing a deck with no
 * slides — an empty file that opens is the failure mode this product exists to prevent,
 * and `assess()` is the gate that should have caught it first.
 */
export async function emitPPTXWithReport(doc: Doc): Promise<PPTXResult> {
  if (doc.pages.length === 0) {
    throw new RangeError('cannot build a presentation from a document with no pages');
  }

  const warnings = new WarningLog();
  const media = new MediaLibrary();

  // A deck has one slide size; the model allows one per page. Page 1 sets the size and any
  // page that disagrees is reported by number rather than silently rescaled.
  const first = doc.pages[0] as Page;
  const size = {
    cx: clamp(emu(first.width), MIN_SLIDE_EMU, MAX_SLIDE_EMU),
    cy: clamp(emu(first.height), MIN_SLIDE_EMU, MAX_SLIDE_EMU),
  };
  doc.pages.forEach((page, i) => {
    if (i > 0 && (page.width !== first.width || page.height !== first.height)) {
      warnings.add(
        'SHAPE_APPROXIMATED',
        'This publication mixes page sizes. A PowerPoint file has one slide size for the ' +
          'whole deck, so every slide uses the size of page 1 and this page keeps its ' +
          'original positions on that canvas.',
        i + 1,
      );
    }
  });

  const zip = new JSZip();
  const write = (path: string, content: string) => zip.file(path, content, ZIP_OPTIONS);

  const rootRels = new Rels();
  rootRels.add(REL.officeDocument, 'ppt/presentation.xml');
  rootRels.add(REL.coreProperties, 'docProps/core.xml');
  rootRels.add(REL.extendedProperties, 'docProps/app.xml');

  const presentationRels = new Rels();
  const masterRelId = presentationRels.add(REL.slideMaster, 'slideMasters/slideMaster1.xml');
  const slideRelIds = doc.pages.map((_, i) => presentationRels.add(REL.slide, `slides/slide${i + 1}.xml`));
  presentationRels.add(REL.presProps, 'presProps.xml');
  presentationRels.add(REL.tableStyles, 'tableStyles.xml');
  presentationRels.add(REL.theme, 'theme/theme1.xml');

  doc.pages.forEach((page, i) => {
    const { xml, rels } = slideXml(doc, page, i, media, warnings);
    write(`ppt/slides/slide${i + 1}.xml`, xml);
    write(`ppt/slides/_rels/slide${i + 1}.xml.rels`, rels.xml());
  });

  const masterRels = new Rels();
  const layoutRelId = masterRels.add(REL.slideLayout, '../slideLayouts/slideLayout1.xml');
  masterRels.add(REL.theme, '../theme/theme1.xml');

  const layoutRels = new Rels();
  layoutRels.add(REL.slideMaster, '../slideMasters/slideMaster1.xml');

  write('[Content_Types].xml', contentTypesXml(doc.pages.length, media.extensions));
  write('_rels/.rels', rootRels.xml());
  write('docProps/core.xml', corePropsXml(doc));
  write('docProps/app.xml', appPropsXml(doc));
  write('ppt/presentation.xml', presentationXml(slideRelIds, masterRelId, size));
  write('ppt/_rels/presentation.xml.rels', presentationRels.xml());
  write('ppt/presProps.xml', part(`<p:presProps ${PML_NS}/>`));
  write('ppt/tableStyles.xml', part(`<a:tblStyleLst xmlns:a="${NS_A}" def="${TABLE_STYLE_NO_GRID}"/>`));
  write('ppt/theme/theme1.xml', themeXml());
  write('ppt/slideMasters/slideMaster1.xml', slideMasterXml(layoutRelId));
  write('ppt/slideMasters/_rels/slideMaster1.xml.rels', masterRels.xml());
  write('ppt/slideLayouts/slideLayout1.xml', slideLayoutXml());
  write('ppt/slideLayouts/_rels/slideLayout1.xml.rels', layoutRels.xml());

  for (const file of media.files) {
    zip.file(file.path, file.base64, { ...ZIP_OPTIONS, base64: true });
  }

  const bytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return { bytes, warnings: warnings.list() };
}

/** Converts a document to a PowerPoint deck. See {@link emitPPTXWithReport} for the losses. */
export async function emitPPTX(doc: Doc): Promise<Uint8Array> {
  return (await emitPPTXWithReport(doc)).bytes;
}
