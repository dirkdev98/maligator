#pragma once

#include "./defaults.h"
#include "object.h"

/**
 * Iteration source + result shape for a built-in iterator instance.
 */
typedef enum MalIteratorKind {
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
 * methods. Map/Set iterators walk the backing table's storage order (stable
 * because map tables never compact), so entries inserted during iteration
 * are visited and deleted entries are skipped, matching spec semantics.
 */
typedef struct MalIteratorObject {
    MalObject object;
    MalIteratorKind kind;
    MalValue target;

    /**
     * Storage-order index for map/set sources, element index for arrays,
     * code-unit index for strings.
     */
    u64 index;

    /**
     * Set once iteration reports done; stays done even if the source grows
     * afterwards.
     */
    bool done;
} MalIteratorObject;

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
