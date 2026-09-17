/* icu_shim.cpp — see icu_shim.h for why this exists and what it covers.
 *
 * Structure:
 *   - converter labels and how they resolve (matching ICU's alias behaviour)
 *   - single-byte and UTF-16LE decoding, from tables dumped out of real ICU
 *   - multi-byte CJK decoding, delegated to the host's TextDecoder
 *   - the charset detector, which is deliberately a fallback-only stub
 *   - LCID -> locale, which lands in the IR and is therefore exact
 */

#ifdef __EMSCRIPTEN__

#include "icu_shim.h"

#include <cstring>
#include <cstdlib>
#include <string>
#include <vector>

#include "icu_shim_data.inc"

namespace
{

/* --------------------------------------------------------------- converters */

enum ConverterKind
{
  CK_WIN1250, CK_WIN1251, CK_WIN1252, CK_WIN1256,
  CK_LATIN1, CK_LATIN2,
  CK_UTF16LE,
  CK_SJIS,   /* windows-932 / Shift_JIS  -> ICU ibm-943_P15A-2003 */
  CK_GBK,    /* windows-936              -> ICU windows-936-2000  */
  CK_BIG5,   /* windows-950 / Big5       -> ICU windows-950-2000  */
  CK_GB18030,
};

struct ConverterDef
{
  const char *label;
  ConverterKind kind;
  const char *jsLabel;   /* nullptr for the ones we decode ourselves */
};

/* Every label libmspub can hand us, plus the detector's output names it never
 * actually opens (ISO-8859-*, Shift_JIS, Big5, GB18030) so the shim stays
 * correct if that ever changes. The jsLabel column follows ICU's own alias
 * resolution, which the probe confirmed: ICU maps "Shift_JIS" to ibm-943, the
 * same converter as windows-932, and "Big5" to windows-950-2000. */
const ConverterDef kConverters[] = {
  {"windows-1250", CK_WIN1250, nullptr},
  {"windows-1251", CK_WIN1251, nullptr},
  {"windows-1252", CK_WIN1252, nullptr},
  {"windows-1256", CK_WIN1256, nullptr},
  {"iso-8859-1",   CK_LATIN1,  nullptr},
  {"latin1",       CK_LATIN1,  nullptr},
  {"iso-8859-2",   CK_LATIN2,  nullptr},
  {"utf-16le",     CK_UTF16LE, nullptr},
  {"windows-932",  CK_SJIS,    "shift_jis"},
  {"shift_jis",    CK_SJIS,    "shift_jis"},
  {"sjis",         CK_SJIS,    "shift_jis"},
  {"windows-936",  CK_GBK,     "gbk"},
  {"gbk",          CK_GBK,     "gbk"},
  {"windows-950",  CK_BIG5,    "big5"},
  {"big5",         CK_BIG5,    "big5"},
  {"gb18030",      CK_GB18030, "gb18030"},
};

/* ICU's converter lookup ignores case and the separators '-', '_' and ' '.
 * "Windows_1252", "windows-1252" and "WINDOWS 1252" all open the same thing,
 * so the shim normalises the same way instead of doing a literal compare. */
std::string normalizeLabel(const char *name)
{
  std::string out;
  for (const char *p = name; *p; ++p)
  {
    char c = *p;
    if (c == '-' || c == '_' || c == ' ') continue;
    if (c >= 'A' && c <= 'Z') c = char(c - 'A' + 'a');
    out += c;
  }
  return out;
}

const ConverterDef *findConverter(const char *name)
{
  if (!name) return nullptr;
  const std::string want = normalizeLabel(name);
  for (const ConverterDef &d : kConverters)
    if (normalizeLabel(d.label) == want) return &d;
  return nullptr;
}

const uint16_t *sbcsTable(ConverterKind k)
{
  switch (k)
  {
  case CK_WIN1250: return kWIN1250;
  case CK_WIN1251: return kWIN1251;
  case CK_WIN1252: return kWIN1252;
  case CK_WIN1256: return kWIN1256;
  case CK_LATIN1:  return kLATIN1;
  case CK_LATIN2:  return kLATIN2;
  default:         return nullptr;
  }
}

/* One decoded unit: the code point, and how many input bytes produced it.
 * Keeping the byte count is what lets ucnv_getNextUChar advance the caller's
 * pointer exactly as real ICU would. */
struct Unit
{
  UChar32 cp;
  uint32_t bytes;
};

} // namespace

/* The multi-byte path lives in textdecoder.js and is wired up by --js-library.
 * It decodes a whole buffer in one call and writes two parallel arrays:
 * code points, and the byte length each one consumed. Returns the unit count,
 * or -1 if the host has no decoder for that label. */
extern "C" int32_t pubshift_td_decode(const char *label, const uint8_t *bytes,
                                      int32_t len, int32_t **cpsOut,
                                      int32_t **lensOut);
extern "C" void pubshift_td_free(int32_t *p);

struct UConverter
{
  ConverterKind kind;
  const char *jsLabel;

  /* The whole input, decoded once. ucnv_getNextUChar then just walks it —
   * a per-code-point trip into JS for a 300 KB document would be absurd. */
  std::vector<Unit> units;
  size_t pos = 0;
  const char *decodedFrom = nullptr;  /* buffer the cache belongs to */
  const char *decodedTo = nullptr;
  const char *nextSource = nullptr;   /* where the caller should be by now */
};

namespace
{

void decodeSingleByte(UConverter *c, const uint8_t *p, size_t n)
{
  const uint16_t *tbl = sbcsTable(c->kind);
  c->units.reserve(n);
  for (size_t i = 0; i < n; ++i)
  {
    uint8_t b = p[i];
    c->units.push_back(Unit{b < 0x80 ? UChar32(b) : UChar32(tbl[b - 0x80]), 1});
  }
}

/* UTF-16LE, matching what ICU's UTF-16LE converter was measured to do:
 *   - a lone high or low surrogate yields U+FFFD and consumes its two bytes
 *   - a trailing odd byte yields U+FFFD
 *   - a leading BOM is NOT stripped (that is ICU's "UTF-16", not "UTF-16LE")
 *   - noncharacters such as U+FFFE and U+FFFF pass through untouched
 * Note that JS TextDecoder('utf-16le') strips a leading BOM unless you ask it
 * not to, which is one reason this one is not delegated. */
void decodeUtf16LE(UConverter *c, const uint8_t *p, size_t n)
{
  c->units.reserve(n / 2 + 1);
  size_t i = 0;
  while (i < n)
  {
    if (i + 1 >= n)
    {
      c->units.push_back(Unit{0xFFFD, 1});
      break;
    }
    uint32_t u = uint32_t(p[i]) | (uint32_t(p[i + 1]) << 8);
    if (u >= 0xD800 && u <= 0xDBFF)
    {
      if (i + 3 < n)
      {
        uint32_t lo = uint32_t(p[i + 2]) | (uint32_t(p[i + 3]) << 8);
        if (lo >= 0xDC00 && lo <= 0xDFFF)
        {
          UChar32 cp = UChar32(0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00));
          c->units.push_back(Unit{cp, 4});
          i += 4;
          continue;
        }
      }
      c->units.push_back(Unit{0xFFFD, 2});
      i += 2;
      continue;
    }
    if (u >= 0xDC00 && u <= 0xDFFF)
    {
      c->units.push_back(Unit{0xFFFD, 2});
      i += 2;
      continue;
    }
    c->units.push_back(Unit{UChar32(u), 2});
    i += 2;
  }
}

/* Corrections applied on top of the host decoder, for the single-byte cases
 * where ICU's converter and the WHATWG Encoding spec disagree.
 *
 * Two different hosts had to be measured, because they are not the same
 * decoder. node's TextDecoder is ICU-backed and already agrees with the native
 * extractor; a browser's implements WHATWG and does not. Chrome 152 was checked
 * directly (test/browser-check.html) rather than inferred from the node run.
 *
 * windows-932 is ICU's ibm-943_P15A-2003, which carries the IBM PC control
 * swap — 0x1A means U+001C, 0x1C means U+007F, 0x7F means U+001A — and rejects
 * 0x80-0xA0 and 0xE0-0xFF standing alone. WHATWG shift_jis passes all of those
 * through or replaces them. The rule is stated over input bytes rather than
 * over the decoder's output so it gives the same answer under both hosts.
 *
 * windows-950 and windows-936 differ only on bytes ICU maps into the private
 * use area, which is not text under either interpretation.
 *
 * What this does NOT fix is the two-byte space: ICU's tables assign private-use
 * code points where the WHATWG tables have nothing, and the trail-byte validity
 * edges differ. Closing that would mean shipping the tables this delegation
 * exists to avoid, and none of it is reachable — see the detector note below,
 * and the numbers in README.md. */
void fixupDelegated(ConverterKind kind, std::vector<Unit> &units,
                    const uint8_t *p, size_t n)
{
  size_t off = 0;
  for (Unit &u : units)
  {
    if (u.bytes != 1 || off >= n) { off += u.bytes; continue; }
    const uint8_t b = p[off];
    switch (kind)
    {
    case CK_SJIS:
      if (b == 0x1A)                      u.cp = 0x1C;
      else if (b == 0x1C)                 u.cp = 0x7F;
      else if (b == 0x7F)                 u.cp = 0x1A;
      else if (b >= 0x80 && b <= 0xA0)    u.cp = 0x1A;
      else if (b >= 0xE0)                 u.cp = 0x1A;
      break;
    case CK_BIG5:
      if (b == 0x80)                      u.cp = 0x80;
      else if (b == 0xFF)                 u.cp = 0xF8F8;
      break;
    case CK_GBK:
      if (b == 0xFF)                      u.cp = 0xF8F5;
      break;
    default:
      break;
    }
    off += u.bytes;
  }
}

void decodeViaHost(UConverter *c, const uint8_t *p, size_t n)
{
  int32_t *cps = nullptr;
  int32_t *lens = nullptr;
  int32_t count = pubshift_td_decode(c->jsLabel, p, int32_t(n), &cps, &lens);

  if (count < 0)
  {
    /* The host has no decoder for this label — an old browser, or a locked
     * down environment. Rather than dropping the text on the floor, fall back
     * to windows-1252, which is exactly what libmspub itself falls back to
     * when the detector cannot decide. Mojibake beats an empty document. */
    const uint16_t *tbl = kWIN1252;
    c->units.reserve(n);
    for (size_t i = 0; i < n; ++i)
    {
      uint8_t b = p[i];
      c->units.push_back(Unit{b < 0x80 ? UChar32(b) : UChar32(tbl[b - 0x80]), 1});
    }
    return;
  }

  c->units.reserve(size_t(count));
  for (int32_t i = 0; i < count; ++i)
    c->units.push_back(Unit{UChar32(cps[i]), uint32_t(lens[i])});
  pubshift_td_free(cps);
  pubshift_td_free(lens);

  fixupDelegated(c->kind, c->units, p, n);
}

void ensureDecoded(UConverter *c, const char *source, const char *sourceLimit)
{
  if (c->decodedFrom == source && c->decodedTo == sourceLimit) return;

  c->units.clear();
  c->pos = 0;
  c->decodedFrom = source;
  c->decodedTo = sourceLimit;

  const uint8_t *p = reinterpret_cast<const uint8_t *>(source);
  size_t n = size_t(sourceLimit - source);
  if (n == 0) return;

  if (c->kind == CK_UTF16LE) decodeUtf16LE(c, p, n);
  else if (sbcsTable(c->kind))    decodeSingleByte(c, p, n);
  else                            decodeViaHost(c, p, n);
}

} // namespace

/* ------------------------------------------------------------------- ucnv_* */

UConverter *ucnv_open(const char *converterName, UErrorCode *err)
{
  if (err && U_FAILURE(*err)) return nullptr;
  const ConverterDef *def = findConverter(converterName);
  if (!def)
  {
    /* Real ICU reports U_FILE_ACCESS_ERROR here (it failed to load the
     * converter data). libmspub only checks U_SUCCESS, but matching the code
     * costs nothing and keeps the shim honest. */
    if (err) *err = U_FILE_ACCESS_ERROR;
    return nullptr;
  }
  UConverter *c = new UConverter();
  c->kind = def->kind;
  c->jsLabel = def->jsLabel;
  if (err) *err = U_ZERO_ERROR;
  return c;
}

UChar32 ucnv_getNextUChar(UConverter *converter, const char **source,
                          const char *sourceLimit, UErrorCode *err)
{
  if (err && U_FAILURE(*err)) return 0xFFFF;
  if (!converter || !source || !*source || *source >= sourceLimit)
  {
    if (err) *err = U_ILLEGAL_ARGUMENT_ERROR;
    return 0xFFFF;
  }

  /* The caller advances *source itself between calls. The common case — it is
   * exactly where we left it — costs one pointer compare; anything else means
   * the caller jumped, so resync by byte offset, and a different buffer means
   * decode again. Walking the units on every call instead would make a long
   * text run quadratic. */
  const bool sameBuffer = converter->decodedFrom &&
                          sourceLimit == converter->decodedTo &&
                          *source >= converter->decodedFrom &&
                          *source <= converter->decodedTo;

  if (!sameBuffer)
  {
    ensureDecoded(converter, *source, sourceLimit);
    converter->nextSource = *source;
  }
  else if (*source != converter->nextSource)
  {
    size_t want = size_t(*source - converter->decodedFrom);
    size_t off = 0, idx = 0;
    while (idx < converter->units.size() && off < want)
    {
      off += converter->units[idx].bytes;
      ++idx;
    }
    converter->pos = idx;
    converter->nextSource = *source;
  }

  if (converter->pos >= converter->units.size())
  {
    /* Nothing decodable left, but the caller still sees bytes. Consume them so
     * its `while (src < srcLimit)` loop cannot spin forever. */
    *source = sourceLimit;
    converter->nextSource = sourceLimit;
    if (err) *err = U_ZERO_ERROR;
    return 0xFFFD;
  }

  const Unit &u = converter->units[converter->pos++];
  *source += u.bytes;
  if (*source > sourceLimit) *source = sourceLimit;
  converter->nextSource = *source;
  if (err) *err = U_ZERO_ERROR;
  return u.cp;
}

void ucnv_close(UConverter *converter)
{
  delete converter;
}

/* ----------------------------------------------------------------- ucsdet_* */

/* The charset detector is, deliberately, a fallback-only stub.
 *
 * libmspub asks the detector for a guess and then keeps only the first answer
 * that is one of seven names (Shift_JIS, GB18030, Big5, ISO-8859-1,
 * ISO-8859-2, windows-1251, windows-1256); anything else, including no answer
 * at all, means "windows-1252". Reproducing ICU's answer would mean shipping
 * its n-gram language models, and a detector that is *better* than ICU's would
 * be worse for this product, because the native extractor is the oracle the
 * rest of the pipeline is tested against: disagreeing with it silently turns
 * one document into two different conversions.
 *
 * So the shim reports no matches, which drives libmspub down its own
 * windows-1252 fallback. On the 31-file corpus this reproduces real ICU
 * exactly — only one file reaches the detector at all, and on that file ICU
 * returns UTF-16BE and UTF-16LE, neither of which is in the seven, so it
 * falls back too. README.md states the cases where this would diverge.
 */

struct UCharsetDetector
{
  const char *text = nullptr;
  int32_t len = 0;
};

UCharsetDetector *ucsdet_open(UErrorCode *status)
{
  if (status && U_FAILURE(*status)) return nullptr;
  if (status) *status = U_ZERO_ERROR;
  return new UCharsetDetector();
}

void ucsdet_close(UCharsetDetector *ucsd)
{
  delete ucsd;
}

void ucsdet_setText(UCharsetDetector *ucsd, const char *textIn, int32_t len,
                    UErrorCode *status)
{
  if (status && U_FAILURE(*status)) return;
  if (!ucsd)
  {
    if (status) *status = U_ILLEGAL_ARGUMENT_ERROR;
    return;
  }
  ucsd->text = textIn;
  ucsd->len = len;
  if (status) *status = U_ZERO_ERROR;
}

const UCharsetMatch **ucsdet_detectAll(UCharsetDetector *ucsd,
                                       int32_t *matchesFound, UErrorCode *status)
{
  static const UCharsetMatch *kNone[1] = {nullptr};
  if (status && U_FAILURE(*status)) return nullptr;
  if (!ucsd)
  {
    if (status) *status = U_ILLEGAL_ARGUMENT_ERROR;
    return nullptr;
  }
  if (matchesFound) *matchesFound = 0;
  if (status) *status = U_ZERO_ERROR;
  return kNone;
}

const char *ucsdet_getName(const UCharsetMatch *, UErrorCode *status)
{
  /* Unreachable while detectAll reports nothing, but a null name would crash
   * libmspub's strcmp chain if that ever changed. */
  if (status) *status = U_ZERO_ERROR;
  return "";
}

int32_t ucsdet_getConfidence(const UCharsetMatch *, UErrorCode *status)
{
  if (status) *status = U_ZERO_ERROR;
  return 0;
}

/* -------------------------------------------------------------------- uloc_* */

/* This one goes straight into the IR as fo:language / fo:country / fo:script,
 * so it is exact: the tables are every LCID real ICU answers for, dumped from
 * ICU itself. */

namespace
{

const char *localeForLcid(uint32_t lcid)
{
  if (lcid > 0xFFFF) return nullptr;

  /* Exceptions first: sublanguage ids whose locale differs from their primary
   * language's (en_GB vs en, sr_Latn_CS vs sr, ...). Sorted, so binary search. */
  size_t lo = 0, hi = sizeof(kLcidExceptions) / sizeof(kLcidExceptions[0]);
  while (lo < hi)
  {
    size_t mid = (lo + hi) / 2;
    if (kLcidExceptions[mid].lcid == uint16_t(lcid))
      return kLocales[kLcidExceptions[mid].locale];
    if (kLcidExceptions[mid].lcid < uint16_t(lcid)) lo = mid + 1;
    else hi = mid;
  }

  uint16_t idx = kLcidPrimary[lcid & 0x3FF];
  if (idx == 0xFFFF) return nullptr;
  return kLocales[idx];
}

/* Splits an ICU locale id into language / script / country.
 *
 * Verified against real ICU for all 433 locale ids the LCID table can produce:
 * this rule reproduces uloc_getLanguage / getScript / getCountry exactly. The
 * two cases worth naming are "root", whose language is the empty string, and
 * "es_ES@collation=traditional", where the keywords have to come off first. */
void splitLocale(const char *localeID, std::string &lang, std::string &script,
                 std::string &country)
{
  lang.clear();
  script.clear();
  country.clear();
  if (!localeID) return;

  std::string s(localeID);
  size_t at = s.find('@');
  if (at != std::string::npos) s = s.substr(0, at);
  if (s == "root") return;

  std::vector<std::string> parts;
  size_t start = 0;
  while (true)
  {
    size_t sep = s.find('_', start);
    if (sep == std::string::npos) { parts.push_back(s.substr(start)); break; }
    parts.push_back(s.substr(start, sep - start));
    start = sep + 1;
  }
  if (parts.empty()) return;

  lang = parts[0];
  size_t i = 1;

  auto allAlpha = [](const std::string &t) {
    for (char c : t)
      if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))) return false;
    return !t.empty();
  };
  auto allDigit = [](const std::string &t) {
    for (char c : t)
      if (c < '0' || c > '9') return false;
    return !t.empty();
  };

  if (i < parts.size() && parts[i].size() == 4 && allAlpha(parts[i]))
    script = parts[i++];
  if (i < parts.size() &&
      ((parts[i].size() == 2 && allAlpha(parts[i])) ||
       (parts[i].size() == 3 && allDigit(parts[i]))))
    country = parts[i++];
}

int32_t copyOut(const std::string &value, char *dest, int32_t cap, UErrorCode *err)
{
  int32_t len = int32_t(value.size());
  if (!dest || cap <= 0)
  {
    if (err) *err = U_BUFFER_OVERFLOW_ERROR;
    return len;
  }
  if (len >= cap)
  {
    std::memcpy(dest, value.data(), size_t(cap - 1));
    dest[cap - 1] = '\0';
    if (err) *err = U_BUFFER_OVERFLOW_ERROR;
    return len;
  }
  std::memcpy(dest, value.data(), size_t(len));
  dest[len] = '\0';
  return len;
}

} // namespace

int32_t uloc_getLocaleForLCID(uint32_t hostid, char *locale,
                              int32_t localeCapacity, UErrorCode *status)
{
  if (status && U_FAILURE(*status)) return 0;
  const char *loc = localeForLcid(hostid);
  if (!loc)
  {
    /* Same shape as ICU: failure status, nothing written. libmspub returns
     * early and emits no fo:language at all, which is what the native
     * extractor does for e.g. LCID 0x48f. */
    if (status) *status = U_ILLEGAL_ARGUMENT_ERROR;
    return 0;
  }
  return copyOut(loc, locale, localeCapacity, status);
}

int32_t uloc_getLanguage(const char *localeID, char *language,
                         int32_t languageCapacity, UErrorCode *err)
{
  if (err && U_FAILURE(*err)) return 0;
  std::string lang, script, country;
  splitLocale(localeID, lang, script, country);
  return copyOut(lang, language, languageCapacity, err);
}

int32_t uloc_getCountry(const char *localeID, char *country,
                        int32_t countryCapacity, UErrorCode *err)
{
  if (err && U_FAILURE(*err)) return 0;
  std::string lang, script, ctry;
  splitLocale(localeID, lang, script, ctry);
  return copyOut(ctry, country, countryCapacity, err);
}

int32_t uloc_getScript(const char *localeID, char *script,
                       int32_t scriptCapacity, UErrorCode *err)
{
  if (err && U_FAILURE(*err)) return 0;
  std::string lang, scr, country;
  splitLocale(localeID, lang, scr, country);
  return copyOut(scr, script, scriptCapacity, err);
}

#endif /* __EMSCRIPTEN__ */
