#pragma once

#include <math.h>
#include "./defaults.h"
#include "heap.h"
#include "heap_string.h"
#include "value.h"

MalString *mal_ops_to_string(MalHeap *heap, MalValue value);

f64 mal_ops_to_number(MalValue value);

/**
 * Whether the value is a JS Number (any of: int32, f64, NaN, -0, ±Infinity),
 * and the f64 recovery of a value already known to be one (precondition:
 * mal_ops_is_number). Both are written directly over the NaN-boxing layout
 * (see value.h) and kept `static inline` so the native-C backend's speculative
 * numeric guard lowers to a few bit tests in the hot loop instead of two
 * cross-TU calls. mal_ops_number_as_f64 matches mal_ops_to_number on Numbers.
 */
static inline bool mal_ops_is_number(MalValue value) {
    return ((value & MASK_EXPONENT_BITS) != MASK_EXPONENT_BITS) || // genuine f64 (incl ±0.0)
        ((value & MAL_VALUE_INT32) == MAL_VALUE_INT32) ||          // tagged int32
        value == MAL_VALUE_NAN ||
        value == MAL_VALUE_NEGATIVE_ZERO ||
        value == MAL_VALUE_POSITIVE_INFINITY ||
        value == MAL_VALUE_NEGATIVE_INFINITY;
}

static inline f64 mal_ops_number_as_f64(MalValue value) {
    if ((value & MASK_EXPONENT_BITS) != MASK_EXPONENT_BITS) {
        return *(f64 *) &value; // genuine double, incl ±0.0
    }
    if ((value & MAL_VALUE_INT32) == MAL_VALUE_INT32) {
        return (f64) (i32) (u32) (value & MASK_INT32); // tagged int32
    }
    if (value == MAL_VALUE_POSITIVE_INFINITY) {
        return INFINITY;
    }
    if (value == MAL_VALUE_NEGATIVE_INFINITY) {
        return -INFINITY;
    }
    if (value == MAL_VALUE_NEGATIVE_ZERO) {
        return -0.0;
    }
    return NAN; // MAL_VALUE_NAN
}

/**
 * Box a f64 as an int32 when integral and in range, else as f64/NaN.
 */
MalValue mal_ops_number_value(f64 value);

MalValue mal_ops_add(MalHeap *heap, MalValue left, MalValue right);

MalValue mal_ops_subtract(MalValue left, MalValue right);

MalValue mal_ops_multiply(MalValue left, MalValue right);

MalValue mal_ops_divide(MalValue left, MalValue right);

MalValue mal_ops_remainder(MalValue left, MalValue right);

MalValue mal_ops_exponentiate(MalValue left, MalValue right);

MalValue mal_ops_bit_and(MalValue left, MalValue right);

MalValue mal_ops_bit_or(MalValue left, MalValue right);

MalValue mal_ops_bit_xor(MalValue left, MalValue right);

MalValue mal_ops_shift_left(MalValue left, MalValue right);

MalValue mal_ops_shift_right(MalValue left, MalValue right);

MalValue mal_ops_shift_right_unsigned(MalValue left, MalValue right);

MalValue mal_ops_less_than(MalValue left, MalValue right);

MalValue mal_ops_less_equal(MalValue left, MalValue right);

MalValue mal_ops_greater_than(MalValue left, MalValue right);

MalValue mal_ops_greater_equal(MalValue left, MalValue right);

MalValue mal_ops_equal(MalValue left, MalValue right);

MalValue mal_ops_not_equal(MalValue left, MalValue right);

MalValue mal_ops_strict_equal(MalValue left, MalValue right);

MalValue mal_ops_strict_not_equal(MalValue left, MalValue right);
