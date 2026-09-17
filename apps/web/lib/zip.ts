/**
 * Bundling a batch into one .zip, in the browser.
 *
 * Fifteen years of parish bulletins is not a one-file job, and clicking forty
 * download buttons is not a workflow. This runs in the worker with everything
 * else, so a big batch does not lock the page while it packs.
 *
 * PPTX, DOCX and PDF are already deflate-compressed containers; squeezing them
 * again costs seconds and saves almost nothing, so they are stored. SVG is plain
 * text and compresses to roughly a fifth, so it is deflated.
 */

import JSZip from 'jszip';
import type { ZipEntry } from '@/lib/protocol';

/** Two files called `Bulletin.pptx` must not silently become one file called `Bulletin.pptx`. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    taken.add(name);
    return name;
  }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem} (${n})${extension}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

export async function zipOutputs(entries: ZipEntry[], comment?: string): Promise<Blob> {
  const zip = new JSZip();
  const taken = new Set<string>();

  for (const entry of entries) {
    const name = uniqueName(entry.name, taken);
    const deflate = name.toLowerCase().endsWith('.svg');
    zip.file(name, entry.blob, {
      compression: deflate ? 'DEFLATE' : 'STORE',
      ...(deflate ? { compressionOptions: { level: 6 } } : {}),
    });
  }

  // The list of what did not convert travels with the files that did. Someone
  // opening this folder in eighteen months should not have to remember.
  if (comment) {
    zip.file(uniqueName('READ ME — what did not convert.txt', taken), comment);
  }

  return zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
}
