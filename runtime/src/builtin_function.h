#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Function constructor and install the Function builtins on
 * %Function.prototype%.
 */
void mal_builtin_function_install(MalVm *vm);
