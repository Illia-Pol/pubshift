/**
 * Starting the Publisher reader.
 *
 * This is the WebAssembly build, not `bin/pubshift-extract`. The native binary is
 * faster to start and is the parity oracle, but it needs libmspub and icu4c present
 * on the machine, which means Homebrew, which means a Mac with developer tools. The
 * product promise is that this installs and runs on Mac, Windows and Linux with
 * nothing but Node, and only the WASM build keeps it. `wasm/test/parity.mjs` is the
 * standing evidence that the two agree byte for byte on all 31 corpus files, so this
 * costs no fidelity.
 *
 * Nothing here opens a socket. The module is a local file loaded from disk.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface ExtractorHandle {
  readonly version: string;
  extractJSON(bytes: Uint8Array): string;
}

interface WasmEntry {
  loadPubshift(options?: { reload?: boolean }): Promise<ExtractorHandle>;
}

export class EngineUnavailable extends Error {
  override readonly name = 'EngineUnavailable';
}

/**
 * Two places the reader can be, and both are ordinary files on this disk.
 *
 * `vendor/wasm` is what `build.mjs` copies in and what a published install has.
 * The repository copy is the fallback, so that someone working in a checkout who
 * has not run the build yet still gets a working tool rather than a puzzle.
 */
function candidates(): string[] {
  return [
    fileURLToPath(new URL('../vendor/wasm/index.mjs', import.meta.url)),
    fileURLToPath(new URL('../../../wasm/index.mjs', import.meta.url)),
  ];
}

let handle: ExtractorHandle | null = null;

async function start(reload: boolean): Promise<ExtractorHandle> {
  const tried = candidates();
  const found = tried.find((p) => existsSync(p));
  if (found === undefined) {
    throw new EngineUnavailable(
      'The Publisher reader is missing from this installation. Reinstalling pubshift should fix it.',
    );
  }

  // A variable specifier so that bundlers leave it alone: the target is Emscripten
  // output that finds its own .wasm beside itself at runtime, and inlining it into a
  // bundle breaks that. apps/web/lib/convert.ts makes the same choice for the same reason.
  const specifier = new URL(`file://${found.replace(/\\/g, '/')}`).href;
  let entry: WasmEntry;
  try {
    entry = (await import(specifier)) as WasmEntry;
  } catch (cause) {
    throw new EngineUnavailable(
      `The Publisher reader would not start. ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return entry.loadPubshift(reload ? { reload: true } : undefined);
}

/** Starts the reader once per process. Cheap to call again. */
export async function loadEngine(): Promise<ExtractorHandle> {
  if (handle === null) handle = await start(false);
  return handle;
}

/**
 * Builds a fresh reader, discarding the old one.
 *
 * Worth having for a four-hundred-file run: if the module ever aborts internally —
 * out of memory on one enormous file, say — its heap is not guaranteed to be sane
 * afterwards, and every remaining file would inherit the damage. Rebuilding costs a
 * few milliseconds and contains the blast radius to the one file that caused it.
 */
export async function reloadEngine(): Promise<ExtractorHandle> {
  handle = await start(true);
  return handle;
}
