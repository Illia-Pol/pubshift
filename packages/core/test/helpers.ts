import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDoc } from '../src/model/build';
import { readIR } from '../src/ir/read';
import type { Doc, Element, Paragraph } from '../src/model/types';

const here = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const EXTRACTOR = path.join(REPO_ROOT, 'bin', 'pubshift-extract');
export const CORPUS_DIR = path.join(here, 'corpus');

/** The one corpus file that is not a Publisher document; the extractor must reject it. */
export const NOT_A_PUB = 'EDB-29664-1.pub';

export function corpusFiles(): string[] {
  return readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.pub')).sort();
}

const rawCache = new Map<string, string>();

/** Runs the real native extractor. Its failure output is on stdout with a non-zero exit. */
export function extract(name: string): string {
  const cached = rawCache.get(name);
  if (cached !== undefined) return cached;
  let out: string;
  try {
    out = execFileSync(EXTRACTOR, [path.join(CORPUS_DIR, name)], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
    });
  } catch (err) {
    const stdout = (err as { stdout?: string }).stdout;
    if (typeof stdout !== 'string' || stdout.trim() === '') throw err;
    out = stdout;
  }
  rawCache.set(name, out);
  return out;
}

const docCache = new Map<string, Doc>();

export function docFor(name: string): Doc {
  const cached = docCache.get(name);
  if (cached !== undefined) return cached;
  const doc = buildDoc(readIR(extract(name)));
  docCache.set(name, doc);
  return doc;
}

export function walkElements(elements: Element[], visit: (el: Element) => void): void {
  for (const el of elements) {
    visit(el);
    if (el.kind === 'group') walkElements(el.children, visit);
  }
}

export function allElements(doc: Doc): Element[] {
  const out: Element[] = [];
  for (const page of doc.pages) walkElements(page.elements, (el) => out.push(el));
  return out;
}

export function allParagraphs(doc: Doc): Paragraph[] {
  const out: Paragraph[] = [];
  for (const el of allElements(doc)) {
    if (el.kind === 'text') out.push(...el.paragraphs);
    else if (el.kind === 'table') for (const row of el.rows) for (const c of row.cells) out.push(...c.paragraphs);
  }
  return out;
}

export function paragraphText(p: Paragraph): string {
  return p.runs.map((r) => r.text).join('');
}

/** Every non-finite number anywhere in the doc, reported by path. */
export function nonFiniteNumbers(value: unknown, at = '$', found: string[] = []): string[] {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) found.push(`${at} = ${String(value)}`);
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => nonFiniteNumbers(v, `${at}[${i}]`, found));
    return found;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) nonFiniteNumbers(v, `${at}.${k}`, found);
  }
  return found;
}
