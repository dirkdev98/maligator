#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Install the ArrayBuffer and SharedArrayBuffer constructors and prototypes.
 */
void mal_builtin_array_buffer_install(MalVm *vm);

bool mal_builtin_array_buffer_is_byte_length_getter(MalValue getter);
