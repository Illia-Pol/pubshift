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
