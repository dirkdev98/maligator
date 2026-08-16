#pragma once

#include "vm.h"

/** Finalize and protect the ECMAScript primordial graph for the current Realm. */
void mal_primordials_lock(MalVm *vm);

/** Throw the authoritative locked-world mutation error. */
void mal_primordials_throw_mutation(MalVm *vm, const byte *operation);

/** Throw a mutation error which names a string or index property when known. */
void mal_primordials_throw_property_mutation(
    MalVm *vm, const byte *operation, MalKey key
);
