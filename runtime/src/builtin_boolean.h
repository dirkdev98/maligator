#pragma once

#include "./defaults.h"
#include "intrinsics.h"
#include "value_ops.h"

/**
 * Create the Boolean constructor and install the Boolean builtins on
 * %Boolean.prototype%.
 */
void mal_builtin_boolean_install(MalVm *vm);

/** Exact locked Boolean.prototype.valueOf after primitive-receiver proof. */
MalValue mal_builtin_boolean_value_of_known(MalValue this_value);

typedef enum MalBooleanOperation {
    MAL_BOOLEAN_CALL,
    MAL_BOOLEAN_VALUE_OF,
    MAL_BOOLEAN_TO_STRING,
} MalBooleanOperation;

extern const MalNativeFunctionCallback mal_builtin_boolean_callbacks[3];

// Callback identity admits foreign builtins only where primitive results cannot expose their realm.
static inline bool mal_builtin_boolean_callee_matches(MalBooleanOperation operation, MalValue callee) {
    return (u32) operation < countof(mal_builtin_boolean_callbacks) &&
        mal_value_is_native_function_object(callee) &&
        mal_value_to_native_function_object(callee)->callback == mal_builtin_boolean_callbacks[operation];
}

// A false result performs no observable work; method fast paths require a primitive Boolean receiver.
bool mal_builtin_boolean_try_direct(
    MalVm *vm, MalBooleanOperation operation, MalValue callee, MalValue receiver,
    MalValue argument, MalValue *result);
