#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the console namespace object with log / info / warn / error.
 */
void mal_builtin_console_install(MalVm *vm);

#if MAL_NODE
/** Define console.Console, whose instances write through their stream's write(string). */
void mal_builtin_console_install_class(MalVm *vm);
#endif
