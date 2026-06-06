#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Object constructor and install the Object builtins on the
 * constructor and %Object.prototype%.
 */
void mal_builtin_object_install(MalVm *vm);
