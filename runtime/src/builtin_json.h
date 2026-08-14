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

typedef struct MalJsonProjectionCapture {
    i32 owner_function_index;
    i32 index;
} MalJsonProjectionCapture;

typedef enum MalInvariantJsonMapTemplateState {
    MAL_INVARIANT_JSON_MAP_EMPTY = 0,
    MAL_INVARIANT_JSON_MAP_FILLED = 1,
    MAL_INVARIANT_JSON_MAP_DISABLED = 2,
} MalInvariantJsonMapTemplateState;

/**
 * Activation-local linked parse/map final-row template. `roots` is caller-owned:
 * [private final array, text, exact callback, exact parse callee,
 * capture snapshots...].
 */
typedef struct MalInvariantJsonMapTemplate {
    MalValue *roots;
    u64 watched_methods_epoch;
    u64 array_elements_epoch;
    u32 row_count;
    u32 slot_count;
    MalShape *row_shape;
    u32 source_container_count;
    u32 property_loads_per_map;
    u32 exclusion_checks_per_map;
#if MAL_REALMS
    MalRealm *realm;
#endif
    MalInvariantJsonMapTemplateState state;
#if MAL_PERF_STATS
    bool test_fill_failure_consumed;
#endif
} MalInvariantJsonMapTemplate;

bool mal_builtin_json_map_template_try_clone(
    MalVm *vm, MalInvariantJsonMapTemplate *cache,
    MalValue parse_callee, MalValue json_this, MalValue text,
    MalValue callback, i32 target_function_index,
    const MalJsonProjectionCapture *captures, u32 capture_count,
    MalValue *out);
bool mal_builtin_json_map_template_fill(
    MalVm *vm, MalInvariantJsonMapTemplate *cache,
    MalValue parse_callee, MalValue json_this, MalValue text,
    MalValue map_callee, MalValue parsed, MalValue callback,
    i32 target_function_index,
    const MalJsonProjectionCapture *captures, u32 capture_count,
    MalValue mapped, const MalValue *primitive_row_keys,
    u32 primitive_row_key_count, MalValue nested_base_key,
    MalValue nested_value_key, const MalValue *excluded_keys,
    u32 excluded_key_count, u32 row_property_loads);
