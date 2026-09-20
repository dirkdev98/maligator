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
     * `elements == nullptr`, every index key in the table) the first time it needs
     * non-uniform element attributes, an accessor index, or a far-sparse write that
     * would waste memory as holes. Packed seal/freeze transitions stay dense because
     * writable/configurable are uniform across every present element. After deopt
     * the dense fields stay null/zero forever for that array.
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

    /**
     * Conservative hole summary for the dense region. False proves every slot in
     * [0, dense_count) is present; true may remain set after later hole filling.
     */
    bool dense_maybe_holey : 1;

    /** Uniform attributes synthesized for every present dense element. */
    bool dense_elements_writable : 1;
    bool dense_elements_configurable : 1;
} MalArrayObject;

static_assert(sizeof(MalArrayObject) <= 64, "MalArrayObject outgrew its 64-byte size class");

/** Whether the array uses the dense element fast path (vs. legacy table storage). */
bool mal_array_object_is_dense(const MalArrayObject *array);

/**
 * Read a dense element. Returns true and writes *out when `index` is in the dense
 * region and not a hole; false otherwise (caller falls back to the table / proto).
 */
bool mal_array_object_dense_get(const MalArrayObject *array, u32 index, MalValue *out);

/** Exact numeric [[Get]] for a compiler-proven private dense Array. Its complete
 * lifetime permits only dense push/pop, length, and numeric reads, while locked
 * primordials prove an invalid or out-of-bounds Number key resolves to undefined. */
static inline MalValue mal_array_object_contained_dense_get(
    const MalArrayObject *array, f64 index
) {
    if (index >= 0 && index < (f64) array->length) {
        u32 integer = (u32) index;
        if ((f64) integer == index) {
            return array->elements[integer];
        }
    }
    return MAL_VALUE_UNDEFINED;
}

/** Read the two own data elements of a dense entry pair atomically. */
bool mal_array_object_dense_pair(
    const MalArrayObject *array, MalValue *first_out, MalValue *second_out);

/** Whether `index` is a present (non-hole) own element in the dense region. */
bool mal_array_object_dense_has(const MalArrayObject *array, u32 index);

/** Descriptor flags shared by every present dense element. */
static inline MalPropertyFlags mal_array_object_dense_element_flags(
    const MalArrayObject *array
) {
    MalPropertyFlags flags = MAL_PROPERTY_ENUMERABLE;
    if (array->dense_elements_writable) flags |= MAL_PROPERTY_WRITABLE;
    if (array->dense_elements_configurable) flags |= MAL_PROPERTY_CONFIGURABLE;
    return flags;
}

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

/**
 * Reserve exactly `needed` slots on a pristine private Array without publishing
 * any elements or changing length. Returns false if the array is no longer fresh.
 */
bool mal_array_object_fresh_dense_reserve_exact(MalArrayObject *array, u32 needed);

/**
 * Fallible exact reserve for a pristine private Array. Unlike the ordinary
 * reserve helper, allocation failure returns false without aborting or changing
 * the Array, so it is suitable for semantically invisible speculative state.
 */
bool mal_array_object_try_fresh_dense_reserve_exact(
    MalArrayObject *array, u32 needed);

/**
 * Append a default-data element to an intrinsic ordinary Array that has remained
 * private to its native builder since creation. This is CreateDataProperty-style:
 * it does not resolve inherited indexed properties. Capacity grows geometrically.
 * Returns false without changing the array if the fresh/contiguous contract no
 * longer holds or the dense vector cannot grow.
 */
bool mal_array_object_fresh_dense_append(MalArrayObject *array, MalValue value);

/** Append after an exact reserve proved the fresh dense capacity. */
void mal_array_object_fresh_dense_append_reserved(
    MalArrayObject *array, MalValue value);

/**
 * Atomically append `count` values to a contiguous ordinary dense Array. This
 * reserves all storage before publishing any element, then applies the required
 * GC barriers. The caller is responsible for proving that inherited indexed
 * properties cannot intercept the writes. Returns false without changing the
 * array when its dense/extensible/length state is ineligible or storage cannot grow.
 */
bool mal_array_object_dense_append_many(
    MalArrayObject *array, const MalValue *values, u32 count
);

/**
 * Dense operations for an Array whose whole lifetime is compiler-contained.
 * The compiler proves the ordinary, extensible, writable, contiguous invariants;
 * these helpers assert that contract and omit the corresponding dynamic guards.
 * Push returns false only at the uint32 Array-length boundary. Pop reports
 * whether an element was present and applies the SATB deletion barrier.
 */
bool mal_array_object_contained_dense_push(
    MalArrayObject *array, const MalValue *values, u32 count
);
bool mal_array_object_contained_dense_pop(
    MalArrayObject *array, MalValue *value_out
);

/**
 * Append values into the unpublished tail of a native-built dense Array. Unlike
 * dense_append_many, the Array may already have its final length (the usual
 * ArraySpeciesCreate/copy-by-change shape); `start` must equal dense_count. The
 * helper reserves before publishing, applies card barriers, and grows length
 * only when the builder started from length zero.
 */
bool mal_array_object_dense_build_values(
    MalArrayObject *array, u32 start, const MalValue *values, u32 count
);

/** Append `count` copies of one value into an unpublished dense tail. */
bool mal_array_object_dense_build_fill(
    MalArrayObject *array, u32 start, u32 count, MalValue value
);

/**
 * Append a source Array range into the unpublished tail of a native-built dense
 * result. Source holes are either preserved or materialized as undefined, and
 * the range can be read in reverse order. The source and destination must be
 * distinct and no observable operation may run while the raw range is copied.
 */
bool mal_array_object_dense_build_range(
    MalArrayObject *array, u32 start,
    const MalArrayObject *source, u32 source_start, u32 count,
    bool reverse, bool holes_as_undefined
);

/**
 * Leaf bulk kernels over a fully materialized dense region. Callers must prove
 * that ordinary indexed property operations cannot invoke user code and that
 * any required extensibility checks have already passed. These helpers apply
 * the SATB/card barriers required by raw vector movement.
 */
void mal_array_object_dense_shift(MalArrayObject *array);
bool mal_array_object_dense_unshift_many(
    MalArrayObject *array, const MalValue *values, u32 count
);
void mal_array_object_dense_reverse(MalArrayObject *array);
void mal_array_object_dense_fill(
    MalArrayObject *array, u32 start, u32 end, MalValue value
);
void mal_array_object_dense_copy_within(
    MalArrayObject *array, u32 target, u32 start, u32 count
);
bool mal_array_object_dense_splice(
    MalArrayObject *array, u32 start, u32 delete_count,
    const MalValue *values, u32 insert_count
);

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
MalArrayObject *mal_array_object_try_new(MalHeap *heap, MalObject *prototype);

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
 * CreateDataProperty populator with JS array semantics: an index defines an own
 * element (ignoring the prototype chain) and grows the length field; a "length"
 * key updates the length field. Use for internal result arrays (CreateArrayFromList,
 * Object.keys, spread, ...), where a poisoned inherited index must not intercept.
 */
bool mal_array_object_store(MalArrayObject *array, MalKey key, MalValue value);

/**
 * [[Set]] variant of mal_array_object_store: an index write is an OrdinarySet
 * that honors the prototype chain (an inherited non-writable/accessor index
 * rejects it) and grows the length field. Use for spec Set on a user array.
 */
bool mal_array_object_set(MalArrayObject *array, MalKey key, MalValue value);

#if MAL_PERF_STATS
u8 mal_array_object_perf_element_mask(const MalArrayObject *array);
#endif
