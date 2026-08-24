#include "bigint128.h"

#include <math.h>
#include <string.h>

#include "ecma_whitespace.h"

u128 mal_bigint128_bits(i128 value) {
    return (u128) value;
}

i128 mal_bigint128_from_bits(u128 bits) {
    i128 value;
    static_assert(sizeof(value) == sizeof(bits));
    memcpy(&value, &bits, sizeof(value));
    return value;
}

i128 mal_bigint128_add(i128 left, i128 right) {
    return mal_bigint128_from_bits((u128) left + (u128) right);
}

i128 mal_bigint128_subtract(i128 left, i128 right) {
    return mal_bigint128_from_bits((u128) left - (u128) right);
}

i128 mal_bigint128_multiply(i128 left, i128 right) {
    return mal_bigint128_from_bits((u128) left * (u128) right);
}

i128 mal_bigint128_negate(i128 value) {
    return mal_bigint128_from_bits((u128) 0 - (u128) value);
}

i128 mal_bigint128_bit_and(i128 left, i128 right) {
    return mal_bigint128_from_bits((u128) left & (u128) right);
}

i128 mal_bigint128_bit_or(i128 left, i128 right) {
    return mal_bigint128_from_bits((u128) left | (u128) right);
}

i128 mal_bigint128_bit_xor(i128 left, i128 right) {
    return mal_bigint128_from_bits((u128) left ^ (u128) right);
}

i128 mal_bigint128_bit_not(i128 value) {
    return mal_bigint128_from_bits(~(u128) value);
}

static u128 mal_bigint128_count_magnitude(i128 count) {
    u128 bits = (u128) count;
    return count < 0 ? (u128) 0 - bits : bits;
}

static i128 mal_bigint128_shift_left_positive(i128 value, u128 count) {
    if (count >= MAL_BIGINT128_WIDTH) {
        return 0;
    }
    return mal_bigint128_from_bits((u128) value << (u32) count);
}

static i128 mal_bigint128_shift_right_positive(i128 value, u128 count) {
    if (count >= MAL_BIGINT128_WIDTH) {
        return value < 0 ? mal_bigint128_from_bits(~(u128) 0) : 0;
    }
    if (count == 0) {
        return value;
    }

    u32 shift = (u32) count;
    u128 shifted = (u128) value >> shift;
    if (value < 0) {
        shifted |= ~(u128) 0 << (MAL_BIGINT128_WIDTH - shift);
    }
    return mal_bigint128_from_bits(shifted);
}

i128 mal_bigint128_shift_left(i128 value, i128 count) {
    u128 magnitude = mal_bigint128_count_magnitude(count);
    return count < 0
        ? mal_bigint128_shift_right_positive(value, magnitude)
        : mal_bigint128_shift_left_positive(value, magnitude);
}

i128 mal_bigint128_shift_right(i128 value, i128 count) {
    u128 magnitude = mal_bigint128_count_magnitude(count);
    return count < 0
        ? mal_bigint128_shift_left_positive(value, magnitude)
        : mal_bigint128_shift_right_positive(value, magnitude);
}

static bool mal_bigint128_is_min(i128 value) {
    return (u128) value == ((u128) 1 << 127);
}

bool mal_bigint128_divide(i128 dividend, i128 divisor, i128 *out) {
    if (divisor == 0) {
        return false;
    }
    if (mal_bigint128_is_min(dividend) && divisor == -1) {
        *out = dividend;
        return true;
    }
    *out = dividend / divisor;
    return true;
}

bool mal_bigint128_remainder(i128 dividend, i128 divisor, i128 *out) {
    if (divisor == 0) {
        return false;
    }
    if (mal_bigint128_is_min(dividend) && divisor == -1) {
        *out = 0;
        return true;
    }
    *out = dividend % divisor;
    return true;
}

i128 mal_bigint128_exponentiate(i128 base, i128 exponent) {
    u128 remaining = (u128) exponent;
    i128 result = 1;
    while (remaining != 0) {
        if ((remaining & 1) != 0) {
            result = mal_bigint128_multiply(result, base);
        }
        base = mal_bigint128_multiply(base, base);
        remaining >>= 1;
    }
    return result;
}

bool mal_bigint128_from_number(f64 number, i128 *out) {
    if (!isfinite(number) || trunc(number) != number) {
        return false;
    }
    if (number == 0.0) {
        *out = 0;
        return true;
    }

    bool negative = number < 0.0;
    f64 magnitude = negative ? -number : number;
    i32 exponent;
    f64 fraction = frexp(magnitude, &exponent);
    u64 significand = (u64) ldexp(fraction, 53);
    i32 shift = exponent - 53;
    u128 bits;
    if (shift >= (i32) MAL_BIGINT128_WIDTH) {
        bits = 0;
    } else if (shift >= 0) {
        bits = (u128) significand << (u32) shift;
    } else {
        bits = (u128) significand >> (u32) -shift;
    }
    if (negative) {
        bits = (u128) 0 - bits;
    }
    *out = mal_bigint128_from_bits(bits);
    return true;
}

i128 mal_bigint128_as_uint_n(i128 value, u64 bits) {
    if (bits == 0) {
        return 0;
    }
    if (bits >= MAL_BIGINT128_WIDTH) {
        return value;
    }
    u128 mask = ((u128) 1 << (u32) bits) - 1;
    return mal_bigint128_from_bits((u128) value & mask);
}

i128 mal_bigint128_as_int_n(i128 value, u64 bits) {
    if (bits == 0) {
        return 0;
    }
    if (bits >= MAL_BIGINT128_WIDTH) {
        return value;
    }

    u128 mask = ((u128) 1 << (u32) bits) - 1;
    u128 result = (u128) value & mask;
    u128 sign = (u128) 1 << ((u32) bits - 1);
    if ((result & sign) != 0) {
        result |= ~mask;
    }
    return mal_bigint128_from_bits(result);
}

static i32 mal_bigint128_digit_value(c16 unit) {
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

i128 mal_bigint128_parse(const c16 *code_units, usize length, bool *ok) {
    *ok = true;

    usize start = 0;
    usize end = length;
    while (start < end && mal_ecma_is_string_whitespace(code_units[start])) {
        start++;
    }
    while (end > start && mal_ecma_is_string_whitespace(code_units[end - 1])) {
        end--;
    }
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

    u32 radix = 10;
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
    if (start == end) {
        *ok = false;
        return 0;
    }

    u128 accumulator = 0;
    if (radix != 10) {
        u32 shift = radix == 16 ? 4 : radix == 8 ? 3 : 1;
        for (; start < end; start++) {
            i32 digit = mal_bigint128_digit_value(code_units[start]);
            if (digit < 0 || (u32) digit >= radix) {
                *ok = false;
                return 0;
            }
            accumulator = (accumulator << shift) | (u128) digit;
        }
    } else {
        static const u128 decimal_chunk_base = (u128) 10000000000000000000ULL;
        usize group_length = (end - start) % 19;
        if (group_length == 0) {
            group_length = 19;
        }
        while (start < end) {
            u64 chunk = 0;
            u64 multiplier = 1;
            usize group_end = start + group_length;
            for (; start < group_end; start++) {
                c16 unit = code_units[start];
                if (unit < '0' || unit > '9') {
                    *ok = false;
                    return 0;
                }
                chunk = chunk * 10 + (u64) (unit - '0');
                multiplier *= 10;
            }
            accumulator = accumulator * (group_length == 19
                ? decimal_chunk_base
                : (u128) multiplier) + (u128) chunk;
            group_length = 19;
        }
    }
    if (negative) {
        accumulator = (u128) 0 - accumulator;
    }
    return mal_bigint128_from_bits(accumulator);
}
