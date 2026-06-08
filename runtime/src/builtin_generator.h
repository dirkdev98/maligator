#pragma once

typedef struct MalVm MalVm;

/**
 * Install %GeneratorPrototype% (next, @@toStringTag "Generator") inheriting
 * %IteratorPrototype% (which supplies @@iterator -> this). Requires the
 * well-known symbols and the iterator prototype to be installed first.
 */
void mal_builtin_generator_install(MalVm *vm);
