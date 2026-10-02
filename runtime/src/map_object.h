#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalMapObject {
    MalObject object;
    MalObjectStorage object_storage;

    /**
     * General-mode ordered table. Entry keys are canonicalized through
     * mal_collection_key_from_value; map values live in the inline entry payload.
     * Compaction is deferred while an iterator pins the table, so storage-order
     * indexes stay stable for every outstanding iterator.
     */
    MalTable *entries;

    bool weak;
} MalMapObject;

/**
 * Initialize Map/WeakMap state in caller-provided storage.
 */
void mal_map_object_init(MalHeap *heap, MalMapObject *map, MalObject *prototype, bool weak);

/**
 * Allocate and initialize a new Map/WeakMap object.
 */
MalMapObject *mal_map_object_new(MalHeap *heap, MalObject *prototype, bool weak);

/** Canonicalize a key and attribute its runtime kind to this collection. */
MalKey mal_map_object_key_from_value(const MalMapObject *map, MalValue value);

/**
 * Insert or update a Map entry.
 */
void mal_map_object_set(MalMapObject *map, MalValue key, MalValue value);

/** Insert or update using a key already produced by mal_collection_key_from_value. */
void mal_map_object_set_canonical(MalMapObject *map, MalKey key, MalValue value);

/**
 * Check for an entry under SameValueZero.
 */
bool mal_map_object_has(const MalMapObject *map, MalValue key);

/** Check for an entry using an already-canonicalized key. */
bool mal_map_object_has_canonical(const MalMapObject *map, MalKey key);

/**
 * Read the value stored for key, or undefined when absent.
 */
MalValue mal_map_object_get(const MalMapObject *map, MalValue key);

/**
 * Delete the entry for key if present.
 */
bool mal_map_object_delete(MalMapObject *map, MalValue key);

/** Delete an entry using an already-canonicalized key. */
bool mal_map_object_delete_canonical(MalMapObject *map, MalKey key);

/**
 * Number of live entries.
 */
usize mal_map_object_size(const MalMapObject *map);

/**
 * Remove all entries, keeping outstanding iterators valid.
 */
void mal_map_object_clear(MalMapObject *map);

#if MAL_PERF_STATS
u8 mal_map_object_perf_key_mask(const MalMapObject *map);
#endif
