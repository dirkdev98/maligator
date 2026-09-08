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

/**
 * Abstract ToBigInt: coerce a primitive to a 128-bit BigInt value. Booleans,
 * BigInts, and valid BigInt strings convert; Number/Symbol/undefined/null throw
 * TypeError, and an invalid string throws SyntaxError. Returns false (with a
 * pending throw) on failure. Used by BigInt64Array/BigUint64Array element writes.
 */
bool mal_bigint_to_bigint(MalVm *vm, MalValue value, i128 *out);
