#pragma once

#include "./defaults.h"
#include "intrinsics.h"
#include "value_ops.h"

// Requires primitive strings; roots their backing storage through flattening.
f64 mal_builtin_parse_int_string(MalValue source, f64 radix);
f64 mal_builtin_parse_float_string(MalValue source);

/**
 * Create the Number constructor and install the Number builtins on the
 * constructor and %Number.prototype%, plus the global parseInt / parseFloat /
 * isNaN / isFinite functions.
 */
void mal_builtin_number_install(MalVm *vm);

static inline bool mal_builtin_number_value_is_nan(MalValue value) {
    return mal_value_is_nan(value) || (mal_value_is_f64(value) && isnan(mal_value_to_f64(value)));
}

static inline bool mal_builtin_number_value_is_finite(MalValue value) {
    if (mal_value_is_int32(value) || value == MAL_VALUE_NEGATIVE_ZERO) {
        return true;
    }

    return mal_value_is_f64(value) && isfinite(mal_value_to_f64(value));
}

static inline bool mal_builtin_number_value_is_integer(MalValue value) {
    if (mal_value_is_int32(value) || value == MAL_VALUE_NEGATIVE_ZERO) {
        return true;
    }

    if (!mal_value_is_f64(value)) {
        return false;
    }

    f64 number = mal_value_to_f64(value);
    return isfinite(number) && trunc(number) == number;
}

static inline bool mal_builtin_number_value_is_safe_integer(MalValue value) {
    return mal_builtin_number_value_is_integer(value) &&
        fabs(mal_ops_number_as_f64(value)) <= MAL_NUMBER_MAX_SAFE_INTEGER;
}

MalValue mal_builtin_number_is_nan_known(const MalValue *args, i32 arg_count);
MalValue mal_builtin_number_is_finite_known(const MalValue *args, i32 arg_count);
MalValue mal_builtin_number_is_integer_known(const MalValue *args, i32 arg_count);
MalValue mal_builtin_number_is_safe_integer_known(const MalValue *args, i32 arg_count);

typedef enum MalNumberPredicate {
    MAL_NUMBER_PREDICATE_IS_NAN,
    MAL_NUMBER_PREDICATE_IS_FINITE,
    MAL_NUMBER_PREDICATE_IS_INTEGER,
    MAL_NUMBER_PREDICATE_IS_SAFE_INTEGER,
} MalNumberPredicate;

extern const MalNativeFunctionCallback mal_builtin_number_predicate_callbacks[4];

// These noncoercing Boolean predicates cannot allocate, throw, or observe their realm.
static inline bool mal_builtin_number_predicate_callee_matches(MalNumberPredicate predicate, MalValue callee) {
    return (u32) predicate < countof(mal_builtin_number_predicate_callbacks) &&
        mal_value_is_native_function_object(callee) &&
        mal_value_to_native_function_object(callee)->callback == mal_builtin_number_predicate_callbacks[predicate];
}
bool mal_builtin_number_predicate_try_direct(
    MalNumberPredicate predicate, MalValue callee, MalValue argument, MalValue *result);

/** Exact locked Number.prototype.valueOf after primitive-receiver proof. */
MalValue mal_builtin_number_value_of_known(MalValue this_value);

// Primitive receiver; radix 2..36, digits 0..100, precision 1..100; -1 means omitted for exponential/precision.
MalValue mal_builtin_number_to_string_numeric(MalVm *vm, f64 number, i32 radix);
MalValue mal_builtin_number_to_fixed_numeric(MalVm *vm, f64 number, i32 digits);
MalValue mal_builtin_number_to_exponential_numeric(MalVm *vm, f64 number, i32 digits);
MalValue mal_builtin_number_to_precision_numeric(MalVm *vm, f64 number, i32 precision);

typedef enum MalNumberFormatMethod {
    MAL_NUMBER_FORMAT_FIXED,
    MAL_NUMBER_FORMAT_EXPONENTIAL,
    MAL_NUMBER_FORMAT_PRECISION,
} MalNumberFormatMethod;

// Direct formatting must retain the callee's realm for exceptions and allocation.
bool mal_builtin_number_format_callee_matches(
    MalVm *vm, MalNumberFormatMethod method, MalValue callee);

// A false result performs no coercion, allocation, or observable work.
bool mal_builtin_number_format_try_direct(
    MalVm *vm, MalNumberFormatMethod method, MalValue callee,
    MalValue receiver, MalValue option, MalValue *result);
