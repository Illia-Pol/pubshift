/* icu_shim.h — the slice of ICU that libmspub actually uses, reimplemented for
 * WebAssembly.
 *
 * Why this exists
 * ---------------
 * libmspub links ICU for three things. Emscripten's ICU port would add several
 * megabytes to a tool whose entire pitch is "drop the file in a tab and it
 * converts, nothing uploaded, nothing installed" — so the load time is the
 * product. This header plus icu_shim.cpp supply exactly those three things and
 * nothing else.
 *
 * What libmspub uses, in full (grep the sources; there is no fourth thing):
 *
 *   1. ucnv_open / ucnv_getNextUChar / ucnv_close  (libmspub_utils.cpp:393)
 *      Decodes legacy-codepage bytes to code points, one at a time.
 *
 *   2. ucsdet_*                                    (MSPUBCollector.cpp:1265)
 *      Guesses the codepage of a pre-2000 Publisher file's text.
 *
 *   3. uloc_getLocaleForLCID / uloc_getLanguage / getCountry / getScript
 *                                                  (MSPUBCollector.cpp:332)
 *      Turns a Windows LCID into fo:language / fo:country / fo:script.
 *      This one lands directly in the IR, so it has to be exact.
 *
 * How it is kept honest
 * ---------------------
 * The tables in icu_shim_data.inc are dumped out of the same icu4c the native
 * extractor links against (see tools/gen-icu-data.py), not transcribed from
 * standards documents. test/encoding.mjs replays that dump through the compiled
 * shim, so "matches ICU" is a test result rather than a claim.
 *
 * The native build never sees this file: it is reached only through the headers
 * in wasm/include/unicode, which are on the include path for the emscripten
 * build alone, and every definition below is inside `#ifdef __EMSCRIPTEN__`.
 * The native extractor therefore stays an independent oracle.
 */

#ifndef PUBSHIFT_ICU_SHIM_H
#define PUBSHIFT_ICU_SHIM_H

#ifdef __EMSCRIPTEN__

#include <stdint.h>

/* ---------------------------------------------------------------- utypes.h */

typedef int32_t UChar32;
typedef uint16_t UChar;

/* ICU's convention: <= 0 is success (0 is fine, negatives are warnings),
 * > 0 is failure. libmspub relies on this exact shape. */
typedef enum UErrorCode
{
  U_USING_DEFAULT_WARNING = -127,
  U_AMBIGUOUS_ALIAS_WARNING = -122,
  U_ZERO_ERROR = 0,
  U_ILLEGAL_ARGUMENT_ERROR = 1,
  U_MISSING_RESOURCE_ERROR = 2,
  U_INVALID_FORMAT_ERROR = 3,
  U_FILE_ACCESS_ERROR = 4,
  U_INTERNAL_PROGRAM_ERROR = 5,
  U_ILLEGAL_CHAR_FOUND = 13,
  U_INVALID_CHAR_FOUND = 14,
  U_TRUNCATED_CHAR_FOUND = 15,
  U_BUFFER_OVERFLOW_ERROR = 15 + 1
} UErrorCode;

#define U_SUCCESS(x) ((x) <= U_ZERO_ERROR)
#define U_FAILURE(x) ((x) > U_ZERO_ERROR)

/* ------------------------------------------------------------------ ucnv.h */

struct UConverter;
typedef struct UConverter UConverter;

/* Opens a converter for `converterName`. On an unrecognised name this sets
 * *err to a failure code and returns nullptr, which is what real ICU does and
 * what libmspub's caller checks. */
UConverter *ucnv_open(const char *converterName, UErrorCode *err);

/* Decodes one code point starting at *source, advancing *source past the bytes
 * it consumed. Never advances past sourceLimit. Returns the code point; on a
 * malformed or unassigned sequence returns the substitution character the real
 * converter would return (which is not always U+FFFD — see icu_shim.cpp). */
UChar32 ucnv_getNextUChar(UConverter *converter, const char **source,
                          const char *sourceLimit, UErrorCode *err);

void ucnv_close(UConverter *converter);

/* ---------------------------------------------------------------- ucsdet.h */

struct UCharsetDetector;
typedef struct UCharsetDetector UCharsetDetector;
struct UCharsetMatch;
typedef struct UCharsetMatch UCharsetMatch;

UCharsetDetector *ucsdet_open(UErrorCode *status);
void ucsdet_close(UCharsetDetector *ucsd);
void ucsdet_setText(UCharsetDetector *ucsd, const char *textIn, int32_t len,
                    UErrorCode *status);
const UCharsetMatch **ucsdet_detectAll(UCharsetDetector *ucsd,
                                       int32_t *matchesFound, UErrorCode *status);
const char *ucsdet_getName(const UCharsetMatch *ucsm, UErrorCode *status);
int32_t ucsdet_getConfidence(const UCharsetMatch *ucsm, UErrorCode *status);

/* ------------------------------------------------------------------ uloc.h */

#define ULOC_FULLNAME_CAPACITY 157
#define ULOC_LANG_CAPACITY 12
#define ULOC_SCRIPT_CAPACITY 6
#define ULOC_COUNTRY_CAPACITY 4

int32_t uloc_getLocaleForLCID(uint32_t hostid, char *locale,
                              int32_t localeCapacity, UErrorCode *status);
int32_t uloc_getLanguage(const char *localeID, char *language,
                         int32_t languageCapacity, UErrorCode *err);
int32_t uloc_getCountry(const char *localeID, char *country,
                        int32_t countryCapacity, UErrorCode *err);
int32_t uloc_getScript(const char *localeID, char *script,
                       int32_t scriptCapacity, UErrorCode *err);

#endif /* __EMSCRIPTEN__ */
#endif /* PUBSHIFT_ICU_SHIM_H */
