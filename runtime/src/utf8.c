#include "utf8.h"

#include <stdlib.h>

#include "heap_string.h"
#include "utf16.h"

byte *mal_utf8_encode(const c16 *units, usize len, usize *out_len) {
    *out_len = 0;
    if (len > (SIZE_MAX - 1) / 3) return nullptr;
    byte *out = malloc(len * 3 + 1); // <= 3 bytes/BMP unit; a surrogate pair is 2 units -> 4 bytes
    if (out == nullptr) return nullptr;
    usize o = 0;
    for (usize i = 0; i < len; i++) {
        u32 c;
        usize width;
        if (!mal_utf16_read_scalar(units, len, i, &c, &width)) c = 0xFFFD;
        i += width - 1;
        if (c < 0x80) {
            out[o++] = (byte) c;
        } else if (c < 0x800) {
            out[o++] = (byte) (0xC0 | (c >> 6));
            out[o++] = (byte) (0x80 | (c & 0x3F));
        } else if (c < 0x10000) {
            out[o++] = (byte) (0xE0 | (c >> 12));
            out[o++] = (byte) (0x80 | ((c >> 6) & 0x3F));
            out[o++] = (byte) (0x80 | (c & 0x3F));
        } else {
            out[o++] = (byte) (0xF0 | (c >> 18));
            out[o++] = (byte) (0x80 | ((c >> 12) & 0x3F));
            out[o++] = (byte) (0x80 | ((c >> 6) & 0x3F));
            out[o++] = (byte) (0x80 | (c & 0x3F));
        }
    }
    *out_len = o;
    return out;
}

c16 *mal_utf8_decode(const byte *bytes, usize len, usize *out_count) {
    bool had_error;
    return mal_utf8_decode_report(bytes, len, out_count, &had_error);
}

c16 *mal_utf8_decode_report(const byte *bytes, usize len, usize *out_count, bool *had_error) {
    *out_count = 0;
    *had_error = false;
    if (len > SIZE_MAX / sizeof(c16) - 1) return nullptr;
    c16 *out = malloc(sizeof(c16) * (len + 1)); // <= len code units
    if (out == nullptr) return nullptr;
    usize o = 0;
    usize i = 0;
    while (i < len) {
        u8 b = (u8) bytes[i];
        u32 cp;
        usize n = 1;
        u8 second_min = 0x80;
        u8 second_max = 0xBF;
        if (b < 0x80) {
            cp = b;
        } else if (b >= 0xC2 && b <= 0xDF) {
            cp = b & 0x1Fu;
            n = 2;
        } else if (b >= 0xE0 && b <= 0xEF) {
            cp = b & 0x0Fu;
            n = 3;
            if (b == 0xE0) second_min = 0xA0;
            if (b == 0xED) second_max = 0x9F;
        } else if (b >= 0xF0 && b <= 0xF4) {
            cp = b & 0x07u;
            n = 4;
            if (b == 0xF0) second_min = 0x90;
            if (b == 0xF4) second_max = 0x8F;
        } else {
            cp = 0xFFFD;
            *had_error = true;
        }
        if (n > 1) {
            usize consumed = 1;
            for (usize k = 1; k < n; k++) {
                if (i + k >= len) {
                    cp = 0xFFFD;
                    n = consumed;
                    *had_error = true;
                    break;
                }
                u8 cont = (u8) bytes[i + k];
                u8 minimum = k == 1 ? second_min : 0x80;
                u8 maximum = k == 1 ? second_max : 0xBF;
                if (cont < minimum || cont > maximum) {
                    cp = 0xFFFD;
                    n = consumed;
                    *had_error = true;
                    break;
                }
                cp = (cp << 6) | (cont & 0x3Fu);
                consumed++;
            }
        }
        i += n;
        if (cp <= 0xFFFF) {
            out[o++] = (c16) cp;
        } else {
            mal_utf16_emit_pair(cp, out + o);
            o += 2;
        }
    }
    *out_count = o;
    return out;
}

byte *mal_string_to_utf8(const MalString *string, usize *out_len) {
    return mal_utf8_encode(mal_string_code_units(string), mal_string_length(string), out_len);
}

MalString *mal_string_from_utf8(MalHeap *heap, const byte *bytes, usize len) {
    usize count;
    c16 *units = mal_utf8_decode(bytes, len, &count);
    if (units == nullptr || count > MAL_STRING_MAX_CODE_UNITS) {
        free(units);
        return nullptr;
    }
    MalString *string = mal_string_new_copy(heap, units, count);
    free(units);
    return string;
}

MalUtf8CStringResult mal_string_to_utf8_c_string(
    const MalString *string, char **out, usize *out_len
) {
    *out = nullptr;
    *out_len = 0;
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    for (usize i = 0; i < length; i++) {
        if (units[i] == 0) return MAL_UTF8_C_STRING_EMBEDDED_NUL;
    }
    byte *bytes = mal_utf8_encode(units, length, out_len);
    if (bytes == nullptr) return MAL_UTF8_C_STRING_ALLOCATION_FAILED;
    bytes[*out_len] = '\0';
    *out = (char *) bytes;
    return MAL_UTF8_C_STRING_OK;
}
