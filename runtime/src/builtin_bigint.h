#pragma once

#include "./defaults.h"
#include "intrinsics.h"

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
