#pragma once

#include "./defaults.h"
#include "intrinsics.h"

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
