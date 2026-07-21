#pragma once

#include "./defaults.h"

static inline bool mal_utf16_is_lead_surrogate(c16 unit) {
    return unit >= 0xD800 && unit <= 0xDBFF;
}

static inline bool mal_utf16_is_trail_surrogate(c16 unit) {
    return unit >= 0xDC00 && unit <= 0xDFFF;
}

static inline bool mal_utf16_is_surrogate(c16 unit) {
    return unit >= 0xD800 && unit <= 0xDFFF;
}

static inline bool mal_utf16_is_pair(c16 lead, c16 trail) {
    return mal_utf16_is_lead_surrogate(lead) && mal_utf16_is_trail_surrogate(trail);
}

static inline u32 mal_utf16_compose_pair(c16 lead, c16 trail) {
    return 0x10000u + (((u32) lead - 0xD800u) << 10) + ((u32) trail - 0xDC00u);
}

/* Emit a non-BMP scalar as its lead/trail pair. */
static inline void mal_utf16_emit_pair(u32 scalar, c16 out[2]) {
    u32 adjusted = scalar - 0x10000u;
    out[0] = (c16) (0xD800u + (adjusted >> 10));
    out[1] = (c16) (0xDC00u + (adjusted & 0x3FFu));
}

/* ECMAScript code-point iteration width: lone surrogates remain one code unit. */
static inline usize mal_utf16_code_point_width(
    const c16 *units, usize length, usize index
) {
    return index + 1 < length && mal_utf16_is_pair(units[index], units[index + 1]) ? 2 : 1;
}

/* Read one Unicode scalar. A lone surrogate returns false with width one; the
 * caller explicitly chooses whether to preserve, replace, or reject that unit. */
static inline bool mal_utf16_read_scalar(
    const c16 *units, usize length, usize index, u32 *out_scalar, usize *out_width
) {
    c16 first = units[index];
    usize width = mal_utf16_code_point_width(units, length, index);
    if (out_width != nullptr) *out_width = width;
    if (width == 2) {
        if (out_scalar != nullptr) {
            *out_scalar = mal_utf16_compose_pair(first, units[index + 1]);
        }
        return true;
    }
    if (out_scalar != nullptr) *out_scalar = first;
    return !mal_utf16_is_surrogate(first);
}

/* Decode UTF-16 bytes in the requested byte order. Valid surrogate pairs are
 * preserved as two engine code units. Odd trailing bytes and unpaired
 * surrogates become U+FFFD and set *had_error. The result is malloc'd. */
c16 *mal_utf16_decode_report(
    const byte *bytes, usize len, bool big_endian, usize *out_count, bool *had_error);
