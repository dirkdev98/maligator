#pragma once

#include "object.h"
#include "heap_symbol.h"

typedef struct MalWeakStorage MalWeakStorage;

typedef struct MalWeakMapObject {
    MalObject object;
    MalObjectStorage object_storage;
    MalWeakStorage *entries;
} MalWeakMapObject;

typedef struct MalWeakSetObject {
    MalObject object;
    MalObjectStorage object_storage;
    MalWeakStorage *entries;
} MalWeakSetObject;

typedef struct MalWeakMapIter {
    const MalWeakStorage *storage;
    usize index;
} MalWeakMapIter;

typedef struct MalWeakSetIter {
    const MalWeakStorage *storage;
    usize index;
} MalWeakSetIter;

static inline bool mal_weak_key_can_be_held(MalValue key) {
    return mal_value_is_object(key) ||
        (mal_value_is_symbol(key) && !mal_value_to_symbol(key)->registered);
}

MalWeakMapObject *mal_weak_map_object_new(MalHeap *heap, MalObject *prototype);
// Insertions require CanBeHeldWeakly; queries accept any value and report absence for invalid keys.
void mal_weak_map_object_set(MalWeakMapObject *map, MalValue key, MalValue value);
MalValue mal_weak_map_object_get(const MalWeakMapObject *map, MalValue key);
bool mal_weak_map_object_lookup(const MalWeakMapObject *map, MalValue key, MalValue *value);
bool mal_weak_map_object_has(const MalWeakMapObject *map, MalValue key);
bool mal_weak_map_object_delete(MalWeakMapObject *map, MalValue key);
MalValue mal_weak_map_object_get_or_insert(MalWeakMapObject *map, MalValue key, MalValue value);
usize mal_weak_map_object_size(const MalWeakMapObject *map);
bool mal_weak_map_object_reserve(MalWeakMapObject *map, usize desired_size);

MalWeakSetObject *mal_weak_set_object_new(MalHeap *heap, MalObject *prototype);
// The caller must reject keys that fail CanBeHeldWeakly before insertion.
void mal_weak_set_object_add(MalWeakSetObject *set, MalValue key);
bool mal_weak_set_object_has(const MalWeakSetObject *set, MalValue key);
bool mal_weak_set_object_delete(MalWeakSetObject *set, MalValue key);
usize mal_weak_set_object_size(const MalWeakSetObject *set);
bool mal_weak_set_object_reserve(MalWeakSetObject *set, usize desired_size);

// Collector cursors cannot span mutation or collection; weak buckets have no stable order.
void mal_weak_map_iter_init(MalWeakMapIter *iter, const MalWeakStorage *storage);
bool mal_weak_map_iter_next(MalWeakMapIter *iter, MalValue *key, MalValue *value);
void mal_weak_set_iter_init(MalWeakSetIter *iter, const MalWeakStorage *storage);
bool mal_weak_set_iter_next(MalWeakSetIter *iter, MalValue *key);
// Predicates must not allocate, collect, or mutate the store.
usize mal_weak_map_storage_retain(MalWeakStorage *storage, bool (*keep)(MalValue));
usize mal_weak_set_storage_retain(MalWeakStorage *storage, bool (*keep)(MalValue));
// Finalization only frees RAW allocations; member cells may already be reclaimed.
void mal_weak_storage_free(MalWeakStorage *storage);
usize mal_weak_storage_allocation_bytes(const MalWeakStorage *storage);
usize mal_weak_storage_capacity(const MalWeakStorage *storage);
usize mal_weak_storage_scan_slots(const MalWeakStorage *storage);

#if MAL_PERF_STATS
u8 mal_weak_map_object_perf_key_mask(const MalWeakMapObject *map);
u8 mal_weak_set_object_perf_key_mask(const MalWeakSetObject *set);
#endif
