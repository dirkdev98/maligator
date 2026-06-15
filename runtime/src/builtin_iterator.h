#pragma once

#include "./defaults.h"
#include "iterator_object.h"

typedef struct MalVm MalVm;

/**
 * Spec IteratorRecord: the iterator object together with its cached next
 * method, so a mutated `next` is not observed mid-iteration.
 */
typedef struct MalIteratorRecord {
    MalValue iterator;
    MalValue next_method;
} MalIteratorRecord;

/**
 * Install %IteratorPrototype% and the Map/Set/Array/String iterator
 * prototypes. Requires the well-known symbols.
 */
void mal_builtin_iterator_install(MalVm *vm);

/**
 * Build a spec CreateIterResultObject: { value, done } over Object.prototype.
 */
MalValue mal_vm_create_iter_result(MalVm *vm, MalValue value, bool done);

/**
 * Allocate a built-in iterator instance over target, backed by the iterator
 * prototype matching kind.
 */
MalValue mal_vm_new_builtin_iterator(MalVm *vm, MalIteratorKind kind, MalValue target);

/**
 * Spec GetIterator(value): look up @@iterator, call it, validate the result.
 * Returns false when something threw (TypeError for non-iterable values);
 * the throw completion is left on the vm.
 */
bool mal_vm_get_iterator(MalVm *vm, MalValue value, MalIteratorRecord *record_out);

/**
 * Spec IteratorStep + value read: calls next() and unpacks the result
 * object. Returns false when something threw. On success *done_out signals
 * exhaustion and *value_out carries the step value (undefined when done).
 */
bool mal_vm_iterator_step(MalVm *vm, const MalIteratorRecord *record, MalValue *value_out, bool *done_out);

/**
 * Spec IteratorClose for abrupt completions: invoke return() if present,
 * swallowing any secondary error so the original completion survives.
 */
void mal_vm_iterator_close(MalVm *vm, const MalIteratorRecord *record);

/**
 * Spec IteratorClose for a NORMAL completion: read return(), call it, and let
 * any error (from the getter, the call, or a non-object result) propagate as a
 * throw completion. Returns false (with the throw left on the vm) when the
 * close was abrupt; true otherwise. Used where the spec sequences a close ahead
 * of a normal result (e.g. take exhaustion and %IteratorHelper%.return).
 */
bool mal_vm_iterator_close_normal(MalVm *vm, const MalIteratorRecord *record);
