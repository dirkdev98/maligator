#pragma once

#include "./defaults.h"
#include "object.h"

/**
 * Iteration source + result shape for a built-in iterator instance.
 */
typedef enum MalIteratorKind : u8 {
    MAL_ITERATOR_MAP_KEYS,
    MAL_ITERATOR_MAP_VALUES,
    MAL_ITERATOR_MAP_ENTRIES,
    MAL_ITERATOR_SET_VALUES,
    MAL_ITERATOR_SET_ENTRIES,
    MAL_ITERATOR_ARRAY_KEYS,
    MAL_ITERATOR_ARRAY_VALUES,
    MAL_ITERATOR_ARRAY_ENTRIES,
    MAL_ITERATOR_STRING_VALUES,
} MalIteratorKind;

/**
 * Built-in iterator instance produced by the Map/Set/Array/String iteration
 * methods. Map/Set iterators pin and walk the backing table's storage order,
 * so compaction is deferred while entries inserted during iteration must
 * remain visible and deleted entries must be skipped.
 */
typedef struct MalIteratorObject {
    MalObject object;
    MalObjectStorage object_storage;
    MalValue target;

    /**
     * Storage-order index for map/set sources, element index for arrays,
     * code-unit index for strings.
     */
    u64 index;

    union {
        /** Raw table kept alive by its pin if owner and iterator die together. */
        MalTable *pinned_table;
        /** Traced leaf identity; its payload is reacquired at every step. */
        MalString *string_leaf;
    };
    /** A string index plus bias gives the cached leaf's local code-unit index. */
    i32 string_leaf_bias;
    u32 string_leaf_end;
    MalIteratorKind kind;

    /**
     * Set once iteration reports done; stays done even if the source grows
     * afterwards.
     */
    bool done;
    /** Map/Set storage cannot be renumbered while this iterator is live. */
    bool table_pinned;
} MalIteratorObject;

static_assert(sizeof(MalIteratorObject) <= 80,
              "built-in iterator outgrew its cached-leaf layout");

/**
 * Initialize iterator object state in caller-provided storage.
 */
void mal_iterator_object_init(
    MalHeap *heap,
    MalIteratorObject *iterator,
    MalObject *prototype,
    MalIteratorKind kind,
    MalValue target
);

/**
 * Allocate and initialize a new built-in iterator instance.
 */
MalIteratorObject *mal_iterator_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalIteratorKind kind,
    MalValue target
);

/** Release a Map/Set table pin on exhaustion or GC finalization. */
void mal_iterator_object_release_table_pin(MalIteratorObject *iterator);
