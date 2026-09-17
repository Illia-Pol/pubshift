import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { assess } from '../src/model/assess';
import { recommendFormat } from '../src/model/recommend';
import { corpusFiles, docFor, REPO_ROOT } from './helpers';

const FIDELITY = path.join(REPO_ROOT, 'tools', 'fidelity', 'fidelity.json');

describe('format recommendation', () => {
  it('recommends PowerPoint when the table is the document', () => {
    for (const name of ['tables.pub', 'table-merged.pub']) {
      expect({ name, ...recommendFormat(docFor(name)) }).toMatchObject({
        format: 'pptx',
        confident: true,
      });
    }
  });

  it('recommends Word for a short single block of text', () => {
    for (const name of ['text-style.pub', 'bold-style.pub', 'underline-style.pub']) {
      expect({ name, ...recommendFormat(docFor(name)) }).toMatchObject({
        format: 'docx',
        confident: true,
      });
    }
  });

  it('declines to claim confidence when a table is incidental', () => {
    // fdo68259-2.pub is a four-page newsletter with one table among 138 elements, and
    // DOCX measured better there (0.900 against 0.747). An incidental table says nothing
    // about how the publication as a whole should travel.
    expect(recommendFormat(docFor('fdo68259-2.pub')).confident).toBe(false);
  });

  /**
   * The `confident` flag has to stay earned. If a change makes the confident rules fire
   * more widely, this fails until the fidelity numbers are re-measured and still agree.
   */
  it.skipIf(!existsSync(FIDELITY))(
    'every confident recommendation beats the alternative in the measured scores',
    () => {
      const scores = JSON.parse(readFileSync(FIDELITY, 'utf8')) as {
        files: { name: string; status: string; formats: Record<string, { score?: number }> }[];
      };
      const byFile = new Map(
        scores.files.filter((f) => f.status === 'scored').map((f) => [f.name, f.formats]),
      );

      const losses: string[] = [];
      let judged = 0;

      for (const name of corpusFiles()) {
        let doc;
        try { doc = docFor(name); } catch { continue; }
        if (assess(doc).verdict === 'empty') continue;

        const rec = recommendFormat(doc);
        if (!rec.confident) continue;

        const formats = byFile.get(name);
        const mine = formats?.[rec.format]?.score;
        const other = formats?.[rec.format === 'pptx' ? 'docx' : 'pptx']?.score;
        if (mine == null || other == null) continue;

        judged++;
        // Under 0.05 the two are a tie to anyone looking at the page; only real losses count.
        if (other - mine >= 0.05) losses.push(`${name}: ${rec.format} ${mine} vs ${other}`);
      }

      // Guards against this test quietly passing because it compared nothing at all —
      // which is exactly how it failed the first time it was written.
      expect(judged).toBeGreaterThanOrEqual(6);
      expect(losses).toEqual([]);
    },
  );
});
