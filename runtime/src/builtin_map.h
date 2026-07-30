#pragma once

#include "./defaults.h"
#include "vm.h"

typedef enum MalBuiltinCollectionDirectOp {
    MAL_BUILTIN_COLLECTION_MAP_GET,
    MAL_BUILTIN_COLLECTION_MAP_SET,
    MAL_BUILTIN_COLLECTION_SET_ADD,
} MalBuiltinCollectionDirectOp;

/**
 * Install the Map and WeakMap constructors and prototypes. Requires the
 * well-known symbols and iterator prototypes.
 */
void mal_builtin_map_install(MalVm *vm);

/**
 * Guarded native-backend dispatch for direct Map.get/Map.set/Set.add sites.
 * Exact intrinsic-callee and receiver-brand hits execute the collection body
 * without a native call frame; every miss retains ordinary cached dispatch.
 */
MalCompletion mal_builtin_collection_direct(
    MalVm *vm,
    MalCallCache *fallback_cache,
    MalBuiltinCollectionDirectOp operation,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);
