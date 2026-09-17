/**
 * The PPTX emitter against a real OOXML consumer.
 *
 * Unit tests prove the emitter writes the XML it means to write. They cannot prove the
 * result opens, because what decides that is a consumer with its own opinions about what
 * a presentation must contain. So this converts the real corpus, hands every deck to
 * headless LibreOffice, and requires it to import each one — a file that will not open is
 * broken however correct its markup looks.
 *
 * "It opened" is not enough either, so two further things are checked with LibreOffice as
 * the witness:
 *
 *   - the PDF export has exactly one page per page of the publication, which is the only
 *     way to see from outside that no slide was silently dropped;
 *   - the PNG render of the first slide has ink on it, for every file `assess()` calls
 *     'ok'. Handing someone a deck that opens to a blank slide is the failure this
 *     project exists to prevent. Files `assess()` calls 'partial' are exempt from the ink
 *     check and only have to open: on this corpus that is one publication whose shapes
 *     are degenerate, and LibreOffice renders the *original* `.pub` blank too.
 *
 * LibreOffice is an external tool. When it is absent the suite says so loudly and skips,
 * rather than passing quietly and leaving the impression that the guarantee still holds.
 */

import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emitPPTXWithReport } from '../src/emit/pptx';
import { assess, type Verdict } from '../src/model/assess';
import type { Warning } from '../src/model/types';
import { corpusFiles, docFor, NOT_A_PUB } from './helpers';
import { pngStats } from './helpers/png';

const run = promisify(execFile);

const SOFFICE_CANDIDATES = [
  '/opt/homebrew/bin/soffice',
  '/usr/local/bin/soffice',
  '/usr/bin/soffice',
  '/Applications/LibreOffice.app/Contents/MacOS/soffice',
];

function findSoffice(): string | undefined {
  for (const candidate of SOFFICE_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    const found = execFileSync('/bin/sh', ['-c', 'command -v soffice'], { encoding: 'utf8' }).trim();
    return found === '' ? undefined : found;
  } catch {
    return undefined;
  }
}

const SOFFICE = findSoffice();

/**
 * Converting the corpus and starting an office suite are both slow, and this machine has
 * no `timeout(1)`, so the ceiling is enforced from Node instead of from the shell.
 */
const CONVERT_TIMEOUT_MS = 10 * 60 * 1000;
const STEP_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * Share of pixels that must differ from the background for a slide to count as rendered.
 * One line of 10pt text on a letter page is about 0.05%, so this sits well below that:
 * the question is "is anything there", not "is it good".
 */
const MIN_INK_COVERAGE = 0.0002;

/** LibreOffice's PNG export renders the first slide only; the PDF export covers them all. */
const PAGE_OBJECT = /\/Type\s*\/Page(?!s)/g;

interface Deck {
  name: string;
  verdict: Verdict;
  pages: number;
  deckPath: string;
  bytes: number;
  warnings: Warning[];
}

const workDir = mkdtempSync(path.join(os.tmpdir(), 'pubshift-pptx-'));
const deckDir = path.join(workDir, 'decks');
const pngDir = path.join(workDir, 'png');
const pdfDir = path.join(workDir, 'pdf');
const profileDir = path.join(workDir, 'profile');

const decks: Deck[] = [];
const notConverted: string[] = [];

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe.skipIf(SOFFICE === undefined)('pptx opened by LibreOffice', () => {
  beforeAll(async () => {
    for (const dir of [deckDir, pngDir, pdfDir]) mkdirSync(dir, { recursive: true });

    for (const name of corpusFiles()) {
      if (name === NOT_A_PUB) continue;
      const doc = docFor(name);
      const verdict = assess(doc).verdict;
      // Never hand someone a file for a publication we could not read.
      if (verdict === 'empty') {
        notConverted.push(name);
        continue;
      }
      const deckPath = path.join(deckDir, name.replace(/\.pub$/i, '.pptx'));
      const { bytes, warnings } = await emitPPTXWithReport(doc);
      writeFileSync(deckPath, bytes);
      decks.push({ name, verdict, pages: doc.pages.length, deckPath, bytes: bytes.length, warnings });
    }
  }, STEP_TIMEOUT_MS);

  it('converts every readable corpus file and no empty one', () => {
    expect(decks.length + notConverted.length).toBe(corpusFiles().length - 1);
    expect(decks.length).toBeGreaterThanOrEqual(25);
    expect(notConverted.length).toBeGreaterThan(0);
    for (const deck of decks) {
      // A deck smaller than its own boilerplate would mean parts went missing.
      expect(deck.bytes, deck.name).toBeGreaterThan(4096);
    }
  });

  it(
    'imports and renders every deck without an error',
    async () => {
      const { stdout, stderr } = await run(
        SOFFICE as string,
        [
          '--headless',
          `-env:UserInstallation=file://${profileDir}`,
          '--convert-to', 'png',
          '--outdir', pngDir,
          ...decks.map((d) => d.deckPath),
        ],
        { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      );
      // LibreOffice reports a refusal on stdout and still exits 0, so the text is the signal.
      expect(`${stdout}\n${stderr}`).not.toMatch(/Error:|no export filter|could not be loaded/i);

      const failures: string[] = [];
      for (const deck of decks) {
        const rendered = path.join(pngDir, path.basename(deck.deckPath).replace(/\.pptx$/, '.png'));
        if (!existsSync(rendered)) {
          failures.push(`${deck.name}: LibreOffice produced no render`);
          continue;
        }
        const stats = pngStats(readFileSync(rendered));
        if (deck.verdict === 'ok' && stats.inkCoverage < MIN_INK_COVERAGE) {
          failures.push(
            `${deck.name}: opened but rendered blank ` +
              `(${stats.distinctColors} colours, ${(stats.inkCoverage * 100).toFixed(4)}% ink)`,
          );
        }
      }
      expect(failures).toEqual([]);
    },
    STEP_TIMEOUT_MS,
  );

  it(
    'keeps one slide per page all the way through to a PDF',
    async () => {
      await run(
        SOFFICE as string,
        [
          '--headless',
          `-env:UserInstallation=file://${profileDir}`,
          '--convert-to', 'pdf',
          '--outdir', pdfDir,
          ...decks.map((d) => d.deckPath),
        ],
        { timeout: CONVERT_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 },
      );

      const wrong: string[] = [];
      for (const deck of decks) {
        const pdf = path.join(pdfDir, path.basename(deck.deckPath).replace(/\.pptx$/, '.pdf'));
        if (!existsSync(pdf)) {
          wrong.push(`${deck.name}: no PDF`);
          continue;
        }
        const found = (readFileSync(pdf, 'latin1').match(PAGE_OBJECT) ?? []).length;
        if (found !== deck.pages) wrong.push(`${deck.name}: ${deck.pages} pages became ${found} slides`);
      }
      expect(wrong).toEqual([]);

      const slides = decks.reduce((n, d) => n + d.pages, 0);
      const total = decks.reduce((n, d) => n + d.bytes, 0);
      const sizes = decks.map((d) => d.bytes).sort((a, b) => a - b);
      console.log(
        `LibreOffice opened ${decks.length}/${decks.length} generated decks: ` +
          `${slides} slides, ${(total / 1024 / 1024).toFixed(1)} MB total, ` +
          `median ${Math.round((sizes[sizes.length >> 1] as number) / 1024)} KB, ` +
          `largest ${Math.round((sizes[sizes.length - 1] as number) / 1024)} KB. ` +
          `${notConverted.length} corpus files read as empty and no deck was written for them.`,
      );
    },
    STEP_TIMEOUT_MS,
  );
});
