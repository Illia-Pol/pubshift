/**
 * A minimal PDF content-stream reader for tests.
 *
 * The PDF emitter writes raw operators, so the only way to assert on what it produced is
 * to read the operators back. pdf-lib can re-parse the file and inflate the stream but has
 * no operator-level reader, and adding a full PDF parser to the dependency tree to assert
 * on our own output would be a heavy dependency for a light job.
 *
 * Deliberately narrow: it understands the subset of PDF syntax the emitter can emit, and
 * throws on anything else, so a malformed stream fails the test rather than being skipped.
 */

import {
  PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';

// --- typed accessors --------------------------------------------------------
//
// pdf-lib's `lookup(key, type)` asserts the type it is given, which keeps assertions in
// the tests readable and makes a missing or wrong-typed entry a clear failure instead of
// an `undefined` that quietly compares equal to nothing.

/** A sub-dictionary, by key. */
export function dictAt(dict: PDFDict, key: string): PDFDict {
  return dict.lookup(PDFName.of(key), PDFDict);
}

/** A number entry, by key. */
export function numberAt(dict: PDFDict, key: string): number {
  return dict.lookup(PDFName.of(key), PDFNumber).asNumber();
}

/** A numeric array entry, by key. */
export function numbersAt(dict: PDFDict, key: string): number[] {
  return dict.lookup(PDFName.of(key), PDFArray).asArray().map((v) => (v as PDFNumber).asNumber());
}

/** A name entry, by key, without its leading slash. */
export function nameAt(dict: PDFDict, key: string): string {
  return dict.lookup(PDFName.of(key), PDFName).asString().replace(/^\//, '');
}

/** The number of entries in an array-valued key. */
export function lengthAt(dict: PDFDict, key: string): number {
  return dict.lookup(PDFName.of(key), PDFArray).size();
}

/** The first link annotation's target URI, or undefined when there is no link. */
export async function firstLinkURI(bytes: Uint8Array, pageIndex = 0): Promise<string | undefined> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const annots = pdf.getPage(pageIndex).node.Annots();
  if (!annots || annots.size() === 0) return undefined;
  const action = dictAt(annots.lookup(0, PDFDict), 'A');
  return action.lookup(PDFName.of('URI'))?.toString().replace(/^\(|\)$/g, '');
}

/** The number of annotations on a page. */
export async function annotationCount(bytes: Uint8Array, pageIndex = 0): Promise<number> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  return pdf.getPage(pageIndex).node.Annots()?.size() ?? 0;
}

/** The dictionaries of the image XObjects a page declares, in resource order. */
export async function imageDictsOf(bytes: Uint8Array, pageIndex = 0): Promise<PDFDict[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const xobjects = pdf.getPage(pageIndex).node.Resources()?.lookup(PDFName.of('XObject'));
  if (!(xobjects instanceof PDFDict)) return [];
  const out: PDFDict[] = [];
  for (const key of xobjects.keys()) {
    const value = xobjects.lookup(key);
    if (value instanceof PDFStream) out.push(value.dict);
  }
  return out;
}

/** The inflated content stream of one page. */
export async function contentOf(bytes: Uint8Array, pageIndex = 0): Promise<string> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const page = pdf.getPage(pageIndex);
  const contents = page.node.Contents();
  const streams: PDFRawStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = contents.lookup(i);
      if (s instanceof PDFRawStream) streams.push(s);
    }
  } else if (contents instanceof PDFRawStream) {
    streams.push(contents);
  }
  if (streams.length === 0) throw new Error(`page ${pageIndex} has no readable content stream`);
  return streams
    .map((s) => new TextDecoder('latin1').decode(decodePDFRawStream(s).decode()))
    .join('\n');
}

export interface Op {
  /** The operator itself, e.g. `Tj`, `re`, `cm`. */
  op: string;
  /** Its operands, in order. Numbers stay numbers; names keep their leading slash. */
  args: Array<number | string | Array<number | string>>;
}

const DELIMITERS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';
}

/**
 * Splits a content stream into operators and their operands.
 *
 * Hex strings come back as `<...>` with the angle brackets kept, so a test can tell a
 * string operand from a name without a second type.
 */
export function parseOps(content: string): Op[] {
  const out: Op[] = [];
  let operands: Array<number | string | Array<number | string>> = [];
  let i = 0;

  const readToken = (): string | undefined => {
    while (i < content.length && isWhitespace(content[i] as string)) i++;
    if (i >= content.length) return undefined;
    const c = content[i] as string;
    if (c === '%') { // comment to end of line
      while (i < content.length && content[i] !== '\n') i++;
      return readToken();
    }
    if (c === '<') {
      const end = content.indexOf('>', i);
      if (end < 0) throw new Error('unterminated hex string');
      const token = content.slice(i, end + 1);
      i = end + 1;
      return token;
    }
    if (c === '(') {
      // Literal strings: balanced parens, backslash escapes.
      let depth = 0;
      const start = i;
      for (; i < content.length; i++) {
        const ch = content[i];
        if (ch === '\\') { i++; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
      }
      if (depth !== 0) throw new Error('unterminated literal string');
      return content.slice(start, i);
    }
    if (c === '[' || c === ']') { i++; return c; }
    const start = i;
    if (c === '/') i++;
    while (i < content.length && !isWhitespace(content[i] as string) && !DELIMITERS.has(content[i] as string)) i++;
    if (i === start) throw new Error(`unexpected character ${JSON.stringify(c)} in content stream`);
    return content.slice(start, i);
  };

  let array: Array<number | string> | undefined;
  for (let token = readToken(); token !== undefined; token = readToken()) {
    if (token === '[') { array = []; continue; }
    if (token === ']') {
      if (!array) throw new Error('unbalanced ] in content stream');
      operands.push(array);
      array = undefined;
      continue;
    }
    const asNumber = /^[-+]?(\d+\.?\d*|\.\d+)$/.test(token) ? Number(token) : undefined;
    const value = asNumber === undefined ? token : asNumber;
    if (array) { array.push(value); continue; }
    if (typeof value === 'number' || token.startsWith('/') || token.startsWith('<') || token.startsWith('(')) {
      operands.push(value);
      continue;
    }
    out.push({ op: token, args: operands });
    operands = [];
  }
  return out;
}

export function opsNamed(ops: Op[], name: string): Op[] {
  return ops.filter((o) => o.op === name);
}

/** The 0x80–0x9F range, where WinAnsi differs from Latin-1. `''` marks an unused slot. */
const WINANSI_HIGH = [
  '€', '', '‚', 'ƒ', '„', '…', '†', '‡',
  'ˆ', '‰', 'Š', '‹', 'Œ', '', 'Ž', '',
  '', '‘', '’', '“', '”', '•', '–', '—',
  '˜', '™', 'š', '›', 'œ', '', 'ž', 'Ÿ',
];

function decodeWinAnsi(bytes: number[]): string {
  let out = '';
  for (const b of bytes) {
    if (b >= 0x80 && b <= 0x9f) out += WINANSI_HIGH[b - 0x80] ?? '';
    else out += String.fromCharCode(b);
  }
  return out;
}

function hexToBytes(token: string): number[] {
  const hex = token.slice(1, -1).replace(/\s+/g, '');
  const padded = hex.length % 2 === 1 ? `${hex}0` : hex;
  const out: number[] = [];
  for (let j = 0; j < padded.length; j += 2) out.push(parseInt(padded.slice(j, j + 2), 16));
  return out;
}

export interface ShownText {
  text: string;
  /** Text-matrix translation, i.e. where the string starts, in PDF user space. */
  x: number;
  y: number;
}

/**
 * Every string the page shows, in the order the stream shows them.
 *
 * Content marked `/Artifact` is skipped, which is what a conforming reader does and what
 * the emitter relies on to keep shadow and relief ghosts out of the extracted text.
 */
export function extractText(content: string): ShownText[] {
  const out: ShownText[] = [];
  let x = 0;
  let y = 0;
  let artifactDepth = 0;
  for (const { op, args } of parseOps(content)) {
    if (op === 'BMC' || op === 'BDC') {
      if (artifactDepth > 0 || args[0] === '/Artifact') artifactDepth++;
      continue;
    }
    if (op === 'EMC') {
      if (artifactDepth > 0) artifactDepth--;
      continue;
    }
    if (op === 'Tm') {
      x = Number(args[4] ?? 0);
      y = Number(args[5] ?? 0);
      continue;
    }
    if (op === 'Tj' && artifactDepth === 0) {
      const token = args[args.length - 1];
      if (typeof token === 'string' && token.startsWith('<')) {
        out.push({ text: decodeWinAnsi(hexToBytes(token)), x, y });
      }
    }
  }
  return out;
}

/** The concatenated text of a page, artifacts excluded. */
export function pageText(content: string): string {
  return extractText(content).map((t) => t.text).join('');
}

/** The `/Shading` dictionaries a page declares, by resource name. */
export async function shadingsOf(bytes: Uint8Array, pageIndex = 0): Promise<Map<string, PDFDict>> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const resources = pdf.getPage(pageIndex).node.Resources();
  const out = new Map<string, PDFDict>();
  const shadings = resources?.lookup(PDFName.of('Shading'));
  if (shadings instanceof PDFDict) {
    for (const key of shadings.keys()) {
      const value = shadings.lookup(key);
      if (value instanceof PDFDict) out.set(String(key), value);
    }
  }
  return out;
}

/** The `/ExtGState` dictionaries a page declares, by resource name. */
export async function extGStatesOf(bytes: Uint8Array, pageIndex = 0): Promise<Map<string, PDFDict>> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const resources = pdf.getPage(pageIndex).node.Resources();
  const out = new Map<string, PDFDict>();
  const states = resources?.lookup(PDFName.of('ExtGState'));
  if (states instanceof PDFDict) {
    for (const key of states.keys()) {
      const value = states.lookup(key);
      if (value instanceof PDFDict) out.set(String(key), value);
    }
  }
  return out;
}

/** The BaseFont names a page references, in resource order. */
export async function fontsOf(bytes: Uint8Array, pageIndex = 0): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  const resources = pdf.getPage(pageIndex).node.Resources();
  const fonts = resources?.lookup(PDFName.of('Font'));
  const out: string[] = [];
  if (fonts instanceof PDFDict) {
    for (const key of fonts.keys()) {
      const dict = fonts.lookup(key);
      if (dict instanceof PDFDict) out.push(String(dict.lookup(PDFName.of('BaseFont'))).replace(/^\//, ''));
    }
  }
  return out.sort();
}
