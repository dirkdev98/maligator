#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Install %TypedArray% / %TypedArray%.prototype and the eleven concrete
 * TypedArray constructors and prototypes.
 */
void mal_builtin_typed_array_install(MalVm *vm);
