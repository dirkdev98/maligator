#pragma once

#include "object.h"

typedef struct MalSetStorage MalSetStorage;

typedef enum MalSetKeyDomain : u8 {
    MAL_SET_KEYS_EMPTY,
    MAL_SET_KEYS_INT32,
    MAL_SET_KEYS_NUMBER,
    MAL_SET_KEYS_STRING,
    MAL_SET_KEYS_IDENTITY,
    MAL_SET_KEYS_GENERIC,
} MalSetKeyDomain;

typedef struct MalSetObject {
    MalObject object;
    MalObjectStorage object_storage;
    MalSetStorage *entries;
    bool weak;
} MalSetObject;

typedef struct MalSetIter {
    MalSetStorage *storage;
    usize index;
} MalSetIter;

MalSetObject *mal_set_object_new(MalHeap *heap, MalObject *prototype, bool weak);
void mal_set_object_add(MalSetObject *set, MalValue value);
// Canonical inputs must come from collection normalization or Set iteration.
void mal_set_object_add_canonical(MalSetObject *set, MalValue key);
bool mal_set_object_has(const MalSetObject *set, MalValue value);
bool mal_set_object_has_canonical(const MalSetObject *set, MalValue key);
bool mal_set_object_delete(MalSetObject *set, MalValue value);
bool mal_set_object_delete_canonical(MalSetObject *set, MalValue key);
usize mal_set_object_size(const MalSetObject *set);
void mal_set_object_clear(MalSetObject *set);
void mal_set_object_compact(MalSetObject *set);

// Empty/small storage realizes this capacity hint when it first needs a hash index.
bool mal_set_object_reserve(MalSetObject *set, usize size);
MalSetStorage *mal_set_object_storage(MalSetObject *set);

void mal_set_iter_init(MalSetIter *iter, MalSetStorage *storage);
bool mal_set_iter_next(MalSetIter *iter, MalValue *key);
void mal_set_storage_pin(MalSetStorage *storage);
// Finalizers may only drop ownership; they must not read or rehash dead members.
void mal_set_storage_unpin(MalSetStorage *storage);
void mal_set_storage_release_owner(MalSetStorage *storage);
// The predicate must not allocate, collect, or mutate the store.
usize mal_set_storage_retain(MalSetStorage *storage, bool (*keep)(MalValue));
usize mal_set_storage_traced_slots(const MalSetStorage *storage);
MalSetKeyDomain mal_set_storage_key_domain(const MalSetStorage *storage);
usize mal_set_storage_order_length(const MalSetStorage *storage);
usize mal_set_storage_allocation_bytes(const MalSetStorage *storage);

#if MAL_PERF_STATS
u8 mal_set_object_perf_key_mask(const MalSetObject *set);
#endif
