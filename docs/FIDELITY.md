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

## WebAssembly parity

The browser build must agree with the native build, which is the independent oracle:

```
parity: 31/31 equivalent (30 byte-identical, 1 differing only in a semicircle's large-arc flag)
cold module load 3.1 ms · median file 0.5 ms · slowest (600 KB) 28 ms · pubshift.wasm 465 KB
```

The single divergence is provably benign and narrowly exempted. libmspub decides the flag with
`angleDifference >= M_PI` and notes in its own comment that at exactly 180° the large and small arcs
are the same curve. Both diverging arcs are exact semicircles — chord 2.047239 against diameter
2.047240 — so the comparison sits on the boundary where ARM libm and emscripten's musl differ in the
last bit. `wasm/test/parity.mjs` accepts a differing large-arc flag **only** when the endpoints are a
full diameter apart; any other divergence still fails.

## Known limits

- **WMF/EMF pictures are dropped**, with a warning naming the page. 13 of 18 pictures in
  `REG-TST2-pub2010.pub` are WMF. Old Publisher clipart is overwhelmingly WMF, so this is the largest
  remaining visible loss and the most valuable thing to fix next.
- Text that overflows its frame in the original is drawn rather than clipped. Four corpus files do
  this genuinely; dropping the overflow silently would be worse.
- Pixel comparison against the original requires LibreOffice; `tools/fidelity/compare.mjs` reports
  honestly when it is unavailable rather than quietly weakening the check.
