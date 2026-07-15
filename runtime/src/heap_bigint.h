#pragma once

#include "./defaults.h"
#include "heap.h"

typedef struct MalString MalString;

/**
 * BigInt primitive value.
 *
 * This is a 128-bit-backed stand-in, not arbitrary precision.
 * Values beyond the i128 range wrap. The 128-bit width is deliberate so the
 * full i64 and u64 ranges used by BigInt64Array/BigUint64Array round-trip.
 */
typedef struct MalBigInt {
    MalHeapHeader header;
    i128 value;
} MalBigInt;

/**
 * Initialize a BigInt allocation in caller-provided storage.
 */
void mal_bigint_init(MalBigInt *bigint, i128 value);

/**
 * Allocate and initialize a new BigInt.
 */
MalBigInt *mal_bigint_new(MalHeap *heap, i128 value);

/**
 * Read the backing 128-bit value.
 */
i128 mal_bigint_value(const MalBigInt *bigint);

/**
 * Format a BigInt value in the given radix (2..36) as a heap string.
 */
MalString *mal_bigint_to_string(MalHeap *heap, i128 value, i32 radix);

/**
 * Parse a StringToBigInt: optional surrounding whitespace, optional leading
 * sign, and either a 0x/0o/0b-prefixed literal or a decimal run. The empty (or
 * all-whitespace) string is 0. Sets *ok to false on any invalid input.
 */
i128 mal_bigint_parse(const c16 *code_units, usize length, bool *ok);
