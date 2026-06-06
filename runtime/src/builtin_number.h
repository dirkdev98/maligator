#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Number constructor and install the Number builtins on the
 * constructor and %Number.prototype%, plus the global parseInt / parseFloat /
 * isNaN / isFinite functions.
 */
void mal_builtin_number_install(MalVm *vm);
