#pragma once

#include "./defaults.h"

/**
 * Length of the longest prefix matching [+-] (digits [. [digits]] | . digits)
 * [(e|E) [+-] digits], the StrDecimalLiteral grammar without Infinity. Returns
 * zero when the prefix contains no significand digit.
 */
usize mal_number_decimal_prefix_length(const byte *text, usize length);

/**
 * Correctly rounded value of a complete literal accepted by
 * mal_number_decimal_prefix_length. The text need not be NUL-terminated.
 */
f64 mal_number_parse_decimal(const byte *text, usize length);

/**
 * Number::toString digits for finite, non-zero values that print without an
 * exponent and need at most a few fractional digits. Writes at most 32 bytes
 * and returns their length, or zero when the general formatter must decide.
 */
usize mal_number_format_shortest_plain(f64 value, byte out[32]);

/**
 * Number::prototype.toFixed digits for magnitudes below 2^53 with at most 20
 * fraction digits whose scaled value fits 64 bits. Writes at most 48 bytes and
 * returns their length, or zero when the general formatter must decide.
 */
usize mal_number_format_fixed_plain(f64 value, u32 fraction_digits, byte out[48]);
