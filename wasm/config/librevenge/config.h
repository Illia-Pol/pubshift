/* Hand-written replacement for librevenge's generated config.h.
 *
 * Honest note, because it would be misleading to imply otherwise: none of the
 * librevenge sources we compile actually contain `#include "config.h"`. The
 * upstream tree generates one (see librevenge/config.h.in) but only the build
 * system consumes it; the .cpp files reach for boost headers unconditionally.
 * Verified by grepping src/lib and inc for `config.h` and `HAVE_` — the only
 * hits are in Makefile.in.
 *
 * The file is kept for two reasons. It documents what librevenge's configure
 * probes for, so the next person does not have to re-derive it; and it is on
 * the include path, so if an upstream bump ever adds `#include "config.h"` to a
 * source we compile, the build keeps working instead of failing obscurely.
 *
 * Contents mirror config.h.in with the values that hold for the emscripten
 * sysroot plus the emscripten boost_headers port (boost 1.83.0).
 */

#ifndef PUBSHIFT_LIBREVENGE_CONFIG_H
#define PUBSHIFT_LIBREVENGE_CONFIG_H

/* boost headers used by RVNGBinaryData.cpp, RVNGDirectoryStream.cpp and
 * RVNGPropertyList.cpp. All header-only, all in the boost_headers port. */
#define HAVE_BOOST_ALGORITHM_STRING_HPP 1
#define HAVE_BOOST_ARCHIVE_ITERATORS_BASE64_FROM_BINARY_HPP 1
#define HAVE_BOOST_ARCHIVE_ITERATORS_BINARY_FROM_BASE64_HPP 1
#define HAVE_BOOST_ARCHIVE_ITERATORS_REMOVE_WHITESPACE_HPP 1
#define HAVE_BOOST_ARCHIVE_ITERATORS_TRANSFORM_WIDTH_HPP 1
#define HAVE_BOOST_SPIRIT_INCLUDE_QI_HPP 1

#define HAVE_CXX11 1
#define HAVE_INTTYPES_H 1
#define HAVE_STDINT_H 1
#define HAVE_STDIO_H 1
#define HAVE_STDLIB_H 1
#define HAVE_STRINGS_H 1
#define HAVE_STRING_H 1
#define HAVE_SYS_STAT_H 1
#define HAVE_SYS_TYPES_H 1
#define HAVE_UNISTD_H 1
#define STDC_HEADERS 1

/* Not defined under emscripten: HAVE_DLFCN_H (no dlopen in a wasm module). */

#define PACKAGE "librevenge"
#define PACKAGE_NAME "librevenge"
#define PACKAGE_TARNAME "librevenge"
#define PACKAGE_VERSION "0.0.6"
#define PACKAGE_STRING "librevenge 0.0.6"
#define VERSION "0.0.6"

#endif /* PUBSHIFT_LIBREVENGE_CONFIG_H */
