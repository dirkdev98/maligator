#pragma once

#include "object.h"

typedef struct MalMapStorage MalMapStorage;

typedef enum MalMapKeyDomain : u8 {
    MAL_MAP_KEYS_EMPTY,
    MAL_MAP_KEYS_INT32,
    MAL_MAP_KEYS_NUMBER,
    MAL_MAP_KEYS_STRING,
    MAL_MAP_KEYS_IDENTITY,
    MAL_MAP_KEYS_GENERIC,
} MalMapKeyDomain;

typedef struct MalMapObject {
    MalObject object;
    MalObjectStorage object_storage;
    MalMapStorage *entries;
} MalMapObject;

typedef struct MalMapIter {
    MalMapStorage *storage;
    usize index;
} MalMapIter;

void mal_map_object_init(MalHeap *heap, MalMapObject *map, MalObject *prototype);
MalMapObject *mal_map_object_new(MalHeap *heap, MalObject *prototype);
// All insertion/update APIs require mapped values other than the internal MAL_VALUE_EMPTY sentinel.
void mal_map_object_set(MalMapObject *map, MalValue key, MalValue value);
// Canonical inputs come from collection normalization or Map/Set iteration.
void mal_map_object_set_canonical(MalMapObject *map, MalValue key, MalValue value);
bool mal_map_object_has(const MalMapObject *map, MalValue key);
bool mal_map_object_has_canonical(const MalMapObject *map, MalValue key);
MalValue mal_map_object_get(const MalMapObject *map, MalValue key);
bool mal_map_object_delete(MalMapObject *map, MalValue key);
bool mal_map_object_delete_canonical(MalMapObject *map, MalValue key);
usize mal_map_object_size(const MalMapObject *map);
void mal_map_object_clear(MalMapObject *map);
void mal_map_object_compact(MalMapObject *map);

// One-based order handles survive growth/widening; pin across mutations that may compact. Zero is absent.
u32 mal_map_object_find_canonical(const MalMapObject *map, MalValue key);
// A newly inserted entry is live with an UNDEFINED value until updated.
u32 mal_map_object_upsert_canonical(MalMapObject *map, MalValue key, bool *inserted);
MalValue mal_map_storage_key(const MalMapStorage *storage, u32 entry);
MalValue mal_map_storage_value(const MalMapStorage *storage, u32 entry);
// A validated entry for an equal key may adopt a compact string representative.
void mal_map_object_update_entry(MalMapObject *map, u32 entry, MalValue key, MalValue value);
u32 mal_map_object_entry_hint(const MalMapObject *map, MalValue key);
void mal_map_object_remember_entry(MalMapObject *map, u32 entry);

// Empty/small storage realizes the hint on its first spill.
bool mal_map_object_reserve(MalMapObject *map, usize desired_size);
MalMapStorage *mal_map_object_storage(MalMapObject *map);
void mal_map_iter_init(MalMapIter *iter, MalMapStorage *storage);
bool mal_map_iter_next(MalMapIter *iter, MalValue *key, MalValue *value);
void mal_map_storage_pin(MalMapStorage *storage);
// Finalizers may only drop ownership; they must not read or rehash dead members.
void mal_map_storage_unpin(MalMapStorage *storage);
void mal_map_storage_release_owner(MalMapStorage *storage);
usize mal_map_storage_traced_slots(const MalMapStorage *storage);
MalMapKeyDomain mal_map_storage_key_domain(const MalMapStorage *storage);
usize mal_map_storage_order_length(const MalMapStorage *storage);
usize mal_map_storage_allocation_bytes(const MalMapStorage *storage);

#if MAL_PERF_STATS
u8 mal_map_object_perf_key_mask(const MalMapObject *map);
#endif
