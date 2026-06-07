#pragma once

#include "./defaults.h"

typedef struct MalVm MalVm;

/**
 * Install the Map and WeakMap constructors and prototypes. Requires the
 * well-known symbols and iterator prototypes.
 */
void mal_builtin_map_install(MalVm *vm);
