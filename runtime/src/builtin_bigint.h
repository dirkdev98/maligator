#pragma once

#include "./defaults.h"
#include "language_components.h"

MalValue mal_builtin_bigint_width_number(MalVm *vm, f64 bits, MalValue input, bool is_signed);
// The caller proves radix is an integer in [2, 36]; receiver branding remains dynamic.
MalValue mal_builtin_bigint_to_string_radix(MalVm *vm, MalValue receiver, i32 radix);

/**
 * Install the BigInt constructor function and BigInt.prototype.
 */
void mal_builtin_bigint_install(MalVm *vm);

/** ToBigInt preserves the full primitive. Hold its result in a GC root before
 * another coercion or allocation; syntax and type failures set a pending throw. */
bool mal_bigint_to_bigint(MalVm *vm, MalValue value, MalBigInt **out);

typedef struct MalBigIntOperations {
    typeof(&mal_bigint_new) create;
    typeof(&mal_bigint_from_digits) from_digits;
    typeof(&mal_bigint_parse) parse;
    typeof(&mal_bigint_to_bigint) coerce;
    typeof(&mal_bigint_to_string) to_string;
    typeof(&mal_bigint_to_number) to_number;
    typeof(&mal_bigint_compare_number) compare_number;
    MalValue (*binary)(MalVm *vm, MalBinaryOp op, MalValue left, MalValue right);
    MalValue (*unary)(MalVm *vm, MalUnaryOp op, MalValue value);
} MalBigIntOperations;

static inline const MalBigIntOperations *mal_bigint_operations(void) {
    return mal_language_components[MAL_LANGUAGE_COMPONENT_BIGINT]->operations;
}
