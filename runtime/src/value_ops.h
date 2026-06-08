#pragma once

#include "./defaults.h"
#include "heap.h"
#include "heap_string.h"
#include "value.h"

MalString *mal_ops_to_string(MalHeap *heap, MalValue value);

f64 mal_ops_to_number(MalValue value);

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
