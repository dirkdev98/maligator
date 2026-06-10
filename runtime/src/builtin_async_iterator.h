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
