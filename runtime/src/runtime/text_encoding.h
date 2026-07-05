#pragma once

#include "./defaults.h"

/*
 * UTF-16 <-> UTF-8 conversion shared by the WinterTC runtime surface (fetch
 * bodies, TextEncoder/TextDecoder). Both helpers malloc their result; the caller
 * frees it. Decoding is lenient (WHATWG-style): malformed sequences become U+FFFD.
 */

/** UTF-16 code units -> UTF-8 bytes. Sets *out_len; returns a malloc'd buffer. */
byte *mal_utf8_encode(const c16 *units, usize len, usize *out_len);

/** UTF-8 bytes -> UTF-16 code units. Sets *out_count; returns a malloc'd buffer. */
c16 *mal_utf8_decode(const byte *bytes, usize len, usize *out_count);
