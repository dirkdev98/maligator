#pragma once

#include "./defaults.h"

typedef struct MalVm MalVm;

/**
 * Install the Symbol constructor, Symbol.prototype, and the well-known
 * symbol values. Must run before any install pass that defines well-known
 * symbol keyed properties (iterators, toStringTag wiring).
 */
void mal_builtin_symbol_install(MalVm *vm);
