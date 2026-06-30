#pragma once

#include "vm.h"

/**
 * The `Atomics` namespace object. Single-threaded, so each operation is an
 * ordinary read-modify-write on the backing integer TypedArray; the methods
 * exist for spec surface + correctness (return values, coercion ordering,
 * error types). wait/notify/waitAsync are intentionally absent (they require
 * real agent blocking).
 */
void mal_builtin_atomics_install(MalVm *vm);
