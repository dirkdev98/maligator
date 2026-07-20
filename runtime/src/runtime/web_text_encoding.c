#include "web_text_encoding.h"

#include <stdlib.h>

byte *mal_utf8_encode(const c16 *units, usize len, usize *out_len) {
    *out_len = 0;
    if (len > (SIZE_MAX - 1) / 3) return nullptr;
    byte *out = malloc(len * 3 + 1); // <= 3 bytes/BMP unit; a surrogate pair is 2 units -> 4 bytes
    if (out == nullptr) return nullptr;
    usize o = 0;
    for (usize i = 0; i < len; i++) {
        u32 c = units[i];
        if (c >= 0xD800 && c <= 0xDBFF) {
            u32 lo = i + 1 < len ? units[i + 1] : 0;
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00);
                i++;
            } else {
                c = 0xFFFD;
            }
        } else if (c >= 0xDC00 && c <= 0xDFFF) {
            c = 0xFFFD;
        }
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
            cp -= 0x10000;
            out[o++] = (c16) (0xD800 + (cp >> 10));
            out[o++] = (c16) (0xDC00 + (cp & 0x3FF));
        }
    }
    *out_count = o;
    return out;
}

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

        if (unit >= 0xD800 && unit <= 0xDBFF) {
            if (i + 1 < len) {
                first = (u8) bytes[i];
                second = (u8) bytes[i + 1];
                c16 trail = big_endian
                    ? (c16) ((first << 8) | second)
                    : (c16) ((second << 8) | first);
                if (trail >= 0xDC00 && trail <= 0xDFFF) {
                    out[o++] = unit;
                    out[o++] = trail;
                    i += 2;
                    continue;
                }
            }
            out[o++] = 0xFFFD;
            *had_error = true;
        } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
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
