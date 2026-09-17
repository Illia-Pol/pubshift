/**
 * The Pubshift document model.
 *
 * Every emitter targets this, and only this. It is deliberately a *page of
 * absolutely-positioned boxes* — which is what a Publisher document actually is —
 * rather than a flowing document, because flattening to a flow is exactly the
 * loss we are selling protection against.
 *
 * All geometry is in POINTS (72 per inch), origin at the page's top-left.
 * All colours are `#rrggbb`. All angles are degrees, clockwise.
 */

export interface Doc {
  pages: Page[];
  meta: DocMeta;
  /** Content-addressed binaries referenced by `Image.assetRef`. */
  assets: Record<string, Asset>;
  /** Non-fatal fidelity losses, surfaced to the user rather than hidden. */
  warnings: Warning[];
}

export interface DocMeta {
  title?: string;
  creator?: string;
  subject?: string;
  description?: string;
  keywords?: string;
  created?: string;
  sourceVersion?: string;
}

export interface Asset {
  /** Raw bytes, base64. */
  data: string;
  mime: string;
}

export interface Page {
  width: number;
  height: number;
  elements: Element[];
}

export type Element = TextBox | Table | Image | Shape | Group;

interface Base {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees clockwise about the box centre. */
  rotation?: number;
  style?: ShapeStyle;
}

export interface TextBox extends Base {
  kind: 'text';
  paragraphs: Paragraph[];
  padding?: { top: number; right: number; bottom: number; left: number };
  verticalAlign?: 'top' | 'middle' | 'bottom';
  columns?: { count: number; gap: number };
}

export interface Table extends Base {
  kind: 'table';
  columnWidths: number[];
  rows: TableRow[];
}

export interface TableRow {
  height?: number;
  cells: TableCell[];
}

export interface TableCell {
  row: number;
  column: number;
  rowSpan: number;
  colSpan: number;
  /** True for cells covered by another cell's span; emitters merge rather than draw. */
  covered: boolean;
  paragraphs: Paragraph[];
  style?: ShapeStyle;
}

export interface Image extends Base {
  kind: 'image';
  assetRef: string;
}

export interface Shape extends Base {
  kind: 'shape';
  geometry: Geometry;
}

export interface Group extends Base {
  kind: 'group';
  children: Element[];
}

export type Geometry =
  | { type: 'rect'; rx?: number; ry?: number }
  | { type: 'ellipse' }
  | { type: 'polygon'; points: Point[] }
  | { type: 'polyline'; points: Point[] }
  | { type: 'path'; d: PathCommand[] };

export interface Point { x: number; y: number }

export type PathCommand =
  | { op: 'M' | 'L'; x: number; y: number }
  | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'Q'; x1: number; y1: number; x: number; y: number }
  | { op: 'A'; rx: number; ry: number; rotation: number; largeArc: boolean; sweep: boolean; x: number; y: number }
  | { op: 'Z' };

export interface ShapeStyle {
  fill?: Fill;
  stroke?: Stroke;
  shadow?: Shadow;
  /** 0..1 */
  opacity?: number;
}

export type Fill =
  | { type: 'none' }
  | { type: 'solid'; color: string }
  | { type: 'gradient'; angle: number; stops: GradientStop[] }
  | { type: 'image'; assetRef: string; repeat: 'stretch' | 'repeat' | 'none' };

export interface GradientStop { offset: number; color: string; opacity?: number }

export interface Stroke {
  color: string;
  width: number;
  dash?: number[];
}

export interface Shadow {
  color: string;
  offsetX: number;
  offsetY: number;
  opacity: number;
}

export interface Paragraph {
  runs: Run[];
  align?: 'left' | 'center' | 'right' | 'justify';
  /** Multiplier: 1.15 means 115%. */
  lineHeight?: number;
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  textIndent?: number;
  list?: { type: 'ordered' | 'unordered'; level: number };
}

export interface Run {
  text: string;
  font?: string;
  /** Points. */
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  smallCaps?: boolean;
  allCaps?: boolean;
  color?: string;
  /** Vertical position as a percentage of font size; positive = superscript. */
  baselineShift?: number;
  link?: string;
  lang?: string;
  /** Publisher's outline / emboss / engrave / shadow effects, and character width scaling. */
  outline?: boolean;
  relief?: 'embossed' | 'engraved';
  textShadow?: boolean;
  /** Horizontal glyph scaling as a true percentage: 80 means 80% width. */
  textScale?: number;
}

export interface Warning {
  code: WarningCode;
  message: string;
  page?: number;
  count?: number;
}

export type WarningCode =
  | 'ROTATED_TEXT_APPROXIMATED'
  | 'GRADIENT_FLATTENED'
  | 'WMF_IMAGE_NOT_CONVERTED'
  | 'SHADOW_DROPPED'
  | 'COLUMNS_FLATTENED'
  | 'FONT_NOT_EMBEDDED'
  | 'SHAPE_APPROXIMATED'
  | 'TABLE_IN_UNSUPPORTED_TARGET'
  | 'OVERLAP_MAY_REFLOW';

export type TargetFormat = 'docx' | 'pptx' | 'pdf' | 'svg';
