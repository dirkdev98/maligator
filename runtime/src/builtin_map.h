#pragma once

#include "./defaults.h"
#include "vm.h"

typedef enum MalBuiltinCollectionReceiverFact {
    MAL_BUILTIN_COLLECTION_RECEIVER_UNKNOWN,
    MAL_BUILTIN_COLLECTION_RECEIVER_EXACT_MAP,
    MAL_BUILTIN_COLLECTION_RECEIVER_EXACT_SET,
} MalBuiltinCollectionReceiverFact;

/**
 * Install the Map and WeakMap constructors and prototypes. Requires the
 * well-known symbols and iterator prototypes.
 */
void mal_builtin_map_install(MalVm *vm);

/** Exact locked Map.prototype.get after private-fresh receiver proof. */
MalValue mal_builtin_map_get_known(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

/** Exact locked Map.prototype.set after private-fresh receiver proof. */
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
    MalCallCache *fallback_cache,
    MalGuardedBuiltinCallOp operation,
    MalBuiltinCollectionReceiverFact receiver_fact,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);
