#pragma once

#include "./defaults.h"
#include "function_object.h"
#include "iterator_object.h"

typedef struct MalVm MalVm;
typedef struct MalArrayObject MalArrayObject;

/**
 * The builtin Array iterator `next` callback (mal_builtin_array_iterator_next), cached
 * at install. The inline iterator-step fast path (mal_vm_iterator_step_fast) compares
 * a captured next against it to confirm the array-iterator protocol is unpatched
 * before advancing a dense array directly.
 */
extern MalNativeFunctionCallback mal_array_iterator_next_callback;

/**
 * Spec IteratorRecord: the iterator object together with its cached next
 * method, so a mutated `next` is not observed mid-iteration.
 */
typedef struct MalIteratorRecord {
    MalValue iterator;
    MalValue next_method;
} MalIteratorRecord;

typedef enum MalIteratorCursorProtocol : u8 {
    MAL_ITERATOR_CURSOR_ARRAY_VALUES,
    MAL_ITERATOR_CURSOR_STRING_VALUES,
    MAL_ITERATOR_CURSOR_TYPED_ARRAY_VALUES,
    MAL_ITERATOR_CURSOR_MAP,
    MAL_ITERATOR_CURSOR_SET,
} MalIteratorCursorProtocol;

MalIteratorObject *mal_vm_iterator_protocol_cursor(
    const MalIteratorRecord *record, MalIteratorCursorProtocol protocol);

bool mal_vm_iterator_step_protocol_cursor(
    MalVm *vm, MalIteratorObject *cursor, MalValue *value_out, bool *done_out);

bool mal_vm_iterator_step_entry_pair_protocol_cursor(
	MalVm *vm,
    const MalIteratorRecord *record,
    MalValue *first_out,
    MalValue *second_out,
    bool *done_out);

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
 * Return a sound insertion-count hint for a fresh, exact built-in
 * Array/Map/Set iterator. Custom or already-advanced iterators return false.
 */
bool mal_vm_builtin_iterator_size_hint(
    const MalIteratorRecord *record, usize *size_out);

bool mal_vm_iterator_drain_set_values_to_fresh_dense_array(
    const MalIteratorRecord *record, MalArrayObject *array);

/**
 * Spec GetIteratorFromMethod(value, method): call an already-observed iterator
 * method and capture the returned iterator's next method. This is useful when a
 * preceding dispatch step (such as Web IDL union conversion) must observe
 * @@iterator exactly once.
 */
bool mal_vm_get_iterator_from_method(
    MalVm *vm, MalValue value, MalValue method, MalIteratorRecord *record_out);

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
