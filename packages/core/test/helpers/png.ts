/**
 * A minimal PNG reader for tests.
 *
 * The integration test renders generated `.pptx` files through headless LibreOffice and
 * has to answer one question about the result: is there anything on the slide? File size
 * cannot answer it — a blank page and a page with one word compress to almost the same
 * number of bytes — so the pixels are decoded for real. Node's zlib does the inflating;
 * the rest is the scanline filtering from the PNG specification.
 *
 * Only what LibreOffice actually writes is supported: 8-bit truecolour, non-interlaced.
 * Anything else throws rather than guessing, because a decoder that quietly returns the
 * wrong pixels would turn this test into a rubber stamp.
 */

import { inflateSync } from 'node:zlib';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const COLOR_TYPE_RGB = 2;
const BYTES_PER_PIXEL = 3;

export interface PNGImage {
  width: number;
  height: number;
  /** Row-major RGB triples, one byte per channel. */
  pixels: Uint8Array;
}

export interface PNGStats {
  width: number;
  height: number;
  /** Number of distinct RGB values in the image. A blank page has exactly one. */
  distinctColors: number;
  /** Share of pixels that are not the image's most common colour, 0..1. */
  inkCoverage: number;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

export function decodePNG(bytes: Uint8Array): PNGImage {
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) throw new Error('not a PNG file');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  let offset = PNG_MAGIC.length;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      const bitDepth = bytes[offset + 16];
      const colorType = bytes[offset + 17];
      const interlace = bytes[offset + 20];
      if (bitDepth !== 8 || colorType !== COLOR_TYPE_RGB || interlace !== 0) {
        throw new Error(`unsupported PNG: bitDepth=${bitDepth} colorType=${colorType} interlace=${interlace}`);
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (width === 0 || height === 0) throw new Error('PNG has no IHDR');

  const raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c))));
  const stride = width * BYTES_PER_PIXEL;
  const pixels = new Uint8Array(height * stride);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rowStart = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const value = raw[rowStart + x] ?? 0;
      const left = x >= BYTES_PER_PIXEL ? (pixels[y * stride + x - BYTES_PER_PIXEL] as number) : 0;
      const up = y > 0 ? (pixels[(y - 1) * stride + x] as number) : 0;
      const upLeft =
        y > 0 && x >= BYTES_PER_PIXEL ? (pixels[(y - 1) * stride + x - BYTES_PER_PIXEL] as number) : 0;
      let out: number;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + left; break;
        case 2: out = value + up; break;
        case 3: out = value + ((left + up) >> 1); break;
        case 4: out = value + paeth(left, up, upLeft); break;
        default: throw new Error(`unknown PNG filter ${String(filter)} on row ${y}`);
      }
      pixels[y * stride + x] = out & 0xff;
    }
  }
  return { width, height, pixels };
}

/** Decodes and measures how much of the image is not its background colour. */
export function pngStats(bytes: Uint8Array): PNGStats {
  const { width, height, pixels } = decodePNG(bytes);
  const counts = new Map<number, number>();
  for (let i = 0; i < pixels.length; i += BYTES_PER_PIXEL) {
    const key = ((pixels[i] as number) << 16) | ((pixels[i + 1] as number) << 8) | (pixels[i + 2] as number);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let background = 0;
  for (const n of counts.values()) background = Math.max(background, n);
  const total = width * height;
  return {
    width,
    height,
    distinctColors: counts.size,
    inkCoverage: total === 0 ? 0 : (total - background) / total,
  };
}
