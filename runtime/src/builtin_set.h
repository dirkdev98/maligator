#pragma once

#include "./defaults.h"

typedef struct MalVm MalVm;

/**
 * Install the Set and WeakSet constructors and prototypes. Requires the
 * well-known symbols and iterator prototypes.
 */
void mal_builtin_set_install(MalVm *vm);
