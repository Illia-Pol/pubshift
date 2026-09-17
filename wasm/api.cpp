/* api.cpp — the WASM entry point.
 *
 * The native extractor takes a path and writes JSON to stdout. In a browser
 * there is no path and no stdout: the bytes arrive from a drop zone and have to
 * stay in memory, because "your file never leaves your machine" is the product.
 * So this file swaps the file stream for a memory stream and hands the JSON back
 * as a buffer, and reuses everything else.
 *
 * "Reuses" is literal: native/extract.cpp is included into this translation
 * unit, so JsonCollector and jsonEscape are the same code, not a copy that can
 * drift. Its main() is renamed out of the way rather than edited, so the native
 * build is untouched and stays an independent oracle. The headers it includes
 * are pulled in first, above the rename, so the macro cannot reach them.
 *
 * The one thing genuinely restated here is the ten-line result envelope. That is
 * the only place the two builds could drift apart, and test/parity.mjs compares
 * the two outputs byte for byte over the whole corpus, which is what keeps it
 * honest.
 *
 * Memory ownership
 * ----------------
 *   input   caller (JS) allocates with _malloc and frees it — we only read it
 *   output  we allocate with malloc; caller frees with pubshift_free
 *           *outLen receives the byte length, so JS never has to scan for NUL
 *
 * A null return means allocation failed; nothing is leaked in that case.
 */

#include <libmspub/MSPUBDocument.h>
#include <librevenge/librevenge.h>
#include <librevenge-stream/librevenge-stream.h>

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>
#include <map>
#include <sstream>
#include <iostream>
#include <fstream>

#define main pubshift_native_main_unused
#include "../native/extract.cpp"
#undef main

extern "C"
{

/* Parses `len` bytes of a .pub file and returns the IR JSON.
 *
 * Always returns a document — a failure comes back as the {"ok":false,...}
 * shape from docs/IR.md, not as a null pointer, because the message inside it
 * is written for the person who dropped the file. */
char *pubshift_extract(const unsigned char *data, unsigned long len,
                       unsigned long *outLen);

void pubshift_free(char *p);

/* Version of the IR contract this build produces. Bumped only if the JSON shape
 * changes, so a cached .wasm and a newer wrapper can notice each other. */
const char *pubshift_version(void);

} // extern "C"

namespace
{

std::string buildFailure(const char *code, const char *message)
{
  std::string out = "{\"ok\":false,\"error\":{\"code\":\"";
  out += code;
  out += "\",\"message\":\"";
  out += jsonEscape(message);
  out += "\"}}\n";
  return out;
}

/* Mirrors the success envelope written by native/extract.cpp's main().
 * Kept in step by test/parity.mjs, which diffs the two builds byte for byte. */
std::string buildSuccess(const JsonCollector &collector)
{
  std::string out = "{\"ok\":true,\"events\":[\n" + collector.events + "\n],\"assets\":{";
  bool first = true;
  for (const auto &kv : collector.assets)
  {
    if (!first) out += ",";
    first = false;
    out += "\"" + kv.first + "\":\"" + kv.second + "\"";
  }
  out += "}}";
  return out;
}

std::string runExtract(const unsigned char *data, unsigned long len)
{
  /* An empty file gets no special case on purpose. The native extractor hands
   * a zero-byte file to the same isSupported() check and reports UNSUPPORTED,
   * so answering NO_INPUT here would be a nicer message and a divergence —
   * and the corpus cannot catch it, since every file in it has bytes. */
  static const unsigned char kNothing[1] = {0};
  if (!data) { data = kNothing; len = 0; }

  /* RVNGStringStream copies the buffer. That is one extra copy of the document,
   * which for the sizes Publisher files come in is a better trade than teaching
   * librevenge about a borrowed buffer. */
  librevenge::RVNGStringStream input(data, unsigned(len));

  if (!libmspub::MSPUBDocument::isSupported(&input))
    return buildFailure("UNSUPPORTED",
                        "This file is not a Microsoft Publisher document that we can read.");

  JsonCollector collector;
  bool ok = false;
  try
  {
    ok = libmspub::MSPUBDocument::parse(&input, &collector);
  }
  catch (const std::exception &e)
  {
    return buildFailure("PARSE_EXCEPTION", e.what());
  }
  catch (...)
  {
    return buildFailure("PARSE_EXCEPTION", "unknown error while reading the document");
  }

  if (!ok)
    return buildFailure("PARSE_FAILED",
                        "The document could not be read. It may be corrupt or password-protected.");

  return buildSuccess(collector);
}

} // namespace

extern "C" char *pubshift_extract(const unsigned char *data, unsigned long len,
                                  unsigned long *outLen)
{
  std::string json;
  try
  {
    json = runExtract(data, len);
  }
  catch (const std::exception &e)
  {
    /* Anything that escaped runExtract — a bad_alloc, say. Still answer in the
     * documented shape rather than tearing the module down. */
    json = buildFailure("PARSE_EXCEPTION", e.what());
  }
  catch (...)
  {
    json = buildFailure("PARSE_EXCEPTION", "unknown error while reading the document");
  }

  char *buf = static_cast<char *>(std::malloc(json.size() + 1));
  if (!buf)
  {
    if (outLen) *outLen = 0;
    return nullptr;
  }
  std::memcpy(buf, json.data(), json.size());
  buf[json.size()] = '\0';
  if (outLen) *outLen = static_cast<unsigned long>(json.size());
  return buf;
}

extern "C" void pubshift_free(char *p)
{
  std::free(p);
}

extern "C" const char *pubshift_version(void)
{
  return "pubshift-ir/1";
}
