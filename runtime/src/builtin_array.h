#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Array constructor and install the Array builtins on the
 * constructor and %Array.prototype%.
 */
void mal_builtin_array_install(MalVm *vm);
