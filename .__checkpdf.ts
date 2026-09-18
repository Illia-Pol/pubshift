import { readdirSync, readFileSync } from 'node:fs';
import { PDFDocument } from 'pdf-lib';

const OUT = '/private/tmp/claude-501/-Users-illia-pol/cdcaf96d-92b0-40f9-b037-9f16e3768b9b/scratchpad/out';

async function main() {
  for (const f of readdirSync(OUT).filter((x) => x.endsWith('.pdf')).sort()) {
    const bytes = readFileSync(`${OUT}/${f}`);
    try {
      const d = await PDFDocument.load(bytes, { throwOnInvalidObject: true });
      d.getPageCount();
      console.log(`PDF-OK   ${f}`);
    } catch (e: any) {
      console.log(`PDF-BAD  ${f}: ${String(e?.message).split('\n')[0].slice(0, 200)}`);
    }
  }
}
main();
