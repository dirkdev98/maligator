#pragma once

#include "./defaults.h"

typedef struct MalHeap MalHeap;
typedef struct MalString MalString;

/* UTF-8 conversion uses WHATWG replacement semantics for malformed input and
 * unpaired UTF-16 surrogates. Returned buffers are malloc'd and caller-owned. */

/** UTF-16 code units -> UTF-8 bytes. Sets *out_len; returns a malloc'd buffer. */
byte *mal_utf8_encode(const c16 *units, usize len, usize *out_len);

/** UTF-8 bytes -> UTF-16 code units. Sets *out_count; returns a malloc'd buffer. */
c16 *mal_utf8_decode(const byte *bytes, usize len, usize *out_count);

/** Decode with replacement while reporting whether malformed input was seen. */
c16 *mal_utf8_decode_report(
    const byte *bytes, usize len, usize *out_count, bool *had_error);

/** Encode a complete engine string. The returned byte buffer is not a C string. */
byte *mal_string_to_utf8(const MalString *string, usize *out_len);

/** Decode UTF-8 with replacement and copy it into a new engine string. */
MalString *mal_string_from_utf8(MalHeap *heap, const byte *bytes, usize len);

typedef enum MalUtf8CStringResult : u8 {
    MAL_UTF8_C_STRING_OK,
    MAL_UTF8_C_STRING_EMBEDDED_NUL,
    MAL_UTF8_C_STRING_ALLOCATION_FAILED,
} MalUtf8CStringResult;

/* Encode to a malloc'd, NUL-terminated C string. Embedded U+0000 is rejected,
 * never truncated. On failure *out is nullptr and *out_len is zero. */
MalUtf8CStringResult mal_string_to_utf8_c_string(
    const MalString *string, char **out, usize *out_len);
