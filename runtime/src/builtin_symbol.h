#pragma once

#include "./defaults.h"
#include "value.h"

typedef struct MalVm MalVm;

/** SymbolDescriptiveString for a Symbol primitive; throws only when out of memory. */
MalValue mal_builtin_symbol_descriptive_string(MalVm *vm, MalValue symbol_value);

/**
 * Install the Symbol constructor, Symbol.prototype, and the well-known
 * symbol values. Must run before any install pass that defines well-known
 * symbol keyed properties (iterators, toStringTag wiring).
 */
void mal_builtin_symbol_install(MalVm *vm);
