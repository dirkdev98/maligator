#pragma once

#include "./defaults.h"
#include "object.h"

/**
 * Backing storage for Map/Set/WeakMap/WeakSet instances. The heap type
 * distinguishes map-shaped (key -> value) from set-shaped (key only) use;
 * the weak flag brands the Weak* variants on the shared layout.
 */
typedef struct MalMapObject {
    MalObject object;

    /**
     * General-mode ordered table. Entry keys are canonicalized through
     * mal_map_key_from_value; map values live in the inline entry payload.
     * Compaction is deferred while an iterator pins the table, so storage-order
     * indexes stay stable for every outstanding iterator.
     */
    MalTable *entries;

    bool weak;
} MalMapObject;

/**
 * Initialize map/set object state in caller-provided storage. type must be
 * MAL_HEAP_MAP_OBJECT or MAL_HEAP_SET_OBJECT.
 */
void mal_map_object_init(MalHeap *heap, MalMapObject *map, MalHeapType type, MalObject *prototype, bool weak);

/**
 * Allocate and initialize a new map/set object.
 */
MalMapObject *mal_map_object_new(MalHeap *heap, MalHeapType type, MalObject *prototype, bool weak);

/**
 * Build the canonical table key for a JS value under SameValueZero: int32-
 * boxed numbers fold into their f64 encoding, every zero (raw +/-0 and the
 * static -0) becomes raw +0, and NaNs collapse into the canonical NaN, so
 * the table's bit-pattern equality implements SameValueZero exactly. The
 * spec's set-key-to-+0 normalization for stored keys falls out for free.
 */
MalKey mal_map_key_from_value(MalValue value);

static inline MalKey mal_map_key_from_number(f64 number) {
    MalValue value = number == 0.0
        ? mal_value_from_f64(0.0)
        : mal_value_from_f64_convert_nan(number);
    return (MalKey) {.kind = MAL_KEY_NUMBER, .value = value};
}

/**
 * Insert or update an entry (Map.prototype.set / Set.prototype.add).
 */
void mal_map_object_set(MalMapObject *map, MalValue key, MalValue value);

/** Insert or update using a key already produced by mal_map_key_from_value. */
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
