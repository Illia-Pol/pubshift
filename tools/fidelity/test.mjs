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
import {
  structuralSignature, compareSignatures, parsePath, detectRasteriser,
  recordBaseline, compareToBaseline,
} from './render.mjs';
import { emptyProfile, addFile, finalizeProfile } from './lib/profile.mjs';
import { checkCoverage } from './lib/coverage.mjs';
import { extractOne, corpusFiles } from './lib/extract.mjs';

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

// ---------------------------------------------------------------- rasteriser

test('rasteriser detection is honest about being unavailable', () => {
  const r = detectRasteriser();
  assert.equal(typeof r.available, 'boolean');
  if (!r.available) assert.ok(r.reason.length > 0, 'an unavailable rasteriser must say why');
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
