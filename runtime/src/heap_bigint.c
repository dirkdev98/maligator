#include "heap_bigint.h"

#include "heap_string.h"

void mal_bigint_init(MalBigInt *bigint, i128 value) {
    mal_heap_header_init(&bigint->header, MAL_HEAP_BIGINT);
    bigint->value = value;
}

MalBigInt *mal_bigint_new(MalHeap *heap, i128 value) {
    MalBigInt *bigint = mal_heap_alloc(heap, sizeof(MalBigInt), MAL_HEAP_BIGINT);
    mal_bigint_init(bigint, value);

    return bigint;
}

i128 mal_bigint_value(const MalBigInt *bigint) {
    return bigint->value;
}

MalString *mal_bigint_to_string(MalHeap *heap, i128 value, i32 radix) {
    if (radix < 2 || radix > 36) {
        radix = 10;
    }

    if (value == 0) {
        return mal_string_new_ascii(heap, "0", 1);
    }

    bool negative = value < 0;
    // Two's-complement magnitude, correct even for the i128 minimum.
    u128 magnitude = negative ? (~(u128) value + 1) : (u128) value;

    // 128 binary digits is the worst case, plus sign.
    byte buffer[140];
    usize length = 0;
    while (magnitude > 0) {
        i32 digit = (i32) (magnitude % (u128) radix);
        buffer[length++] = digit < 10 ? (byte) ('0' + digit) : (byte) ('a' + digit - 10);
        magnitude /= (u128) radix;
    }
    if (negative) {
        buffer[length++] = '-';
    }

    // Reverse into final order.
    for (usize i = 0; i < length / 2; i++) {
        byte tmp = buffer[i];
        buffer[i] = buffer[length - 1 - i];
        buffer[length - 1 - i] = tmp;
    }

    return mal_string_new_ascii(heap, buffer, length);
}

static bool mal_bigint_is_whitespace(c16 unit) {
    return unit == ' ' || unit == '\t' || unit == '\n' || unit == '\r' ||
        unit == 0x0B || unit == 0x0C || unit == 0xA0 || unit == 0xFEFF;
}

static i32 mal_bigint_digit_value(c16 unit) {
    if (unit >= '0' && unit <= '9') {
        return unit - '0';
    }
    if (unit >= 'a' && unit <= 'z') {
        return unit - 'a' + 10;
    }
    if (unit >= 'A' && unit <= 'Z') {
        return unit - 'A' + 10;
    }

    return -1;
}

i128 mal_bigint_parse(const c16 *code_units, usize length, bool *ok) {
    *ok = true;

    usize start = 0;
    usize end = length;
    while (start < end && mal_bigint_is_whitespace(code_units[start])) {
        start++;
    }
    while (end > start && mal_bigint_is_whitespace(code_units[end - 1])) {
        end--;
    }

    // The empty / all-whitespace string is 0n.
    if (start == end) {
        return 0;
    }

    bool negative = false;
    bool had_sign = false;
    if (code_units[start] == '+' || code_units[start] == '-') {
        negative = code_units[start] == '-';
        had_sign = true;
        start++;
    }

    i32 radix = 10;
    // Non-decimal prefixes are only valid without an explicit sign.
    if (!had_sign && end - start >= 2 && code_units[start] == '0') {
        c16 prefix = code_units[start + 1];
        if (prefix == 'x' || prefix == 'X') {
            radix = 16;
            start += 2;
        } else if (prefix == 'o' || prefix == 'O') {
            radix = 8;
            start += 2;
        } else if (prefix == 'b' || prefix == 'B') {
            radix = 2;
            start += 2;
        }
    }

    // A sign or prefix with no following digits is invalid.
    if (start == end) {
        *ok = false;
        return 0;
    }

    i128 accumulator = 0;
    for (; start < end; start++) {
        i32 digit = mal_bigint_digit_value(code_units[start]);
        if (digit < 0 || digit >= radix) {
            *ok = false;
            return 0;
        }
        accumulator = accumulator * radix + digit;
    }

    return negative ? -accumulator : accumulator;
}
