#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Error constructor hierarchy (Error, TypeError, RangeError,
 * ReferenceError, SyntaxError, AggregateError) and install the Error builtins.
 */
void mal_builtin_error_install(MalVm *vm);

/**
 * Construct an AggregateError whose `errors` own property is the given array,
 * with no message. For Promise.any's rejection. Returns the error value.
 */
MalValue mal_builtin_new_aggregate_error(MalVm *vm, MalValue errors);
