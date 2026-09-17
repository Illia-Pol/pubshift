# Pubshift

Converts Microsoft Publisher `.pub` files to PPTX / DOCX / PDF / SVG, entirely client-side.
Independent of `~/work/uzum` and `~/work/artworkout` — never mix those contexts in here.

## Read before changing anything

- `docs/IR.md` — contract between the native/WASM extractor and the TypeScript pipeline,
  including a **measured** unit-quirks table. Trust the table, not your intuition about unit names.
- `docs/POSITIONING.md` — why the product is client-side and PPTX-first. The market has eight
  browser-based .pub converters already; the differentiators are no-upload, layout fidelity,
  and honest loss reporting. Changes that erode those three erode the whole product.
- `packages/core/src/model/types.ts` — every emitter targets this and only this.
  Extend with optional fields; never repurpose an existing one.

## Layout

```
native/    C++ extractor -> JSON IR (build: ./native/build.sh, needs libmspub + icu4c via brew)
wasm/      the same extractor compiled to WebAssembly — this is what ships to users
packages/core/  IR -> document model -> emitters
apps/web/  the browser app
tools/fidelity/ objective conversion-quality harness
```

## Invariants that must not regress

- **WASM and native output must stay byte-identical.** `node wasm/test/parity.mjs` is the oracle.
- **The fidelity harness must exit 0.** `node tools/fidelity/run.mjs` fails the build when the
  corpus contains a property key that is in neither the handled nor the consciously-dropped list.
  When you add a feature, move its key from dropped to handled; do not silence the check.
- `packages/core/test/corpus/` holds 31 real Publisher files (97 -> 2010). 30 parse;
  `EDB-29664-1.pub` is not a Publisher file and is *expected* to fail.
- No file ever leaves the browser. Any change that introduces a server-side upload path for
  document content contradicts the product and needs an explicit decision, not a default.

## Commands

```bash
npm run build:native && npm test && node tools/fidelity/run.mjs
```
