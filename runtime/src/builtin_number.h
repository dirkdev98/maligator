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
