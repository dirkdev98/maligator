#include "text_encoding.h"

#include <stdlib.h>

byte *mal_utf8_encode(const c16 *units, usize len, usize *out_len) {
    byte *out = malloc(len * 3 + 1); // <= 3 bytes/BMP unit; a surrogate pair is 2 units -> 4 bytes
    usize o = 0;
    for (usize i = 0; i < len; i++) {
        u32 c = units[i];
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < len) {
            u32 lo = units[i + 1];
            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                c = 0x10000 + ((c - 0xD800) << 10) + (lo - 0xDC00);
                i++;
            }
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
    c16 *out = malloc(sizeof(c16) * (len + 1)); // <= len code units
    usize o = 0;
    usize i = 0;
    while (i < len) {
        u8 b = (u8) bytes[i];
        u32 cp;
        usize n;
        if (b < 0x80) {
            cp = b;
            n = 1;
        } else if ((b & 0xE0) == 0xC0) {
            cp = b & 0x1Fu;
            n = 2;
        } else if ((b & 0xF0) == 0xE0) {
            cp = b & 0x0Fu;
            n = 3;
        } else if ((b & 0xF8) == 0xF0) {
            cp = b & 0x07u;
            n = 4;
        } else {
            cp = 0xFFFD;
            n = 1;
        }
        if (n > 1) {
            if (i + n > len) {
                cp = 0xFFFD;
                n = 1;
            } else {
                for (usize k = 1; k < n; k++) {
                    u8 cont = (u8) bytes[i + k];
                    if ((cont & 0xC0) != 0x80) {
                        cp = 0xFFFD;
                        n = 1;
                        break;
                    }
                    cp = (cp << 6) | (cont & 0x3Fu);
                }
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
