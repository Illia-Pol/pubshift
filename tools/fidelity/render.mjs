#!/usr/bin/env node
// Rendering and comparing pages.
//
// Two modes, and the important one is now real. PIXEL mode rasterises documents through
// LibreOffice — which opens .pub, .pptx, .docx, .svg and .pdf, so the same engine draws
// both the original and our conversion of it — and scores the two images against each
// other. STRUCTURAL mode parses SVG markup and compares element counts, path command mix,
// text, colour histograms and the composed bounding box; it needs no external tool and is
// what still runs for SVG-to-SVG work and for baselines.
//
// Structural mode cannot see a glyph shifted by 2pt, which is why it was never enough on
// its own. Pixel mode cannot see that the shifted glyph is still selectable text, which is
// why structural mode did not go away. Every result says which mode produced it, so a green
// run can never be mistaken for a pixel-verified one.
//
//   node tools/fidelity/render.mjs a.svg b.svg          # compare two SVGs
//   node tools/fidelity/render.mjs --render f.pub -o d  # rasterise every page to PNG
//   node tools/fidelity/render.mjs --png a.png b.png    # score two renders, write a diff
//   node tools/fidelity/render.mjs --check              # what the rasteriser can do here

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

import { decodePNG, encodePNG } from './lib/png.mjs';
import { comparePixels as comparePixelBuffers, countInk, describeMetric, THRESHOLDS } from './lib/pixel.mjs';
import {
  convert,
  detectPdftoppm,
  detectSoffice,
  rasterisePDF,
  DEFAULT_DPI,
  DEFAULT_TIMEOUT_MS,
} from './lib/soffice.mjs';

// ---------------------------------------------------------------- rasteriser

/** What LibreOffice will open for us. Anything else has to be converted first. */
const RENDERABLE = new Set(['.pub', '.pptx', '.ppt', '.docx', '.doc', '.odp', '.odt', '.odg', '.svg', '.rtf', '.pdf']);

let _rasteriser = null;

/**
 * Whether a real pixel comparison is possible here, and with what.
 *
 * `available` means LibreOffice can turn a document into a PDF. `pdfRasteriser` names what
 * turns that PDF into one PNG per page — poppler if it is installed, LibreOffice re-importing
 * its own PDF if it is not. The distinction matters: the fallback re-interprets the PDF
 * through Draw's importer instead of rendering it, so its output is not comparable with
 * poppler's and a run must not mix the two.
 */
export function detectRasteriser() {
  if (_rasteriser) return _rasteriser;
  const lo = detectSoffice();
  if (!lo.available) {
    _rasteriser = { available: false, engine: null, version: null, reason: lo.reason };
    return _rasteriser;
  }
  const poppler = detectPdftoppm();
  _rasteriser = {
    available: true,
    engine: 'libreoffice',
    version: lo.version,
    bin: lo.bin,
    pdfRasteriser: poppler.available ? `pdftoppm ${poppler.version}` : 'libreoffice-reimport',
    ...(poppler.available ? {} : { note: `poppler absent (${poppler.reason}); falling back to LibreOffice PDF re-import` }),
  };
  return _rasteriser;
}

/**
 * Every page of a document, as PNG files on disk.
 *
 * `.pdf` skips straight to rasterisation; `.png` is passed through as a one-page render, so
 * a caller can feed it something already rasterised. Everything else goes through
 * LibreOffice to PDF first, because `--convert-to png` silently renders only page one.
 *
 * @param {string} input absolute or cwd-relative path
 * @param {{dpi?:number, outDir?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, pages?:string[], via?:string, ms:number, reason?:string, outDir?:string}>}
 */
export async function renderToPNG(input, { dpi = DEFAULT_DPI, outDir, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  const src = resolve(input);
  const ext = extname(src).toLowerCase();
  const dir = outDir ? resolve(outDir) : mkdtempSync(join(tmpdir(), 'pubshift-render-'));
  mkdirSync(dir, { recursive: true });

  if (ext === '.png') return { ok: true, pages: [src], via: 'passthrough', ms: Date.now() - t0, outDir: dir };

  if (!RENDERABLE.has(ext)) {
    return { ok: false, ms: Date.now() - t0, reason: `no renderer for ${ext || 'a file with no extension'}`, outDir: dir };
  }

  let pdf = src;
  let converted = null;
  if (ext !== '.pdf') {
    converted = await convert(src, 'pdf', join(dir, 'pdf'), { timeoutMs });
    if (!converted.ok) return { ok: false, ms: Date.now() - t0, reason: converted.reason, outDir: dir };
    pdf = converted.path;
  }

  const raster = await rasterisePDF(pdf, join(dir, 'png'), { dpi, timeoutMs });
  if (!raster.ok) return { ok: false, ms: Date.now() - t0, reason: raster.reason, outDir: dir };

  return {
    ok: true,
    pages: raster.pages,
    pdf,
    via: converted ? `libreoffice -> ${raster.via}` : raster.via,
    dpi,
    ms: Date.now() - t0,
    outDir: dir,
  };
}

/**
 * Rasterises an SVG string to a PNG buffer — page one, since one SVG is one page.
 * Returns null when no rasteriser is available, so callers can fall back to structure.
 */
export async function rasterise(svg, { dpi = DEFAULT_DPI, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!detectRasteriser().available) return null;
  const dir = mkdtempSync(join(tmpdir(), 'pubshift-svg-'));
  try {
    const file = join(dir, 'page.svg');
    writeFileSync(file, svg);
    const r = await renderToPNG(file, { dpi, outDir: dir, timeoutMs });
    if (!r.ok) throw new Error(r.reason);
    return readFileSync(r.pages[0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Scores two PNG files against each other and optionally writes the diff image.
 * See `lib/pixel.mjs` for what the number means; `describeMetric()` returns it as data.
 *
 * @returns {{mode:'pixel', score:number, …}} the `comparePixels` result with `diff` replaced
 *   by the path it was written to (or dropped when `diffPath` is not given)
 */
export function comparePNGFiles(a, b, { diffPath, ...opts } = {}) {
  const result = comparePixelBuffers(decodePNG(readFileSync(a)), decodePNG(readFileSync(b)), {
    ...opts,
    diff: Boolean(diffPath),
  });
  const { diff, ...rest } = result;
  if (diffPath && diff) {
    mkdirSync(resolve(diffPath, '..'), { recursive: true });
    writeFileSync(diffPath, encodePNG(diff));
  }
  return { mode: 'pixel', ...rest, ...(diffPath && diff ? { diffPath } : {}) };
}

/**
 * Pixel comparison of two SVG strings: rasterise both through LibreOffice, score the PNGs.
 * Returns null when there is no rasteriser, which is what makes `compareSvg` degrade
 * honestly rather than silently.
 */
export async function comparePixels(svgA, svgB, opts = {}) {
  if (!detectRasteriser().available) return null;
  const dir = mkdtempSync(join(tmpdir(), 'pubshift-pair-'));
  try {
    const a = join(dir, 'a.png');
    const b = join(dir, 'b.png');
    writeFileSync(a, await rasterise(svgA, opts));
    writeFileSync(b, await rasterise(svgB, opts));
    return comparePNGFiles(a, b, opts);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Marks on a rendered page. 0 means the rasteriser produced a blank sheet. */
export function pngInkCount(path) {
  return countInk(decodePNG(readFileSync(path)));
}

export { describeMetric, THRESHOLDS };

// ---------------------------------------------------------------- svg parsing

const SHAPES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path', 'image', 'use', 'text']);

const TAG_RE = /<(\/)?([A-Za-z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/)?>/g;
const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

function stripNoise(svg) {
  return svg
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');
}

function parseAttrs(raw) {
  const out = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw))) out[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

// ---------------------------------------------------------------- transforms

const IDENT = [1, 0, 0, 1, 0, 0];

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function parseTransform(value) {
  if (!value) return IDENT;
  let m = IDENT;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(value))) {
    const n = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
    const rad = (d) => (d * Math.PI) / 180;
    switch (t[1]) {
      case 'matrix':
        if (n.length === 6) m = mul(m, n);
        break;
      case 'translate':
        m = mul(m, [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0]);
        break;
      case 'scale':
        m = mul(m, [n[0] ?? 1, 0, 0, n[1] ?? n[0] ?? 1, 0, 0]);
        break;
      case 'rotate': {
        const a = rad(n[0] ?? 0);
        const r = [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0];
        if (n.length >= 3) m = mul(mul(mul(m, [1, 0, 0, 1, n[1], n[2]]), r), [1, 0, 0, 1, -n[1], -n[2]]);
        else m = mul(m, r);
        break;
      }
      case 'skewX':
        m = mul(m, [1, 0, Math.tan(rad(n[0] ?? 0)), 1, 0, 0]);
        break;
      case 'skewY':
        m = mul(m, [1, Math.tan(rad(n[0] ?? 0)), 0, 1, 0, 0]);
        break;
    }
  }
  return m;
}

// ---------------------------------------------------------------- geometry

const num = (v, fallback = 0) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

function parsePoints(value) {
  const n = (value ?? '').split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
  const pts = [];
  for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
  return pts;
}

const PATH_TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;

/**
 * Returns {points, commands}. Control points are included in `points`, so a bbox built
 * from them is a conservative superset of the true curve bounds — fine for comparing
 * two renderings of the same document, which is all this is used for.
 */
export function parsePath(d) {
  const toks = [];
  PATH_TOKEN.lastIndex = 0;
  let t;
  while ((t = PATH_TOKEN.exec(d ?? ''))) toks.push(t[1] ?? Number(t[2]));

  const points = [];
  const commands = {};
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let cmd = null;

  const push = (x, y) => points.push([x, y]);
  const ARITY = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };

  while (i < toks.length) {
    if (typeof toks[i] === 'string') {
      cmd = toks[i];
      i++;
    } else if (cmd === null) {
      i++;
      continue;
    } else if (cmd === 'M') {
      cmd = 'L';
    } else if (cmd === 'm') {
      cmd = 'l';
    }
    if (cmd === null) continue;

    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const arity = ARITY[up] ?? 0;
    commands[up] = (commands[up] ?? 0) + 1;

    if (up === 'Z') {
      cx = sx;
      cy = sy;
      if (typeof toks[i] === 'number') continue;
      continue;
    }
    if (i + arity > toks.length) break;
    const a = toks.slice(i, i + arity).map(Number);
    i += arity;

    switch (up) {
      case 'M':
      case 'L':
      case 'T': {
        cx = rel ? cx + a[0] : a[0];
        cy = rel ? cy + a[1] : a[1];
        if (up === 'M') {
          sx = cx;
          sy = cy;
        }
        push(cx, cy);
        break;
      }
      case 'H':
        cx = rel ? cx + a[0] : a[0];
        push(cx, cy);
        break;
      case 'V':
        cy = rel ? cy + a[0] : a[0];
        push(cx, cy);
        break;
      case 'C': {
        const bx = rel ? cx : 0;
        const by = rel ? cy : 0;
        push(bx + a[0], by + a[1]);
        push(bx + a[2], by + a[3]);
        cx = bx + a[4];
        cy = by + a[5];
        push(cx, cy);
        break;
      }
      case 'S':
      case 'Q': {
        const bx = rel ? cx : 0;
        const by = rel ? cy : 0;
        push(bx + a[0], by + a[1]);
        cx = bx + a[2];
        cy = by + a[3];
        push(cx, cy);
        break;
      }
      case 'A': {
        const bx = rel ? cx : 0;
        const by = rel ? cy : 0;
        cx = bx + a[5];
        cy = by + a[6];
        push(cx, cy);
        break;
      }
    }
  }
  return { points, commands };
}

function elementPoints(tag, attrs) {
  switch (tag) {
    case 'rect':
    case 'image':
    case 'use':
    case 'svg': {
      const x = num(attrs.x);
      const y = num(attrs.y);
      const w = num(attrs.width);
      const h = num(attrs.height);
      if (!w && !h) return [];
      return [
        [x, y],
        [x + w, y + h],
      ];
    }
    case 'circle': {
      const r = num(attrs.r);
      const x = num(attrs.cx);
      const y = num(attrs.cy);
      return [
        [x - r, y - r],
        [x + r, y + r],
      ];
    }
    case 'ellipse': {
      const rx = num(attrs.rx);
      const ry = num(attrs.ry);
      const x = num(attrs.cx);
      const y = num(attrs.cy);
      return [
        [x - rx, y - ry],
        [x + rx, y + ry],
      ];
    }
    case 'line':
      return [
        [num(attrs.x1), num(attrs.y1)],
        [num(attrs.x2), num(attrs.y2)],
      ];
    case 'polygon':
    case 'polyline':
      return parsePoints(attrs.points);
    case 'path':
      return parsePath(attrs.d).points;
    case 'text':
    case 'tspan':
      return attrs.x !== undefined || attrs.y !== undefined ? [[num(attrs.x), num(attrs.y)]] : [];
    default:
      return [];
  }
}

// ---------------------------------------------------------------- signature

function paintOf(attrs, name) {
  const style = attrs.style ?? '';
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style);
  const v = (m?.[1] ?? attrs[name] ?? '').trim().toLowerCase();
  return v && v !== 'inherit' ? v : null;
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * A comparable fingerprint of an SVG document: what was drawn, where, in what colours,
 * and what it says. No DOM required.
 */
export function structuralSignature(svg) {
  const src = stripNoise(String(svg));
  const stack = [IDENT];
  const elementCounts = {};
  const pathCommands = {};
  const fills = {};
  const strokes = {};
  const fonts = {};
  let totalElements = 0;
  let drawnElements = 0;
  let pointCount = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let root = null;
  const texts = [];
  let inText = 0;

  let last = 0;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(src))) {
    if (inText > 0) {
      const chunk = decodeEntities(src.slice(last, m.index));
      if (chunk.trim()) texts.push(chunk);
    }
    last = TAG_RE.lastIndex;

    const closing = Boolean(m[1]);
    const tag = m[2].replace(/^.*:/, '');
    const selfClosing = Boolean(m[4]);

    if (closing) {
      if (tag === 'text') inText = Math.max(0, inText - 1);
      if (stack.length > 1) stack.pop();
      continue;
    }

    const attrs = parseAttrs(m[3]);
    totalElements++;
    elementCounts[tag] = (elementCounts[tag] ?? 0) + 1;
    if (!root && tag === 'svg') root = attrs;

    const ctm = mul(stack[stack.length - 1], parseTransform(attrs.transform));

    const fill = paintOf(attrs, 'fill');
    if (fill && fill !== 'none') fills[fill] = (fills[fill] ?? 0) + 1;
    const stroke = paintOf(attrs, 'stroke');
    if (stroke && stroke !== 'none') strokes[stroke] = (strokes[stroke] ?? 0) + 1;
    const font = paintOf(attrs, 'font-family');
    if (font) fonts[font] = (fonts[font] ?? 0) + 1;

    if (SHAPES.has(tag)) {
      drawnElements++;
      if (tag === 'path') {
        const { commands } = parsePath(attrs.d);
        for (const [k, v] of Object.entries(commands)) pathCommands[k] = (pathCommands[k] ?? 0) + v;
      }
    }

    if (tag !== 'svg') {
      for (const [px, py] of elementPoints(tag, attrs)) {
        const [x, y] = apply(ctm, px, py);
        pointCount++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    if (tag === 'text' && !selfClosing) inText++;
    if (!selfClosing) stack.push(ctm);
    if (selfClosing && tag === 'text') {
      /* <text/> holds no content */
    }
  }

  const text = norm(texts.join(' '));
  const viewBox = root?.viewBox
    ? root.viewBox.split(/[\s,]+/).filter(Boolean).map(Number)
    : null;

  return {
    viewBox: viewBox && viewBox.length === 4 ? viewBox : null,
    width: root?.width !== undefined ? num(root.width, null) : null,
    height: root?.height !== undefined ? num(root.height, null) : null,
    totalElements,
    drawnElements,
    elementCounts,
    pathCommands,
    pointCount,
    fills,
    strokes,
    fonts,
    textLength: text.length,
    textHash: fnv1a(text),
    text,
    bbox:
      pointCount > 0
        ? {
            x: round(minX),
            y: round(minY),
            width: round(maxX - minX),
            height: round(maxY - minY),
          }
        : null,
  };
}

const round = (n) => Math.round(n * 1000) / 1000;

// ---------------------------------------------------------------- comparison

function histogramSimilarity(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return 1;
  let inter = 0;
  let total = 0;
  for (const k of keys) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    inter += Math.min(x, y);
    total += Math.max(x, y);
  }
  return total === 0 ? 1 : inter / total;
}

function histogramDiff(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[k] ?? 0;
    const y = b[k] ?? 0;
    if (x !== y) out.push({ key: k, a: x, b: y });
  }
  return out.sort((p, q) => Math.abs(q.a - q.b) - Math.abs(p.a - p.b));
}

function bboxDelta(a, b) {
  if (!a && !b) return { delta: 0, fields: [] };
  if (!a || !b) return { delta: Infinity, fields: [{ key: 'bbox', a: a ?? null, b: b ?? null }] };
  const fields = [];
  let delta = 0;
  for (const k of ['x', 'y', 'width', 'height']) {
    const d = Math.abs(a[k] - b[k]);
    delta = Math.max(delta, d);
    if (d > 0) fields.push({ key: `bbox.${k}`, a: a[k], b: b[k], delta: round(d) });
  }
  return { delta: round(delta), fields };
}

/**
 * @param {object} sigA @param {object} sigB
 * @param {{tolerance?:number}} opts tolerance is in user units (points for our output)
 */
export function compareSignatures(sigA, sigB, { tolerance = 0.5 } = {}) {
  const differences = [];
  const add = (severity, field, a, b, note) => differences.push({ severity, field, a, b, ...(note ? { note } : {}) });

  const elementSim = histogramSimilarity(sigA.elementCounts, sigB.elementCounts);
  for (const d of histogramDiff(sigA.elementCounts, sigB.elementCounts)) {
    add(d.a === 0 || d.b === 0 ? 'major' : 'minor', `element:${d.key}`, d.a, d.b);
  }

  const pathSim = histogramSimilarity(sigA.pathCommands, sigB.pathCommands);
  for (const d of histogramDiff(sigA.pathCommands, sigB.pathCommands)) {
    add('minor', `pathCommand:${d.key}`, d.a, d.b);
  }

  const fillSim = histogramSimilarity(sigA.fills, sigB.fills);
  for (const d of histogramDiff(sigA.fills, sigB.fills)) add('minor', `fill:${d.key}`, d.a, d.b);
  const strokeSim = histogramSimilarity(sigA.strokes, sigB.strokes);
  for (const d of histogramDiff(sigA.strokes, sigB.strokes)) add('minor', `stroke:${d.key}`, d.a, d.b);
  const fontSim = histogramSimilarity(sigA.fonts, sigB.fonts);
  for (const d of histogramDiff(sigA.fonts, sigB.fonts)) add('major', `font:${d.key}`, d.a, d.b);

  const textSim =
    sigA.textHash === sigB.textHash
      ? 1
      : sigA.textLength === 0 && sigB.textLength === 0
        ? 1
        : Math.min(sigA.textLength, sigB.textLength) / Math.max(1, Math.max(sigA.textLength, sigB.textLength));
  if (sigA.textHash !== sigB.textHash) {
    add(
      sigA.textLength === sigB.textLength ? 'minor' : 'major',
      'text',
      `${sigA.textLength} chars`,
      `${sigB.textLength} chars`,
      firstTextDivergence(sigA.text, sigB.text),
    );
  }

  const bb = bboxDelta(sigA.bbox, sigB.bbox);
  for (const f of bb.fields) if (f.delta === undefined || f.delta > tolerance) add('major', f.key, f.a, f.b);
  const diag = sigA.bbox ? Math.hypot(sigA.bbox.width, sigA.bbox.height) : 0;
  const bboxSim = !Number.isFinite(bb.delta) ? 0 : diag > 0 ? Math.max(0, 1 - bb.delta / diag) : bb.delta === 0 ? 1 : 0;

  const weights = [
    [elementSim, 3],
    [pathSim, 2],
    [textSim, 3],
    [bboxSim, 3],
    [fillSim, 1],
    [strokeSim, 1],
    [fontSim, 1],
  ];
  const score = weights.reduce((s, [v, w]) => s + v * w, 0) / weights.reduce((s, [, w]) => s + w, 0);

  return {
    mode: 'structural',
    pixelComparison: 'unavailable',
    match: differences.every((d) => d.severity !== 'major') && bb.delta <= tolerance,
    score: round(score),
    similarity: {
      elements: round(elementSim),
      pathCommands: round(pathSim),
      text: round(textSim),
      bbox: round(bboxSim),
      fills: round(fillSim),
      strokes: round(strokeSim),
      fonts: round(fontSim),
    },
    bboxDelta: bb.delta,
    differences,
  };
}

function firstTextDivergence(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  if (i === n && a.length === b.length) return undefined;
  return `diverges at char ${i}: ${JSON.stringify(a.slice(i, i + 40))} vs ${JSON.stringify(b.slice(i, i + 40))}`;
}

/**
 * Ink agreement above which two renders are called a match. Not 1: the rasteriser is
 * deterministic but not bit-exact across page sizes, and a handful of boundary pixels on a
 * 800,000-pixel page is not a fidelity finding. Below this, something moved.
 */
const PIXEL_MATCH_SCORE = 0.995;

/**
 * The entry point emitters should call. Uses pixels when a rasteriser exists and
 * structure otherwise; the result always says which, so a green run can never be
 * mistaken for a pixel-verified one.
 */
export async function compareSvg(svgA, svgB, opts = {}) {
  const sigA = structuralSignature(svgA);
  const sigB = structuralSignature(svgB);
  const structural = compareSignatures(sigA, sigB, opts);
  structural.signatures = { a: sigA, b: sigB };

  const r = detectRasteriser();
  if (!r.available) {
    structural.rasteriser = r;
    return structural;
  }
  const pixel = await comparePixels(svgA, svgB, opts);
  return {
    ...structural,
    pixel,
    rasteriser: r,
    match: structural.match && pixel.score >= PIXEL_MATCH_SCORE,
    pixelComparison: 'ran',
  };
}

// ---------------------------------------------------------------- baselines

// Before/after across time, not just across two files in hand: record the signatures
// of today's output, then fail the day an emitter change moves any of them.

export function recordBaseline(files) {
  const entries = {};
  for (const f of files) entries[basename(f)] = structuralSignature(readFileSync(f, 'utf8'));
  return { generatedAt: new Date().toISOString(), rasteriser: detectRasteriser(), entries };
}

export function compareToBaseline(baseline, files, opts = {}) {
  const results = [];
  for (const f of files) {
    const name = basename(f);
    const before = baseline.entries[name];
    if (!before) {
      results.push({ name, status: 'new', match: false });
      continue;
    }
    const r = compareSignatures(before, structuralSignature(readFileSync(f, 'utf8')), opts);
    results.push({ name, status: r.match ? 'unchanged' : 'CHANGED', ...r });
  }
  const missing = Object.keys(baseline.entries).filter((n) => !files.some((f) => basename(f) === n));
  return { results, missing, pass: missing.length === 0 && results.every((r) => r.match) };
}

// ---------------------------------------------------------------- cli

function summarise(result) {
  const lines = [];
  lines.push(`mode        ${result.mode}${result.pixel ? ' + pixel' : ''}`);
  lines.push(`match       ${result.match ? 'yes' : 'NO'}`);
  lines.push(`score       ${result.score}`);
  if (result.pixel) lines.push(`pixels      ${summarisePixel(result.pixel)}`);
  else lines.push(`pixels      unavailable — ${result.rasteriser?.reason ?? 'no rasteriser'}`);
  for (const [k, v] of Object.entries(result.similarity)) lines.push(`  ${k.padEnd(14)}${v}`);
  if (result.differences.length) {
    lines.push(`differences (${result.differences.length}):`);
    for (const d of result.differences.slice(0, 40)) {
      lines.push(`  [${d.severity}] ${d.field}: ${JSON.stringify(d.a)} -> ${JSON.stringify(d.b)}${d.note ? ` (${d.note})` : ''}`);
    }
  }
  return lines.join('\n');
}

/** One line of prose for a pixel result — the numbers people actually want to read. */
function summarisePixel(p) {
  const d = p.dimensions;
  const size = d.match ? `${d.compared.width}x${d.compared.height}` : `${d.reference.width}x${d.reference.height} vs ${d.candidate.width}x${d.candidate.height} — PAGE SIZE DIFFERS`;
  const curve = Object.entries(p.byRadius).map(([r, s]) => `${r}px ${s}`).join('  ');
  return (
    `ink agreement ${p.score} at ${p.radius}px  (${curve})\n` +
    `            ink ${p.ink.reference} ref / ${p.ink.candidate} out` +
    `, ${p.ink.lost} lost, ${p.ink.recoloured} recoloured\n` +
    `            raw per-pixel ${p.perPixel.exactRatio} exact, ${p.perPixel.tolerantRatio} within ${p.perPixel.channelTolerance}/255  ·  ${size}`
  );
}

async function main(argv) {
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tolerance = opt('--tolerance') !== undefined ? Number(opt('--tolerance')) : 0.5;
  const dpi = opt('--dpi') !== undefined ? Number(opt('--dpi')) : DEFAULT_DPI;

  if (argv.includes('--check')) {
    console.log(JSON.stringify({ rasteriser: detectRasteriser(), metric: describeMetric(), thresholds: THRESHOLDS }, null, 2));
    return 0;
  }
  if (argv.includes('--self-test')) return (await import('./test.mjs')).runSelfTest();

  const files = argv.filter(
    (a, i) => !a.startsWith('-') && !argv[i - 1]?.match(/^(--tolerance|--record|--compare|--dpi|--diff|-o|--out)$/),
  );

  const render = opt('--render');
  if (render !== undefined) {
    const r = await renderToPNG(render, { dpi, outDir: opt('-o') ?? opt('--out') });
    if (!r.ok) {
      console.error(`cannot render ${render}: ${r.reason}`);
      return 1;
    }
    console.log(`${r.pages.length} page(s) via ${r.via} in ${r.ms}ms`);
    for (const p of r.pages) console.log(`  ${p}`);
    return 0;
  }

  if (argv.includes('--png')) {
    if (files.length !== 2) {
      console.error('usage: node tools/fidelity/render.mjs --png <a.png> <b.png> [--diff out.png]');
      return 2;
    }
    const r = comparePNGFiles(files[0], files[1], { diffPath: opt('--diff') });
    if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(summarisePixel(r));
      if (r.diffPath) console.log(`            diff written to ${r.diffPath}`);
    }
    return r.score >= PIXEL_MATCH_SCORE ? 0 : 1;
  }

  const record = opt('--record');
  if (record) {
    writeFileSync(record, JSON.stringify(recordBaseline(files), null, 2) + '\n');
    console.log(`recorded ${files.length} signature(s) to ${record}`);
    return 0;
  }

  const against = opt('--compare');
  if (against) {
    const baseline = JSON.parse(readFileSync(against, 'utf8'));
    const cmp = compareToBaseline(baseline, files, { tolerance });
    for (const r of cmp.results) {
      console.log(`${r.status.padEnd(10)} ${r.name}${r.score !== undefined ? `  score ${r.score}` : ''}`);
      for (const d of r.differences?.slice(0, 10) ?? []) {
        console.log(`             [${d.severity}] ${d.field}: ${JSON.stringify(d.a)} -> ${JSON.stringify(d.b)}`);
      }
    }
    for (const m of cmp.missing) console.log(`MISSING    ${m} — in the baseline, not produced now`);
    return cmp.pass ? 0 : 1;
  }

  if (files.length !== 2) {
    console.error('usage: node tools/fidelity/render.mjs <a.svg> <b.svg> [--json] [--tolerance N] [--dpi N]');
    console.error('       node tools/fidelity/render.mjs --render <file> [-o dir] [--dpi N]  # every page to PNG');
    console.error('       node tools/fidelity/render.mjs --png <a.png> <b.png> [--diff d.png]  # score two renders');
    console.error('       node tools/fidelity/render.mjs --record base.json <svg...>   # snapshot today');
    console.error('       node tools/fidelity/render.mjs --compare base.json <svg...>  # fail on drift');
    console.error('       node tools/fidelity/render.mjs --check      # rasteriser availability and the metric');
    console.error('       node tools/fidelity/render.mjs --self-test  # verify the comparator itself');
    return 2;
  }
  const result = await compareSvg(readFileSync(files[0], 'utf8'), readFileSync(files[1], 'utf8'), { tolerance });
  console.log(argv.includes('--json') ? JSON.stringify(result, null, 2) : summarise(result));
  return result.match ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then((c) => process.exit(c));
}
