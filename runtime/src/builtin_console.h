#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the console namespace object with log / info / warn / error.
 */
void mal_builtin_console_install(MalVm *vm);
