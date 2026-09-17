// A PNG codec in the ~250 lines it actually takes, so the fidelity harness can look at
// pixels without the project acquiring an image dependency.
//
// Scope is deliberate: every PNG this tool ever decodes was written minutes earlier by
// `pdftoppm` or by LibreOffice's own PNG export, so the encoder is known. Both emit
// non-interlaced 8-bit images. The decoder nonetheless handles all five filter types,
// bit depths 1/2/4/8/16 and colour types 0/2/3/4/6, because "we only ever see RGB8"
// is the kind of assumption that turns into a silent wrong answer when the toolchain
// changes underneath. Adam7 interlacing is the one case it refuses, loudly.
//
// The encoder writes 8-bit RGBA with filter 0 on every row. Diff images are large flat
// areas of three colours; the filter choice costs a few KB and saves a heuristic.

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channels per pixel, indexed by PNG colour type. Types 1 and 5 do not exist. */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** How big a PNG we are willing to allocate for, as a pixel count. A 600 DPI A0 page is ~80M. */
const MAX_PIXELS = 100_000_000;

// ---------------------------------------------------------------- crc32

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- decode

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Reverses the per-scanline filter in place over the concatenated IDAT payload.
 * `bpp` is the filter's byte distance to the pixel on the left — ceil(bits per pixel / 8),
 * never less than 1, which is what the spec means by "corresponding byte of the prior pixel".
 */
function unfilter(raw, width, height, bpp, stride) {
  const out = Buffer.allocUnsafe(height * stride);
  let src = 0;
  let prev = null;
  for (let y = 0; y < height; y++) {
    const type = raw[src++];
    const row = out.subarray(y * stride, (y + 1) * stride);
    raw.copy(row, 0, src, src + stride);
    src += stride;

    switch (type) {
      case 0:
        break;
      case 1:
        for (let i = bpp; i < stride; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
        break;
      case 2:
        if (prev) for (let i = 0; i < stride; i++) row[i] = (row[i] + prev[i]) & 0xff;
        break;
      case 3:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? row[i - bpp] : 0;
          const b = prev ? prev[i] : 0;
          row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? row[i - bpp] : 0;
          const b = prev ? prev[i] : 0;
          const c = prev && i >= bpp ? prev[i - bpp] : 0;
          row[i] = (row[i] + paeth(a, b, c)) & 0xff;
        }
        break;
      default:
        throw new Error(`PNG: unknown filter type ${type} on row ${y}`);
    }
    prev = row;
  }
  return out;
}

/** Reads sample `i` of a scanline at an arbitrary bit depth, scaled up to 0..255. */
function sampleReader(row, bitDepth) {
  if (bitDepth === 8) return (i) => row[i];
  if (bitDepth === 16) return (i) => row[i * 2]; // high byte; we never need >8 bits of precision
  const perByte = 8 / bitDepth;
  const mask = (1 << bitDepth) - 1;
  const max = mask;
  return (i) => {
    const shift = 8 - bitDepth * ((i % perByte) + 1);
    const v = (row[Math.floor(i / perByte)] >> shift) & mask;
    return Math.round((v * 255) / max);
  };
}

/** Same as `sampleReader` but without the 0..255 rescale — palette indices are literal. */
function indexReader(row, bitDepth) {
  if (bitDepth === 8) return (i) => row[i];
  const perByte = 8 / bitDepth;
  const mask = (1 << bitDepth) - 1;
  return (i) => (row[Math.floor(i / perByte)] >> (8 - bitDepth * ((i % perByte) + 1))) & mask;
}

/**
 * @param {Buffer|Uint8Array} buffer
 * @returns {{width:number, height:number, data:Uint8Array, colorType:number, bitDepth:number}}
 *   `data` is RGBA, 8 bits per channel, row-major, length `width*height*4`.
 */
export function decodePNG(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('PNG: bad signature');

  let width = 0;
  let height = 0;
  let bitDepth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette = null;
  let transparency = null;
  const idat = [];

  let p = 8;
  while (p + 8 <= buf.length) {
    const length = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + length);
    if (p + 12 + length > buf.length) throw new Error(`PNG: truncated ${type} chunk`);
    p += 12 + length;

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') transparency = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }

  if (!width || !height) throw new Error('PNG: no IHDR');
  if (interlace !== 0) throw new Error('PNG: Adam7 interlacing is not supported by this decoder');
  if (!(colorType in CHANNELS)) throw new Error(`PNG: unknown colour type ${colorType}`);
  if (width * height > MAX_PIXELS) throw new Error(`PNG: ${width}x${height} exceeds the ${MAX_PIXELS}px cap`);
  if (idat.length === 0) throw new Error('PNG: no IDAT');

  const channels = CHANNELS[colorType];
  const stride = Math.ceil((width * channels * bitDepth) / 8);
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length < height * (stride + 1)) throw new Error('PNG: IDAT is shorter than the image');

  const rows = unfilter(raw, width, height, bpp, stride);
  const out = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    const row = rows.subarray(y * stride, (y + 1) * stride);
    const read = sampleReader(row, bitDepth);
    const readIndex = indexReader(row, bitDepth);
    let o = y * width * 4;
    for (let x = 0; x < width; x++) {
      let r;
      let g;
      let b;
      let a = 255;
      switch (colorType) {
        case 0:
          r = g = b = read(x);
          if (transparency && transparency.length >= 2 && read(x) === transparency.readUInt16BE(0)) a = 0;
          break;
        case 2:
          r = read(x * 3);
          g = read(x * 3 + 1);
          b = read(x * 3 + 2);
          break;
        case 3: {
          const i = readIndex(x);
          if (!palette || i * 3 + 2 >= palette.length) throw new Error('PNG: palette index out of range');
          r = palette[i * 3];
          g = palette[i * 3 + 1];
          b = palette[i * 3 + 2];
          if (transparency && i < transparency.length) a = transparency[i];
          break;
        }
        case 4:
          r = g = b = read(x * 2);
          a = read(x * 2 + 1);
          break;
        default:
          r = read(x * 4);
          g = read(x * 4 + 1);
          b = read(x * 4 + 2);
          a = read(x * 4 + 3);
      }
      out[o++] = r;
      out[o++] = g;
      out[o++] = b;
      out[o++] = a;
    }
  }

  return { width, height, data: out, colorType, bitDepth };
}

// ---------------------------------------------------------------- encode

function chunk(type, data) {
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4, 8), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * @param {{width:number, height:number, data:Uint8Array}} image RGBA, 8 bits per channel.
 * @returns {Buffer} a complete PNG file.
 */
export function encodePNG({ width, height, data }) {
  if (data.length !== width * height * 4) {
    throw new Error(`PNG: ${width}x${height} needs ${width * height * 4} bytes, got ${data.length}`);
  }
  const stride = width * 4;
  const raw = Buffer.allocUnsafe(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Reads just the header. Cheap enough to call on every cached render. */
export function readPNGSize(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('PNG: bad signature');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
