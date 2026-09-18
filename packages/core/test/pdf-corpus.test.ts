/**
 * The PDF emitter against the 31 real Publisher files.
 *
 * Unit tests prove the emitter does what it was told; these prove the result is a PDF —
 * that pdf-lib can read back what it wrote, that the pages are the size the model says,
 * that every character of text survived, and that a program which is not pdf-lib will
 * open the file. That last one matters: a PDF that only its own producer can parse is
 * not an archive, and "LibreOffice can open it" is the minimum bar, not the goal.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';

import { emitPDF } from '../src/emit/pdf';
import { assess } from '../src/model/assess';
import type { Doc, Element, Paragraph, Warning } from '../src/model/types';
import { corpusFiles, docFor, extract, NOT_A_PUB } from './helpers';
import { contentOf, opsNamed, pageText, parseOps } from './helpers/pdf';

const TIMEOUT = 300_000;

const FILES = corpusFiles();
const READABLE = FILES.filter((f) => f !== NOT_A_PUB);

interface Converted {
  name: string;
  doc: Doc;
  bytes: Uint8Array;
  file: string;
  /** Only the warnings this emitter added — `doc.warnings` also holds the builder's. */
  emitted: Warning[];
}

const scratch = mkdtempSync(path.join(tmpdir(), 'pubshift-pdf-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Every corpus file the product would actually hand a PDF to a user for. */
const CONVERTIBLE = READABLE.filter((name) => assess(docFor(name)).verdict !== 'empty');

let converted: Converted[] | undefined;

async function convertAll(): Promise<Converted[]> {
  if (converted) return converted;
  const out: Converted[] = [];
  for (const name of CONVERTIBLE) {
    const doc = docFor(name);
    const before = doc.warnings.length;
    const bytes = await emitPDF(doc);
    const file = path.join(scratch, `${name.replace(/\.pub$/, '')}.pdf`);
    writeFileSync(file, bytes);
    out.push({ name, doc, bytes, file, emitted: doc.warnings.slice(before) });
  }
  converted = out;
  return out;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe('the corpus, measured', () => {
  it('splits into the verdicts the pipeline was measured at', () => {
    const verdicts = { ok: 0, partial: 0, empty: 0 };
    for (const name of READABLE) verdicts[assess(docFor(name)).verdict]++;
    expect(verdicts).toEqual({ ok: 24, partial: 1, empty: 5 });
    expect(FILES).toHaveLength(31);
    expect(CONVERTIBLE).toHaveLength(25);
  }, TIMEOUT);

  it('refuses to hand a PDF to anyone for a file it could not read', () => {
    // Emitting a blank PDF for an 'empty' verdict and calling it a conversion is the
    // failure this product exists to prevent, so the gate belongs in front of the emitter
    // and these files never reach it.
    const empty = READABLE.filter((name) => assess(docFor(name)).verdict === 'empty');
    expect(empty).toEqual([
      '14.0-metadata.pub', 'border1.pub', 'multipara.pub', 'table1.pub', 'tdf89993-1.pub',
    ]);
    for (const name of empty) expect(CONVERTIBLE).not.toContain(name);
  }, TIMEOUT);

  it('is not a Publisher file in exactly one case, which never gets that far', () => {
    expect(() => extract(NOT_A_PUB)).not.toThrow();
    expect(CONVERTIBLE).not.toContain(NOT_A_PUB);
  });
});

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe('every convertible corpus file', () => {
  it('produces a PDF pdf-lib can parse back, with the right pages at the right size', async () => {
    const failures: string[] = [];
    let pages = 0;
    for (const { name, doc, bytes } of await convertAll()) {
      let pdf: PDFDocument;
      try {
        pdf = await PDFDocument.load(bytes, { updateMetadata: false });
      } catch (err) {
        failures.push(`${name}: will not re-parse — ${(err as Error).message}`);
        continue;
      }
      if (pdf.getPageCount() !== doc.pages.length) {
        failures.push(`${name}: ${pdf.getPageCount()} pages, model has ${doc.pages.length}`);
        continue;
      }
      for (const [i, page] of doc.pages.entries()) {
        const size = pdf.getPage(i).getSize();
        const want = { width: Math.max(1, page.width), height: Math.max(1, page.height) };
        if (Math.abs(size.width - want.width) > 1e-6 || Math.abs(size.height - want.height) > 1e-6) {
          failures.push(`${name} p${i + 1}: ${size.width}x${size.height}, model says ${want.width}x${want.height}`);
        }
        pages++;
      }
    }
    expect(failures).toEqual([]);
    // Measured on this corpus: 25 convertible files, 51 pages between them.
    expect(pages).toBe(51);
  }, TIMEOUT);

  it('starts with a PDF header and ends with a trailer', async () => {
    for (const { name, bytes } of await convertAll()) {
      const head = new TextDecoder('latin1').decode(bytes.subarray(0, 8));
      const tail = new TextDecoder('latin1').decode(bytes.subarray(-32));
      expect(head, name).toMatch(/^%PDF-1\.\d/);
      expect(tail, name).toContain('%%EOF');
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

function paragraphsOf(elements: Element[], out: Paragraph[] = []): Paragraph[] {
  for (const el of elements) {
    if (el.kind === 'text') out.push(...el.paragraphs);
    else if (el.kind === 'table') {
      for (const row of el.rows) for (const cell of row.cells) if (!cell.covered) out.push(...cell.paragraphs);
    } else if (el.kind === 'group') paragraphsOf(el.children, out);
  }
  return out;
}

/**
 * Both sides of the comparison, reduced to the characters that have to survive.
 *
 * Whitespace goes, because line breaking legitimately moves it and drops the space a line
 * breaks at. C0/C1 controls go, because the emitter strips them deliberately — real `.pub`
 * text carries 0x0B and 0x98, neither of which is text or encodable. List bullets go,
 * because the emitter adds them and the model does not carry them.
 */
function comparable(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\s\u00a0\u2022]+/g, '');
}

describe('text survives the round trip', () => {
  it('extracts back exactly the characters the model holds, page by page', async () => {
    const failures: string[] = [];
    let characters = 0;

    for (const { name, doc, bytes } of await convertAll()) {
      for (const [i, page] of doc.pages.entries()) {
        const paragraphs = paragraphsOf(page.elements);
        // allCaps and smallCaps runs are deliberately drawn as capitals — and uppercasing
        // can lengthen a string, as German ß does — so a page that uses either is compared
        // with both sides folded.
        const recased = paragraphs.some((p) => p.runs.some((r) => r.allCaps || r.smallCaps));
        const fold = (s: string) => (recased ? comparable(s).toUpperCase() : comparable(s));

        const want = fold(paragraphs.flatMap((p) => p.runs).map((r) => r.text).join(''));
        const got = fold(pageText(await contentOf(bytes, i)));
        characters += want.length;

        if (want !== got) {
          let k = 0;
          while (k < want.length && k < got.length && want[k] === got[k]) k++;
          failures.push(
            `${name} p${i + 1}: diverges at ${k} of ${want.length} — ` +
            `model ${JSON.stringify(want.slice(k, k + 40))} vs pdf ${JSON.stringify(got.slice(k, k + 40))}`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
    // Measured on this corpus: 86,162 characters of real Publisher text make it into the
    // PDFs and come back out of them.
    expect(characters).toBe(86_162);
  }, TIMEOUT);

  it('loses no text to a box too small to wrap into', async () => {
    // tdf78739-3.pub reports a 5.5pt-wide frame around 3,911 characters at 20pt.
    // LibreOffice's own converter drops every one of them.
    const entry = (await convertAll()).find((c) => c.name === 'tdf78739-3.pub');
    expect(entry).toBeDefined();
    const text = pageText(await contentOf((entry as Converted).bytes, 0));
    expect(text.length).toBeGreaterThan(5_000);
    expect(entry?.doc.warnings.map((w) => w.code)).toContain('OVERLAP_MAY_REFLOW');
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

describe('losses are reported rather than hidden', () => {
  it('tells the user about every substituted font', async () => {
    const withSubstitution = (await convertAll()).filter(({ doc }) =>
      doc.warnings.some((w) => w.code === 'FONT_NOT_EMBEDDED'));
    // Publisher documents are mostly set in faces that are not one of the standard 14.
    expect(withSubstitution.length).toBeGreaterThanOrEqual(6);
    for (const { name, doc } of withSubstitution) {
      const warning = doc.warnings.find((w) => w.code === 'FONT_NOT_EMBEDDED');
      expect(warning?.message, name).toMatch(/could not be embedded|WinAnsi/);
    }
  }, TIMEOUT);

  it('uses only warning codes the model declares and the app can explain', async () => {
    const known = new Set([
      'ROTATED_TEXT_APPROXIMATED', 'GRADIENT_FLATTENED', 'WMF_IMAGE_NOT_CONVERTED',
      'SHADOW_DROPPED', 'COLUMNS_FLATTENED', 'FONT_NOT_EMBEDDED', 'SHAPE_APPROXIMATED',
      'TABLE_IN_UNSUPPORTED_TARGET', 'OVERLAP_MAY_REFLOW',
    ]);
    for (const { name, doc } of await convertAll()) {
      for (const warning of doc.warnings) {
        expect(known, `${name}: ${warning.code}`).toContain(warning.code);
        expect(warning.message.length, name).toBeGreaterThan(20);
        if (warning.page !== undefined) {
          expect(warning.page, name).toBeGreaterThanOrEqual(1);
          expect(warning.page, name).toBeLessThanOrEqual(doc.pages.length);
        }
      }
    }
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// A reader that is not us
// ---------------------------------------------------------------------------

interface Reader {
  name: string;
  /** Renders each PDF and returns the output file it produced, or undefined on failure. */
  render: (pdfs: string[], outDir: string) => Array<string | undefined>;
}

function which(command: string): string | undefined {
  const candidates = [`/opt/homebrew/bin/${command}`, `/usr/local/bin/${command}`, `/usr/bin/${command}`];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  try {
    return execFileSync('command', ['-v', command], { encoding: 'utf8', shell: '/bin/sh' }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function findReader(): Reader | undefined {
  const soffice = which('soffice');
  if (soffice) {
    return {
      name: 'LibreOffice',
      render: (pdfs, outDir) => {
        execFileSync(
          soffice,
          [
            // Its own profile, so the test can never collide with a LibreOffice the
            // developer happens to have open.
            `-env:UserInstallation=file://${path.join(outDir, 'profile')}`,
            '--headless', '--convert-to', 'png', '--outdir', outDir, ...pdfs,
          ],
          // There is no `timeout` binary on macOS, so the limit is set here.
          { timeout: 240_000, stdio: 'pipe' },
        );
        return pdfs.map((pdf) => {
          const png = path.join(outDir, `${path.basename(pdf, '.pdf')}.png`);
          return existsSync(png) && statSync(png).size > 0 ? png : undefined;
        });
      },
    };
  }
  const qlmanage = which('qlmanage');
  if (qlmanage) {
    return {
      name: 'qlmanage',
      render: (pdfs, outDir) => {
        execFileSync(qlmanage, ['-t', '-s', '400', '-o', outDir, ...pdfs], { timeout: 240_000, stdio: 'pipe' });
        return pdfs.map((pdf) => {
          const png = path.join(outDir, `${path.basename(pdf)}.png`);
          return existsSync(png) && statSync(png).size > 0 ? png : undefined;
        });
      },
    };
  }
  return undefined;
}

const reader = findReader();

describe.runIf(reader)(`a reader that is not pdf-lib (${reader?.name ?? 'none found'})`, () => {
  it('opens and renders every PDF the emitter produced', async () => {
    const files = (await convertAll()).map((c) => c.file);
    const outDir = path.join(scratch, 'rendered');
    const rendered = (reader as Reader).render(files, outDir);

    const unopened = files.filter((_, i) => rendered[i] === undefined).map((f) => path.basename(f));
    expect(unopened).toEqual([]);
    expect(rendered.filter(Boolean)).toHaveLength(25);
  }, TIMEOUT);
});

if (!reader) {
  // Not a silent skip: if neither renderer is installed, say so where it will be read.
  describe('a reader that is not pdf-lib', () => {
    it.skip('needs LibreOffice (`brew install --cask libreoffice`) or macOS qlmanage', () => {});
  });
}

// ---------------------------------------------------------------------------
// Size and speed, so a regression in either is visible
// ---------------------------------------------------------------------------

describe('cost', () => {
  it('stays close to the size of the pictures it carries', async () => {
    const rows: string[] = [];
    for (const { name, doc, bytes } of await convertAll()) {
      const assets = Object.values(doc.assets).reduce((sum, a) => sum + Math.ceil((a.data.length * 3) / 4), 0);
      // Content streams are deflated, so everything that is not a picture is small.
      const overhead = bytes.length - assets;
      rows.push(`${name} ${(bytes.length / 1024).toFixed(0)}KB (${(overhead / 1024).toFixed(0)}KB besides pictures)`);
      expect(overhead, `${name}: ${rows[rows.length - 1]}`).toBeLessThan(400 * 1024);
    }
    expect(rows).toHaveLength(25);
  }, TIMEOUT);

  it('embeds every picture in the corpus rather than marking its place', async () => {
    // The corpus holds PNGs, JPEGs, one BMP and — declared as PNGs — three GIFs. All of
    // them are pictures a browser renders from the SVG, so a placeholder here would mean
    // the archive format lost something the preview format kept.
    const lost: string[] = [];
    let drawn = 0;
    for (const { name, doc, bytes, emitted } of await convertAll()) {
      for (const warning of emitted) {
        if (warning.code === 'WMF_IMAGE_NOT_CONVERTED') lost.push(`${name}: ${warning.message}`);
      }
      for (let i = 0; i < doc.pages.length; i++) {
        drawn += opsNamed(parseOps(await contentOf(bytes, i)), 'Do').length;
      }
    }
    expect(lost).toEqual([]);
    // Measured on this corpus: 43 picture placements across the 25 convertible files.
    expect(drawn).toBe(43);
  }, TIMEOUT);
});

// A guard against the scratch directory silently not being written to.
describe('the fixtures themselves', () => {
  it('writes one PDF per convertible file', async () => {
    await convertAll();
    const written = readdirSync(scratch).filter((f) => f.endsWith('.pdf'));
    expect(written).toHaveLength(25);
  }, TIMEOUT);
});
