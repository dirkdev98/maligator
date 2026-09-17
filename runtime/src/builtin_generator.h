#pragma once

#include "value.h"

typedef struct MalVm MalVm;

/**
 * Install %GeneratorPrototype% (next, @@toStringTag "Generator") inheriting
 * %IteratorPrototype% (which supplies @@iterator -> this). Requires the
 * well-known symbols and the iterator prototype to be installed first.
 */
void mal_builtin_generator_install(MalVm *vm);

/** Returns 1 after an exact step, 0 for generic fallback, and -1 on exception. */
int mal_generator_try_exact_iterator_step(
    MalVm *vm, MalValue iterator, MalValue next_method,
    MalValue *value_out, bool *done_out);
