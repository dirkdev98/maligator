#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Boolean constructor and install the Boolean builtins on
 * %Boolean.prototype%.
 */
void mal_builtin_boolean_install(MalVm *vm);
