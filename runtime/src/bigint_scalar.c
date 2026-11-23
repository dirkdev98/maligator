#include "heap_bigint.h"

bool mal_bigint_try_i128(const MalBigInt *value, i128 *out) {
    if (value->digit_count > 2) return false;
    u128 magnitude = mal_bigint_inline_magnitude(value);
    u128 maximum = ((u128) 1 << 127) - (value->sign < 0 ? 0 : 1);
    if (magnitude > maximum) return false;
    *out = mal_bigint_signed_bits(value->sign < 0 ? (u128) 0 - magnitude : magnitude);
    return true;
}

u64 mal_bigint_low_u64(const MalBigInt *value) {
    u64 bits = mal_bigint_digits(value)[0];
    return value->sign < 0 ? (u64) 0 - bits : bits;
}

i32 mal_bigint_compare(const MalBigInt *left, const MalBigInt *right) {
    if (left->sign != right->sign) return left->sign < right->sign ? -1 : 1;
    return left->sign * mal_bigint_compare_magnitude(left, right);
}

u64 mal_bigint_hash(const MalBigInt *value) {
    u64 hash = UINT64_C(0x9e3779b97f4a7c15) ^ (u64) value->sign;
    const u64 *digits = mal_bigint_digits(value);
    for (u32 i = 0; i < value->digit_count; i++) {
        hash ^= digits[i];
        hash *= UINT64_C(0x100000001b3);
        hash ^= hash >> 32;
    }
    return hash;
}
