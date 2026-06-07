#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Object constructor and install the Object builtins on the
 * constructor and %Object.prototype%.
 */
void mal_builtin_object_install(MalVm *vm);

/**
 * Object.prototype.toString: the "[object Tag]" fallback, also used by
 * builtins that delegate to it for non-array receivers.
 */
MalValue mal_builtin_object_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target);
