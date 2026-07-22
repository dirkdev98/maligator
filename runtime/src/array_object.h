#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalArrayObject {
    MalObject object;

    /**
     * Dense element fast path. In dense mode (`elements != nullptr`), integer-index
     * elements at [0, dense_count) live directly in `elements` (MAL_VALUE_ARRAY_HOLE
     * marks an absent slot) and NO integer-index keys live in the property table —
     * so reads/writes of in-range indices are O(1) instead of a hash lookup. The
     * remaining (string/symbol) keys still live in the object's shape/overflow.
     *
     * An array deoptimizes back to pure table storage (the legacy representation:
     * `elements == nullptr`, every index key in the table) the first time it needs a
     * per-element attribute the vector cannot express: a non-default-data define, an
     * accessor index, or a far-sparse write that would waste memory as holes. After
     * deopt the dense fields stay null/zero forever for that array.
     */
    MalValue *elements;
    u32 length;
    u32 capacity;    // allocated slots in `elements`
    u32 dense_count; // number of leading slots that are part of the dense region

    /**
     * length is writable by default; Object.defineProperty(arr, "length",
     * { writable: false }) clears this, after which length-changing stores
     * are rejected.
     */
    bool length_writable : 1;

    /**
     * Set once an array has deoptimized to table storage; it then stays table-mode
     * forever (never re-densifies). Distinguishes a deopted array (elements == null,
     * must use the table) from a fresh/lazy one (elements == null, still eligible —
     * the first contiguous index store creates the vector).
     */
    bool dense_deopted : 1;
} MalArrayObject;

static_assert(sizeof(MalArrayObject) <= 64, "MalArrayObject outgrew its 64-byte size class");

/** Whether the array uses the dense element fast path (vs. legacy table storage). */
bool mal_array_object_is_dense(const MalArrayObject *array);

/**
 * Read a dense element. Returns true and writes *out when `index` is in the dense
 * region and not a hole; false otherwise (caller falls back to the table / proto).
 */
bool mal_array_object_dense_get(const MalArrayObject *array, u32 index, MalValue *out);

/** Whether `index` is a present (non-hole) own element in the dense region. */
bool mal_array_object_dense_has(const MalArrayObject *array, u32 index);

/**
 * Reserve dense element capacity without creating properties or changing length.
 * Intended for audited native builders that know how many indices they will fill.
 */
bool mal_array_object_dense_reserve(MalArrayObject *array, u32 needed);

/**
 * Reserve exactly the requested dense capacity instead of growing geometrically.
 * Intended for fresh arrays whose final dense length is known in advance.
 */
bool mal_array_object_dense_reserve_exact(MalArrayObject *array, u32 needed);

/** Result of attempting a dense default-data store. */
typedef enum MalArrayDenseStore {
    MAL_ARRAY_DENSE_APPLIED,     // stored in the vector (length already updated)
    MAL_ARRAY_DENSE_NEEDS_TABLE, // too sparse for the vector; caller deopts + tables
} MalArrayDenseStore;

/**
 * Try to store a default-data `value` at integer `index` in the dense vector of an
 * already-dense array, growing it (filling any gap with holes) and bumping length as
 * needed. Returns MAL_ARRAY_DENSE_APPLIED on success. Returns
 * MAL_ARRAY_DENSE_NEEDS_TABLE (leaving the array unchanged, still dense) when `index`
 * is too far past the dense region to store without wasting memory — the caller then
 * deoptimizes the array and stores via the table. Caller must have checked dense mode
 * and that the descriptor is default-data.
 */
MalArrayDenseStore mal_array_object_dense_store(MalArrayObject *array, u32 index, MalValue value);

/** Delete a dense element (mark it a hole). No-op if `index` is out of the region. */
void mal_array_object_dense_delete(MalArrayObject *array, u32 index);

/**
 * Initialize array object state in caller-provided storage.
 */
void mal_array_object_init(MalHeap *heap, MalArrayObject *array, MalObject *prototype);

/**
 * Allocate and initialize a new array object.
 */
MalArrayObject *mal_array_object_new(MalHeap *heap, MalObject *prototype);

/**
 * Return the raw array length field.
 */
u32 mal_array_object_length(const MalArrayObject *array);

/**
 * Update the raw array length field.
 */
void mal_array_object_set_length(MalArrayObject *array, u32 length);

/**
 * Check if the key is the "length" string key.
 */
bool mal_array_key_is_length(MalKey key);

/**
 * Store with JS array semantics: index stores grow the length field, "length"
 * stores update the length field instead of defining a property.
 */
bool mal_array_object_store(MalArrayObject *array, MalKey key, MalValue value);
