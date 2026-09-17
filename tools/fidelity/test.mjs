#!/usr/bin/env node
// Tests for the harness itself. If the oracle is wrong we would never know the
// emitters are wrong, so this runs against real corpus output, not fixtures.
//
//   node tools/fidelity/test.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';
import {
  structuralSignature, compareSignatures, parsePath, detectRasteriser,
  recordBaseline, compareToBaseline, renderToPNG, comparePNGFiles, pngInkCount,
} from './render.mjs';
import { decodePNG, encodePNG, readPNGSize } from './lib/png.mjs';
import { comparePixels, countInk, describeMetric, THRESHOLDS } from './lib/pixel.mjs';
import { emptyProfile, addFile, finalizeProfile } from './lib/profile.mjs';
import { checkCoverage } from './lib/coverage.mjs';
import { extractOne, corpusFiles } from './lib/extract.mjs';
import { alignReferencePages } from './compare.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

const svg = (body, attrs = 'width="200" height="100" viewBox="0 0 200 100"') =>
  `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

// ---------------------------------------------------------------- signature

test('counts elements and drawn shapes', () => {
  const s = structuralSignature(svg('<g><rect x="0" y="0" width="10" height="10"/><circle cx="5" cy="5" r="2"/></g>'));
  assert.equal(s.elementCounts.rect, 1);
  assert.equal(s.elementCounts.circle, 1);
  assert.equal(s.elementCounts.g, 1);
  assert.equal(s.drawnElements, 2);
  assert.deepEqual(s.viewBox, [0, 0, 200, 100]);
  assert.equal(s.width, 200);
});

test('bbox spans every shape', () => {
  const s = structuralSignature(svg('<rect x="10" y="20" width="30" height="40"/><circle cx="100" cy="10" r="5"/>'));
  assert.deepEqual(s.bbox, { x: 10, y: 5, width: 95, height: 55 });
});

test('nested transforms compose into the bbox', () => {
  const plain = structuralSignature(svg('<rect x="10" y="10" width="10" height="10"/>'));
  const moved = structuralSignature(
    svg('<g transform="translate(100,50)"><g transform="scale(2)"><rect x="10" y="10" width="10" height="10"/></g></g>'),
  );
  assert.deepEqual(plain.bbox, { x: 10, y: 10, width: 10, height: 10 });
  assert.deepEqual(moved.bbox, { x: 120, y: 70, width: 20, height: 20 });
});

test('rotate(90) about a point lands where it should', () => {
  const s = structuralSignature(svg('<rect transform="rotate(90 0 0)" x="10" y="0" width="10" height="0"/>'));
  // (10,0) -> (0,10) and (20,0) -> (0,20)
  assert.equal(Math.round(s.bbox.x), 0);
  assert.equal(Math.round(s.bbox.y), 10);
  assert.equal(Math.round(s.bbox.height), 10);
});

test('transform does not leak to the next sibling', () => {
  const s = structuralSignature(
    svg('<g transform="translate(1000,0)"><rect x="0" y="0" width="1" height="1"/></g><rect x="0" y="0" width="2" height="2"/>'),
  );
  assert.equal(s.bbox.x, 0);
  assert.equal(s.bbox.width, 1001);
});

test('reads text content and decodes entities', () => {
  const s = structuralSignature(svg('<text x="5" y="5">Bold &amp; <tspan>beautiful</tspan></text>'));
  assert.equal(s.text, 'Bold & beautiful');
  assert.equal(s.textLength, 16);
});

test('picks paint up from attributes and from style', () => {
  const s = structuralSignature(
    svg('<rect fill="#FF0000" stroke="#00ff00" width="1" height="1"/><path style="fill:#ff0000;stroke:none" d="M0 0L1 1"/>'),
  );
  assert.equal(s.fills['#ff0000'], 2);
  assert.equal(s.strokes['#00ff00'], 1);
  assert.equal(Object.keys(s.strokes).length, 1, 'stroke:none must not be counted');
});

test('self-closing and comment-laden markup parses', () => {
  const s = structuralSignature(svg('<!-- hi --><rect width="1" height="1"/><!-- <rect width="9" height="9"/> -->'));
  assert.equal(s.elementCounts.rect, 1);
});

// ---------------------------------------------------------------- paths

test('path: absolute and relative commands track the current point', () => {
  const { points, commands } = parsePath('M10 10 l10 0 L30 10 h10 v10 Z');
  assert.equal(commands.M, 1);
  assert.equal(commands.L, 2);
  assert.equal(commands.H, 1);
  assert.equal(commands.V, 1);
  assert.equal(commands.Z, 1);
  assert.deepEqual(points[1], [20, 10]);
  assert.deepEqual(points.at(-1), [40, 20]);
});

test('path: implicit lineto after moveto', () => {
  const { commands } = parsePath('M0 0 10 10 20 20');
  assert.equal(commands.M, 1);
  assert.equal(commands.L, 2);
});

test('path: curves and arcs contribute their endpoints', () => {
  const { points, commands } = parsePath('M0 0 C10 0 20 0 30 0 A5 5 0 1 0 40 0');
  assert.equal(commands.C, 1);
  assert.equal(commands.A, 1);
  assert.deepEqual(points.at(-1), [40, 0]);
});

test('path: Z returns to the subpath start', () => {
  const { points } = parsePath('M5 5 L20 20 Z l1 1');
  assert.deepEqual(points.at(-1), [6, 6]);
});

// ---------------------------------------------------------------- comparison

test('identical documents score 1 and match', () => {
  const a = svg('<rect x="1" y="2" width="3" height="4" fill="#123456"/><text x="0" y="0">hi</text>');
  const r = compareSignatures(structuralSignature(a), structuralSignature(a));
  assert.equal(r.score, 1);
  assert.equal(r.match, true);
  assert.equal(r.differences.length, 0);
  assert.equal(r.pixelComparison, 'unavailable');
});

test('a dropped element is a major difference', () => {
  const a = svg('<rect width="10" height="10"/><circle cx="5" cy="5" r="5"/>');
  const b = svg('<rect width="10" height="10"/>');
  const r = compareSignatures(structuralSignature(a), structuralSignature(b));
  assert.equal(r.match, false);
  assert.ok(r.differences.some((d) => d.field === 'element:circle' && d.severity === 'major'));
  assert.ok(r.score < 1);
});

test('lost text is caught even when the geometry is identical', () => {
  const a = svg('<text x="0" y="0">Annual Report 2026</text>');
  const b = svg('<text x="0" y="0">Annual Report</text>');
  const r = compareSignatures(structuralSignature(a), structuralSignature(b));
  assert.equal(r.match, false);
  const d = r.differences.find((x) => x.field === 'text');
  assert.equal(d.severity, 'major');
  assert.match(d.note, /diverges at char 13/);
});

test('text reordered at the same length is a minor difference, not silence', () => {
  const a = svg('<text x="0" y="0">AB</text>');
  const b = svg('<text x="0" y="0">BA</text>');
  const r = compareSignatures(structuralSignature(a), structuralSignature(b));
  assert.ok(r.differences.some((d) => d.field === 'text' && d.severity === 'minor'));
});

test('a shift inside tolerance matches, outside does not', () => {
  const a = svg('<rect x="10" y="10" width="10" height="10"/>');
  const b = svg('<rect x="10.3" y="10" width="10" height="10"/>');
  assert.equal(compareSignatures(structuralSignature(a), structuralSignature(b), { tolerance: 0.5 }).match, true);
  assert.equal(compareSignatures(structuralSignature(a), structuralSignature(b), { tolerance: 0.1 }).match, false);
});

test('a wrong colour shows up without failing the match', () => {
  const a = svg('<rect width="1" height="1" fill="#ff0000"/>');
  const b = svg('<rect width="1" height="1" fill="#00ff00"/>');
  const r = compareSignatures(structuralSignature(a), structuralSignature(b));
  assert.ok(r.differences.some((d) => d.field.startsWith('fill:')));
  assert.ok(r.similarity.fills < 1);
});

test('a substituted font is major', () => {
  const a = svg('<text x="0" y="0" font-family="Times New Roman">x</text>');
  const b = svg('<text x="0" y="0" font-family="Liberation Serif">x</text>');
  const r = compareSignatures(structuralSignature(a), structuralSignature(b));
  assert.equal(r.match, false);
  assert.ok(r.differences.some((d) => d.field.startsWith('font:') && d.severity === 'major'));
});

test('a page scaled by 2 is caught by the bbox', () => {
  const a = svg('<rect x="0" y="0" width="100" height="100"/>');
  const b = svg('<g transform="scale(2)"><rect x="0" y="0" width="100" height="100"/></g>');
  const r = compareSignatures(structuralSignature(a), structuralSignature(b));
  assert.equal(r.match, false);
  assert.equal(r.bboxDelta, 100);
});

// ---------------------------------------------------------------- baselines

test('a baseline round-trips and then catches drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pubshift-fidelity-'));
  const page = join(dir, 'page1.svg');
  writeFileSync(page, svg('<rect x="0" y="0" width="50" height="50" fill="#123456"/><text x="1" y="1">Newsletter</text>'));

  const baseline = recordBaseline([page]);
  assert.ok(baseline.entries['page1.svg']);
  assert.equal(compareToBaseline(baseline, [page]).pass, true);

  writeFileSync(page, svg('<rect x="0" y="0" width="50" height="50" fill="#123456"/>'));
  const drifted = compareToBaseline(baseline, [page]);
  assert.equal(drifted.pass, false);
  assert.equal(drifted.results[0].status, 'CHANGED');
  assert.ok(drifted.results[0].differences.some((d) => d.field === 'text'));
});

test('a page that disappears from the output is a baseline failure', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pubshift-fidelity-'));
  const a = join(dir, 'p1.svg');
  const b = join(dir, 'p2.svg');
  writeFileSync(a, svg('<rect width="1" height="1"/>'));
  writeFileSync(b, svg('<rect width="2" height="2"/>'));
  const baseline = recordBaseline([a, b]);
  const r = compareToBaseline(baseline, [a]);
  assert.deepEqual(r.missing, ['p2.svg']);
  assert.equal(r.pass, false);
});

// ---------------------------------------------------------------- profile

test('profile records events, props, units and nested vectors', () => {
  const p = emptyProfile();
  addFile(p, 'a.pub', {
    events: [
      { t: 'startPage', p: { 'svg:width': { v: 8.5, u: 'in' } } },
      { t: 'text', s: 'hello' },
      {
        t: 'drawPath',
        p: { 'svg:d': [{ 'librevenge:path-action': 'M', 'svg:x': { v: 1, u: 'in' } }] },
      },
    ],
    assets: { a1: 'AAAA' },
  });
  const f = finalizeProfile(p);
  assert.equal(f.files, 1);
  assert.equal(f.events.startPage.count, 1);
  assert.equal(f.text.chars, 5);
  assert.equal(f.properties['svg:width'].units.in, 1);
  assert.equal(f.properties['svg:d'].kinds.vector, 1);
  assert.equal(f.properties['svg:d[].librevenge:path-action'].count, 1);
  assert.equal(f.properties['svg:d[].svg:x'].example.v, 1);
  assert.equal(f.assets.count, 1);
});

test('profile keeps distinct samples but caps them', () => {
  const p = emptyProfile();
  for (let i = 0; i < 40; i++) addFile(p, `f${i}.pub`, { events: [{ t: 'setStyle', p: { 'draw:fill': `c${i}` } }] });
  const f = finalizeProfile(p);
  assert.equal(f.properties['draw:fill'].count, 40);
  assert.equal(f.properties['draw:fill'].files, 40);
  assert.ok(f.properties['draw:fill'].samples.length <= 8);
});

// ---------------------------------------------------------------- coverage

test('coverage fails on a key nobody classified', () => {
  const profile = { properties: { 'fo:color': { count: 1, files: 1, events: { openSpan: 1 }, example: '#000' },
                                  'x:new': { count: 2, files: 1, events: { openSpan: 2 }, example: 'surprise' } },
                    events: { openSpan: { count: 3, files: 1 } } };
  const r = checkCoverage(profile, {
    properties: { handled: { 'fo:color': 'Run.color' }, ignored: {} },
    events: { handled: { openSpan: 'Run' }, ignored: {}, documentedButAbsent: {} },
  });
  assert.equal(r.pass, false);
  assert.equal(r.unknownProperties.length, 1);
  assert.equal(r.unknownProperties[0].key, 'x:new');
  assert.equal(r.unknownProperties[0].example, 'surprise');
});

test('coverage flags stale entries and contradictions but keeps them separate from failure', () => {
  const profile = { properties: { 'fo:color': { count: 1, files: 1, events: {}, example: '#000' } }, events: {} };
  const r = checkCoverage(profile, {
    properties: { handled: { 'fo:color': 'a', 'gone:key': 'b' }, ignored: { 'fo:color': 'c' } },
    events: { handled: {}, ignored: {}, documentedButAbsent: {} },
  });
  assert.deepEqual(r.stalePropertyKeys, ['gone:key']);
  assert.equal(r.contradictions.length, 1);
  assert.equal(r.pass, false, 'a key in both lists is a real bug in handled.json');
});

test('the real handled.json classifies the real corpus with nothing left over', () => {
  // Profiles the corpus from scratch rather than trusting a checked-in profile.json,
  // so this fails the moment the extractor starts emitting something new.
  const handled = JSON.parse(readFileSync(join(HERE, 'handled.json'), 'utf8'));
  const p = emptyProfile();
  for (const file of corpusFiles(join(ROOT, 'packages/core/test/corpus'))) {
    const r = extractOne(join(ROOT, 'bin/pubshift-extract'), file);
    if (r.ok) addFile(p, r.name, r.ir);
  }
  const profile = finalizeProfile(p);
  assert.ok(profile.propertyKeys > 50, 'the corpus should be rich enough to be worth gating on');
  const r = checkCoverage(profile, handled);
  assert.deepEqual(r.unknownProperties.map((u) => u.key), []);
  assert.deepEqual(r.unknownEvents.map((u) => u.event), []);
  assert.deepEqual(r.contradictions, []);
  assert.deepEqual(r.stalePropertyKeys, []);
  assert.equal(r.pass, true);
});

// ---------------------------------------------------------------- extraction

test('the extractor produces the IR shape the contract promises', () => {
  const file = corpusFiles(join(ROOT, 'packages/core/test/corpus')).find((f) => f.name === 'text-style.pub');
  const r = extractOne(join(ROOT, 'bin/pubshift-extract'), file);
  assert.equal(r.ok, true);
  assert.equal(r.ir.events[0].t, 'startDocument');
  assert.equal(r.ir.events.at(-1).t, 'endDocument');
  assert.ok(r.events > 10);
  assert.ok(r.ms >= 0);
  assert.ok(r.textChars > 0);
});

test('a non-Publisher file fails with a user-readable message, not a crash', () => {
  const file = corpusFiles(join(ROOT, 'packages/core/test/corpus')).find((f) => f.name === 'EDB-29664-1.pub');
  const r = extractOne(join(ROOT, 'bin/pubshift-extract'), file);
  assert.equal(r.ok, false);
  assert.equal(r.expectedFailure, true);
  assert.ok(r.error.code.length > 0);
  assert.ok(r.error.message.length > 0);
});

// ---------------------------------------------------------------- png codec
//
// The decoder is tested against PNGs this file builds itself, with an independent forward
// implementation of the five scanline filters. A round-trip through our own encoder would
// only prove the two halves agree with each other.

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function testCrc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function testChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(testCrc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, crc]);
}

const testPaeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/** Forward filter — the inverse of what the decoder does, written independently. */
function applyFilter(type, row, prev, bpp) {
  const out = Buffer.alloc(row.length);
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    const sub =
      type === 0 ? 0 : type === 1 ? a : type === 2 ? b : type === 3 ? (a + b) >> 1 : testPaeth(a, b, c);
    out[i] = (row[i] - sub) & 0xff;
  }
  return out;
}

/** Builds a PNG from raw scanlines with a chosen filter per row. */
function buildPNG({ width, height, bitDepth = 8, colorType = 2, interlace = 0, rows, filters, palette }) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const parts = [];
  let prev = null;
  for (let y = 0; y < height; y++) {
    const type = filters ? filters[y % filters.length] : 0;
    parts.push(Buffer.from([type]), applyFilter(type, rows[y], prev, bpp));
    prev = rows[y];
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[12] = interlace;
  return Buffer.concat([
    PNG_SIG,
    testChunk('IHDR', ihdr),
    ...(palette ? [testChunk('PLTE', palette)] : []),
    testChunk('IDAT', deflateSync(Buffer.concat(parts))),
    testChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A 4x4 RGB gradient, as raw scanlines. */
function gradientRows(width, height) {
  return Array.from({ length: height }, (_, y) => {
    const row = Buffer.alloc(width * 3);
    for (let x = 0; x < width; x++) {
      row[x * 3] = (x * 37 + y * 11) & 0xff;
      row[x * 3 + 1] = (x * 5 + y * 71) & 0xff;
      row[x * 3 + 2] = (x * 97 + y * 3) & 0xff;
    }
    return row;
  });
}

test('png: every scanline filter decodes back to the original bytes', () => {
  const rows = gradientRows(9, 7);
  for (const filter of [0, 1, 2, 3, 4]) {
    const img = decodePNG(buildPNG({ width: 9, height: 7, rows, filters: [filter] }));
    assert.equal(img.width, 9);
    assert.equal(img.height, 7);
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 9; x++) {
        const o = (y * 9 + x) * 4;
        assert.equal(img.data[o], rows[y][x * 3], `filter ${filter} at ${x},${y} red`);
        assert.equal(img.data[o + 1], rows[y][x * 3 + 1], `filter ${filter} at ${x},${y} green`);
        assert.equal(img.data[o + 2], rows[y][x * 3 + 2], `filter ${filter} at ${x},${y} blue`);
        assert.equal(img.data[o + 3], 255);
      }
    }
  }
});

test('png: filters mixed row by row, which is what a real encoder emits', () => {
  const rows = gradientRows(9, 7);
  const img = decodePNG(buildPNG({ width: 9, height: 7, rows, filters: [4, 0, 2, 1, 3] }));
  assert.equal(img.data[0], rows[0][0]);
  assert.equal(img.data[(6 * 9 + 8) * 4 + 2], rows[6][8 * 3 + 2]);
});

test('png: greyscale, palette and 16-bit all arrive as RGBA', () => {
  const grey = decodePNG(buildPNG({ width: 2, height: 1, colorType: 0, rows: [Buffer.from([10, 200])] }));
  assert.deepEqual([...grey.data.slice(0, 8)], [10, 10, 10, 255, 200, 200, 200, 255]);

  const paletted = decodePNG(
    buildPNG({
      width: 2,
      height: 1,
      colorType: 3,
      rows: [Buffer.from([1, 0])],
      palette: Buffer.from([255, 0, 0, 0, 0, 255]),
    }),
  );
  assert.deepEqual([...paletted.data.slice(0, 8)], [0, 0, 255, 255, 255, 0, 0, 255]);

  // 16-bit: the decoder keeps the high byte, which is all this comparison ever needs.
  const deep = decodePNG(
    buildPNG({ width: 2, height: 1, bitDepth: 16, colorType: 0, rows: [Buffer.from([0x12, 0x34, 0xab, 0xcd])] }),
  );
  assert.equal(deep.data[0], 0x12);
  assert.equal(deep.data[4], 0xab);
});

test('png: sub-byte bit depths expand to the full range', () => {
  // 4-bit greyscale: 0x0f is white, 0x00 is black, and both must land on 0..255.
  const img = decodePNG(buildPNG({ width: 2, height: 1, bitDepth: 4, colorType: 0, rows: [Buffer.from([0x0f])] }));
  assert.equal(img.data[0], 0);
  assert.equal(img.data[4], 255);
});

test('png: an interlaced file is refused by name, not mis-decoded', () => {
  assert.throws(
    () => decodePNG(buildPNG({ width: 2, height: 2, interlace: 1, rows: gradientRows(2, 2) })),
    /Adam7/,
  );
});

test('png: a truncated or non-PNG buffer is refused', () => {
  assert.throws(() => decodePNG(Buffer.from('not a png at all')), /signature/);
  const good = buildPNG({ width: 4, height: 4, rows: gradientRows(4, 4) });
  assert.throws(() => decodePNG(good.subarray(0, good.length - 30)), /truncated|IDAT|IEND/i);
});

test('png: our encoder round-trips through our decoder, header included', () => {
  const data = new Uint8Array(6 * 5 * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 13) & 0xff;
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const png = encodePNG({ width: 6, height: 5, data });
  assert.deepEqual(readPNGSize(png), { width: 6, height: 5 });
  const back = decodePNG(png);
  assert.equal(back.width, 6);
  assert.deepEqual([...back.data], [...data]);
});

test('png: the encoder refuses a buffer that is the wrong size for the dimensions', () => {
  assert.throws(() => encodePNG({ width: 4, height: 4, data: new Uint8Array(10) }), /needs 64 bytes/);
});

// ---------------------------------------------------------------- pixel score

const WHITE = [255, 255, 255];
const BLACK = [0, 0, 0];
const RED = [220, 20, 20];

function image(w, h, marks = []) {
  const data = new Uint8Array(w * h * 4).fill(255);
  for (let i = 0; i < w * h; i++) data[i * 4 + 3] = 255;
  for (const [x, y, colour] of marks) {
    const o = (y * w + x) * 4;
    data[o] = colour[0];
    data[o + 1] = colour[1];
    data[o + 2] = colour[2];
    data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}

test('pixels: an image scores 1 against itself', () => {
  const a = image(20, 20, [[5, 5, BLACK], [6, 5, BLACK], [7, 5, RED]]);
  const r = comparePixels(a, a);
  assert.equal(r.score, 1);
  assert.equal(r.blank, false);
  assert.equal(r.byRadius[0], 1);
  assert.equal(r.ink.lost, 0);
});

test('pixels: two blank pages score 1 and say they are blank', () => {
  const r = comparePixels(image(10, 10), image(10, 10));
  assert.equal(r.blank, true);
  assert.equal(r.score, 1);
  assert.equal(r.ink.reference, 0);
});

test('pixels: a blank output against a real page scores 0, not 0.99', () => {
  const marks = Array.from({ length: 20 }, (_, i) => [i, 5, BLACK]);
  const r = comparePixels(image(40, 40, marks), image(40, 40));
  assert.equal(r.score, 0);
  assert.equal(r.ink.lost, 20);
  // The raw per-pixel number is exactly the trap this metric exists to avoid.
  assert.ok(r.perPixel.tolerantRatio > 0.98, 'a blank page is 98% identical to a printed one');
});

test('pixels: a one-pixel shift is forgiven at r=1 and visible at r=0', () => {
  const marks = (dy) => Array.from({ length: 10 }, (_, i) => [i + 3, 5 + dy, BLACK]);
  const r = comparePixels(image(30, 30, marks(0)), image(30, 30, marks(1)));
  assert.equal(r.byRadius[1], 1, 'a 1px shift is inside the placement tolerance');
  assert.ok(r.byRadius[0] < 0.2, 'and plainly visible without it');
  assert.equal(r.score, r.byRadius[1]);
});

test('pixels: a three-pixel shift is not forgiven at any reported radius', () => {
  const marks = (dy) => Array.from({ length: 10 }, (_, i) => [i + 3, 5 + dy, BLACK]);
  const r = comparePixels(image(30, 30, marks(0)), image(30, 30, marks(3)));
  assert.ok(r.byRadius[2] < 0.1);
  assert.equal(r.ink.lost, 10);
});

test('pixels: antialiasing coverage matches, hue does not', () => {
  const at = (colour) => [[5, 5, colour]];
  const solid = image(20, 20, at(BLACK));
  // The same black glyph at 45% coverage over white.
  const faint = image(20, 20, at([140, 140, 140]));
  assert.equal(comparePixels(solid, faint).score, 1, 'grey is black at lower coverage');

  const recoloured = comparePixels(solid, image(20, 20, at(RED)));
  assert.equal(recoloured.score, 0, 'red is not black');
  assert.equal(recoloured.ink.recoloured, 1, 'and is reported as recoloured, not lost');
  assert.equal(recoloured.ink.lost, 0);
});

test('pixels: lost ink and recoloured ink are counted apart', () => {
  const ref = image(30, 30, [[5, 5, BLACK], [6, 5, BLACK], [20, 20, BLACK]]);
  const out = image(30, 30, [[5, 5, RED], [6, 5, RED]]);
  const r = comparePixels(ref, out);
  assert.equal(r.ink.recoloured, 2);
  assert.equal(r.ink.lost, 1);
});

test('pixels: a page emitted at the wrong size is padded, never scaled', () => {
  const ref = image(40, 40, [[10, 10, BLACK]]);
  const half = image(20, 20, [[10, 10, BLACK]]);
  const r = comparePixels(ref, half);
  assert.equal(r.dimensions.match, false);
  assert.deepEqual(r.dimensions.compared, { width: 40, height: 40 });
  assert.equal(r.score, 1, 'the mark is at the same place; only the sheet is smaller');

  const scaled = image(20, 20, [[5, 5, BLACK]]);
  assert.equal(comparePixels(ref, scaled).score, 0, 'a scaled-down page is not the same page');
});

test('pixels: faint marks below the ink threshold are not marks', () => {
  const faint = [Math.round(255 - THRESHOLDS.INK_THRESHOLD / 2)];
  const grey = [faint[0], faint[0], faint[0]];
  assert.equal(countInk(image(10, 10, [[1, 1, grey]])), 0);
  assert.equal(countInk(image(10, 10, [[1, 1, BLACK]])), 1);
});

test('pixels: the diff image marks losses red and additions blue', () => {
  const ref = image(20, 20, [[3, 3, BLACK]]);
  const out = image(20, 20, [[15, 15, BLACK]]);
  const r = comparePixels(ref, out);
  const px = (img, x, y) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 3)];
  assert.deepEqual(px(r.diff, 3, 3), [216, 27, 44], 'the reference mark we did not reproduce');
  assert.deepEqual(px(r.diff, 15, 15), [21, 96, 216], 'the mark we invented');
  assert.deepEqual(px(r.diff, 10, 10), [255, 255, 255], 'untouched page stays white');
});

test('pixels: the metric describes itself, including what it cannot see', () => {
  const m = describeMetric();
  assert.equal(m.headline, 'score');
  assert.ok(m.definition.includes('ink'));
  assert.ok(m.doesNotCapture.some((s) => /Publisher/.test(s)), 'it must admit it is not measured against Publisher');
  assert.ok(m.doesNotCapture.length >= 3);
});

// ---------------------------------------------------------------- page alignment

test('a leading blank page in the reference is stripped, and only as far as the surplus', () => {
  // LibreOffice's Publisher import puts a blank sheet in front of some documents.
  const r = alignReferencePages(['blank', 'a'], [0, 500], 1);
  assert.deepEqual(r.pages, ['a']);
  assert.equal(r.strippedLeadingBlanks, 1);
});

test('a reference blank is kept when the page counts already agree', () => {
  // Both sides start with a blank page: that is agreement, not an artefact.
  const r = alignReferencePages(['blank', 'a'], [0, 500], 2);
  assert.deepEqual(r.pages, ['blank', 'a']);
  assert.equal(r.strippedLeadingBlanks, 0);
});

test('only LEADING reference blanks are stripped, never interior ones', () => {
  const r = alignReferencePages(['a', 'blank', 'b'], [500, 0, 500], 1);
  assert.deepEqual(r.pages, ['a', 'blank', 'b'], 'an interior blank must keep its position');
  assert.equal(r.strippedLeadingBlanks, 0);
});

test('a blank page of OURS in the middle does not renumber the pages after it', () => {
  // This is the regression that made REG-TST2 score 0.028 on a page that was merely
  // misaligned: our page 2 renders blank, and dropping it slid pages 3 and 4 up a slot.
  // The reference is untouched here, so page 3 still lines up with page 3.
  const reference = ['r1', 'r2', 'r3', 'r4'];
  const r = alignReferencePages(reference, [500, 500, 500, 500], 4);
  assert.deepEqual(r.pages, reference);
  assert.equal(r.strippedLeadingBlanks, 0);
});

test('several leading blanks are stripped, but no further than the surplus', () => {
  const r = alignReferencePages(['b1', 'b2', 'b3', 'a'], [0, 0, 0, 500], 2);
  assert.deepEqual(r.pages, ['b3', 'a'], 'two pages of surplus means two blanks removed');
  assert.equal(r.strippedLeadingBlanks, 2);
});

// ---------------------------------------------------------------- rasteriser

test('rasteriser detection is honest about being unavailable', () => {
  const r = detectRasteriser();
  assert.equal(typeof r.available, 'boolean');
  if (!r.available) assert.ok(r.reason.length > 0, 'an unavailable rasteriser must say why');
  else assert.ok(r.pdfRasteriser, 'an available rasteriser must name what turns PDF into pages');
});

test('a real .pub renders to one PNG per page at the requested DPI', async () => {
  if (!detectRasteriser().available) return; // nothing to test without LibreOffice
  const file = corpusFiles(join(ROOT, 'packages/core/test/corpus')).find((f) => f.name === 'tables.pub');
  const dir = mkdtempSync(join(tmpdir(), 'pubshift-render-test-'));
  const r = await renderToPNG(file.path, { dpi: 96, outDir: dir });
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.pages.length >= 1);
  // tables.pub is US Letter: 612x792pt at 96 DPI is 816x1056 px.
  assert.deepEqual(readPNGSize(readFileSync(r.pages[0])), { width: 816, height: 1056 });
  assert.ok(pngInkCount(r.pages[0]) > 0, 'the reference page must actually have something on it');
  assert.equal(comparePNGFiles(r.pages[0], r.pages[0]).score, 1);
});

test('a multi-page document really does produce every page, not just the first', async () => {
  if (!detectRasteriser().available) return;
  // This is the LibreOffice quirk the whole render path is built around: `--convert-to png`
  // would silently hand back page one alone.
  const file = corpusFiles(join(ROOT, 'packages/core/test/corpus')).find((f) => f.name === 'fdo68259-1.pub');
  const dir = mkdtempSync(join(tmpdir(), 'pubshift-render-test-'));
  const r = await renderToPNG(file.path, { dpi: 96, outDir: dir });
  assert.equal(r.ok, true, r.reason);
  assert.ok(r.pages.length >= 2, `expected more than one page, got ${r.pages.length}`);
});

test('an unrenderable file is refused with a reason rather than a stack trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pubshift-render-test-'));
  const junk = join(dir, 'thing.xyz');
  writeFileSync(junk, 'not a document');
  const r = await renderToPNG(junk, { outDir: dir });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no renderer for \.xyz/);
});

test('LibreOffice refusing a file is a reported failure, not a hang', async () => {
  if (!detectRasteriser().available) return;
  // It has to be genuinely unloadable. LibreOffice is far more permissive than you would
  // expect — handed plain text named `.pub` it renders it as a text document and succeeds —
  // so this uses a truncated OOXML package, which its zip layer really does reject.
  const dir = mkdtempSync(join(tmpdir(), 'pubshift-render-test-'));
  const junk = join(dir, 'broken.pptx');
  writeFileSync(junk, Buffer.from('PK truncated', 'latin1'));
  const r = await renderToPNG(junk, { outDir: dir, timeoutMs: 60000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /produced no pdf/);
});

test('a LibreOffice run that overruns its timeout is killed and reported', async () => {
  if (!detectRasteriser().available) return;
  // 1ms is unreachable, so this exercises the kill path rather than a slow document.
  const file = corpusFiles(join(ROOT, 'packages/core/test/corpus')).find((f) => f.name === 'tables.pub');
  const dir = mkdtempSync(join(tmpdir(), 'pubshift-render-test-'));
  const r = await renderToPNG(file.path, { outDir: dir, timeoutMs: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /exceeded 1ms and was killed/);
});

// ---------------------------------------------------------------- runner

export async function runSelfTest() {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (e) {
      failed++;
      console.log(`  FAIL  ${name}\n        ${e.message.split('\n').join('\n        ')}`);
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  return failed === 0 ? 0 : 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(await runSelfTest());
}
