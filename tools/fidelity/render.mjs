#!/usr/bin/env node
// Render diff for SVG output.
//
// Two modes. Pixel mode rasterises both SVGs in a headless browser and reports the
// fraction of differing pixels; it needs Playwright, which is NOT installed here and
// which this tool will never install for you. Structural mode needs nothing, works
// today, and is what actually runs: it compares element counts, path command mix,
// text, colour histograms and the composed bounding box.
//
// Structural mode is not a substitute for pixel mode — it cannot see a glyph shifted
// by 2pt — but it does catch the failures that matter early: dropped elements, lost
// text, collapsed geometry, wrong colours, a page laid out at the wrong scale.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';

// ---------------------------------------------------------------- rasteriser

let _rasteriser = null;

/** Probes for Playwright without ever triggering an install. */
export function detectRasteriser() {
  if (_rasteriser) return _rasteriser;
  const probe = spawnSync('npx', ['--no-install', 'playwright', '--version'], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  const version = /Version (\d+\.\d+\.\d+)/.exec(out)?.[1] ?? /playwright[ @v]*(\d+\.\d+\.\d+)/i.exec(out)?.[1];
  if (probe.status === 0 && version) {
    _rasteriser = { available: true, engine: 'playwright', version };
  } else {
    _rasteriser = {
      available: false,
      engine: null,
      reason:
        probe.error?.message ??
        'playwright is not installed in this workspace (probed with `npx --no-install playwright --version`)',
    };
  }
  return _rasteriser;
}

/**
 * Rasterises an SVG string to a PNG buffer. Returns null when no rasteriser is
 * available — callers fall back to structural comparison.
 */
export async function rasterise(svg, { width = 816, height = 1056, deviceScaleFactor = 1 } = {}) {
  const r = detectRasteriser();
  if (!r.available) return null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor });
    await page.setContent(
      `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#fff}` +
        `svg{display:block}</style>${svg}`,
      { waitUntil: 'load' },
    );
    return await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width, height } });
  } finally {
    await browser.close();
  }
}

/**
 * Pixel diff, done inside the browser so Node needs no PNG decoder.
 * @returns {{mode:'pixel', differing:number, total:number, ratio:number, match:boolean}}
 */
export async function comparePixels(svgA, svgB, { width = 816, height = 1056, threshold = 12 } = {}) {
  const r = detectRasteriser();
  if (!r.available) return null;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.setContent('<!doctype html><meta charset="utf-8"><body>', { waitUntil: 'load' });
    const result = await page.evaluate(
      async ([a, b, w, h, thr]) => {
        const draw = (svg) =>
          new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
              const c = document.createElement('canvas');
              c.width = w;
              c.height = h;
              const ctx = c.getContext('2d');
              ctx.fillStyle = '#fff';
              ctx.fillRect(0, 0, w, h);
              ctx.drawImage(img, 0, 0, w, h);
              resolve(ctx.getImageData(0, 0, w, h).data);
            };
            img.onerror = () => reject(new Error('svg failed to load as an image'));
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
          });
        const [da, db] = await Promise.all([draw(a), draw(b)]);
        let differing = 0;
        for (let i = 0; i < da.length; i += 4) {
          const d =
            Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
          if (d > thr) differing++;
        }
        return { differing, total: da.length / 4 };
      },
      [svgA, svgB, width, height, threshold],
    );
    const ratio = result.total ? result.differing / result.total : 0;
    return { mode: 'pixel', ...result, ratio, match: ratio <= 0.001 };
  } finally {
    await browser.close();
  }
}

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
  return { ...structural, pixel, rasteriser: r, match: structural.match && pixel.match, pixelComparison: 'ran' };
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
  if (result.pixel) lines.push(`pixels      ${result.pixel.differing}/${result.pixel.total} differ`);
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

async function main(argv) {
  const opt = (n) => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tolerance = opt('--tolerance') !== undefined ? Number(opt('--tolerance')) : 0.5;

  if (argv.includes('--check')) {
    const r = detectRasteriser();
    console.log(JSON.stringify(r, null, 2));
    return 0;
  }
  if (argv.includes('--self-test')) return (await import('./test.mjs')).runSelfTest();

  const files = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.match(/^--(tolerance|record|compare)$/));

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
    console.error('usage: node tools/fidelity/render.mjs <a.svg> <b.svg> [--json] [--tolerance N]');
    console.error('       node tools/fidelity/render.mjs --record base.json <svg...>   # snapshot today');
    console.error('       node tools/fidelity/render.mjs --compare base.json <svg...>  # fail on drift');
    console.error('       node tools/fidelity/render.mjs --check      # rasteriser availability');
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
