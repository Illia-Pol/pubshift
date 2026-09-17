/* Hand-written replacement for the config.h that libmspub's configure would
 * generate. We compile the 15 .cpp files directly with emcc instead of running
 * autotools, so this file has to state, by hand, the three facts the sources
 * actually consult.
 *
 * Determined by reading libmspub/configure.ac and grepping the sources for
 * config-driven #ifdefs. The complete set is:
 *
 *   HAVE_FUNC_ATTRIBUTE_FORMAT        libmspub_utils.h:32
 *   HAVE_CLANG_ATTRIBUTE_FALLTHROUGH  libmspub_utils.h:38
 *   HAVE_GCC_ATTRIBUTE_FALLTHROUGH    libmspub_utils.h:40
 *
 * All three feed diagnostics only (printf-format checking and switch
 * fallthrough annotations); none of them changes generated code. That matters
 * for this project: it means config.h cannot be the cause of a native/WASM
 * output divergence.
 *
 * DEBUG is deliberately left undefined. Defining it would make libmspub write
 * to stderr from inside the parser, which is noise in a browser and, more to
 * the point, a behavioural difference from the native oracle.
 */

#ifndef PUBSHIFT_LIBMSPUB_CONFIG_H
#define PUBSHIFT_LIBMSPUB_CONFIG_H

/* emcc is clang. __has_attribute is the honest test rather than a guess. */
#if defined(__has_attribute)
#  if __has_attribute(__format__)
#    define HAVE_FUNC_ATTRIBUTE_FORMAT 1
#  endif
#endif

/* [[clang::fallthrough]] over __attribute__((fallthrough)): both work in
 * clang 17 (emscripten 6.0.9), and this is the branch configure picks for
 * clang, so we stay on the same path upstream tests. */
#if defined(__clang__)
#  define HAVE_CLANG_ATTRIBUTE_FALLTHROUGH 1
#elif defined(__GNUC__) && __GNUC__ >= 7
#  define HAVE_GCC_ATTRIBUTE_FALLTHROUGH 1
#endif

/* Identity strings. libmspub's sources never read these — they exist in the
 * generated header and are reproduced so the file is a faithful stand-in. */
#define PACKAGE "libmspub"
#define PACKAGE_NAME "libmspub"
#define PACKAGE_TARNAME "libmspub"
#define PACKAGE_VERSION "0.1.6"
#define PACKAGE_STRING "libmspub 0.1.6"
#define VERSION "0.1.6"

/* Headers configure probes for. Present under emscripten and on macOS. */
#define HAVE_BOOST_CSTDINT_HPP 1
#define HAVE_BOOST_NUMERIC_CONVERSION_CAST_HPP 1
#define HAVE_BOOST_OPTIONAL_HPP 1
#define STDC_HEADERS 1

#endif /* PUBSHIFT_LIBMSPUB_CONFIG_H */
