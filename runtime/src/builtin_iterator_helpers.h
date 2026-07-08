#pragma once

#include "./defaults.h"
#include "object.h"
#include "value.h"

typedef struct MalVm MalVm;

/**
 * Which lazy transform an Iterator Helper applies (or WRAP for Iterator.from).
 */
typedef enum MalIteratorHelperKind : u8 {
    MAL_ITERATOR_HELPER_MAP,
    MAL_ITERATOR_HELPER_FILTER,
    MAL_ITERATOR_HELPER_TAKE,
    MAL_ITERATOR_HELPER_DROP,
    MAL_ITERATOR_HELPER_FLATMAP,
    MAL_ITERATOR_HELPER_WRAP,
    MAL_ITERATOR_HELPER_CONCAT,
    MAL_ITERATOR_HELPER_ZIP,
} MalIteratorHelperKind;

/** Iterator.zip / Iterator.zipKeyed iteration mode. */
typedef enum MalIteratorZipMode : u8 {
    MAL_ITERATOR_ZIP_SHORTEST,
    MAL_ITERATOR_ZIP_LONGEST,
    MAL_ITERATOR_ZIP_STRICT,
} MalIteratorZipMode;

/**
 * An Iterator Helper instance: holds the lazy transform state so next/return
 * live (shared) on %IteratorHelperPrototype% rather than as own closures.
 */
typedef struct MalIteratorHelperObject {
    MalObject object;

    // Underlying iterator record.
    MalValue iterator;
    MalValue next_method;

    // map/filter/flatMap predicate (undefined for take/drop/wrap).
    MalValue callback;
    // take/drop remaining count.
    f64 counter;

    // flatMap: the inner iterator currently being drained.
    // concat: the currently-open source iterator.
    MalValue inner_iterator;
    MalValue inner_next;

    // concat: array of source iterables and their captured @@iterator methods.
    // `index` doubles as the cursor into these arrays.
    // zip: `sources` holds the open iterator objects (a null entry marks an
    // exhausted input in "longest" mode) and `source_methods` their cached next
    // methods; `zip_padding` holds the per-input padding values (longest mode)
    // and `zip_keys` the property keys for zipKeyed (undefined for plain zip).
    MalValue sources;
    MalValue source_methods;
    MalValue zip_padding;
    MalValue zip_keys;

    // Scalar fields clustered last so they share one trailing word (no interior
    // padding between the 8-byte MalValue members above).
    MalIteratorHelperKind kind;
    MalIteratorZipMode zip_mode;
    bool done;
    // Guards against re-entrant next() (GeneratorState "executing"): a TypeError
    // is thrown if next() is called while a previous next() is still on the stack.
    bool running;
    i32 index;
} MalIteratorHelperObject;

/**
 * Install the Iterator Helpers surface: the %Iterator% global (abstract
 * constructor) + Iterator.from, the %IteratorPrototype% accessors (constructor,
 * @@toStringTag) and helper methods (map/filter/take/drop/flatMap +
 * reduce/toArray/forEach/some/every/find), and %IteratorHelperPrototype%
 * (carrying the shared next/return). Requires %IteratorPrototype%.
 */
void mal_builtin_iterator_helpers_install(MalVm *vm);
