#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Function constructor and install the Function builtins on
 * %Function.prototype%.
 */
void mal_builtin_function_install(MalVm *vm);

MalValue mal_builtin_function_prototype_apply(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee);
