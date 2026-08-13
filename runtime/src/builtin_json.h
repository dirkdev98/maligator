#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/** Create the JSON namespace object with stringify and parse. */
void mal_builtin_json_install(MalVm *vm);

/** Parse text with the intrinsic JSON parser, without observing JSON.parse mutations. */
MalValue mal_builtin_json_parse_intrinsic(MalVm *vm, MalValue text);

/**
 * Activation-local exact no-reviver parse template. `roots` points at two
 * caller-owned GC slots: [template, text]. Realm/epoch state is non-owning.
 */
typedef struct MalInvariantJsonParseCache {
    MalValue *roots;
#if MAL_REALMS
    MalRealm *realm;
#endif
    bool filled;
} MalInvariantJsonParseCache;

bool mal_builtin_json_parse_cache_try_clone(
    MalVm *vm, MalInvariantJsonParseCache *cache, MalValue callee,
    MalValue this_value, MalValue text, MalValue *out);
bool mal_builtin_json_parse_cache_fill(
    MalVm *vm, MalInvariantJsonParseCache *cache, MalValue callee,
    MalValue this_value, MalValue text, MalValue parsed);
