#pragma once

#include "defaults.h"
#include "heap.h"

typedef struct MalString MalString;

// The bound permits checked byte sizes on every target, including wasm32.
#define MAL_BIGINT_MAX_BITS (1u << 30)
#define MAL_BIGINT_MAX_DIGITS (MAL_BIGINT_MAX_BITS / 32u)

/** Immutable normalized signed magnitude. Wide dynamic digits trail their GC cell;
 * constant digits belong to the image. Inline limbs beyond digit_count are zero.
 * Zero has no digits and sign zero. */
typedef struct MalBigInt {
    MalHeapHeader header;
    i32 sign;
    u32 digit_count;
    alignas(16) union {
        u32 inline_digits[4];
        const u32 *digits;
    } data;
} MalBigInt;

static_assert(sizeof(MalBigInt) == 32);

static inline const u32 *mal_bigint_digits(const MalBigInt *value) {
    return value->digit_count <= countof(value->data.inline_digits)
        ? value->data.inline_digits : value->data.digits;
}

/** Factories return null with the owning VM's pending allocation or size exception.
 * Managed input storage must remain rooted until publication. */
MalBigInt *mal_bigint_new(MalHeap *heap, i128 value);
MalBigInt *mal_bigint_from_digits(MalHeap *heap, i32 sign, const u32 *digits, u32 count);
MalBigInt *mal_bigint_from_number(MalHeap *heap, f64 number);
MalBigInt *mal_bigint_parse(MalHeap *heap, const c16 *units, usize length, bool *valid);

bool mal_bigint_try_i128(const MalBigInt *value, i128 *out);
u64 mal_bigint_low_u64(const MalBigInt *value);
f64 mal_bigint_to_number(const MalBigInt *value);
u32 mal_bigint_bit_length(const MalBigInt *value);
i32 mal_bigint_compare(const MalBigInt *left, const MalBigInt *right);
// NaN returns 2; all other results are -1, 0 or 1.
i32 mal_bigint_compare_number(const MalBigInt *left, f64 right);
u64 mal_bigint_hash(const MalBigInt *value);
MalString *mal_bigint_to_string(MalHeap *heap, const MalBigInt *value, i32 radix);

MalBigInt *mal_bigint_add(MalHeap *heap, const MalBigInt *left, const MalBigInt *right);
MalBigInt *mal_bigint_subtract(MalHeap *heap, const MalBigInt *left, const MalBigInt *right);
MalBigInt *mal_bigint_multiply(MalHeap *heap, const MalBigInt *left, const MalBigInt *right);
MalBigInt *mal_bigint_divide(MalHeap *heap, const MalBigInt *left, const MalBigInt *right, bool remainder);
MalBigInt *mal_bigint_power(MalHeap *heap, const MalBigInt *base, const MalBigInt *exponent);
MalBigInt *mal_bigint_bitwise(MalHeap *heap, const MalBigInt *left, const MalBigInt *right, char operation);
MalBigInt *mal_bigint_shift(MalHeap *heap, const MalBigInt *value, const MalBigInt *count, bool right);
MalBigInt *mal_bigint_negate(MalHeap *heap, const MalBigInt *value);
MalBigInt *mal_bigint_not(MalHeap *heap, const MalBigInt *value);
MalBigInt *mal_bigint_width(MalHeap *heap, const MalBigInt *value, u64 bits, bool is_signed);
