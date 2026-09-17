#!/usr/bin/env node
// The fidelity harness.
//
//   node tools/fidelity/run.mjs
//
// Runs bin/pubshift-extract over the whole corpus, writes report.json (per-file
// results, timing, event counts) and profile.json (every event type and property key
// the corpus contains), then fails the build if the corpus holds a property key that
// handled.json neither claims to handle nor consciously drops.
//
// Flags:
//   --json        machine output on stdout instead of the table
//   --no-gate     report coverage but always exit 0
//   --filter STR  only corpus files whose name contains STR
//   --quiet       summary only, no per-file rows

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractOne, corpusFiles, EXPECTED_FAILURES } from './lib/extract.mjs';
import { emptyProfile, addFile, finalizeProfile } from './lib/profile.mjs';
import { checkCoverage } from './lib/coverage.mjs';
import { detectRasteriser } from './render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const BIN = join(ROOT, 'bin/pubshift-extract');
const CORPUS = join(ROOT, 'packages/core/test/corpus');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : d;
};

const asJson = flag('--json');
const quiet = flag('--quiet') || asJson;
const filter = opt('--filter', null);

function pad(s, n, right = false) {
  s = String(s);
  return right ? s.padStart(n) : s.padEnd(n);
}
const kb = (b) => (b / 1024).toFixed(0);
/** First sentence of a reason string — `Fill.image has ...` must not truncate at `Fill`. */
const firstSentence = (s) => (/^.*?[.!?](?=\s|$)/.exec(s)?.[0] ?? s).slice(0, 96);
const commas = (n) => n.toLocaleString('en-US');

function run() {
  let files = corpusFiles(CORPUS);
  if (filter) files = files.filter((f) => f.name.includes(filter));

  const profile = emptyProfile();
  const rows = [];
  const started = Date.now();

  if (!quiet) {
    console.log(`corpus  ${CORPUS}`);
    console.log(`binary  ${BIN}\n`);
    console.log(
      `${pad('FILE', 46)}${pad('KB', 6, true)}${pad('MS', 8, true)}${pad('EVENTS', 8, true)}` +
        `${pad('PAGES', 7, true)}${pad('TEXT', 8, true)}${pad('ASSETS', 8, true)}  STATUS`,
    );
    console.log('-'.repeat(103));
  }

  for (const file of files) {
    const r = extractOne(BIN, file);
    let pages = 0;
    const eventCounts = {};

    if (r.ok) {
      for (const ev of r.ir.events) {
        eventCounts[ev.t] = (eventCounts[ev.t] ?? 0) + 1;
        if (ev.t === 'startPage') pages++;
      }
      addFile(profile, r.name, r.ir);
    }

    const status = r.ok
      ? 'ok'
      : r.expectedFailure
        ? `expected-fail (${r.error.code})`
        : `FAIL ${r.error.code}: ${r.error.message}`;

    if (!quiet) {
      console.log(
        `${pad(r.name, 46)}${pad(kb(r.bytes), 6, true)}${pad(r.ms.toFixed(1), 8, true)}` +
          `${pad(commas(r.events), 8, true)}${pad(pages, 7, true)}${pad(commas(r.textChars), 8, true)}` +
          `${pad(r.assets, 8, true)}  ${status}`,
      );
    }

    rows.push({
      name: r.name,
      bytes: r.bytes,
      ok: r.ok,
      ms: r.ms,
      exitCode: r.exitCode,
      expectedFailure: r.expectedFailure,
      pages,
      events: r.events,
      textChars: r.textChars,
      assets: r.assets,
      assetBytes: r.assetBytes,
      eventCounts,
      ...(r.error ? { error: r.error } : {}),
    });
  }

  const finalized = finalizeProfile(profile);
  const handled = JSON.parse(readFileSync(join(HERE, 'handled.json'), 'utf8'));
  const coverage = checkCoverage(finalized, handled);
  const raster = detectRasteriser();

  const totals = {
    files: rows.length,
    extracted: rows.filter((r) => r.ok).length,
    failed: rows.filter((r) => !r.ok).length,
    unexpectedFailures: rows.filter((r) => !r.ok && !r.expectedFailure).map((r) => r.name),
    missingExpectedFailures: [...EXPECTED_FAILURES].filter((n) =>
      rows.some((r) => r.name === n && r.ok),
    ),
    events: rows.reduce((a, r) => a + r.events, 0),
    pages: rows.reduce((a, r) => a + r.pages, 0),
    textChars: rows.reduce((a, r) => a + r.textChars, 0),
    assets: rows.reduce((a, r) => a + r.assets, 0),
    wallMs: Date.now() - started,
    slowest: [...rows].sort((a, b) => b.ms - a.ms).slice(0, 3).map((r) => ({ name: r.name, ms: r.ms })),
  };

  const report = {
    generatedAt: new Date().toISOString(),
    binary: BIN,
    corpusDir: CORPUS,
    totals,
    coverage: {
      pass: coverage.pass,
      corpusPropertyKeys: coverage.corpusPropertyKeys,
      handledProperties: coverage.handledProperties,
      ignoredProperties: coverage.ignoredProperties,
      unknownProperties: coverage.unknownProperties,
      unknownEvents: coverage.unknownEvents,
      stalePropertyKeys: coverage.stalePropertyKeys,
      staleEventKeys: coverage.staleEventKeys,
      documentedButAbsent: coverage.documentedButAbsent,
      documentedAbsentNowPresent: coverage.documentedAbsentNowPresent,
      contradictions: coverage.contradictions,
      knownLosses: coverage.knownLosses,
    },
    renderDiff: raster.available
      ? { pixel: 'available', engine: raster.engine, version: raster.version }
      : { pixel: 'unavailable', reason: raster.reason, fallback: 'structural signature comparison' },
    files: rows,
  };

  // A filtered run sees only part of the corpus, so it must never overwrite the
  // canonical artefacts — and its "stale" list would be nothing but noise.
  const suffix = filter ? '.filtered' : '';
  mkdirSync(HERE, { recursive: true });
  writeFileSync(join(HERE, `report${suffix}.json`), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(HERE, `profile${suffix}.json`), JSON.stringify(finalized, null, 2) + '\n');

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSummary(report, coverage, finalized, raster);
  }

  const gateFails = !coverage.pass || totals.unexpectedFailures.length > 0 || totals.missingExpectedFailures.length > 0;
  return flag('--no-gate') ? 0 : gateFails ? 1 : 0;
}

function printSummary(report, coverage, profile, raster) {
  const t = report.totals;
  console.log('');
  console.log(
    `extraction   ${t.extracted}/${t.files} ok` +
      (t.failed ? `, ${t.failed} failed (${t.failed - t.unexpectedFailures.length} expected)` : '') +
      `  ·  ${commas(t.events)} events  ·  ${t.pages} pages  ·  ${commas(t.textChars)} text chars  ·  ${t.wallMs}ms`,
  );
  if (t.unexpectedFailures.length) console.log(`  UNEXPECTED FAILURES: ${t.unexpectedFailures.join(', ')}`);
  if (t.missingExpectedFailures.length)
    console.log(`  expected to fail but extracted: ${t.missingExpectedFailures.join(', ')} — update EXPECTED_FAILURES`);
  console.log(`  slowest: ${t.slowest.map((s) => `${s.name} ${s.ms}ms`).join(', ')}`);

  console.log('');
  console.log(
    `coverage     ${coverage.corpusPropertyKeys} property keys in corpus  ·  ` +
      `${coverage.handledProperties} handled  ·  ${coverage.ignoredProperties} consciously dropped  ·  ` +
      `${coverage.unknownProperties.length} unknown`,
  );
  console.log(
    `             ${coverage.corpusEventTypes} event types  ·  ${coverage.unknownEvents.length} unknown`,
  );

  if (coverage.unknownProperties.length) {
    console.log('\n  UNKNOWN PROPERTY KEYS — the corpus uses these and handled.json has never heard of them:');
    for (const u of coverage.unknownProperties) {
      console.log(
        `    ${pad(u.key, 40)} ${pad(u.count, 6, true)}x in ${u.files} files  on ${u.events.join(',')}` +
          `  e.g. ${JSON.stringify(u.example)}`,
      );
    }
  }
  if (coverage.unknownEvents.length) {
    console.log('\n  UNKNOWN EVENT TYPES:');
    for (const u of coverage.unknownEvents) console.log(`    ${pad(u.event, 24)} ${u.count}x in ${u.files} files`);
  }
  if (coverage.contradictions.length) {
    console.log('\n  CONTRADICTORY ENTRIES (listed as both handled and ignored):');
    for (const c of coverage.contradictions) console.log(`    ${c.scope} ${c.key}`);
  }
  if (!filter && (coverage.stalePropertyKeys.length || coverage.staleEventKeys.length)) {
    console.log(
      `\n  stale handled.json entries (no longer in the corpus): ` +
        [...coverage.stalePropertyKeys, ...coverage.staleEventKeys].join(', '),
    );
  }
  if (coverage.documentedAbsentNowPresent.length) {
    console.log(
      `\n  events listed as documentedButAbsent now DO appear: ${coverage.documentedAbsentNowPresent.join(', ')} — classify them`,
    );
  }
  if (coverage.documentedButAbsent.length) {
    console.log(
      `  in docs/IR.md but never emitted by this corpus: ${coverage.documentedButAbsent.join(', ')}`,
    );
  }

  if (coverage.knownLosses.length) {
    console.log('\n  accepted fidelity losses, by frequency:');
    for (const l of coverage.knownLosses.slice(0, 8)) {
      console.log(`    ${pad(l.key, 30)} ${pad(l.count, 5, true)}x  ${firstSentence(l.reason)}`);
    }
    if (coverage.knownLosses.length > 8) console.log(`    … ${coverage.knownLosses.length - 8} more in report.json`);
  }

  console.log('');
  console.log(
    raster.available
      ? `render diff  pixel comparison available (${raster.engine} ${raster.version})`
      : `render diff  PIXEL COMPARISON UNAVAILABLE — ${raster.reason}\n             falling back to structural signatures (element counts, path mix, text, colours, bbox)`,
  );
  const suffix = filter ? '.filtered' : '';
  console.log(`\nwrote        ${join(HERE, `report${suffix}.json`)}\n             ${join(HERE, `profile${suffix}.json`)}`);
  console.log(
    `\nRESULT       ${report.coverage.pass && !t.unexpectedFailures.length ? 'PASS' : 'FAIL'}`,
  );
}

process.exit(run());
