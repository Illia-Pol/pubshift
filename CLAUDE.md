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

## Business context lives in docs/business/

Brought in from the strategy session on 2026-09-18. Read `docs/business/OPERATING-RULES.md` before
writing anything user-facing, and `docs/business/market.md` and `rails.md` before any launch plan.
Four rules from there bind this repo too:

- **No figure reaches a user without a primary source.** A competitor's price comes from that
  competitor's own page, never from a comparison article. On this project a claimed incumbent price
  turned out to be a rival's invention five times running. No source, no number in the text.
- **Claim no accuracy that has not been measured.** That is what `tools/fidelity/` exists for; the
  numbers in `docs/FIDELITY.md` are the only ones allowed on the site.
- **Say plainly that LibreOffice Draw opens .pub for free.** Hiding it loses: anyone finds it in a
  minute. We position on what free does not give, not on pretending it does not exist.
- **Nothing is published outward without the owner's explicit say-so** — posts, emails, community
  replies. Draft first, send never without asking.

`docs/business/rails.md` carries the constraint that dominates every commercial plan: the owner is a
Belarusian citizen in Belarus, and **no payment rail for a web product is reliably open**. The product
can be finished while the till is not. Never write a launch plan that assumes a working checkout.

## Open question this repo cannot answer

`docs/business/metrics.md` asks for honest thresholds — how many visits mean the channel works, what
conversion rate means the product is sellable, and at what result the project stops — **set before
launch**. A threshold chosen after seeing the numbers is not a threshold. They are not set yet.
