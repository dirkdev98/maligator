#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Math namespace object and install its functions and constants.
 */
void mal_builtin_math_install(MalVm *vm);
