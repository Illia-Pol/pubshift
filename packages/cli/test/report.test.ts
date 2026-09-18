/**
 * The report is the deliverable, so its failure modes are the ones worth pinning down:
 * a filename that executes when the spreadsheet is opened, a filename Excel mangles into
 * mojibake, an order that buries the nine files that need a human, and an HTML file that
 * phones home or renders a filename as markup.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Warning } from '@pubshift/core';

import {
  csvCell,
  describeLoss,
  escapeHtml,
  groupLosses,
  humanBytes,
  needsAttention,
  pageList,
  renderCsv,
  renderHtml,
  renderTextSummary,
  sortForReport,
  summariseResults,
  type FileResult,
} from '../src/report';

function result(over: Partial<FileResult> & Pick<FileResult, 'source'>): FileResult {
  return {
    sizeBytes: 1024,
    outcome: 'converted',
    outputs: [],
    pages: 1,
    warnings: [],
    ...over,
  };
}

const CRLF = '\r\n';
/** The data rows of a rendered CSV, BOM and header removed. */
function dataRows(csv: string): string[] {
  const lines = csv.replace(/^﻿/, '').split(CRLF);
  return lines.slice(1).filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------

describe('csvCell', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvCell('Bulletin.pub')).toBe('Bulletin.pub');
    expect(csvCell('1024')).toBe('1024');
    expect(csvCell('')).toBe('');
  });

  it('quotes fields containing a comma, a quote or a newline (RFC4180)', () => {
    expect(csvCell('Spring, 1998.pub')).toBe('"Spring, 1998.pub"');
    expect(csvCell('He said "hi".pub')).toBe('"He said ""hi"".pub"');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell('carriage\rreturn')).toBe('"carriage\rreturn"');
  });

  it('quotes fields with leading or trailing space so they survive a round trip', () => {
    expect(csvCell(' padded ')).toBe('" padded "');
  });

  it.each(['=', '+', '-', '@'])('neutralises a field starting with %s', (lead) => {
    const cell = csvCell(`${lead}cmd|'/c calc'!A1`);
    expect(cell.startsWith("'")).toBe(true);
    expect(cell.startsWith(lead)).toBe(false);
  });

  it('neutralises the tab and carriage-return lead-ins as well', () => {
    expect(csvCell('\t=1+1')).toBe('"\'\t=1+1"');
    expect(csvCell('\r=1+1')).toBe('"\'\r=1+1"');
  });

  it('neutralises and quotes together when the value needs both', () => {
    expect(csvCell('=HYPERLINK("http://evil","click"),x')).toBe(
      '"\'=HYPERLINK(""http://evil"",""click""),x"',
    );
  });

  it('does not mangle a name that merely contains an equals sign', () => {
    expect(csvCell('rate=12.pub')).toBe('rate=12.pub');
  });
});

describe('renderCsv', () => {
  it('starts with a UTF-8 BOM and uses CRLF line endings', () => {
    const csv = renderCsv([result({ source: 'a.pub' })]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain(CRLF);
    expect(csv.endsWith(CRLF)).toBe(true);
    expect(csv.replace(/^﻿/, '').split(CRLF)[0]).toBe(
      'Source file,Size (bytes),Size,Outcome,Needs attention,Pages,Output files,Format,' +
        'Format chosen automatically,Why this format,What was lost,Note',
    );
  });

  it('carries non-ASCII filenames through unchanged', () => {
    const source = '/Gemeinde/Grüße_Weihnachten_ыёж_日本語.pub';
    const csv = renderCsv([result({ source })]);
    expect(csv).toContain(source);
    // The BOM is the only reason Excel on Windows shows that string rather than mojibake.
    expect(Buffer.from(csv, 'utf8').subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('never emits a cell that a spreadsheet would execute', () => {
    const hostile = [
      "=cmd|'/c calc'!A1.pub",
      '+1+1.pub',
      '-2+3.pub',
      '@SUM(1,2).pub',
      '=HYPERLINK("http://evil.example/steal","Click me").pub',
    ];
    const csv = renderCsv(hostile.map((source) => result({ source, outcome: 'failed' })));

    for (const row of dataRows(csv)) {
      const first = row.startsWith('"') ? row.slice(1) : row;
      expect(first[0]).toBe("'");
    }
    // And the raw formula never appears at the start of a field anywhere in the file.
    expect(/(^|,|")=cmd/.test(csv)).toBe(false);
  });

  it('writes a filterable attention column and plain-English losses, not enum names', () => {
    const csv = renderCsv([
      result({
        source: 'news.pub',
        outcome: 'converted-with-caveats',
        warnings: [{ code: 'WMF_IMAGE_NOT_CONVERTED', message: 'raw', page: 2, count: 13 }],
        format: { format: 'pptx', automatic: true, because: 'Because it has a table.' },
        outputs: [{ path: 'out/news.pptx', format: 'pptx' }],
        pages: 4,
      }),
      result({ source: 'clean.pub' }),
    ]);
    const rows = dataRows(csv);
    expect(rows[0]).toContain('yes');
    expect(rows[1]).toContain('no');
    expect(csv).toContain('Older Publisher clip art');
    expect(csv).toContain('13 times, page 2');
    expect(csv).not.toContain('WMF_IMAGE_NOT_CONVERTED');
    expect(csv).toContain('Because it has a table.');
  });
});

// ---------------------------------------------------------------------------

describe('sortForReport', () => {
  const results: FileResult[] = [
    result({ source: 'z-clean.pub' }),
    result({ source: 'a-clean.pub' }),
    result({
      source: 'one-loss.pub',
      outcome: 'converted-with-caveats',
      warnings: [{ code: 'SHADOW_DROPPED', message: 'm' }],
    }),
    result({ source: 'blank.pub', outcome: 'unreadable', pages: 0 }),
    result({
      source: 'many-losses.pub',
      outcome: 'converted-with-caveats',
      warnings: [{ code: 'WMF_IMAGE_NOT_CONVERTED', message: 'm', count: 9 }],
    }),
    result({ source: 'crashed.pub', outcome: 'failed', pages: 0 }),
  ];

  it('puts the files needing attention first, worst kind first', () => {
    expect(sortForReport(results).map((r) => r.source)).toEqual([
      'crashed.pub',
      'blank.pub',
      'many-losses.pub',
      'one-loss.pub',
      'a-clean.pub',
      'z-clean.pub',
    ]);
  });

  it('is stable across runs and does not mutate the input', () => {
    const before = results.map((r) => r.source);
    const once = sortForReport(results).map((r) => r.source);
    const twice = sortForReport(sortForReport(results)).map((r) => r.source);
    expect(once).toEqual(twice);
    expect(results.map((r) => r.source)).toEqual(before);
  });

  it('counts the outcomes the same way the writers do', () => {
    const s = summariseResults(results);
    expect(s).toMatchObject({
      total: 6,
      converted: 2,
      withCaveats: 2,
      unreadable: 1,
      failed: 1,
      needsAttention: 4,
    });
    expect(results.filter(needsAttention)).toHaveLength(4);
  });
});

describe('renderTextSummary', () => {
  const many: FileResult[] = [
    ...Array.from({ length: 30 }, (_, i) =>
      result({ source: `ok-${String(i).padStart(3, '0')}.pub` }),
    ),
    result({ source: 'blank.pub', outcome: 'unreadable', pages: 0, message: 'Nothing inside.' }),
    result({
      source: 'shadow.pub',
      outcome: 'converted-with-caveats',
      warnings: [{ code: 'SHADOW_DROPPED', message: 'm', page: 1 }],
    }),
  ];

  it('leads with what needs a human, not with the success count', () => {
    const text = renderTextSummary(many);
    const attention = text.indexOf('NEEDS A HUMAN');
    const success = text.indexOf('CONVERTED CLEANLY');
    expect(attention).toBeGreaterThan(-1);
    expect(success).toBeGreaterThan(attention);
    expect(text).toContain('2 of 32 files');
    // The two files to open are named before the thirty that are fine.
    expect(text.indexOf('blank.pub')).toBeLessThan(text.indexOf('ok-000.pub'));
    expect(text.indexOf('blank.pub')).toBeLessThan(text.indexOf('shadow.pub'));
  });

  it('caps the clean list rather than printing four hundred lines', () => {
    const text = renderTextSummary(many);
    expect(text).toContain('and 10 more');
    expect(text).not.toContain('ok-029.pub');
  });

  it('says so plainly when nothing needs a human', () => {
    const text = renderTextSummary([result({ source: 'a.pub' })]);
    expect(text).toContain('NOTHING NEEDS A HUMAN');
    expect(text.indexOf('NOTHING NEEDS A HUMAN')).toBeLessThan(text.indexOf('CONVERTED CLEANLY'));
  });

  it('keeps its own headings and wording ASCII so they print on a Windows console', () => {
    // Only the report's own furniture. A file called `Grusse.pub` with an umlaut is the
    // user's text and is passed through as it is: mangling a filename to protect a code
    // page would break the one column they use to find the file.
    expect(/[^\x20-\x7E\n]/.test(renderTextSummary(many))).toBe(false);
  });

  it('handles an empty run', () => {
    expect(renderTextSummary([])).toContain('No .pub files were found');
  });
});

// ---------------------------------------------------------------------------

describe('renderHtml', () => {
  const hostile = result({
    source: '<script>alert("xss")</script> & "quoted" \'name\'.pub',
    outcome: 'converted-with-caveats',
    warnings: [{ code: 'GRADIENT_FLATTENED', message: '<b>raw</b>', count: 2, page: 3 }],
    outputs: [{ path: 'out/<img src=x onerror=alert(1)>.pptx', format: 'pptx' }],
    message: 'A message with <angle> brackets & an ampersand.',
  });

  it('is a single self-contained file that loads nothing', () => {
    const html = renderHtml([hostile, result({ source: 'fine.pub' })]);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<style>');
    // No scripts, no external resources, no links out, nothing to fetch. Checked against
    // the tags only: file-supplied text is escaped, so a filename like `<img src=x>` shows
    // up as text in the body and must not be mistaken for markup by this assertion.
    const tags = html.match(/<[^>]+>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) {
      expect(/^<\/?(script|link|iframe|object|embed|img|base)[\s/>]/i.test(tag), tag).toBe(false);
      expect(/\s(src|href|srcset|data|codebase|background)\s*=/i.test(tag), tag).toBe(false);
      expect(/https?:/i.test(tag), tag).toBe(false);
    }
    expect(/@import|url\(/i.test(html)).toBe(false);
    expect(html).toContain('@media print');
  });

  it('escapes every piece of file-supplied text', () => {
    const html = renderHtml([hostile]);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; ');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;.pptx');
    expect(html).toContain('A message with &lt;angle&gt; brackets &amp; an ampersand.');
    // The one place an escaped ampersand must not be double-escaped.
    expect(html).not.toContain('&amp;amp;');
  });

  it('leads with the files needing a human and describes the loss in plain English', () => {
    const html = renderHtml([result({ source: 'fine.pub' }), hostile], {
      root: '/Volumes/Parish & Co/Archive',
    });
    expect(html.indexOf('Needs a human')).toBeLessThan(html.indexOf('Every file'));
    expect(html).toContain('1 file of 2 needs a human look');
    expect(html).toContain('A colour fade was replaced with a single flat colour. (2 times, page 3)');
    expect(html).not.toContain('GRADIENT_FLATTENED');
    expect(html).toContain('/Volumes/Parish &amp; Co/Archive');
  });

  it('omits the attention section entirely when there is nothing to report', () => {
    const html = renderHtml([result({ source: 'fine.pub' })]);
    expect(html).not.toContain('Needs a human');
    expect(html).toContain('Nothing needs a human');
  });
});

describe('escapeHtml', () => {
  it('covers the five characters that matter', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });
});

// ---------------------------------------------------------------------------

describe('plain English', () => {
  const root = new URL('../../../', import.meta.url);

  it('has a sentence for every WarningCode in the core model', () => {
    const types = readFileSync(
      fileURLToPath(new URL('packages/core/src/model/types.ts', root)),
      'utf8',
    );
    const union = types.slice(types.indexOf('export type WarningCode'));
    const codes = [...union.slice(0, union.indexOf(';')).matchAll(/'([A-Z_]+)'/g)].map(
      (m) => m[1] as string,
    );
    expect(codes.length).toBeGreaterThan(0);

    for (const code of codes) {
      const warning = { code, message: 'FALLBACK' } as unknown as Warning;
      const [group] = groupLosses([warning]);
      expect(group, code).toBeDefined();
      expect(group?.sentence, code).not.toBe('FALLBACK');
      expect(group?.sentence, code).not.toContain('_');
      expect(group?.sentence.endsWith('.'), code).toBe(true);
    }
  });

  it('uses exactly the wording the website uses, so the two never disagree', () => {
    const notes = readFileSync(fileURLToPath(new URL('apps/web/lib/notes.ts', root)), 'utf8');
    const sentences = [
      'GRADIENT_FLATTENED',
      'SHADOW_DROPPED',
      'COLUMNS_FLATTENED',
      'OVERLAP_MAY_REFLOW',
      'WMF_IMAGE_NOT_CONVERTED',
    ].map((code) => groupLosses([{ code, message: 'x' } as unknown as Warning])[0]?.sentence ?? '');

    for (const sentence of sentences) {
      expect(sentence.length).toBeGreaterThan(0);
      expect(notes, sentence).toContain(sentence);
    }
  });

  it('falls back to the pipeline message for a code it does not know', () => {
    const unknown = { code: 'SOMETHING_NEW', message: 'A new kind of loss.' } as unknown as Warning;
    expect(groupLosses([unknown])[0]?.sentence).toBe('A new kind of loss.');
  });

  it('merges repeats, sums counts and collects pages', () => {
    const warnings = [
      { code: 'SHADOW_DROPPED', message: 'm', page: 3 },
      { code: 'SHADOW_DROPPED', message: 'm', page: 1, count: 2 },
      { code: 'GRADIENT_FLATTENED', message: 'm' },
    ] as unknown as Warning[];
    const groups = groupLosses(warnings);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ code: 'SHADOW_DROPPED', count: 3, pages: [1, 3] });
    expect(describeLoss(groups[0]!)).toContain('(3 times, pages 1 and 3)');
    expect(describeLoss(groups[1]!)).toBe('A colour fade was replaced with a single flat colour.');
  });

  it('lists pages the way a person would say them', () => {
    expect(pageList([])).toBe('');
    expect(pageList([3])).toBe('page 3');
    expect(pageList([3, 4])).toBe('pages 3 and 4');
    expect(pageList([3, 4, 9])).toBe('pages 3, 4 and 9');
  });
});

describe('humanBytes', () => {
  it('rounds the way a person reads a file listing', () => {
    expect(humanBytes(0)).toBe('0 B');
    expect(humanBytes(999)).toBe('999 B');
    expect(humanBytes(21 * 1024)).toBe('21 KB');
    expect(humanBytes(1536)).toBe('1.5 KB');
    expect(humanBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(humanBytes(Number.NaN)).toBe('');
  });
});
