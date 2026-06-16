#pragma once

#include "./defaults.h"
#include "builtin_iterator.h"

typedef struct MalVm MalVm;

/**
 * Spec GetIterator(value, async): look up @@asyncIterator and use it, or fall
 * back to the sync @@iterator wrapped so each next() returns a promise of an
 * iterator result whose value has been awaited (AsyncFromSyncIterator). The
 * record's next_method always returns a promise; for-await-of awaits it.
 *
 * Returns false with a pending throw when the value is not (async) iterable.
 */
bool mal_vm_get_async_iterator(MalVm *vm, MalValue value, MalIteratorRecord *record_out);

/**
 * GetIteratorFromMethod for the async protocol, given an already-fetched,
 * callable iterator method (so callers that must decide between the iterable and
 * array-like paths — Array.fromAsync — look up @@asyncIterator/@@iterator once).
 * `method_is_async` selects the protocol: an async method's iterator is used
 * directly; a sync method's iterator is wrapped so each next() returns a promise.
 * Returns false with a pending throw on failure.
 */
bool mal_vm_async_iterator_from_method(
    MalVm *vm,
    MalValue value,
    MalValue method,
    bool method_is_async,
    MalIteratorRecord *record_out
);
