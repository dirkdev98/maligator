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

/*
 * Shared decode core. Always substitutes U+FFFD for malformed or truncated
 * sequences (same output as mal_utf8_decode) and additionally reports through
 * *had_error whether any such substitution occurred, so a fatal TextDecoder can
 * throw instead of accepting the replacement. Sets *out_count; returns a malloc'd
 * buffer the caller frees.
 */
c16 *mal_utf8_decode_report(const byte *bytes, usize len, usize *out_count, bool *had_error);
