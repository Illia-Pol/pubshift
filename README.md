# Pubshift

Convert Microsoft Publisher `.pub` files to PowerPoint, Word, PDF and SVG — entirely inside your
browser. Nothing is uploaded.

Microsoft retires Publisher on **1 October 2026**. Microsoft 365 subscribers lose the ability to open
`.pub` files on that date.

## Why it is different

- **Your files never leave your computer.** The Publisher parser is compiled to WebAssembly and runs
  in your browser tab. No server sees your document. Every other free `.pub` converter uploads.
- **PowerPoint first.** A Publisher page is absolutely-positioned boxes on a fixed canvas — so is a
  PowerPoint slide. Converting to Word flattens that into a text flow and wrecks the layout.
- **It tells you what it could not preserve**, per file and per page, instead of quietly dropping it.

## Layout

```
native/          C++ extractor: .pub -> JSON IR, built on libmspub (MPL-2.0)
packages/core/   TypeScript: IR -> document model -> DOCX / PPTX / PDF / SVG emitters
apps/web/        The browser app
tools/fidelity/  Objective conversion-quality harness run against a real corpus
docs/            IR contract, positioning, fidelity notes
```

## Build

Native extractor (for the CLI and the test harness):

```bash
brew install libmspub librevenge icu4c
npm install
npm run build:native
```

Convert a file to the intermediate representation:

```bash
./bin/pubshift-extract path/to/file.pub > out.json
```

Run the test suite and the fidelity harness:

```bash
npm test
node tools/fidelity/run.mjs
```

## Licence

Pubshift is MPL-2.0, matching libmspub, which does the format parsing and deserves the credit.

`pubshift.wasm` ships libmspub and librevenge compiled in, which is distribution in Executable
Form. MPL-2.0 §3.2(a) then requires the corresponding source to be available and recipients to be
told how to get it, so:

- [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) lists every component in the binary, generated
  from [`wasm/third-party.json`](wasm/third-party.json), which pins each upstream by commit hash or
  digest.
- `npm run licence:verify` fails if `third_party/` has drifted from that pin — a source offer that
  points at code you did not compile is not an offer.
- `npm run licence:offer` builds the corresponding-source archive to publish alongside the binary.
- The deployed site carries the licence texts at `/licences/` and a `/credits` page, linked from
  every page's footer, naming the Document Liberation Project and stating the SHA-256 of the exact
  binary served.

See [`docs/DEPLOY.md`](docs/DEPLOY.md) §7 for the one step that is not automated.
