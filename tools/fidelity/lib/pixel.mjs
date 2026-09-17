// Scoring two rendered pages against each other.
//
// A naive per-pixel diff is useless on document images for two reasons. First, a page is
// mostly white: two unrelated letters score 97% "identical" because they agree about the
// margins. Second, no two layout engines put a baseline on the same scanline, so every
// glyph edge differs by antialiasing even when the conversion is perfect.
//
// So the headline number here is not a pixel diff. It is an *ink agreement* score:
//
//   1. A pixel is INK when it is far enough from white to be a mark on the page.
//   2. An ink pixel in A is MATCHED when some ink pixel in B within `r` pixels has the
//      same ink colour — colour compared by direction away from white, so a glyph edge at
//      40% coverage matches the same glyph at 60% coverage but black never matches red.
//   3. score(r) = (matchedA + matchedB) / (inkA + inkB).
//
// Symmetric, so neither dropping a mark nor inventing one can be hidden. Background-free,
// so a blank page scores 0 against a real one instead of 0.97. And reported at r = 0, 1
// and 2 pixels, so the reader can see how much of the score is placement tolerance: a page
// that only scores well at r = 2 is a page whose text has moved by a visible amount.
//
// The raw per-pixel numbers are reported too, clearly labelled, because they are what
// people expect to see — not because they mean much on their own.
//
// All of it assumes both images came out of the same rasteriser at the same DPI, which is
// how compare.mjs drives it.

// ---------------------------------------------------------------------------
// Named thresholds
//
// Every one of these is a judgement call about what counts as "the same mark". They are
// collected here so a surprising score can be traced to a threshold rather than to a
// constant buried in a loop.
// ---------------------------------------------------------------------------

/**
 * How far from white a pixel must be, on its strongest channel, to count as a mark.
 * 32/255 ~= 12%: well above JPEG-ish rasteriser noise and the faintest antialiasing
 * fringe, well below any ink a reader would call visible.
 */
const INK_THRESHOLD = 32;

/**
 * Two ink pixels have the same colour when the vectors pointing from white towards them
 * are within this cosine of each other — about 14 degrees. Direction rather than distance
 * because antialiasing varies coverage, not hue: a glyph edge and a glyph centre are the
 * same ink at different strengths and must match. Black against red is cos 0.58 and must not.
 */
const COLOUR_DIRECTION_MIN = 0.97;

/** Headline placement tolerance. At the harness's default 96 DPI, 1px = 0.75pt. */
const MATCH_RADIUS_PX = 1;

/** Widest tolerance reported. Beyond ~2px at 96 DPI a shift is visible to a reader. */
const MAX_MATCH_RADIUS_PX = 2;

/** Per-channel slack for the raw "tolerant" pixel count. 16/255 ~= 6%. */
const CHANNEL_TOLERANCE = 16;

/** Sentinel in a match-radius map for "no match anywhere within MAX_MATCH_RADIUS_PX". */
const NO_MATCH = 255;

/** Diff image palette. */
const DIFF_BACKGROUND = [255, 255, 255];
const DIFF_AGREED = [198, 198, 198]; // ink both images have: context, not a finding
const DIFF_LOST = [216, 27, 44]; // ink in the reference that the conversion did not produce
const DIFF_ADDED = [21, 96, 216]; // ink the conversion produced that the reference has not

// ---------------------------------------------------------------------------

/** Flattens onto white and returns `{width, height, rgb}` with 3 bytes per pixel. */
function flatten(image) {
  const { width, height, data } = image;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, o = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 255) {
      rgb[o++] = data[i];
      rgb[o++] = data[i + 1];
      rgb[o++] = data[i + 2];
    } else {
      const k = a / 255;
      rgb[o++] = Math.round(data[i] * k + 255 * (1 - k));
      rgb[o++] = Math.round(data[i + 1] * k + 255 * (1 - k));
      rgb[o++] = Math.round(data[i + 2] * k + 255 * (1 - k));
    }
  }
  return { width, height, rgb };
}

/**
 * Grows a flattened image onto a `w x h` white canvas, top-left aligned.
 *
 * Two renders of the same page at the same DPI are the same size, so this only fires when
 * the conversion changed the page size — which is itself a fidelity failure and is meant
 * to score badly. Padding rather than scaling is what makes it score badly: scaling to fit
 * would quietly forgive a letter page emitted as A4.
 */
function pad(flat, w, h) {
  if (flat.width === w && flat.height === h) return flat;
  const rgb = new Uint8Array(w * h * 3).fill(255);
  for (let y = 0; y < flat.height; y++) {
    rgb.set(flat.rgb.subarray(y * flat.width * 3, (y + 1) * flat.width * 3), y * w * 3);
  }
  return { width: w, height: h, rgb };
}

/**
 * How many marks are on a page. Zero means the rasteriser produced a blank sheet, which
 * compare.mjs has to know about before it pairs pages: a blank reference page cannot say
 * anything about fidelity, it can only award 0 or 1 depending on whether we drew something.
 */
export function countInk(image) {
  return inkMask(flatten(image)).count;
}

/** 1 where the pixel is a mark, 0 where it is page. */
function inkMask(flat) {
  const n = flat.width * flat.height;
  const mask = new Uint8Array(n);
  const rgb = flat.rgb;
  let count = 0;
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const min = Math.min(rgb[p], rgb[p + 1], rgb[p + 2]);
    if (255 - min > INK_THRESHOLD) {
      mask[i] = 1;
      count++;
    }
  }
  return { mask, count };
}

/**
 * Cosine between the two "distance from white" vectors. Both pixels are ink, so neither
 * vector is degenerate — the caller guarantees it, and the epsilon only guards against a
 * pixel that is ink on one channel and exactly white on the rest.
 */
function sameInkColour(a, ai, b, bi) {
  const ar = 255 - a[ai];
  const ag = 255 - a[ai + 1];
  const ab = 255 - a[ai + 2];
  const br = 255 - b[bi];
  const bg = 255 - b[bi + 1];
  const bb = 255 - b[bi + 2];
  const dot = ar * br + ag * bg + ab * bb;
  if (dot <= 0) return false;
  const mag = Math.sqrt((ar * ar + ag * ag + ab * ab) * (br * br + bg * bg + bb * bb));
  return mag > 0 && dot / mag >= COLOUR_DIRECTION_MIN;
}

/**
 * For every ink pixel in `src`, the smallest Chebyshev radius at which `dst` has a
 * qualifying ink pixel, or NO_MATCH. Non-ink pixels are left at 0 and never read.
 *
 * `colourAware = false` asks only "is there any mark near here", which is what separates a
 * mark that moved from a mark that was recoloured.
 */
function matchRadii(srcMask, srcRGB, dstMask, dstRGB, w, h, maxRadius, colourAware) {
  const out = new Uint8Array(srcMask.length).fill(NO_MATCH);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!srcMask[i]) continue;
      const si = i * 3;
      let found = NO_MATCH;
      for (let r = 0; r <= maxRadius && found === NO_MATCH; r++) {
        const y0 = Math.max(0, y - r);
        const y1 = Math.min(h - 1, y + r);
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(w - 1, x + r);
        for (let ny = y0; ny <= y1 && found === NO_MATCH; ny++) {
          const onYRing = ny === y - r || ny === y + r;
          for (let nx = x0; nx <= x1; nx++) {
            // Only the ring at exactly distance r is new; the inside was checked at r-1.
            if (r > 0 && !onYRing && nx !== x - r && nx !== x + r) continue;
            const j = ny * w + nx;
            if (!dstMask[j]) continue;
            if (colourAware && !sameInkColour(srcRGB, si, dstRGB, j * 3)) continue;
            found = r;
            break;
          }
        }
      }
      out[i] = found;
    }
  }
  return out;
}

function countByRadius(radii, mask, maxRadius) {
  const counts = new Array(maxRadius + 1).fill(0);
  for (let i = 0; i < radii.length; i++) {
    if (!mask[i]) continue;
    const r = radii[i];
    if (r <= maxRadius) counts[r]++;
  }
  // Matching at r implies matching at r+1, so report the cumulative curve.
  for (let r = 1; r <= maxRadius; r++) counts[r] += counts[r - 1];
  return counts;
}

function buildDiff(w, h, maskA, maskB, radiiA, radiiB, radius) {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0, o = 0; i < w * h; i++, o += 4) {
    let c = DIFF_BACKGROUND;
    const inA = maskA[i] === 1;
    const inB = maskB[i] === 1;
    if (inA && radiiA[i] > radius) c = DIFF_LOST;
    else if (inB && radiiB[i] > radius) c = DIFF_ADDED;
    else if (inA || inB) c = DIFF_AGREED;
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = 255;
  }
  return { width: w, height: h, data };
}

/**
 * @param {{width:number,height:number,data:Uint8Array}} reference RGBA, from decodePNG
 * @param {{width:number,height:number,data:Uint8Array}} candidate RGBA, from decodePNG
 * @param {{radius?:number, maxRadius?:number, diff?:boolean}} [opts]
 * @returns {object} see `describeMetric()` for what every field means
 */
export function comparePixels(reference, candidate, opts = {}) {
  const radius = opts.radius ?? MATCH_RADIUS_PX;
  const maxRadius = Math.max(radius, opts.maxRadius ?? MAX_MATCH_RADIUS_PX);
  const wantDiff = opts.diff !== false;

  const fa0 = flatten(reference);
  const fb0 = flatten(candidate);
  const w = Math.max(fa0.width, fb0.width);
  const h = Math.max(fa0.height, fb0.height);
  const fa = pad(fa0, w, h);
  const fb = pad(fb0, w, h);

  const a = inkMask(fa);
  const b = inkMask(fb);
  const total = w * h;

  // Raw per-pixel agreement. Reported, not used as the headline: on a document page it is
  // dominated by the margins, and a blank page beats a wrong page on it.
  let exact = 0;
  let tolerant = 0;
  for (let i = 0, p = 0; i < total; i++, p += 3) {
    const d = Math.max(
      Math.abs(fa.rgb[p] - fb.rgb[p]),
      Math.abs(fa.rgb[p + 1] - fb.rgb[p + 1]),
      Math.abs(fa.rgb[p + 2] - fb.rgb[p + 2]),
    );
    if (d === 0) exact++;
    if (d <= CHANNEL_TOLERANCE) tolerant++;
  }

  const inkTotal = a.count + b.count;
  const blank = inkTotal === 0;

  const radiiA = blank ? new Uint8Array(0) : matchRadii(a.mask, fa.rgb, b.mask, fb.rgb, w, h, maxRadius, true);
  const radiiB = blank ? new Uint8Array(0) : matchRadii(b.mask, fb.rgb, a.mask, fa.rgb, w, h, maxRadius, true);
  const anyA = blank ? new Uint8Array(0) : matchRadii(a.mask, fa.rgb, b.mask, fb.rgb, w, h, maxRadius, false);

  const cumA = blank ? [] : countByRadius(radiiA, a.mask, maxRadius);
  const cumB = blank ? [] : countByRadius(radiiB, b.mask, maxRadius);

  const byRadius = {};
  for (let r = 0; r <= maxRadius; r++) {
    byRadius[r] = blank ? 1 : round((cumA[r] + cumB[r]) / inkTotal);
  }

  // A reference mark with no ink at all nearby was lost; one with ink nearby that failed
  // the colour test was drawn in the wrong colour. Very different bugs, same low score.
  let lost = 0;
  let recoloured = 0;
  for (let i = 0; i < a.mask.length; i++) {
    if (!a.mask[i] || radiiA[i] <= maxRadius) continue;
    if (anyA[i] <= maxRadius) recoloured++;
    else lost++;
  }

  return {
    score: byRadius[radius],
    radius,
    blank,
    byRadius,
    dimensions: {
      reference: { width: fa0.width, height: fa0.height },
      candidate: { width: fb0.width, height: fb0.height },
      compared: { width: w, height: h },
      match: fa0.width === fb0.width && fa0.height === fb0.height,
    },
    ink: {
      reference: a.count,
      candidate: b.count,
      referenceCoverage: round(a.count / total),
      candidateCoverage: round(b.count / total),
      matchedReference: blank ? 0 : cumA[radius],
      matchedCandidate: blank ? 0 : cumB[radius],
      lost,
      recoloured,
    },
    perPixel: {
      total,
      exact,
      exactRatio: round(exact / total),
      tolerant,
      tolerantRatio: round(tolerant / total),
      channelTolerance: CHANNEL_TOLERANCE,
    },
    diff: wantDiff && !blank ? buildDiff(w, h, a.mask, b.mask, radiiA, radiiB, radius) : null,
  };
}

const round = (n) => Math.round(n * 10000) / 10000;

/**
 * The metric, in the form that goes into fidelity.json. Written out rather than left to a
 * comment because the number is meaningless to anyone reading the JSON without it.
 */
export function describeMetric() {
  return {
    headline: 'score',
    definition:
      'Symmetric ink agreement at a placement tolerance of ' +
      `${MATCH_RADIUS_PX}px: (matched reference ink + matched candidate ink) / (all reference ink + all candidate ink). ` +
      'An ink pixel matches when some ink pixel of the same colour exists in the other image within that radius.',
    range: '0 = no mark in either image has a counterpart in the other; 1 = every mark does.',
    ink: `a pixel whose strongest channel is more than ${INK_THRESHOLD}/255 away from white`,
    colour: `ink colours match when the directions from white agree to within a cosine of ${COLOUR_DIRECTION_MIN} (~14 degrees), so antialiasing coverage is forgiven and hue is not`,
    placementTolerance: `${MATCH_RADIUS_PX}px at the render DPI; byRadius reports 0..${MAX_MATCH_RADIUS_PX}px so the reader can see how much of the score is tolerance`,
    pageSizeMismatch:
      'images of different sizes are padded onto the union canvas with white, never scaled — a page emitted at the wrong size is meant to score badly',
    perPixel: `raw agreement over every pixel including the margins, at 0 and ${CHANNEL_TOLERANCE}/255 per-channel slack; reported for reference only, since on a document page it is dominated by background`,
    doesNotCapture: [
      'fidelity to Microsoft Publisher itself — the reference is LibreOffice rendering the same .pub, which shares our libmspub parser, so both sides inherit the same parse',
      'text that is present but not selectable, searchable or editable: this compares pictures, not document structure',
      'anything off the rasterised page area, including overset text pushed past the page edge',
      'reading order, alt text, tagging and every other non-visual property',
      'sub-pixel typographic differences below the ink threshold, such as slightly lighter hinting',
    ],
  };
}

export const THRESHOLDS = {
  INK_THRESHOLD,
  COLOUR_DIRECTION_MIN,
  MATCH_RADIUS_PX,
  MAX_MATCH_RADIUS_PX,
  CHANNEL_TOLERANCE,
};
