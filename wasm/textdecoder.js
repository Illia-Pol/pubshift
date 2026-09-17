// textdecoder.js — the multi-byte half of the ICU shim, linked with --js-library.
//
// libmspub can ask for Shift_JIS, GBK and Big5. Their mapping tables are tens
// of kilobytes each, and every browser and every node build already ships them
// behind TextDecoder, so shipping our own copies would be paying twice for the
// same data in a tool whose whole point is that it loads fast. The single-byte
// encodings and UTF-16LE are *not* delegated — those are in icu_shim.cpp,
// where they are table-exact against ICU.
//
// The contract with C++ (see pubshift_td_decode in icu_shim.cpp):
//   in:  label (C string), bytes, length, and two int32_t* out-params
//   out: number of decoded units, or -1 if the host cannot decode that label.
//        On success it mallocs two int32 arrays of that length — the code
//        points, and how many input bytes each one consumed — and the caller
//        frees both with pubshift_td_free.
//
// Why byte counts, and why a streaming decode: libmspub walks the buffer with
// a pointer it advances itself, so each decoded code point has to say how far
// to move. A single decode() call returns a string with no offsets, and
// re-deriving offsets means reimplementing each encoding's lead/trail rules —
// exactly the tables we are trying not to ship. Feeding a streaming decoder one
// byte at a time gives the offsets for free and for any encoding. It is one
// WASM->JS call for the whole buffer; the loop is plain JS.

addToLibrary({
  $PubshiftTD: {
    decoders: {},
    // An unknown label throws from the TextDecoder constructor. Cache the
    // failure too, so a document full of undecodable spans does not retry.
    get(label) {
      if (label in this.decoders) return this.decoders[label];
      let dec = null;
      try {
        dec = new TextDecoder(label, { fatal: false, ignoreBOM: true });
      } catch (e) {
        dec = null;
      }
      this.decoders[label] = dec;
      return dec;
    },
  },

  pubshift_td_decode__deps: ['$PubshiftTD', 'malloc', 'free'],
  pubshift_td_decode: function (labelPtr, bytesPtr, len, cpsOutPtr, lensOutPtr) {
    const label = UTF8ToString(labelPtr);
    const dec = PubshiftTD.get(label);
    if (!dec) return -1;

    const bytes = HEAPU8.subarray(bytesPtr, bytesPtr + len);
    const cps = [];
    const lens = [];

    // Streaming, one byte at a time: whenever the decoder emits, the emitted
    // code points belong to the bytes fed since it last emitted.
    let pending = 0;
    const one = new Uint8Array(1);
    const push = (str) => {
      if (!str) return;
      let first = true;
      for (const ch of str) {
        cps.push(ch.codePointAt(0));
        // All the bytes since the previous emission belong to the first code
        // point produced; anything emitted alongside it consumed nothing more.
        lens.push(first ? pending : 0);
        first = false;
      }
      pending = 0;
    };

    for (let i = 0; i < len; i++) {
      one[0] = bytes[i];
      pending++;
      push(dec.decode(one, { stream: true }));
    }
    // Flush: a truncated trailing sequence turns into one replacement char,
    // which owns whatever bytes were still buffered.
    push(dec.decode());

    // Bytes can be left over only if the decoder swallowed them without ever
    // emitting, which no TextDecoder does; give them to the last unit anyway so
    // the caller's pointer still reaches the end of the buffer and its loop
    // terminates.
    if (pending > 0 && lens.length > 0) lens[lens.length - 1] += pending;

    // A unit that reports 0 bytes would make libmspub's loop spin, so fold any
    // zero-length unit into its predecessor's span by moving a byte across.
    for (let i = 1; i < lens.length; i++) {
      if (lens[i] === 0 && lens[i - 1] > 1) {
        lens[i - 1] -= 1;
        lens[i] = 1;
      }
    }

    const n = cps.length;
    const cpsBuf = _malloc(Math.max(4, n * 4));
    const lensBuf = _malloc(Math.max(4, n * 4));
    for (let i = 0; i < n; i++) {
      HEAP32[(cpsBuf >> 2) + i] = cps[i];
      HEAP32[(lensBuf >> 2) + i] = lens[i];
    }
    HEAP32[cpsOutPtr >> 2] = cpsBuf;
    HEAP32[lensOutPtr >> 2] = lensBuf;
    return n;
  },

  pubshift_td_free__deps: ['free'],
  pubshift_td_free: function (ptr) {
    if (ptr) _free(ptr);
  },
});
