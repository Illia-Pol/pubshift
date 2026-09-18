# What actually converts, measured

Numbers here come from `tools/fidelity/` run against `packages/core/test/corpus/` (31 real Publisher
files, Publisher 97 through 2010, from the LibreOffice fuzzing seed corpus). They are not estimates.

## Extraction

| Outcome | Files | Meaning |
|---|---|---|
| Real content | 24 | Converts with text and/or pictures. |
| Partial | 1 | Shapes came through, text did not. Flagged to the user. |
| **Empty** | **5** | libmspub reports success and returns nothing. Flagged to the user. |
| Unreadable | 1 | `EDB-29664-1.pub` is not a Publisher file at all. Correctly rejected. |

For comparison, the `pub2xhtml` tool bundled with libmspub handles 26/31 and silently drops
underline, small-caps, shadows and gradients — which is why this project drives the C++ callback
interface directly instead of using it.

### The five empty files are the honest weak point

`border1.pub`, `multipara.pub`, `table1.pub`, `tdf89993-1.pub` and `14.0-metadata.pub` parse without
error and produce **nothing** — libmspub's own `pub2raw` shows only
`startDocument / setDocumentMetaData / endDocument`. They are 20–23 KB files whose names promise
content, and their OLE stream layout (`CONTENTS, Contents, Quill, QuillSub`) is identical to files
that convert perfectly. So it cannot be predicted from the file, only detected after parsing.

This is an upstream parser gap, not a bug in this project — but a user does not care whose fault it
is. `assess()` in `packages/core/src/model/assess.ts` gates every conversion: a document with no
meaningful content is **never** offered as a successful download. The user is told plainly that we
could not read it, and pointed at the fallback that still works before 1 October 2026.

Handing someone a blank `.docx` and calling it a success is the failure this product exists to
prevent. If that gate is ever removed, the product is no better than the free uploaders.

## Property coverage

99 distinct property keys appear across the corpus: **86 handled, 13 consciously dropped, 0 unknown**.
`tools/fidelity/run.mjs` exits non-zero if the corpus ever contains a key that is in neither list, so
"we forgot about small-caps" becomes a build failure rather than a silent regression.

Largest accepted losses: `svg:fill-rule` (280x), `draw:fill-image-ref-point` (90x), `libmspub:shade`
(36x), per-channel image colour adjustment (7x each).

## Conversion quality, scored against a render of the original

`node tools/fidelity/compare.mjs` renders the original `.pub` with LibreOffice, runs our
pipeline to PPTX/DOCX/PDF/SVG, renders those the same way, and scores symmetric ink
agreement at a 1px placement tolerance. 24 files, 50 pages:

| Format | Score | good / fair / poor |
|---|---|---|
| **DOCX** | **0.794** | 10 / 8 / 6 |
| PPTX | 0.772 | 4 / 17 / 3 |
| SVG | 0.763 | 8 / 9 / 7 |
| PDF | 0.760 | 8 / 9 / 7 |

DOCX overtook PPTX when a real emitter bug was fixed: LibreOffice adds `w:tblCellMar` on top of
`w:trHeight` instead of inside it, so every table row grew and pushed the rest of the page down.
Moving the vertical inset onto the cell's paragraphs took `tables.pub` from 0.494 to **0.948** and
`table-merged.pub` from 0.689 to 0.776. The earlier reading — that Word inherently mangles layout —
was partly measuring our own defect. See docs/POSITIONING.md, which records the reversal.

PPTX has more *fair* and fewer *poor* scores, so it remains the steadier of the two; DOCX has the
higher mean and more outright wins.

The reference is LibreOffice opening the same `.pub` — which uses libmspub, the same
parser behind our extractor. That holds the parse constant and isolates our model and
emitters, which is the thing under test. It is **not** a measurement against Microsoft
Publisher's own rendering; nothing available here can produce that.

Two cautions about reading these numbers. PPTX and DOCX are close on average but win
different documents (see docs/POSITIONING.md) — PPTX is the steadier, DOCX the streakier.
And PPTX carries a measured ~2.5px systematic downward text offset that costs it roughly
0.2 on text-only files while being invisible at 0.027 inch; it comes from a first-baseline
convention in LibreOffice Impress, so it may not exist in PowerPoint itself. It has been
left alone deliberately: tuning an emitter to score better against one renderer's
convention is optimising the measurement instead of the user.

### A measurement bug worth remembering

The first run of this comparison reported 0.584 overall and scored five files at exactly
0.000. The emitters were fine. The reference cache was keyed on the source file and the
renderer version but not on the rendering code, so a run served pages produced by an older
pipeline, and our (correctly) trimmed leading blank page was compared against the
reference's blank master page. The numbers were wrong and entirely plausible, which is the
worst way for a measuring tool to fail. `cacheKey` now includes a hash of `render.mjs`.

## WebAssembly parity

The browser build must agree with the native build, which is the independent oracle:

```
parity: 31/31 byte-identical to the native extractor
cold module load 2.6 ms · median file 0.6 ms · slowest (600 KB) 29 ms · pubshift.wasm 465 KB
```

Getting to 31/31 took a real fix rather than a tolerance. One file diverged on a single
arc's `large-arc` flag. The cause was fused multiply-add: libmspub computes an ellipse
centre as `y + scaleY * v` and then decides the flag with `angleDifference >= M_PI`, and on
arm64 clang defaults to `-ffp-contract=on` and fuses that into one FMA, landing a ULP away
from where two roundings put it. For an exact semicircle that ULP is the whole decision,
and WebAssembly has no scalar FMA instruction, so no WASM build could ever match it.

The first instinct was to exempt the case as visually irrelevant — at exactly 180° the
large and small arcs are the same curve, so it was genuinely harmless. That was the wrong
call: a parity test that forgives a mismatch stops being an oracle. Instead `native/build.sh`
now compiles libmspub and librevenge **from the same sources as the WASM build, with
`-ffp-contract=off`**, rather than linking Homebrew's prebuilt library. Both sides now
compile the same code with the same floating-point semantics, and the invariant holds
exactly. An oracle whose answer depends on whether the host CPU has an FMA unit is not an
oracle.

## Known limits

- **WMF/EMF pictures are dropped**, with a warning naming the page. 13 of 18 pictures in
  `REG-TST2-pub2010.pub` are WMF. Old Publisher clipart is overwhelmingly WMF, so this is the largest
  remaining visible loss and the most valuable thing to fix next.
- Text that overflows its frame in the original is drawn rather than clipped. Four corpus files do
  this genuinely; dropping the overflow silently would be worse.
- Pixel comparison against the original requires LibreOffice; `tools/fidelity/compare.mjs` reports
  honestly when it is unavailable rather than quietly weakening the check.
