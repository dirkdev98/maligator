#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Install the ArrayBuffer and SharedArrayBuffer constructors and prototypes.
 */
void mal_builtin_array_buffer_install(MalVm *vm);
