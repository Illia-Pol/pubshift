/**
 * pubshift/wasm — Microsoft Publisher parsing in WebAssembly.
 *
 * The shapes below mirror docs/IR.md, which is the contract between the
 * extractor and everything downstream. They are deliberately close to the raw
 * librevenge callback stream: nothing is interpreted here.
 */

/** A measurement that carries its unit. See the units table in docs/IR.md —
 *  the declared unit is not always the real one (`librevenge:rotate` is tagged
 *  `in` but means degrees), so normalise before trusting it. */
export interface IRMeasure {
  /** Numeric value. */
  v: number;
  /** `in`, `pt`, `twip`, `%`, or `''` for a generic number. */
  u: 'in' | 'pt' | 'twip' | '%' | '';
}

/** A property value: a string, a measurement, or a nested vector
 *  (`svg:d`, `svg:points`, `svg:linearGradient`, `librevenge:table-columns`). */
export type IRPropertyValue = string | IRMeasure | IRProperties[] | null;

export interface IRProperties {
  [key: string]: IRPropertyValue;
}

/** One librevenge callback, in the order it was emitted. */
export interface IREvent {
  /** Event type, e.g. `startPage`, `openSpan`, `drawPath`, `text`. */
  t: string;
  /** Properties, when the callback carried any. */
  p?: IRProperties;
  /** Text payload; present only on `t: 'text'`. */
  s?: string;
}

/**
 * Embedded binaries, hoisted out of the event stream and deduplicated by
 * content. The event carries `assetRef`; the value here is base64.
 */
export interface IRAssets {
  [key: string]: string;
}

export interface IREnvelope {
  ok: true;
  events: IREvent[];
  assets: IRAssets;
}

export type IRErrorCode =
  | 'UNSUPPORTED'
  | 'PARSE_FAILED'
  | 'PARSE_EXCEPTION'
  | 'NO_INPUT';

/**
 * A document we could not read.
 *
 * `message` is written for the person who dropped the file and is safe to show
 * verbatim; resist the urge to replace it with something more technical.
 */
export declare class PubshiftError extends Error {
  readonly name: 'PubshiftError';
  readonly code: IRErrorCode;
  constructor(code: IRErrorCode, message: string);
}

/**
 * The module could not be started, or it misbehaved. This is never the user's
 * file being wrong — treat it as a bug or an unsupported environment.
 */
export declare class PubshiftLoadError extends Error {
  readonly name: 'PubshiftLoadError';
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown);
}

export interface LoadOptions {
  /** Build a fresh instance instead of reusing the cached one. */
  reload?: boolean;
  /** Supply the .wasm bytes yourself (bundlers, offline caches, CSP setups). */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** Rewrite the URL the module fetches the .wasm from. */
  locateFile?: (path: string, scriptDirectory: string) => string;
}

export interface PubshiftModule {
  /** IR contract version this build produces, e.g. `pubshift-ir/1`. */
  readonly version: string;

  /**
   * Parses a Publisher document held in memory. Nothing is uploaded and
   * nothing is written to disk.
   *
   * @throws {PubshiftError} the file is not Publisher, or is corrupt
   * @throws {PubshiftLoadError} the module itself failed
   */
  extract(bytes: Uint8Array | ArrayBuffer | ArrayBufferView): IREnvelope;

  /**
   * The same parse, returned as the raw IR JSON text. Failures come back as
   * the `{"ok":false,...}` document instead of throwing.
   */
  extractJSON(bytes: Uint8Array | ArrayBuffer | ArrayBufferView): string;
}

/** Instantiates the module. Repeat calls reuse the first instance. */
export declare function loadPubshift(options?: LoadOptions): Promise<PubshiftModule>;

export default loadPubshift;
