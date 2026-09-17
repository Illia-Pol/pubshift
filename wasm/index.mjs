// index.mjs — the JS face of the WebAssembly extractor.
//
//   import { loadPubshift } from './wasm/index.mjs';
//   const pubshift = await loadPubshift();
//   const ir = pubshift.extract(new Uint8Array(await file.arrayBuffer()));
//
// `extract` returns the IR envelope described in docs/IR.md. A file that cannot
// be read throws a PubshiftError carrying the message the parser wrote for the
// person who dropped the file — see the error notes below.
//
// Nothing here touches the network or the filesystem. The bytes go into the
// module's linear memory, the JSON comes back out, and both buffers are freed
// before the call returns.

import createPubshift from './dist/pubshift.mjs';

/**
 * A .pub file we could not read. `code` is one of the IR error codes
 * (UNSUPPORTED, PARSE_FAILED, PARSE_EXCEPTION, NO_INPUT); `message` is written
 * to be shown to a non-technical person as-is, so pass it straight through to
 * the UI rather than rewriting it.
 */
export class PubshiftError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PubshiftError';
    this.code = code;
  }
}

/** The module failed to load or behaved impossibly. Not a bad input file. */
export class PubshiftLoadError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PubshiftLoadError';
    this.cause = cause;
  }
}

let cached = null;

/**
 * Instantiates the WebAssembly module. Cheap to call repeatedly: the first call
 * does the work and later ones return the same handle, so a page can call it
 * on load and again per file without paying twice.
 *
 * @param {{ reload?: boolean, wasmBinary?: ArrayBuffer|Uint8Array,
 *           locateFile?: (path: string, prefix: string) => string }} [options]
 */
export async function loadPubshift(options = {}) {
  if (cached && !options.reload) return cached;

  const moduleArgs = {};
  if (options.wasmBinary) moduleArgs.wasmBinary = options.wasmBinary;
  if (options.locateFile) moduleArgs.locateFile = options.locateFile;

  let wasm;
  try {
    wasm = await createPubshift(moduleArgs);
  } catch (err) {
    throw new PubshiftLoadError(
      'Could not start the Publisher reader in this browser.',
      err,
    );
  }

  const handle = new Pubshift(wasm);
  if (!options.reload) cached = handle;
  return handle;
}

class Pubshift {
  #wasm;

  constructor(wasm) {
    this.#wasm = wasm;
  }

  /** IR contract version this build produces, e.g. "pubshift-ir/1". */
  get version() {
    return this.#wasm.UTF8ToString(this.#wasm._pubshift_version());
  }

  /**
   * Parses a Publisher document.
   *
   * @param {Uint8Array} bytes the raw .pub file
   * @returns {IREnvelope} `{ ok: true, events, assets }`
   * @throws {PubshiftError} when the file is not readable Publisher
   */
  extract(bytes) {
    const view = toBytes(bytes);
    const json = this.extractJSON(view);

    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      // The extractor builds this JSON itself, so a parse failure here is our
      // bug, not the user's file. Say so rather than blaming the document.
      throw new PubshiftLoadError('The Publisher reader produced invalid output.', err);
    }

    if (parsed.ok !== true) {
      const code = parsed?.error?.code ?? 'PARSE_FAILED';
      const message = parsed?.error?.message ?? 'The document could not be read.';
      throw new PubshiftError(code, message);
    }
    return parsed;
  }

  /**
   * Same work as `extract`, but hands back the raw JSON text.
   *
   * Worth having: it is what the parity test compares against the native
   * extractor byte for byte, and a caller streaming the IR somewhere else can
   * skip a parse-and-restringify round trip. Failures come back as the
   * `{"ok":false}` document rather than as a thrown error.
   */
  extractJSON(bytes) {
    const view = toBytes(bytes);
    const wasm = this.#wasm;

    let inPtr = 0;
    let lenPtr = 0;
    let outPtr = 0;
    try {
      // malloc(0) is allowed to return null, and an empty file is a real thing
      // a user can drop, so give it a byte to point at.
      inPtr = wasm._malloc(Math.max(1, view.length));
      if (!inPtr) throw new PubshiftLoadError('Out of memory reading the document.');
      wasm.HEAPU8.set(view, inPtr);

      lenPtr = wasm._malloc(4);
      if (!lenPtr) throw new PubshiftLoadError('Out of memory reading the document.');

      outPtr = wasm._pubshift_extract(inPtr, view.length, lenPtr);
      if (!outPtr) throw new PubshiftLoadError('Out of memory reading the document.');

      const len = wasm.HEAPU32[lenPtr >>> 2];
      // Decode from the heap directly. UTF8ToString would stop at a NUL, and
      // while the extractor escapes control characters, reading by the length
      // it reported is the version that cannot be surprised.
      return new TextDecoder('utf-8').decode(
        wasm.HEAPU8.subarray(outPtr, outPtr + len),
      );
    } finally {
      // Every exit path, including a throw from inside the module: a converter
      // that leaks a document's worth of memory per file would die on the
      // fourth newsletter.
      if (outPtr) wasm._pubshift_free(outPtr);
      if (lenPtr) wasm._free(lenPtr);
      if (inPtr) wasm._free(inPtr);
    }
  }
}

function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  throw new TypeError('extract() expects a Uint8Array of the .pub file');
}

export default loadPubshift;
