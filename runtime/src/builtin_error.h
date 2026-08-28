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

/** Create the intrinsic SuppressedError used while folding disposal failures. */
MalValue mal_builtin_new_suppressed_error(
    MalVm *vm, MalValue error, MalValue suppressed);

/**
 * True if `value` is an object carrying the [[ErrorData]] marker. Backs
 * Error.isError and Object.prototype.toString's "[object Error]" tag.
 */
bool mal_builtin_value_has_error_data(MalVm *vm, MalValue value);

/** Release a private captured-stack slot owned by a dying ordinary object. */
void mal_builtin_error_finalize_object(MalVm *vm, MalObject *object);
