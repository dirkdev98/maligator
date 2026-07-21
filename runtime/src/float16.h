#pragma once

#include "defaults.h"

// NumberToRawBytes uses one implementation-defined NaN encoding. Keep it
// stable so DataView stores are deterministic across hosts.
#define MAL_FLOAT16_CANONICAL_NAN_BITS ((u16) 0x7E00)

/** Convert binary64 to IEEE-754 binary16 bits, rounding to nearest, ties even. */
u16 mal_float16_f64_to_bits(f64 value);

/** Convert IEEE-754 binary16 bits to an exactly representable binary64 value. */
f64 mal_float16_bits_to_f64(u16 bits);
