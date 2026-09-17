# wasm — the Publisher parser, compiled to WebAssembly

This is the part of pubshift that ships. `native/` exists so there is an
independent oracle to check against; `wasm/` is what a person actually runs when
they drop a `.pub` file on the page. The file is read inside the tab and never
leaves the machine, which is the product's whole claim, so the bar here is not
"it converts" but "it converts to exactly the same bytes the reference tool
produces".

```js
import { loadPubshift } from './wasm/index.mjs';

const pubshift = await loadPubshift();
const ir = pubshift.extract(new Uint8Array(await file.arrayBuffer()));
// -> { ok: true, events: [...], assets: {...} }   (docs/IR.md)
```

Unreadable files throw a `PubshiftError` whose `message` is written for the
person who dropped the file and is safe to show verbatim.

---

## Where it stands

| | |
|---|---|
| Parity with the shipped native extractor | **30 / 31 corpus files byte-identical** |
| Parity with a float-deterministic native build | **31 / 31 byte-identical** |
| ICU shim vs real ICU (11,907 checks, node) | **11,907 identical** |
| ICU shim vs real ICU, single-byte + UTF-16LE (Chrome 152) | **1,809 / 1,809 identical** |
| Parity on 13 inputs the corpus cannot cover | **13 / 13 byte-identical** |
| Memory across repeated conversions | no growth; verified with a self-checking leak probe |

The one differing file is `fdo68259-5.pub`, and the cause is not the shim.
[The last file](#the-last-file) has the diagnosis and the one-flag fix.

---

## Sizes and speed

| artifact | raw | gzip | brotli |
|---|---:|---:|---:|
| `dist/pubshift.wasm` | 465,714 B | 166,982 B | 135,340 B |
| `dist/pubshift.mjs` | 14,055 B | 4,962 B | — |

Measured in Chrome 152 on an M-series Mac, local server:

| | |
|---|---:|
| cold load (fetch + instantiate + first call ready) | 7.5 ms |
| `tables.pub`, 37 KB | 1.3 ms |
| `fdo67299-1.pub`, 464 KB → 619 KB of IR | 6.9 ms |
| `923566.pub`, 600 KB → 799 KB of IR | 18.3 ms |

For scale: emscripten's ICU port on its own is several megabytes. Avoiding it is
most of why the whole module is a third of a megabyte, and the ICU shim below is
how.

## Building

```bash
export PUBSHIFT_SRC=/path/to/dir/holding/libmspub/and/librevenge
./build.sh            # -> dist/pubshift.mjs + dist/pubshift.wasm
./build.sh --debug    # -> dist-debug/, with assertions and SAFE_HEAP
```

Needs emscripten on `PATH` (or `EMSCRIPTEN_ROOT` set); built and tested with
6.0.9. boost headers and zlib come from emscripten's own ports, so there is
nothing else to install.

No autotools. libmspub and librevenge are 45 `.cpp` files between them with no
generated sources worth the trouble, so `build.sh` compiles them directly
against the hand-written headers in `config/`. What each one actually needs was
read out of `configure.ac` and the `#ifdef` usage, not guessed:

- **libmspub** consults exactly three macros, all in `libmspub_utils.h`:
  `HAVE_FUNC_ATTRIBUTE_FORMAT`, `HAVE_CLANG_ATTRIBUTE_FALLTHROUGH`,
  `HAVE_GCC_ATTRIBUTE_FALLTHROUGH`. All three only affect diagnostics, which is
  worth knowing: `config.h` cannot be the cause of an output divergence.
- **librevenge** never includes `config.h` at all — the generated header exists
  but only the build system reads it. `config/librevenge/config.h` is provided
  anyway, documented as such, so an upstream bump that adds the include does not
  fail obscurely.

`DEBUG` is deliberately left undefined: it would make libmspub write to stderr
from inside the parser, which is noise in a browser and a behavioural difference
from the oracle.

## Tests

```bash
node test/parity.mjs            # the acceptance test: byte-identical or it fails
node test/parity.mjs --verbose  # per-file timings
node test/edge.mjs              # empty, truncated, corrupted, renamed-PDF inputs

./tools/build-shim-probe.sh     # once, builds the test-only shim module
node test/encoding.mjs          # the ICU shim against real-ICU fixtures
node test/memory.mjs            # leaks across repeated conversions

# In a browser, because node's TextDecoder is not a browser's:
python3 -m http.server 8731     # from the repo root
open http://127.0.0.1:8731/wasm/test/browser-check.html
```

`test/edge.mjs` exists because the corpus is 31 real documents and a drop zone
receives anything: a zero-byte file, a half-finished download, a PDF someone
renamed, a file that starts like an OLE container and then stops. Those take
different paths through libmspub, and the failure message is the only thing the
person will ever see, so the two builds have to agree there too. It caught one
real divergence — an empty file, where the WASM side had a friendlier
`NO_INPUT` message while the native extractor said `UNSUPPORTED`.

`test/parity.mjs` compares raw JSON text, not parsed objects — parsing would
hide exactly the differences worth catching: key order, number formatting,
whitespace. When two documents differ it walks the parsed events to name the
event and property that diverged, rather than printing two 800 KB strings.

## The ICU shim

libmspub links ICU for three things and nothing else. Pulling in emscripten's
ICU port for them would defeat the point of a tool that has to load before the
user gets bored, so `icu_shim.h` / `icu_shim.cpp` supply exactly those three.

The libmspub sources are **not patched**. `wasm/include/unicode/{ucnv,ucsdet,uloc,utypes}.h`
are stand-ins that forward to the shim, and that directory is on the include
path for emcc alone. Everything in the shim is inside `#ifdef __EMSCRIPTEN__`,
so the native build keeps using real ICU and stays an independent oracle.

### 1. Converters — `ucnv_open` / `ucnv_getNextUChar` / `ucnv_close`

Decodes legacy-codepage bytes to code points. `ucnv_open` records the encoding;
the first `ucnv_getNextUChar` decodes the whole buffer at once and later calls
walk the result, which matters because libmspub calls it per character.

The tables were **not transcribed from standards documents**. They are dumped
out of the same icu4c the native extractor links, by `tools/gen-icu-data.py`,
and `test/encoding.mjs` replays that dump through the compiled shim. So "matches
ICU" is a test result, not a claim. That distinction earns its keep: ICU's
`windows-1252` is `ibm-5348_P100-1997`, which maps all 256 bytes including the
five slots the standard leaves undefined, and ICU's `ISO-8859-1` is *true*
Latin-1 while `TextDecoder('iso-8859-1')` is an alias for windows-1252. Guessing
either would have quietly turned curly quotes into something else.

Decoded in the shim, from built-in tables, identical in every host:

| encoding | ICU converter it reproduces | result |
|---|---|---|
| `windows-1250` | ibm-5346_P100-1998 | 257/257 |
| `windows-1251` | ibm-5347_P100-1998 | 257/257 |
| `windows-1252` | ibm-5348_P100-1997 | 257/257 |
| `windows-1256` | ibm-9448_X100-2005 | 257/257 |
| `ISO-8859-1` | ISO-8859-1 | 257/257 |
| `ISO-8859-2` | ibm-912_P100-1995 | 257/257 |
| `UTF-16LE` | UTF-16LE | 267/267 |

UTF-16LE is hand-written rather than delegated, and the edge cases are pinned:
a lone surrogate gives U+FFFD and consumes two bytes, an odd trailing byte gives
U+FFFD, noncharacters like U+FFFE pass through, and a leading BOM is **not**
stripped — which is where `TextDecoder('utf-16le')` would have differed, since
it strips one unless you ask it not to.

Delegated to the host's `TextDecoder`, because every browser already ships these
tables and a second copy would cost tens of kilobytes:

| encoding | host label | node | Chrome 152 |
|---|---|---|---|
| `windows-932` (Shift_JIS) | `shift_jis` | 262/262 | 261/262 |
| `windows-936` (GBK) | `gbk` | 261/261 | 261/261 |
| `windows-950` (Big5) | `big5` | 261/261 | 260/261 |

Two hosts, because they are not the same decoder: **node's `TextDecoder` is
ICU-backed and a browser's implements WHATWG Encoding**. A node-only measurement
would have said 100% and meant nothing about what ships. Chrome was checked
directly (`test/browser-check.html`).

The shim corrects the single-byte cases where the two specifications disagree:
ICU's `windows-932` is `ibm-943_P15A-2003`, which carries the IBM PC control
swap (`0x1A`→U+001C, `0x1C`→U+007F, `0x7F`→U+001A) and rejects `0x80`–`0xA0`
and `0xE0`–`0xFF` standing alone; `windows-950` maps `0x80` to U+0080 and `0xFF`
into the private use area. Those are byte-range rules, so they give the same
answer under both hosts.

**What is still not identical in a browser**, stated exactly:

- `windows-932`: 2 code points in the all-256-bytes probe, where ICU rejects the
  pair `FC FD` as an invalid trail byte and WHATWG accepts it.
- `windows-950`: 3 code points, all of them ICU private-use assignments
  (U+F775, U+E137, U+E273) where WHATWG has a real character.

Closing those means shipping the GBK/Big5/Shift_JIS tables that delegating was
meant to avoid — and none of it is reachable, for the reason in the next
section. Over the full one- and two-byte space the widest gap measured was
`windows-936` under WHATWG, 1,873 of 65,792 sequences, entirely in slots one of
the two tables leaves unassigned.

### 2. The charset detector — `ucsdet_*`

**This one is a deliberate stub, and it is the shim's real limitation.**

For pre-2000 Publisher files libmspub asks ICU to guess the codepage, then keeps
the answer only if it is one of seven names (Shift_JIS, GB18030, Big5,
ISO-8859-1, ISO-8859-2, windows-1251, windows-1256); anything else, including no
answer, means windows-1252. Reproducing ICU's guess means shipping its n-gram
language models. A detector that is merely *different* from ICU's — even a
better one — is worse than none here, because the native extractor is the oracle
the rest of the pipeline is tested against, and disagreeing with it turns one
document into two different conversions depending on where it was converted.

So the shim reports no matches, which drives libmspub down its own windows-1252
fallback. On the corpus that reproduces ICU exactly: instrumenting the native
build shows only **one** of the 31 files reaches the detector at all
(`fdo59355-1.pub`, 16 bytes of text), and on it ICU answers UTF-16BE and
UTF-16LE — neither in the seven — so it falls back too. The file's Russian text
comes out as `Ðóññêèé òåêñò...` in both builds. That is an upstream libmspub bug
(fdo#59355), faithfully reproduced, which is the job.

Where this diverges from ICU: a legacy Publisher 97/2000 file with enough text
for ICU to confidently name a codepage. Note that the most common such answer,
ISO-8859-1, maps to windows-1252 and is therefore already identical to the
fallback; the six that would actually differ are ISO-8859-2, windows-1251,
windows-1256, Shift_JIS, GB18030 and Big5. Since the shim never returns those,
libmspub never opens the corresponding converters — which is why the CJK gaps
above are unreachable today rather than merely small.

### 3. LCID → locale — `uloc_*`

`fo:language`, `fo:country` and `fo:script` come straight from here into the IR,
so this one has to be exact and is:

- all **8,896** LCIDs ICU answers for, byte-for-byte on all three components
- LCIDs ICU rejects are rejected here too, so libmspub emits no language
  property at all — inventing one would change the IR
- the locale id itself matches ICU's string, including `root` (whose language is
  empty) and `es_ES@collation=traditional` (whose keywords have to come off
  before parsing)

Stored as a 1,024-entry primary-language table plus 295 sublanguage exceptions
over 433 distinct locale ids — about 8 KB instead of the several megabytes of
ICU data it replaces. The generator verifies the structural assumption it relies
on (that ICU answers for an LCID exactly when it answers for its primary
language id) and fails loudly rather than shipping a wrong table.

## The last file

`fdo68259-5.pub` differs in one property: `librevenge:large-arc` on one arc of
one path.

libmspub computes an ellipse centre as `y + scaleY * v` and then decides the
flag with `angleDifference >= M_PI` (`PolygonUtils.cpp`), with a comment noting
that at exactly 180° the large and small arcs are the same curve. This arc is an
exact semicircle, so the comparison sits precisely on the boundary.

On arm64, clang's default `-ffp-contract=on` fuses that multiply-add into a
single FMA, and the centre lands one ULP from where two separate roundings put
it — enough to flip the comparison. WebAssembly has **no scalar FMA
instruction**, at any optimisation level or `-ffp-contract` setting; this was
checked directly rather than assumed:

```
arm64 -ffp-contract=off     a*b+c = 0000000000000000 (separate mul then add)
arm64 -ffp-contract=on      a*b+c = b970000000000000 (fused, single rounding)
wasm  -ffp-contract=fast    a*b+c = 0000000000000000 (separate mul then add)
```

So it cannot be fixed from inside `wasm/`. It can be fixed in one flag on the
other side, and that was verified end to end:

```bash
./tools/build-native-oracle.sh --compare
# deterministic native vs wasm: 31/31 byte-identical
```

That script rebuilds libmspub and librevenge from source with
`-ffp-contract=off`, everything else identical including real ICU. **All 31
files match.** The remaining work is in `native/build.sh`, which today links
Homebrew's prebuilt libmspub and so inherits its float settings.

Worth doing regardless of WebAssembly: an oracle whose output depends on whether
the host CPU has an FMA unit will disagree with itself between an arm64 Mac and
an x86 CI runner. The parity test reports this as a failure rather than
excusing it, because `CLAUDE.md` makes byte-identity a must-not-regress
invariant and a test that quietly forgives a mismatch is worse than no test.

## API

`index.mjs` (typed by `index.d.ts`):

- **`loadPubshift(options?)`** → module handle. Repeat calls reuse the first
  instance, so a page can call it on load and again per file without paying
  twice. `options.wasmBinary` and `options.locateFile` cover bundlers, offline
  caches and strict CSP setups; `options.reload` forces a fresh instance.
- **`handle.extract(bytes)`** → `IREnvelope`. Throws `PubshiftError(code, message)`
  for an unreadable file, with the user-facing message intact, and
  `PubshiftLoadError` when the module itself failed — a distinction worth
  keeping, because one means "this file is not Publisher" and the other means
  "we are broken".
- **`handle.extractJSON(bytes)`** → the raw IR text. Failures come back as the
  `{"ok":false,…}` document instead of throwing. This is what the parity test
  compares, and it lets a caller stream the IR onward without a
  parse-and-restringify round trip.
- **`handle.version`** → `"pubshift-ir/1"`, bumped only if the JSON shape
  changes, so a cached `.wasm` and a newer wrapper can notice each other.

### Memory ownership

`api.cpp` exports plain C:

```c
char *pubshift_extract(const unsigned char *data, unsigned long len, unsigned long *outLen);
void  pubshift_free(char *p);
const char *pubshift_version(void);
```

- the **input** buffer is allocated and freed by the caller; the module only
  reads it
- the **output** is allocated by the module and freed with `pubshift_free`;
  `*outLen` receives the byte length so JS never has to scan for a NUL
- a null return means allocation failed, and nothing is leaked in that case

`index.mjs` frees all three buffers in a `finally`, including when the module
throws. `test/memory.mjs` checks that this actually holds over 40 repeated
conversions of the largest corpus file, 40 rejected files (the throwing path is
the one most likely to leak), and a full corpus pass — and then deliberately
leaks 4 KB to prove the detector can see a leak at all.

The module is built with `-sFILESYSTEM=0`: no MEMFS, no NODEFS, no stdin. The
document arrives as bytes in memory and leaves as bytes in memory. Dropping the
filesystem is a large part of why the module is small enough to fetch before the
user notices, and it also means there is no code path that could write a
customer's newsletter anywhere.

## Layout

```
build.sh              one script, reproducible: dist/pubshift.mjs + .wasm
                      + dist/SOURCES.txt, the build's own manifest
api.cpp               entry point; includes native/extract.cpp so the JSON
                      builder is shared rather than copied
icu_shim.h/.cpp       the three ICU APIs libmspub uses
icu_shim_data.inc     generated tables (do not edit; tools/gen-icu-data.py)
textdecoder.js        --js-library: the delegated CJK decoders
include/unicode/      stand-ins so libmspub's #includes reach the shim unpatched
config/               hand-written config.h for each library
index.mjs/.d.ts       the public JS API
test/parity.mjs       the acceptance test
test/edge.mjs         parity on inputs the corpus cannot cover
test/encoding.mjs     the shim against real-ICU fixtures
test/memory.mjs       leak check
test/browser-check.html  the same shim measured in a real browser
test/fixtures/        real-ICU dumps: converters and LCIDs
tools/                data generator, shim-probe build, deterministic oracle
```

`api.cpp` includes `native/extract.cpp` into its translation unit and renames
that file's `main` out of the way with a macro, so `JsonCollector` and
`jsonEscape` are the same code rather than a copy that can drift, and the native
build is untouched. The only thing genuinely restated is the ten-line result
envelope — which is exactly what `test/parity.mjs` compares byte for byte.

## Regenerating the ICU tables

Only needed if the icu4c the native extractor links changes. Both probes have to
run against that same ICU, or the shim will faithfully reproduce the wrong one.

1. Build a probe that calls `ucnv_open` / `ucnv_getNextUChar` / `ucnv_close` the
   way `libmspub_utils.cpp` does — same loop, same shared `UErrorCode` that is
   never reset — over every single byte of each encoding, the whole 0x00–0xFF
   buffer, and the UTF-16 and CJK edge cases. Emit
   `enc|case|open=…|in=<hex>|out=<hex,hex,…>` per line, plus a `LABEL|…` line
   per converter name.
2. Build a second probe that walks LCIDs 0…0xFFFF through
   `uloc_getLocaleForLCID` and the three component getters, emitting
   `lcid|locale|language|country|script`.
3. `python3 tools/gen-icu-data.py icu-truth.txt lcid-truth.txt icu_shim_data.inc`
4. Rebuild `test/fixtures/*.json` from the same dumps, then run
   `node test/encoding.mjs`.

`dist/SOURCES.txt` is written by `build.sh` on every build: toolchain versions,
the exact libmspub commit and librevenge release, every translation unit
compiled in, the full flag list, and sha256 of both artifacts. `third-party.json`
pins the components and defers the build-time versions to it — serving
`pubshift.wasm` from a web page distributes MPL-2.0 code in executable form, and
an offer of source that cannot say which source is not an offer.

The generator re-checks its own assumptions — ASCII identity in the low half,
one code point per byte, the LCID membership rule — and exits with a message
rather than emitting a table it cannot justify.
