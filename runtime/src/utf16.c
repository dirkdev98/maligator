#include "utf16.h"

#include <stdlib.h>

c16 *mal_utf16_decode_report(
    const byte *bytes, usize len, bool big_endian, usize *out_count, bool *had_error) {
    *out_count = 0;
    *had_error = false;
    usize capacity = len / 2 + len % 2;
    if (capacity > SIZE_MAX / sizeof(c16)) return nullptr;
    c16 *out = malloc(sizeof(c16) * (capacity == 0 ? 1 : capacity));
    if (out == nullptr) return nullptr;

    usize o = 0;
    usize i = 0;
    while (i + 1 < len) {
        u8 first = (u8) bytes[i];
        u8 second = (u8) bytes[i + 1];
        c16 unit = big_endian ? (c16) ((first << 8) | second) : (c16) ((second << 8) | first);
        i += 2;

        if (mal_utf16_is_lead_surrogate(unit)) {
            if (i + 1 < len) {
                first = (u8) bytes[i];
                second = (u8) bytes[i + 1];
                c16 trail = big_endian
                    ? (c16) ((first << 8) | second)
                    : (c16) ((second << 8) | first);
                if (mal_utf16_is_trail_surrogate(trail)) {
                    out[o++] = unit;
                    out[o++] = trail;
                    i += 2;
                    continue;
                }
            }
            out[o++] = 0xFFFD;
            *had_error = true;
        } else if (mal_utf16_is_trail_surrogate(unit)) {
            out[o++] = 0xFFFD;
            *had_error = true;
        } else {
            out[o++] = unit;
        }
    }
    if (i < len) {
        out[o++] = 0xFFFD;
        *had_error = true;
    }
    *out_count = o;
    return out;
}
