#include "float16.h"

#include <string.h>

static u64 mal_float16_f64_bits(f64 value) {
    u64 bits;
    memcpy(&bits, &value, sizeof bits);
    return bits;
}

static f64 mal_float16_f64_from_bits(u64 bits) {
    f64 value;
    memcpy(&value, &bits, sizeof value);
    return value;
}

// Round an integer right shift to nearest, resolving an exact tie toward an
// even result. All callers keep shift in [1, 63].
static u64 mal_float16_round_shift(u64 value, u32 shift) {
    u64 truncated = value >> shift;
    u64 remainder_mask = (UINT64_C(1) << shift) - 1;
    u64 remainder = value & remainder_mask;
    u64 halfway = UINT64_C(1) << (shift - 1);
    if (remainder > halfway || (remainder == halfway && (truncated & 1) != 0)) {
        truncated++;
    }
    return truncated;
}

u16 mal_float16_f64_to_bits(f64 value) {
    u64 bits = mal_float16_f64_bits(value);
    u16 sign = (u16) ((bits >> 48) & 0x8000);
    u32 exponent_bits = (u32) ((bits >> 52) & 0x7FF);
    u64 fraction = bits & UINT64_C(0x000FFFFFFFFFFFFF);

    if (exponent_bits == 0x7FF) {
        return fraction == 0 ? (u16) (sign | 0x7C00)
                             : MAL_FLOAT16_CANONICAL_NAN_BITS;
    }
    if (exponent_bits == 0) {
        // Binary64 zero and subnormals are all below the binary16 half-minimum.
        return sign;
    }

    i32 exponent = (i32) exponent_bits - 1023;
    u64 significand = UINT64_C(0x0010000000000000) | fraction;
    if (exponent < -25) {
        return sign;
    }

    if (exponent < -14) {
        // Binary16 subnormals are integer multiples of 2^-24.
        u64 rounded = mal_float16_round_shift(significand, (u32) (28 - exponent));
        return (u16) (sign | (u16) rounded);
    }

    if (exponent > 15) {
        return (u16) (sign | 0x7C00);
    }

    u64 rounded = mal_float16_round_shift(significand, 42);
    u32 half_exponent = (u32) exponent + 15;
    if (rounded == 0x800) {
        rounded = 0x400;
        half_exponent++;
    }
    if (half_exponent >= 0x1F) {
        return (u16) (sign | 0x7C00);
    }
    return (u16) (sign | (u16) (half_exponent << 10) |
                  (u16) (rounded & 0x3FF));
}

f64 mal_float16_bits_to_f64(u16 bits) {
    u64 sign = (u64) (bits & 0x8000) << 48;
    u32 exponent = ((u32) bits >> 10) & 0x1F;
    u32 fraction = (u32) bits & 0x3FF;
    u64 result;

    if (exponent == 0) {
        if (fraction == 0) {
            result = sign;
        } else {
            u32 leading = 0;
            for (u32 value = fraction; value > 1; value >>= 1) {
                leading++;
            }
            u64 double_exponent = (u64) (leading + 999); // leading - 24 + 1023
            u64 double_fraction = (u64) (fraction - (UINT32_C(1) << leading))
                                  << (52 - leading);
            result = sign | (double_exponent << 52) | double_fraction;
        }
    } else if (exponent == 0x1F) {
        // All binary16 NaNs widen to one quiet binary64 NaN.
        result = fraction == 0 ? sign | UINT64_C(0x7FF0000000000000)
                               : UINT64_C(0x7FF8000000000000);
    } else {
        u64 double_exponent = (u64) ((i32) exponent - 15 + 1023);
        result = sign | (double_exponent << 52) | ((u64) fraction << 42);
    }
    return mal_float16_f64_from_bits(result);
}
