#pragma once

#include "./defaults.h"

/**
 * Fixed-width BigInt approximation policy.
 *
 * The engine stores the low 128 bits of the mathematical BigInt in two's-
 * complement form. Parsing, integral Number conversion, unary negation,
 * addition, subtraction, multiplication, exponentiation, and left shifts all
 * reduce modulo 2^128. Arithmetic right shifts sign-fill; shifts by 128 or
 * more produce 0 for left shifts/non-negative right shifts and -1 for negative
 * right shifts. Division truncates toward zero, except MIN / -1 wraps to MIN;
 * its remainder is 0. Division by zero is reported to the caller.
 *
 * All wrapping and shifting is performed as u128. The bit-copy conversion back
 * to i128 avoids signed-overflow UB and implementation-defined signed shifts.
 */

#define MAL_BIGINT128_WIDTH 128u

u128 mal_bigint128_bits(i128 value);
i128 mal_bigint128_from_bits(u128 bits);

i128 mal_bigint128_add(i128 left, i128 right);
i128 mal_bigint128_subtract(i128 left, i128 right);
i128 mal_bigint128_multiply(i128 left, i128 right);
i128 mal_bigint128_negate(i128 value);
i128 mal_bigint128_bit_and(i128 left, i128 right);
i128 mal_bigint128_bit_or(i128 left, i128 right);
i128 mal_bigint128_bit_xor(i128 left, i128 right);
i128 mal_bigint128_bit_not(i128 value);

i128 mal_bigint128_shift_left(i128 value, i128 count);
i128 mal_bigint128_shift_right(i128 value, i128 count);
bool mal_bigint128_divide(i128 dividend, i128 divisor, i128 *out);
bool mal_bigint128_remainder(i128 dividend, i128 divisor, i128 *out);
i128 mal_bigint128_exponentiate(i128 base, i128 exponent);

/** Convert a finite integral Number modulo 2^128; reject all other Numbers. */
bool mal_bigint128_from_number(f64 number, i128 *out);

i128 mal_bigint128_as_uint_n(i128 value, u64 bits);
i128 mal_bigint128_as_int_n(i128 value, u64 bits);

/** StringToBigInt syntax with modulo-2^128 accumulation. */
i128 mal_bigint128_parse(const c16 *code_units, usize length, bool *ok);
