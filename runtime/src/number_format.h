#pragma once

#include "./defaults.h"

/**
 * Exact decimal rendering for finite ECMAScript Number values. Callers handle
 * NaN and infinities before entering these helpers. Output buffers need 128
 * bytes for shortest form and 192 bytes for the fixed-precision operations.
 */
usize mal_number_format_shortest(f64 number, byte *out);
usize mal_number_format_fixed(f64 number, i32 fraction_digits, byte *out);
usize mal_number_format_exponential(
    f64 number,
    i32 fraction_digits,
    bool shortest,
    byte *out
);
usize mal_number_format_precision(f64 number, i32 precision, byte *out);
