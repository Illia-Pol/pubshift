/**
 * The minimum bar: a .docx that LibreOffice cannot open is broken, whatever it looks like
 * in a unit test.
 *
 * Every corpus document we would actually hand a user — everything `assess` does not call
 * 'empty' — is emitted in both modes and opened with headless LibreOffice, which is the
 * one engine on this machine that reads `.pub`, `.docx` and writes PDF. Conversion is
 * checked by what comes out, not by the exit status: LibreOffice reports a file it could
 * not load on stdout and still exits 0, and it will happily read a broken `.docx` as
 * plain text, so the assertions are that an output file exists, that it is a real PDF,
 * and — in layout mode, where nothing flows — that it has exactly one page per Publisher
 * page.
 *
 * The suite skips itself when LibreOffice is not installed rather than failing, so a
 * checkout on a machine without it still runs green.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { emitDOCX, type DocxMode } from '../src/emit/docx';
import { assess } from '../src/model/assess';
import type { Doc, Warning, WarningCode } from '../src/model/types';
import { parseXML } from './helpers/xml';
import { corpusFiles, docFor, NOT_A_PUB } from './helpers';

import JSZip from 'jszip';

const MODES: DocxMode[] = ['layout', 'flow'];

/** LibreOffice refuses an argument list much longer than this in one invocation. */
const CONVERT_BATCH = 8;

const TIMEOUT = 900_000;
const SOFFICE_TIMEOUT = 300_000;

/** A PDF that is smaller than this is not a rendered page, whatever its extension says. */
const MIN_PDF_BYTES = 500;

function findSoffice(): string | undefined {
  const candidates = [
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
    '/usr/bin/soffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  try {
    const found = execFileSync('command', ['-v', 'soffice'], { encoding: 'utf8', shell: '/bin/sh' }).trim();
    return found === '' ? undefined : found;
  } catch {
    return undefined;
  }
}

const SOFFICE = findSoffice();

/** Pages in a PDF, from the page tree when it is readable and by counting page objects otherwise. */
function pdfPageCount(file: string): number {
  const text = readFileSync(file, 'latin1');
  const counts = [...text.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  if (counts.length > 0) return Math.max(...counts);
  return [...text.matchAll(/\/Type\s*\/Page[^s]/g)].length;
}

interface Generated {
  name: string;
  mode: DocxMode;
  docx: string;
  pdf: string;
  pages: number;
  bytes: number;
}

interface Report {
  generated: Generated[];
  /** Documents `assess` rules out before an emitter ever sees them. */
  refused: string[];
  warnings: Map<WarningCode, number>;
  /** Files whose XML did not parse, by part. */
  malformed: string[];
}

const report: Report = { generated: [], refused: [], warnings: new Map(), malformed: [] };
let workDir = '';

describe.skipIf(SOFFICE === undefined)('docx through LibreOffice', () => {
  beforeAll(async () => {
    workDir = mkdtempSync(path.join(os.tmpdir(), 'pubshift-docx-'));
    const docxDir = path.join(workDir, 'docx');
    const pdfDir = path.join(workDir, 'pdf');
    mkdirSync(docxDir);
    mkdirSync(pdfDir);

    for (const name of corpusFiles()) {
      let doc: Doc;
      try {
        doc = docFor(name);
      } catch {
        // The corpus holds one file that is not a Publisher document at all.
        expect(name, 'an unreadable file that was expected to read').toBe(NOT_A_PUB);
        report.refused.push(name);
        continue;
      }
      // Handing someone a file built from nothing is the failure this product exists to
      // prevent, so those documents never reach an emitter.
      if (assess(doc).verdict === 'empty') {
        report.refused.push(name);
        continue;
      }

      for (const mode of MODES) {
        const warnings: Warning[] = [];
        const bytes = await emitDOCX(doc, { mode, onWarning: (w) => warnings.push(w) });
        for (const w of warnings) {
          report.warnings.set(w.code, (report.warnings.get(w.code) ?? 0) + (w.count ?? 1));
        }

        const stem = `${name.replace(/\.pub$/, '')}.${mode}`;
        const docx = path.join(docxDir, `${stem}.docx`);
        writeFileSync(docx, bytes);

        // Well-formedness of the real thing, on real data: an unescaped character from a
        // Publisher control code makes a part unparseable, and that is how an OOXML
        // writer fails outside a test.
        const zip = await JSZip.loadAsync(bytes);
        for (const [part, file] of Object.entries(zip.files)) {
          if (file.dir || !(part.endsWith('.xml') || part.endsWith('.rels'))) continue;
          try {
            parseXML(await file.async('string'));
          } catch (err) {
            report.malformed.push(`${stem}!${part}: ${(err as Error).message}`);
          }
        }

        report.generated.push({
          name, mode, docx, pdf: path.join(pdfDir, `${stem}.pdf`),
          pages: doc.pages.length, bytes: bytes.length,
        });
      }
    }

    // A private profile, so the run does not collide with a LibreOffice the user has open.
    const profile = `file://${path.join(workDir, 'profile')}`;
    for (let i = 0; i < report.generated.length; i += CONVERT_BATCH) {
      const batch = report.generated.slice(i, i + CONVERT_BATCH);
      try {
        execFileSync(SOFFICE as string, [
          '--headless', '--norestore', `-env:UserInstallation=${profile}`,
          '--convert-to', 'pdf', '--outdir', pdfDir, ...batch.map((g) => g.docx),
        ], { encoding: 'utf8', timeout: SOFFICE_TIMEOUT, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        // A failed batch shows up as missing output below, named file by file.
      }
    }
  }, TIMEOUT);

  it('had something to convert', () => {
    expect(report.generated.length).toBeGreaterThan(0);
    expect(report.generated.length % MODES.length).toBe(0);
    // Measured on this corpus: 31 files, of which 1 is not a Publisher document and 5
    // parse to nothing. Change this only when the corpus or the parser changes.
    expect(report.refused).toHaveLength(6);
    expect(report.generated.length / MODES.length).toBe(corpusFiles().length - 6);
  }, TIMEOUT);

  it('writes well-formed XML in every part of every file', () => {
    expect(report.malformed).toEqual([]);
  }, TIMEOUT);

  it('opens every generated file in both modes', () => {
    const failures = report.generated
      .filter((g) => !existsSync(g.pdf) || statSync(g.pdf).size < MIN_PDF_BYTES)
      .map((g) => `${path.basename(g.docx)}: ${existsSync(g.pdf) ? `${statSync(g.pdf).size} bytes` : 'LibreOffice produced no output'}`);

    const total = report.generated.reduce((s, g) => s + g.bytes, 0);
    const largest = Math.max(...report.generated.map((g) => g.bytes));
    const documents = report.generated.length / MODES.length;
    // Printed so the real numbers are on the record, not just the word "pass".
    console.log(
      `LibreOffice opened ${report.generated.length - failures.length}/${report.generated.length} generated files ` +
      `(${documents} documents x ${MODES.join(' + ')}): ` +
      `${(total / 1024 / 1024).toFixed(1)} MB total, largest ${Math.round(largest / 1024)} KB. ` +
      `${report.refused.length} corpus files were refused before emitting: ${report.refused.join(', ')}.`);

    expect(failures).toEqual([]);
  }, TIMEOUT);

  it('lays out one Word page per Publisher page in layout mode', () => {
    // Nothing flows in layout mode — every element is anchored — so the page count is a
    // cheap check that the section breaks and page sizes actually took effect.
    const mismatches = report.generated
      .filter((g) => g.mode === 'layout' && existsSync(g.pdf))
      .map((g) => ({ g, pages: pdfPageCount(g.pdf) }))
      .filter(({ g, pages }) => pages !== g.pages)
      .map(({ g, pages }) => `${g.name}: ${pages} Word pages from ${g.pages} Publisher pages`);
    expect(mismatches).toEqual([]);
  }, TIMEOUT);

  it('produces at least one page from every document in flow mode', () => {
    const empty = report.generated
      .filter((g) => g.mode === 'flow' && existsSync(g.pdf))
      .filter((g) => pdfPageCount(g.pdf) < 1)
      .map((g) => g.name);
    expect(empty).toEqual([]);
  }, TIMEOUT);

  it('reports only losses it can name', () => {
    const known = new Set<WarningCode>([
      'ROTATED_TEXT_APPROXIMATED', 'GRADIENT_FLATTENED', 'WMF_IMAGE_NOT_CONVERTED',
      'SHADOW_DROPPED', 'COLUMNS_FLATTENED', 'FONT_NOT_EMBEDDED', 'SHAPE_APPROXIMATED',
      'TABLE_IN_UNSUPPORTED_TARGET', 'OVERLAP_MAY_REFLOW',
    ]);
    for (const code of report.warnings.keys()) expect(known.has(code), code).toBe(true);
    // Layout mode gives nothing up on this corpus; flow mode gives up the decoration.
    expect(report.warnings.get('SHAPE_APPROXIMATED')).toBeGreaterThan(0);
  }, TIMEOUT);

  it('keeps every file small enough to hand to a browser', () => {
    const oversized = report.generated
      .filter((g) => g.bytes > 8 * 1024 * 1024)
      .map((g) => `${path.basename(g.docx)}: ${Math.round(g.bytes / 1024)}KB`);
    expect(oversized).toEqual([]);
  }, TIMEOUT);
});

/** Leaves nothing behind in the temp directory, whichever way the suite ended. */
describe.skipIf(SOFFICE === undefined)('cleanup', () => {
  it('removes its working directory', () => {
    if (workDir !== '' && existsSync(workDir)) {
      expect(readdirSync(workDir).length).toBeGreaterThan(0);
      rmSync(workDir, { recursive: true, force: true });
    }
    expect(existsSync(workDir)).toBe(false);
  });
});
