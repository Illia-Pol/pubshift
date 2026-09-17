/* Shim stand-in for ICU's <unicode/ucsdet.h>.
 *
 * This directory is on the include path for the emscripten build only, so the
 * unmodified libmspub sources pick up wasm/icu_shim.h instead of real ICU
 * without a single edit to the upstream tree. The native build does not have
 * this directory on its include path and keeps using real ICU.
 */
#include "../../icu_shim.h"
