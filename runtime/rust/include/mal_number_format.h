/*
 * mal_number_format.h - flat, allocation-free ECMAScript Number formatting.
 *
 * The caller owns the output buffer. Each function returns the full ASCII byte
 * length, copying at most out_cap bytes, or -1 for an invalid input/argument.
 * JavaScript coercion, range checks, and non-finite spellings stay in C.
 */
#pragma once

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ECMAScript Number::toString decimal placement and shortest digits. */
int32_t mal_number_format_shortest(double value, uint8_t *out, int32_t out_cap);

/* Shortest exponential form used by toExponential(undefined). */
int32_t mal_number_format_shortest_exponential(double value, uint8_t *out, int32_t out_cap);

/* Shortest round-tripping positional form for radices 2 through 36. */
int32_t mal_number_format_radix(double value, int32_t radix, uint8_t *out, int32_t out_cap);

/* Exact round-half-expand formatting for the explicit precision methods. */
int32_t mal_number_format_fixed(double value, int32_t fraction_digits, uint8_t *out, int32_t out_cap);
int32_t mal_number_format_exponential(double value, int32_t fraction_digits, uint8_t *out, int32_t out_cap);
int32_t mal_number_format_precision(double value, int32_t precision, uint8_t *out, int32_t out_cap);

#ifdef __cplusplus
}
#endif
