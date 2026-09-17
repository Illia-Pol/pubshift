/* shim_probe.cpp — test-only surface for the ICU shim.
 *
 * The shipped module exports one function and keeps the shim internal, which is
 * how it should be. But "the shim reproduces ICU" is a claim that has to be
 * checkable, so this file exposes the three shimmed APIs directly and is built
 * into a separate module that only the tests load (tools/build-shim-probe.sh).
 * It never ends up in dist/.
 *
 * It calls the shim exactly the way libmspub calls it — same loop, same shared
 * UErrorCode that is never reset — so the test measures the real call pattern
 * rather than an idealised one.
 */

#include "../icu_shim.h"

#include <cstring>
#include <stdint.h>

extern "C"
{

/* Decodes `len` bytes with `encoding`, writing code points into `out`.
 * Returns the number written, or -1 if ucnv_open rejected the label. */
int32_t probe_decode(const char *encoding, const unsigned char *bytes, int32_t len,
                     int32_t *out, int32_t outCap)
{
  UErrorCode status = U_ZERO_ERROR;
  UConverter *conv = ucnv_open(encoding, &status);
  if (!U_SUCCESS(status) || !conv)
  {
    if (conv) ucnv_close(conv);
    return -1;
  }

  int32_t n = 0;
  const char *src = (const char *)bytes;
  const char *srcLimit = src + len;
  int32_t guard = 0;
  while (src < srcLimit && n < outCap)
  {
    if (++guard > 4 * len + 16) break;   /* a stuck pointer is a bug, not a hang */
    const char *before = src;
    UChar32 cp = ucnv_getNextUChar(conv, &src, srcLimit, &status);
    if (U_SUCCESS(status)) out[n++] = (int32_t)(uint32_t)cp;
    if (src == before) break;
  }
  ucnv_close(conv);
  return n;
}

/* Mirrors libmspub's fillLocale(). Returns 1 if ICU answered for this LCID.
 * Each of lang/country/script gets the value, or "" when that component is
 * absent — which is how libmspub decides whether to emit the property. */
int32_t probe_locale(uint32_t lcid, char *lang, char *country, char *script)
{
  char locale[ULOC_FULLNAME_CAPACITY];
  UErrorCode status = U_ZERO_ERROR;
  uloc_getLocaleForLCID(lcid, locale, ULOC_FULLNAME_CAPACITY, &status);
  lang[0] = country[0] = script[0] = '\0';
  if (!U_SUCCESS(status)) return 0;

  char component[ULOC_FULLNAME_CAPACITY];
  int32_t len = uloc_getLanguage(locale, component, ULOC_FULLNAME_CAPACITY, &status);
  if (U_SUCCESS(status) && len > 0) std::strcpy(lang, component);
  len = uloc_getCountry(locale, component, ULOC_FULLNAME_CAPACITY, &status);
  if (U_SUCCESS(status) && len > 0) std::strcpy(country, component);
  len = uloc_getScript(locale, component, ULOC_FULLNAME_CAPACITY, &status);
  if (U_SUCCESS(status) && len > 0) std::strcpy(script, component);
  return 1;
}

/* Returns the locale id itself, for comparing against ICU's string directly. */
int32_t probe_locale_id(uint32_t lcid, char *out)
{
  UErrorCode status = U_ZERO_ERROR;
  out[0] = '\0';
  uloc_getLocaleForLCID(lcid, out, ULOC_FULLNAME_CAPACITY, &status);
  if (!U_SUCCESS(status)) { out[0] = '\0'; return 0; }
  return 1;
}

/* How many charset matches the detector reports for this text. */
int32_t probe_detect(const unsigned char *text, int32_t len)
{
  UErrorCode status = U_ZERO_ERROR;
  UCharsetDetector *ucd = ucsdet_open(&status);
  if (!U_SUCCESS(status)) { ucsdet_close(ucd); return -1; }
  ucsdet_setText(ucd, (const char *)text, len, &status);
  if (!U_SUCCESS(status)) { ucsdet_close(ucd); return -1; }
  int32_t found = -1;
  ucsdet_detectAll(ucd, &found, &status);
  if (!U_SUCCESS(status)) { ucsdet_close(ucd); return -1; }
  ucsdet_close(ucd);
  return found;
}

} // extern "C"
