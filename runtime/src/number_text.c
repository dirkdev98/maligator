#include "number_text.h"

#include <float.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

static inline bool mal_number_is_digit(byte unit) {
    return (u8) (unit - '0') < 10;
}

usize mal_number_decimal_prefix_length(const byte *text, usize length) {
    usize cursor = 0;
    if (cursor < length && (text[cursor] == '+' || text[cursor] == '-')) cursor++;
    bool any_digit = false;
    while (cursor < length && mal_number_is_digit(text[cursor])) {
        any_digit = true;
        cursor++;
    }
    if (cursor < length && text[cursor] == '.') {
        cursor++;
        while (cursor < length && mal_number_is_digit(text[cursor])) {
            any_digit = true;
            cursor++;
        }
    }
    if (!any_digit) return 0;
    if (cursor < length && (text[cursor] == 'e' || text[cursor] == 'E')) {
        usize exponent = cursor + 1;
        if (exponent < length && (text[exponent] == '+' || text[exponent] == '-')) exponent++;
        if (exponent < length && mal_number_is_digit(text[exponent])) {
            cursor = exponent;
            while (cursor < length && mal_number_is_digit(text[cursor])) cursor++;
        }
    }
    return cursor;
}

static f64 mal_number_parse_decimal_slow(const byte *text, usize length) {
    byte stack_buffer[64];
    byte *buffer = length < sizeof(stack_buffer) ? stack_buffer : malloc(length + 1);
    if (buffer == nullptr) abort();
    memcpy(buffer, text, length);
    buffer[length] = '\0';
    f64 value = strtod(buffer, nullptr);
    if (buffer != stack_buffer) free(buffer);
    return value;
}

f64 mal_number_parse_decimal(const byte *text, usize length) {
#if defined(FLT_EVAL_METHOD) && FLT_EVAL_METHOD == 0
    // Clinger's fast path: an exact significand of at most 2^53 scaled by an
    // exactly representable power of ten needs one correctly rounded IEEE
    // operation. Excess precision (FLT_EVAL_METHOD != 0) would double-round.
    static const f64 powers_of_ten[] = {
        1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11,
        1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22,
    };
    const u64 exact_limit = (u64) 1 << 53;
    usize cursor = 0;
    bool negative = false;
    if (cursor < length && (text[cursor] == '+' || text[cursor] == '-')) {
        negative = text[cursor] == '-';
        cursor++;
    }
    u64 significand = 0;
    u32 digits = 0;
    i64 exponent = 0;
    bool truncated = false;
    for (; cursor < length && mal_number_is_digit(text[cursor]); cursor++) {
        u32 digit = (u32) (text[cursor] - '0');
        if (digits == 0 && digit == 0) continue;
        if (digits < 19) {
            significand = significand * 10 + digit;
            digits++;
        } else {
            exponent++;
            truncated |= digit != 0;
        }
    }
    if (cursor < length && text[cursor] == '.') {
        for (cursor++; cursor < length && mal_number_is_digit(text[cursor]); cursor++) {
            u32 digit = (u32) (text[cursor] - '0');
            if (digits == 0 && digit == 0) {
                exponent--;
            } else if (digits < 19) {
                significand = significand * 10 + digit;
                digits++;
                exponent--;
            } else {
                truncated |= digit != 0;
            }
        }
    }
    if (cursor < length && (text[cursor] == 'e' || text[cursor] == 'E')) {
        cursor++;
        bool exponent_negative = false;
        if (cursor < length && (text[cursor] == '+' || text[cursor] == '-')) {
            exponent_negative = text[cursor] == '-';
            cursor++;
        }
        i64 explicit_exponent = 0;
        for (; cursor < length && mal_number_is_digit(text[cursor]); cursor++) {
            // Saturate far beyond double range; the slow path decides overflow.
            if (explicit_exponent < 1000000) {
                explicit_exponent = explicit_exponent * 10 + (text[cursor] - '0');
            }
        }
        exponent += exponent_negative ? -explicit_exponent : explicit_exponent;
    }
    if (significand == 0) return negative ? -0.0 : 0.0;
    if (!truncated && significand <= exact_limit) {
        // Move surplus exponent into the significand while it stays exact.
        while (exponent > 22 && significand <= exact_limit / 10) {
            significand *= 10;
            exponent--;
        }
        if (exponent >= -22 && exponent <= 22) {
            f64 value = (f64) significand;
            value = exponent < 0 ? value / powers_of_ten[-exponent] : value * powers_of_ten[exponent];
            return negative ? -value : value;
        }
    }
#endif
    return mal_number_parse_decimal_slow(text, length);
}

#define MAL_NUMBER_PLAIN_FRACTION_DIGITS 8u

usize mal_number_format_shortest_plain(f64 value, byte out[32]) {
#if defined(FLT_EVAL_METHOD) && FLT_EVAL_METHOD == 0
    static const u64 powers_of_five[] = {1, 5, 25, 125, 625, 3125, 15625, 78125, 390625};
    static const f64 powers_of_ten[] = {1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8};
    static_assert(countof(powers_of_five) == MAL_NUMBER_PLAIN_FRACTION_DIGITS + 1);
    const u64 exact_limit = (u64) 1 << 53;
    f64 magnitude = fabs(value);
    // Below 2^53 every integer is exact, so integer-part rounding never
    // round-trips; at least 1e-6 keeps ECMAScript's plain notation.
    if (!(magnitude >= 1e-6 && magnitude < 0x1p53)) return 0;
    u64 bits;
    memcpy(&bits, &magnitude, sizeof(bits));
    u64 significand = (bits & ((exact_limit >> 1) - 1)) | (exact_limit >> 1);
    i32 binary_exponent = (i32) ((bits >> 52) & 0x7ff) - 1075;

    // The first fraction length whose nearest decimal rounds back is the
    // shortest representation, and nearest-even selects the closest digits
    // that Number::toString recommends.
    for (u32 fraction = 0; fraction <= MAL_NUMBER_PLAIN_FRACTION_DIGITS; fraction++) {
        unsigned __int128 scaled = (unsigned __int128) significand * powers_of_five[fraction];
        i32 drop = -(binary_exponent + (i32) fraction);
        u64 digits;
        if (drop <= 0) {
            scaled <<= -drop;
            if (scaled > exact_limit) return 0;
            digits = (u64) scaled;
        } else {
            unsigned __int128 integer = scaled >> drop;
            unsigned __int128 remainder = scaled - (integer << drop);
            unsigned __int128 half = (unsigned __int128) 1 << (drop - 1);
            if (integer > exact_limit) return 0;
            digits = (u64) integer;
            if (remainder > half || (remainder == half && (digits & 1) != 0)) digits++;
            if (digits == 0 || digits > exact_limit ||
                (f64) digits / powers_of_ten[fraction] != magnitude) {
                continue;
            }
        }

        byte reversed[20];
        usize count = 0;
        do {
            reversed[count++] = (byte) ('0' + digits % 10);
            digits /= 10;
        } while (digits != 0);
        usize length = 0;
        if (value < 0) out[length++] = '-';
        if (count <= fraction) {
            out[length++] = '0';
            out[length++] = '.';
            for (usize i = count; i < fraction; i++) out[length++] = '0';
        }
        for (usize i = count; i > 0; i--) {
            if (i == fraction && count > fraction) out[length++] = '.';
            out[length++] = reversed[i - 1];
        }
        return length;
    }
#else
    (void) value;
    (void) out;
#endif
    return 0;
}
