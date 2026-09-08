#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Number constructor and install the Number builtins on the
 * constructor and %Number.prototype%, plus the global parseInt / parseFloat /
 * isNaN / isFinite functions.
 */
void mal_builtin_number_install(MalVm *vm);

/** Exact locked Number predicates after intrinsic-receiver proof. */
MalValue mal_builtin_number_is_nan_known(const MalValue *args, i32 arg_count);
MalValue mal_builtin_number_is_finite_known(const MalValue *args, i32 arg_count);
MalValue mal_builtin_number_is_integer_known(const MalValue *args, i32 arg_count);
MalValue mal_builtin_number_is_safe_integer_known(const MalValue *args, i32 arg_count);

/** Exact locked Number.prototype.valueOf after primitive-receiver proof. */
MalValue mal_builtin_number_value_of_known(MalValue this_value);

// Primitive receiver; radix 2..36, digits 0..100, precision 1..100; -1 means omitted for exponential/precision.
MalValue mal_builtin_number_to_string_numeric(MalVm *vm, f64 number, i32 radix);
MalValue mal_builtin_number_to_fixed_numeric(MalVm *vm, f64 number, i32 digits);
MalValue mal_builtin_number_to_exponential_numeric(MalVm *vm, f64 number, i32 digits);
MalValue mal_builtin_number_to_precision_numeric(MalVm *vm, f64 number, i32 precision);
