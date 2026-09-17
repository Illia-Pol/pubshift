// Runs bin/pubshift-extract over the corpus and turns each run into a record
// the rest of the harness can reason about. Nothing here interprets the IR.

import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Files that are known not to be Publisher documents; failing is the correct outcome. */
export const EXPECTED_FAILURES = new Set(['EDB-29664-1.pub']);

export function corpusFiles(corpusDir) {
  return readdirSync(corpusDir)
    .filter((n) => n.toLowerCase().endsWith('.pub'))
    .sort()
    .map((name) => ({ name, path: join(corpusDir, name), bytes: statSync(join(corpusDir, name)).size }));
}

/**
 * @returns {{name, bytes, ok, ms, exitCode, ir?, error?, stderr?, events, assets, assetBytes, textChars, expectedFailure}}
 */
export function extractOne(bin, file) {
  const t0 = process.hrtime.bigint();
  const proc = spawnSync(bin, [file.path], { maxBuffer: 512 * 1024 * 1024, encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;

  const base = {
    name: file.name,
    bytes: file.bytes,
    ms: Math.round(ms * 10) / 10,
    exitCode: proc.status,
    expectedFailure: EXPECTED_FAILURES.has(file.name),
    events: 0,
    assets: 0,
    assetBytes: 0,
    textChars: 0,
  };

  if (proc.error) {
    return { ...base, ok: false, error: { code: 'SPAWN_FAILED', message: proc.error.message } };
  }

  let ir;
  try {
    ir = JSON.parse(proc.stdout);
  } catch (e) {
    return {
      ...base,
      ok: false,
      error: { code: 'BAD_JSON', message: e.message },
      stderr: (proc.stderr || '').slice(0, 2000),
    };
  }

  if (!ir.ok) {
    return { ...base, ok: false, error: ir.error ?? { code: 'UNKNOWN', message: 'no error object' } };
  }

  const assets = ir.assets ?? {};
  const assetKeys = Object.keys(assets);
  let assetBytes = 0;
  for (const k of assetKeys) assetBytes += Math.floor((assets[k].length * 3) / 4);

  let textChars = 0;
  for (const ev of ir.events) if (typeof ev.s === 'string') textChars += ev.s.length;

  return {
    ...base,
    ok: true,
    ir,
    events: ir.events.length,
    assets: assetKeys.length,
    assetBytes,
    textChars,
  };
}

export function extractCorpus(bin, corpusDir, onFile) {
  const results = [];
  for (const file of corpusFiles(corpusDir)) {
    const r = extractOne(bin, file);
    results.push(r);
    onFile?.(r);
  }
  return results;
}
