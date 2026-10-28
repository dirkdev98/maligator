#pragma once

#include "./defaults.h"
#include "vm.h"

typedef enum MalBuiltinCollectionReceiverFact {
    MAL_BUILTIN_COLLECTION_RECEIVER_UNKNOWN,
    MAL_BUILTIN_COLLECTION_RECEIVER_EXACT_MAP,
    MAL_BUILTIN_COLLECTION_RECEIVER_EXACT_SET,
    MAL_BUILTIN_COLLECTION_RECEIVER_EXACT_WEAK_MAP,
    MAL_BUILTIN_COLLECTION_RECEIVER_EXACT_WEAK_SET,
} MalBuiltinCollectionReceiverFact;

/**
 * Install the Map and WeakMap constructors and prototypes. Requires the
 * well-known symbols and iterator prototypes.
 */
void mal_builtin_map_install(MalVm *vm);

MalValue mal_builtin_map_prototype_for_each(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
);

// Known entries require a genuine Map receiver and the captured builtin identity.
MalValue mal_builtin_map_get_known(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

MalValue mal_builtin_map_set_known(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

MalValue mal_builtin_map_has_known(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

MalValue mal_builtin_map_delete_known(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

/**
 * Guarded native-backend dispatch for direct Map/Set scalar-operation sites.
 * Exact intrinsic-callee and receiver-brand hits execute the collection body
 * without a native call frame; every miss retains ordinary cached dispatch.
 */
MalCompletion mal_builtin_collection_direct(
    MalVm *vm,
    MalGuardedBuiltinCallOp operation,
    MalBuiltinCollectionReceiverFact receiver_fact,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

// Fixed-arity native entries require an exact Map receiver.
MalValue mal_builtin_map_get_key(MalVm *vm, MalValue this_value, MalValue key);
MalValue mal_builtin_map_set_key_value(MalVm *vm, MalValue this_value, MalValue key, MalValue value);
bool mal_builtin_map_has_key(MalVm *vm, MalValue this_value, MalValue key);
bool mal_builtin_map_delete_key(MalVm *vm, MalValue this_value, MalValue key);
// Weak entries require a genuine WeakMap receiver; keys are never coerced.
MalValue mal_builtin_weak_map_get_key(MalValue receiver, MalValue key);
// Throwing entries require the captured builtin's realm to be current.
MalValue mal_builtin_weak_map_set_key_value(MalVm *vm, MalValue receiver, MalValue key, MalValue value);
// Holdable entries additionally require an Object or unregistered Symbol key.
MalValue mal_builtin_weak_map_set_holdable_key_value(MalValue receiver, MalValue key, MalValue value);
bool mal_builtin_weak_map_has_key(MalValue receiver, MalValue key);
bool mal_builtin_weak_map_delete_key(MalValue receiver, MalValue key);
// Number-key variants for keys the compiler already holds unboxed.
MalValue mal_builtin_map_get_number(MalVm *vm, MalValue this_value, f64 key);
MalValue mal_builtin_map_set_number(MalVm *vm, MalValue this_value, f64 key, MalValue value);
bool mal_builtin_map_has_number(MalVm *vm, MalValue this_value, f64 key);
bool mal_builtin_map_delete_number(MalVm *vm, MalValue this_value, f64 key);

// Exact Map receivers, with numeric entry admission and validation owned by Map storage.
MalValue mal_builtin_map_get_entry(MalVm *vm, MalValue receiver, MalValue key, u32 *entry_out);
MalValue mal_builtin_map_set_entry(MalVm *vm, MalValue receiver, MalValue key, MalValue value, u32 entry);
