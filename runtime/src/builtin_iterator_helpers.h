#pragma once

#include "./defaults.h"
#include "object.h"
#include "value.h"

typedef struct MalVm MalVm;

/**
 * Which lazy transform an Iterator Helper applies (or WRAP for Iterator.from).
 */
typedef enum MalIteratorHelperKind {
    MAL_ITERATOR_HELPER_MAP,
    MAL_ITERATOR_HELPER_FILTER,
    MAL_ITERATOR_HELPER_TAKE,
    MAL_ITERATOR_HELPER_DROP,
    MAL_ITERATOR_HELPER_FLATMAP,
    MAL_ITERATOR_HELPER_WRAP,
} MalIteratorHelperKind;

/**
 * An Iterator Helper instance: holds the lazy transform state so next/return
 * live (shared) on %IteratorHelperPrototype% rather than as own closures.
 */
typedef struct MalIteratorHelperObject {
    MalObject object;
    MalIteratorHelperKind kind;

    // Underlying iterator record.
    MalValue iterator;
    MalValue next_method;

    // map/filter/flatMap predicate (undefined for take/drop/wrap).
    MalValue callback;
    // take/drop remaining count.
    f64 counter;
    bool done;
    i32 index;

    // flatMap: the inner iterator currently being drained.
    MalValue inner_iterator;
    MalValue inner_next;
} MalIteratorHelperObject;

/**
 * Install the Iterator Helpers surface: the %Iterator% global (abstract
 * constructor) + Iterator.from, the %IteratorPrototype% accessors (constructor,
 * @@toStringTag) and helper methods (map/filter/take/drop/flatMap +
 * reduce/toArray/forEach/some/every/find), and %IteratorHelperPrototype%
 * (carrying the shared next/return). Requires %IteratorPrototype%.
 */
void mal_builtin_iterator_helpers_install(MalVm *vm);
