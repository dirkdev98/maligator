#include "builtin_iterator_helpers.h"

#include <math.h>

#include "array_object.h"
#include "builtin_iterator.h"
#include "function_object.h"
#include "heap.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "property_iter.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/** GetIteratorDirect(this): require an object and cache its `next`. */
static bool mal_ih_get_direct(MalVm *vm, MalValue this_value, MalIteratorRecord *record_out) {
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator method called on non-object");
        return false;
    }
    MalValue next;
    if (!mal_vm_get_property(
            vm, this_value,
            mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_NEXT), &next)) {
        return false;
    }
    record_out->iterator = this_value;
    record_out->next_method = next;
    return true;
}

/**
 * Spec GetIteratorFlattenable(obj, reject-primitives). Unlike GetIterator, when
 * @@iterator is undefined/null it falls back to treating obj as the iterator
 * itself (GetIteratorDirect). A non-object always throws a TypeError; callers
 * that allow strings (Iterator.from) handle that case before calling here.
 */
static bool mal_ih_get_flattenable(MalVm *vm, MalValue obj, MalIteratorRecord *record_out) {
    if (!mal_value_is_object(obj)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not an object");
        return false;
    }

    MalValue method;
    if (!mal_vm_get_property(vm, obj, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &method)) {
        return false;
    }

    MalValue iterator;
    if (mal_value_is_nil(method)) {
        // No @@iterator: obj is itself the iterator.
        iterator = obj;
    } else if (mal_value_is_callable(method)) {
        MalCompletion completion = mal_vm_call_value(vm, method, obj, nullptr, 0);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            return false;
        }
        if (!mal_value_is_object(completion.value)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator is not an object");
            return false;
        }
        iterator = completion.value;
    } else {
        // Present but neither callable nor nullish.
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "@@iterator is not a function");
        return false;
    }

    MalValue next;
    if (!mal_vm_get_property(
            vm, iterator,
            mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_NEXT), &next)) {
        return false;
    }
    record_out->iterator = iterator;
    record_out->next_method = next;
    return true;
}

/**
 * Eager-method preamble: require an Object receiver, validate the predicate is
 * callable, then GetIteratorDirect. The callable check happens BEFORE `next` is
 * read; on failure the underlying iterator is closed (only `return` is read)
 * and a TypeError is thrown. Returns false (throw pending) on any failure.
 */
static bool mal_ih_get_direct_with_callback(MalVm *vm, MalValue this_value, MalValue callback, const byte *message, MalIteratorRecord *record_out) {
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator method called on non-object");
        return false;
    }
    if (!mal_value_is_callable(callback)) {
        MalIteratorRecord closing = {.iterator = this_value, .next_method = mal_value_new_undefined()};
        mal_vm_iterator_close(vm, &closing);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        return false;
    }
    return mal_ih_get_direct(vm, this_value, record_out);
}

static MalIteratorRecord mal_ih_underlying(const MalIteratorHelperObject *self) {
    return (MalIteratorRecord) {.iterator = self->iterator, .next_method = self->next_method};
}

static bool mal_ih_finish(
    MalIteratorHelperObject *self, MalValue *value_out, bool *done_out
) {
    self->done = true;
    *value_out = mal_value_new_undefined();
    *done_out = true;
    return true;
}

static bool mal_ih_yield(MalValue value, MalValue *value_out, bool *done_out) {
    *value_out = value;
    *done_out = false;
    return true;
}

// --- Per-kind lazy steps (read the helper's struct state) -------------------

static bool mal_ih_step_map(
    MalVm *vm, MalIteratorHelperObject *self,
    MalValue *value_out, bool *done_out
) {
    MalIteratorRecord record = mal_ih_underlying(self);
    MalValue value;
    bool done;
    if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
        return false;
    }
    if (done) {
        return mal_ih_finish(self, value_out, done_out);
    }
    MalValue callback_args[2] = {value, mal_value_from_i32(self->index++)};
    MalCompletion mapped = mal_vm_call_value(vm, self->callback, mal_value_new_undefined(), callback_args, 2);
    if (mapped.kind == MAL_COMPLETION_THROW) {
        self->done = true;
        mal_vm_iterator_close(vm, &record);
        return false;
    }
    return mal_ih_yield(mapped.value, value_out, done_out);
}

static bool mal_ih_step_filter(
    MalVm *vm, MalIteratorHelperObject *self,
    MalValue *value_out, bool *done_out
) {
    MalIteratorRecord record = mal_ih_underlying(self);
    while (true) {
        MalValue value;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
            return false;
        }
        if (done) {
            return mal_ih_finish(self, value_out, done_out);
        }
        MalValue callback_args[2] = {value, mal_value_from_i32(self->index++)};
        MalCompletion kept = mal_vm_call_value(vm, self->callback, mal_value_new_undefined(), callback_args, 2);
        if (kept.kind == MAL_COMPLETION_THROW) {
            self->done = true;
            mal_vm_iterator_close(vm, &record);
            return false;
        }
        if (mal_value_is_truthy(kept.value)) {
            return mal_ih_yield(value, value_out, done_out);
        }
    }
}

static bool mal_ih_step_take(
    MalVm *vm, MalIteratorHelperObject *self,
    MalValue *value_out, bool *done_out
) {
    MalIteratorRecord record = mal_ih_underlying(self);
    if (self->counter <= 0.0) {
        // Normal-completion close: a throwing return() must surface here.
        self->done = true;
        if (!mal_vm_iterator_close_normal(vm, &record)) {
            return false;
        }
        *value_out = mal_value_new_undefined();
        *done_out = true;
        return true;
    }
    self->counter -= 1.0;
    MalValue value;
    bool done;
    if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
        return false;
    }
    if (done) {
        return mal_ih_finish(self, value_out, done_out);
    }
    return mal_ih_yield(value, value_out, done_out);
}

static bool mal_ih_step_drop(
    MalVm *vm, MalIteratorHelperObject *self,
    MalValue *value_out, bool *done_out
) {
    MalIteratorRecord record = mal_ih_underlying(self);
    while (self->counter > 0.0) {
        MalValue skipped;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &skipped, &done)) {
            return false;
        }
        if (done) {
            return mal_ih_finish(self, value_out, done_out);
        }
        self->counter -= 1.0;
    }
    MalValue value;
    bool done;
    if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
        return false;
    }
    if (done) {
        return mal_ih_finish(self, value_out, done_out);
    }
    return mal_ih_yield(value, value_out, done_out);
}

static bool mal_ih_step_flatmap(
    MalVm *vm, MalIteratorHelperObject *self,
    MalValue *value_out, bool *done_out
) {
    MalIteratorRecord outer = mal_ih_underlying(self);
    while (true) {
        if (!mal_value_is_undefined(self->inner_iterator)) {
            MalIteratorRecord inner = {.iterator = self->inner_iterator, .next_method = self->inner_next};
            MalValue value;
            bool done;
            if (!mal_vm_iterator_step(vm, &inner, &value, &done)) {
                // IfAbruptCloseIterator(innerNext, iterated): an abrupt inner
                // step closes the OUTER iterator, keeping the original throw.
                self->done = true;
                mal_vm_iterator_close(vm, &outer);
                return false;
            }
            if (!done) {
                return mal_ih_yield(value, value_out, done_out);
            }
            // SATB: the exhausted inner iterator (traced via this helper) is being
            // dropped; shade the old refs before clearing. The re-arm sites store
            // into a slot just cleared to undefined, so they need no shade.
            mal_gc_write_barrier(self->inner_iterator);
            mal_gc_write_barrier(self->inner_next);
            self->inner_iterator = mal_value_new_undefined();
            self->inner_next = mal_value_new_undefined();
        }

        MalValue value;
        bool done;
        if (!mal_vm_iterator_step(vm, &outer, &value, &done)) {
            return false;
        }
        if (done) {
            return mal_ih_finish(self, value_out, done_out);
        }
        MalValue callback_args[2] = {value, mal_value_from_i32(self->index++)};
        MalCompletion mapped = mal_vm_call_value(vm, self->callback, mal_value_new_undefined(), callback_args, 2);
        if (mapped.kind == MAL_COMPLETION_THROW) {
            self->done = true;
            mal_vm_iterator_close(vm, &outer);
            return false;
        }
        MalIteratorRecord inner;
        if (!mal_ih_get_flattenable(vm, mapped.value, &inner)) {
            self->done = true;
            mal_vm_iterator_close(vm, &outer);
            return false;
        }
        self->inner_iterator = inner.iterator;
        self->inner_next = inner.next_method;
    }
}

static MalValue mal_ih_step_wrap(MalVm *vm, MalIteratorHelperObject *self) {
    // Iterator.from wrapper: forward the underlying step result directly.
    MalCompletion result = mal_vm_call_value(vm, self->next_method, self->iterator, nullptr, 0);
    return result.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : result.value;
}

static MalValue mal_ih_zip_get(MalVm *vm, MalValue array, i32 index);

static bool mal_ih_step_concat(
    MalVm *vm, MalIteratorHelperObject *self,
    MalValue *value_out, bool *done_out
) {
    // sources/source_methods are intrinsic arrays this helper owns.
    i32 length = (i32) mal_array_object_length(mal_value_to_array_object(self->sources));

    while (true) {
        if (!mal_value_is_undefined(self->inner_iterator)) {
            MalIteratorRecord inner = {.iterator = self->inner_iterator, .next_method = self->inner_next};
            MalValue value;
            bool done;
            if (!mal_vm_iterator_step(vm, &inner, &value, &done)) {
                return false;
            }
            if (!done) {
                return mal_ih_yield(value, value_out, done_out);
            }
            // SATB: the exhausted inner iterator (traced via this helper) is being
            // dropped; shade the old refs before clearing. The re-arm sites store
            // into a slot just cleared to undefined, so they need no shade.
            mal_gc_write_barrier(self->inner_iterator);
            mal_gc_write_barrier(self->inner_next);
            self->inner_iterator = mal_value_new_undefined();
            self->inner_next = mal_value_new_undefined();
        }

        if (self->index >= length) {
            return mal_ih_finish(self, value_out, done_out);
        }

        // Open the next source: call its captured @@iterator method.
        MalValue iterable;
        MalValue method;
        iterable = mal_ih_zip_get(vm, self->sources, self->index);
        method = mal_ih_zip_get(vm, self->source_methods, self->index);
        self->index++;

        MalCompletion opened = mal_vm_call_value(vm, method, iterable, nullptr, 0);
        if (opened.kind != MAL_COMPLETION_NORMAL) {
            self->done = true;
            return false;
        }
        if (!mal_value_is_object(opened.value)) {
            self->done = true;
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator is not an object");
            return false;
        }
        MalValue inner_next;
        if (!mal_vm_get_property(
                vm, opened.value,
                mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_NEXT),
                &inner_next)) {
            self->done = true;
            return false;
        }
        self->inner_iterator = opened.value;
        self->inner_next = inner_next;
    }
}

// --- Iterator.zip / Iterator.zipKeyed ---------------------------------------

static i32 mal_ih_zip_count(MalIteratorHelperObject *self) {
    return (i32) mal_array_object_length(mal_value_to_array_object(self->sources));
}

static MalValue mal_ih_zip_get(MalVm *vm, MalValue array, i32 index) {
    MalValue out;
    if (mal_array_object_dense_get(
            mal_value_to_array_object(array), (u32) index, &out)) {
        return out;
    }
    mal_vm_get_property(vm, array, mal_key_index(index), &out);
    return out;
}

static void mal_ih_zip_set(MalVm *vm, MalValue array, i32 index, MalValue value) {
    (void) vm;
    mal_array_object_store(mal_value_to_array_object(array), mal_key_index(index), value);
}

/**
 * IteratorClose every still-open source (a null entry is already exhausted),
 * except index `skip`. mal_vm_iterator_close keeps any already-pending throw, so
 * call this after setting the abrupt completion to propagate it.
 */
static void mal_ih_zip_close_all(MalVm *vm, MalIteratorHelperObject *self, i32 skip) {
    i32 count = mal_ih_zip_count(self);
    // IfAbruptCloseIterators / CloseAllIterators close in reverse List order.
    for (i32 i = count - 1; i >= 0; i--) {
        if (i == skip) {
            continue;
        }
        MalValue iter = mal_ih_zip_get(vm, self->sources, i);
        if (mal_value_is_null(iter) || !mal_value_is_object(iter)) {
            continue;
        }
        MalValue next_method = mal_ih_zip_get(vm, self->source_methods, i);
        MalIteratorRecord record = {.iterator = iter, .next_method = next_method};
        // With a throw already pending, preserve it (swallow secondary close
        // errors); otherwise a throwing return() is the result and propagates.
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_vm_iterator_close(vm, &record);
        } else {
            mal_vm_iterator_close_normal(vm, &record);
        }
    }
}

/** finishResults: a fresh array for zip, a fresh object keyed by zip_keys for zipKeyed. */
static MalValue mal_ih_zip_finish_results(MalVm *vm, MalIteratorHelperObject *self, MalValue results, i32 count) {
    if (mal_value_is_undefined(self->zip_keys)) {
        return results;
    }
    // zipKeyed builds a null-prototype object.
    MalObject *object = mal_object_new(&vm->heap, nullptr);
    for (i32 i = 0; i < count; i++) {
        MalValue key_value = mal_ih_zip_get(vm, self->zip_keys, i);
        MalValue value = mal_ih_zip_get(vm, results, i);
        MalKey key;
        mal_vm_value_to_property_key(vm, key_value, &key);
        MalPropertyDesc desc = mal_intrinsic_data_desc(
            value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_object_define_own(object, key, &desc);
    }
    return mal_value_from_object(object);
}

static bool mal_ih_step_zip(
    MalVm *vm, MalIteratorHelperObject *self,
    MalValue *value_out, bool *done_out
) {
    i32 count = mal_ih_zip_count(self);
    if (count == 0) {
        return mal_ih_finish(self, value_out, done_out);
    }

    MalValue results = mal_value_from_array_object(mal_intrinsic_new_array(vm, (u32) count));
    i32 open = 0;

    for (i32 i = 0; i < count; i++) {
        MalValue iter = mal_ih_zip_get(vm, self->sources, i);
        MalValue result;

        if (mal_value_is_null(iter)) {
            result = mal_ih_zip_get(vm, self->zip_padding, i);
        } else {
            open++;
            MalValue next_method = mal_ih_zip_get(vm, self->source_methods, i);
            MalIteratorRecord record = {.iterator = iter, .next_method = next_method};
            MalValue value;
            bool done;
            if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
                // Abrupt step: close the rest, propagate the pending throw.
                self->done = true;
                mal_ih_zip_close_all(vm, self, i);
                return false;
            }

            if (!done) {
                result = value;
            } else if (self->zip_mode == MAL_ITERATOR_ZIP_SHORTEST) {
                // Any input finishing ends iteration; close the others.
                self->done = true;
                mal_ih_zip_set(vm, self->sources, i, mal_value_new_null());
                mal_ih_zip_close_all(vm, self, -1);
                if (vm->completion.kind == MAL_COMPLETION_THROW) {
                    return false;
                }
                return mal_ih_finish(self, value_out, done_out);
            } else if (self->zip_mode == MAL_ITERATOR_ZIP_LONGEST) {
                mal_ih_zip_set(vm, self->sources, i, mal_value_new_null());
                open--;
                result = mal_ih_zip_get(vm, self->zip_padding, i);
            } else {
                // strict: all inputs must have the same length.
                self->done = true;
                mal_ih_zip_set(vm, self->sources, i, mal_value_new_null());
                if (i == 0) {
                    // The first input ended; every other input must also be done.
                    for (i32 k = 1; k < count; k++) {
                        MalValue k_iter = mal_ih_zip_get(vm, self->sources, k);
                        MalValue k_next = mal_ih_zip_get(vm, self->source_methods, k);
                        MalIteratorRecord k_record = {.iterator = k_iter, .next_method = k_next};
                        MalValue k_value;
                        bool k_done;
                        if (!mal_vm_iterator_step(vm, &k_record, &k_value, &k_done)) {
                            mal_ih_zip_close_all(vm, self, -1);
                            return false;
                        }
                        if (!k_done) {
                            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator.zip strict mode: iterators have different lengths");
                            mal_ih_zip_close_all(vm, self, -1);
                            return false;
                        }
                        mal_ih_zip_set(vm, self->sources, k, mal_value_new_null());
                    }
                    return mal_ih_finish(self, value_out, done_out);
                }
                // A later input ended while earlier ones produced values.
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator.zip strict mode: iterators have different lengths");
                mal_ih_zip_close_all(vm, self, -1);
                return false;
            }
        }

        mal_ih_zip_set(vm, results, i, result);
    }

    // longest: a round with no real value means every input is exhausted.
    if (self->zip_mode == MAL_ITERATOR_ZIP_LONGEST && open == 0) {
        return mal_ih_finish(self, value_out, done_out);
    }

    return mal_ih_yield(
        mal_ih_zip_finish_results(vm, self, results, count), value_out, done_out);
}

// --- Shared %IteratorHelperPrototype% next / return -------------------------

static bool mal_ih_advance(
    MalVm *vm, MalIteratorHelperObject *self,
    MalValue *value_out, bool *done_out
) {
    switch (self->kind) {
        case MAL_ITERATOR_HELPER_MAP:
            return mal_ih_step_map(vm, self, value_out, done_out);
        case MAL_ITERATOR_HELPER_FILTER:
            return mal_ih_step_filter(vm, self, value_out, done_out);
        case MAL_ITERATOR_HELPER_TAKE:
            return mal_ih_step_take(vm, self, value_out, done_out);
        case MAL_ITERATOR_HELPER_DROP:
            return mal_ih_step_drop(vm, self, value_out, done_out);
        case MAL_ITERATOR_HELPER_FLATMAP:
            return mal_ih_step_flatmap(vm, self, value_out, done_out);
        case MAL_ITERATOR_HELPER_WRAP: {
            MalIteratorRecord record = mal_ih_underlying(self);
            return mal_vm_iterator_step(vm, &record, value_out, done_out);
        }
        case MAL_ITERATOR_HELPER_CONCAT:
            return mal_ih_step_concat(vm, self, value_out, done_out);
        case MAL_ITERATOR_HELPER_ZIP:
            return mal_ih_step_zip(vm, self, value_out, done_out);
    }
    return mal_ih_finish(self, value_out, done_out);
}

static MalValue mal_ih_proto_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    if (!mal_value_is_iterator_helper_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not an Iterator Helper");
        return mal_value_new_undefined();
    }
    MalIteratorHelperObject *self = mal_value_to_iterator_helper_object(this_value);
    // GeneratorValidate: a re-entrant next() (the body is already on the stack)
    // is a TypeError, not a recursive resume.
    if (self->running) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator Helper is already running");
        return mal_value_new_undefined();
    }
    if (self->done) {
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }
    self->running = true;
    MalValue result;
    if (self->kind == MAL_ITERATOR_HELPER_WRAP) {
        // %WrapForValidIteratorPrototype%.next forwards the exact result object.
        result = mal_ih_step_wrap(vm, self);
    } else {
        MalValue value;
        bool done;
        result = mal_ih_advance(vm, self, &value, &done)
            ? mal_vm_create_iter_result(vm, value, done)
            : mal_value_new_undefined();
    }
    self->running = false;
    return result;
}

int mal_builtin_iterator_helper_try_step(
    MalVm *vm, const MalIteratorRecord *record,
    MalValue *value_out, bool *done_out
) {
    if (!mal_value_is_iterator_helper_object(record->iterator) ||
        !mal_value_is_native_function_object(record->next_method) ||
        mal_native_function_object_callback(
            mal_value_to_native_function_object(record->next_method)) !=
            mal_ih_proto_next) {
        return 0;
    }

    MalIteratorHelperObject *self =
        mal_value_to_iterator_helper_object(record->iterator);
    if (self->running) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Iterator Helper is already running");
        return -1;
    }
    if (self->done) {
        *value_out = mal_value_new_undefined();
        *done_out = true;
        return 1;
    }

    // This is the allocation-free equivalent of calling the exact native
    // helper next method and immediately unwrapping its {value, done} result.
    // Recreate that native frame's GC suppression while helper state and callback
    // scratch live in C locals.
    self->running = true;
    vm->gc_native_frames++;
    bool ok = mal_ih_advance(vm, self, value_out, done_out);
    vm->gc_native_frames--;
    self->running = false;
    return ok ? 1 : -1;
}

static MalValue mal_ih_proto_return(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (!mal_value_is_iterator_helper_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not an Iterator Helper");
        return mal_value_new_undefined();
    }
    MalIteratorHelperObject *self = mal_value_to_iterator_helper_object(this_value);
    if (self->running) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator Helper is already running");
        return mal_value_new_undefined();
    }
    (void) args;
    (void) arg_count;

    // The Iterator.from wrapper has %WrapForValidIteratorPrototype%.return
    // semantics: forward to the underlying return() (with no arguments) and
    // hand back its result object directly, rather than synthesizing one.
    if (self->kind == MAL_ITERATOR_HELPER_WRAP) {
        MalValue return_method;
        if (!mal_vm_get_property(vm, self->iterator, mal_intrinsic_string_key(vm, "return"), &return_method)) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_nil(return_method)) {
            return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
        }
        MalCompletion completion = mal_vm_call_value(vm, return_method, self->iterator, nullptr, 0);
        return completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : completion.value;
    }

    // Already completed (exhausted or previously returned): do not forward.
    // %IteratorHelperPrototype%.return ignores its argument; the result value
    // is always undefined.
    if (self->done) {
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }
    self->done = true;

    // Marking the generator "executing" so a return() that re-enters this
    // helper (e.g. underlying return() calls iterator.return()) is rejected.
    self->running = true;

    // zip closes every still-open input iterator.
    if (self->kind == MAL_ITERATOR_HELPER_ZIP) {
        mal_ih_zip_close_all(vm, self, -1);
        self->running = false;
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }

    // Normal-completion close: a throwing return() on the underlying iterator
    // must surface to the caller of %IteratorHelper%.return. concat has no
    // single underlying iterator; only its currently-open inner one is closed.
    if (!mal_value_is_undefined(self->inner_iterator)) {
        MalIteratorRecord inner = {.iterator = self->inner_iterator, .next_method = self->inner_next};
        if (!mal_vm_iterator_close_normal(vm, &inner)) {
            self->running = false;
            return mal_value_new_undefined();
        }
    }
    if (mal_value_is_object(self->iterator)) {
        MalIteratorRecord record = mal_ih_underlying(self);
        if (!mal_vm_iterator_close_normal(vm, &record)) {
            self->running = false;
            return mal_value_new_undefined();
        }
    }
    self->running = false;
    return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
}

// --- Helper construction -----------------------------------------------------

static MalValue mal_ih_new(MalVm *vm, MalIteratorHelperKind kind, const MalIteratorRecord *record, MalValue callback, f64 counter) {
    MalIteratorHelperObject *helper = mal_heap_alloc(&vm->heap, sizeof(MalIteratorHelperObject), MAL_HEAP_ITERATOR_HELPER_OBJECT);
    mal_object_init(&vm->heap, &helper->object, MAL_HEAP_ITERATOR_HELPER_OBJECT, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ITERATOR_HELPER_PROTOTYPE]));
    helper->kind = kind;
    helper->iterator = record->iterator;
    helper->next_method = record->next_method;
    helper->callback = callback;
    helper->counter = counter;
    helper->done = false;
    helper->running = false;
    helper->index = 0;
    helper->inner_iterator = mal_value_new_undefined();
    helper->inner_next = mal_value_new_undefined();
    helper->sources = mal_value_new_undefined();
    helper->source_methods = mal_value_new_undefined();
    helper->zip_padding = mal_value_new_undefined();
    helper->zip_keys = mal_value_new_undefined();
    helper->zip_mode = MAL_ITERATOR_ZIP_SHORTEST;
    return mal_value_from_iterator_helper_object(helper);
}

/** take/drop ToIntegerOrInfinity-with-RangeError, atop a full vm ToNumber. */
static bool mal_ih_limit(MalVm *vm, MalValue value, f64 *out) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) {
        return false; // TypeError on BigInt/Symbol/bad @@toPrimitive
    }
    if (isnan(number)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Iterator limit must not be NaN");
        return false;
    }
    if (isfinite(number) && number > MAL_NUMBER_MAX_SAFE_INTEGER) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Iterator limit exceeds the maximum safe integer");
        return false;
    }
    f64 integer = isinf(number) ? number : trunc(number);
    if (integer < 0.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Iterator limit must be non-negative");
        return false;
    }
    *out = integer;
    return true;
}

/**
 * Close `this` on a failed argument validation. The spec performs an
 * IteratorClose here even though GetIteratorDirect has not run, so only the
 * `return` method is read (never `next`). Any error from the validation that
 * is already pending must win over a secondary close error, so this swallows.
 */
static void mal_ih_close_on_validation_failure(MalVm *vm, MalValue this_value) {
    MalIteratorRecord record = {.iterator = this_value, .next_method = mal_value_new_undefined()};
    mal_vm_iterator_close(vm, &record);
}

static MalValue mal_ih_lazy(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalIteratorHelperKind kind, bool wants_callback) {
    // Step 2: O must be an Object. (Done before any argument coercion/close.)
    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator method called on non-object");
        return mal_value_new_undefined();
    }

    MalValue callback = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    f64 counter = 0.0;

    // Steps 3-6: validate the argument BEFORE GetIteratorDirect (so `next` is
    // not read), closing the underlying iterator if validation is abrupt.
    if (wants_callback) {
        if (!mal_value_is_callable(callback)) {
            mal_ih_close_on_validation_failure(vm, this_value);
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator helper callback is not a function");
            return mal_value_new_undefined();
        }
    } else {
        if (!mal_ih_limit(vm, callback, &counter)) {
            mal_ih_close_on_validation_failure(vm, this_value);
            return mal_value_new_undefined();
        }
    }

    // Step 7: GetIteratorDirect(O) now reads `next`.
    MalIteratorRecord record;
    if (!mal_ih_get_direct(vm, this_value, &record)) {
        return mal_value_new_undefined();
    }
    return mal_ih_new(vm, kind, &record, callback, counter);
}

static MalValue mal_ih_method_map(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_lazy(vm, this_value, args, arg_count, MAL_ITERATOR_HELPER_MAP, true);
}
static MalValue mal_ih_method_filter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_lazy(vm, this_value, args, arg_count, MAL_ITERATOR_HELPER_FILTER, true);
}
static MalValue mal_ih_method_flatmap(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_lazy(vm, this_value, args, arg_count, MAL_ITERATOR_HELPER_FLATMAP, true);
}
static MalValue mal_ih_method_take(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_lazy(vm, this_value, args, arg_count, MAL_ITERATOR_HELPER_TAKE, false);
}
static MalValue mal_ih_method_drop(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_lazy(vm, this_value, args, arg_count, MAL_ITERATOR_HELPER_DROP, false);
}

// --- Eager helper methods ----------------------------------------------------

static MalValue mal_ih_method_to_array(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalIteratorRecord record;
    if (!mal_ih_get_direct(vm, this_value, &record)) {
        return mal_value_new_undefined();
    }
    MalArrayObject *array = mal_intrinsic_new_array(vm, 0);
    usize size_hint;
    if (mal_vm_builtin_iterator_size_hint(&record, &size_hint) &&
        size_hint <= UINT32_MAX) {
        mal_array_object_fresh_dense_reserve_exact(array, (u32) size_hint);
    }
    // Each step re-enters JS (iterator.next) and can collect; root the record's
    // iterator/next_method (two contiguous MalValues) + the result array + the
    // in-flight value, and lift GC suppression for the loop.
    MalValue roots[2] = {mal_value_from_array_object(array), mal_value_new_undefined()};
    MalRootSpan rec_span, span;
    mal_gc_root(&rec_span, &record.iterator, 2);
    mal_gc_root(&span, roots, 2);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();
    i32 index = 0;
    while (true) {
        MalValue value;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
            break;
        }
        if (done) {
            ret = mal_value_from_array_object(array);
            break;
        }
        roots[1] = value;
        if (!mal_array_object_fresh_dense_append(array, value)) {
            mal_array_object_store(array, mal_key_index(index), value);
        }
        index++;
    }
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    mal_gc_unroot(&rec_span);
    return ret;
}

static MalValue mal_ih_method_for_each(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalValue callback = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalIteratorRecord record;
    if (!mal_ih_get_direct_with_callback(vm, this_value, callback, "Iterator.prototype.forEach callback is not a function", &record)) {
        return mal_value_new_undefined();
    }
    // Each step and the callback re-enter JS and can collect; root the record +
    // the in-flight value (which is callback_args[0]) and lift GC suppression.
    MalValue roots[1] = {mal_value_new_undefined()};
    MalRootSpan rec_span, span;
    mal_gc_root(&rec_span, &record.iterator, 2);
    mal_gc_root(&span, roots, 1);
    mal_gc_native_rooted_begin(vm);
    i32 index = 0;
    while (true) {
        MalValue value;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
            break;
        }
        if (done) {
            break;
        }
        roots[0] = value;
        MalValue callback_args[2] = {value, mal_value_from_i32(index++)};
        MalCompletion result = mal_vm_call_value(vm, callback, mal_value_new_undefined(), callback_args, 2);
        if (result.kind == MAL_COMPLETION_THROW) {
            mal_vm_iterator_close(vm, &record);
            break;
        }
    }
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    mal_gc_unroot(&rec_span);
    return mal_value_new_undefined();
}

static MalValue mal_ih_method_reduce(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalValue callback = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalIteratorRecord record;
    if (!mal_ih_get_direct_with_callback(vm, this_value, callback, "Iterator.prototype.reduce callback is not a function", &record)) {
        return mal_value_new_undefined();
    }

    // The accumulator is carried across every callback, the in-flight value is
    // callback_args[1], and each step + callback can collect; root the record +
    // {accumulator, value} and lift GC suppression.
    MalValue roots[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan rec_span, span;
    mal_gc_root(&rec_span, &record.iterator, 2);
    mal_gc_root(&span, roots, 2);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();

    MalValue accumulator;
    i32 index = 0;
    if (arg_count >= 2) {
        accumulator = args[1];
    } else {
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &accumulator, &done)) {
            goto done;
        }
        if (done) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reduce of empty iterator with no initial value");
            goto done;
        }
        index = 1;
    }
    roots[0] = accumulator;

    while (true) {
        MalValue value;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
            goto done;
        }
        if (done) {
            ret = accumulator;
            goto done;
        }
        roots[1] = value;
        MalValue callback_args[3] = {accumulator, value, mal_value_from_i32(index++)};
        MalCompletion result = mal_vm_call_value(vm, callback, mal_value_new_undefined(), callback_args, 3);
        if (result.kind == MAL_COMPLETION_THROW) {
            mal_vm_iterator_close(vm, &record);
            goto done;
        }
        accumulator = result.value;
        roots[0] = accumulator;
    }

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    mal_gc_unroot(&rec_span);
    return ret;
}

enum { MAL_IH_SOME, MAL_IH_EVERY, MAL_IH_FIND };

static MalValue mal_ih_predicate(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, i32 kind) {
    MalValue callback = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalIteratorRecord record;
    if (!mal_ih_get_direct_with_callback(vm, this_value, callback, "Iterator helper predicate is not a function", &record)) {
        return mal_value_new_undefined();
    }
    // Each step, the callback, and IteratorClose's return() all re-enter JS and
    // can collect; root the record + the in-flight value (held across the callback
    // and, for find, across the closing return()) and lift GC suppression.
    MalValue roots[1] = {mal_value_new_undefined()};
    MalRootSpan rec_span, span;
    mal_gc_root(&rec_span, &record.iterator, 2);
    mal_gc_root(&span, roots, 1);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();
    i32 index = 0;
    while (true) {
        MalValue value;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
            goto done;
        }
        if (done) {
            ret = kind == MAL_IH_EVERY ? mal_value_new_boolean(true)
                : kind == MAL_IH_SOME  ? mal_value_new_boolean(false)
                                       : mal_value_new_undefined();
            goto done;
        }
        roots[0] = value;
        MalValue callback_args[2] = {value, mal_value_from_i32(index++)};
        MalCompletion result = mal_vm_call_value(vm, callback, mal_value_new_undefined(), callback_args, 2);
        if (result.kind == MAL_COMPLETION_THROW) {
            mal_vm_iterator_close(vm, &record);
            goto done;
        }
        // Early exit is a NORMAL completion: IteratorClose runs and a throwing
        // return() must surface to the caller (not be swallowed).
        bool truthy = mal_value_is_truthy(result.value);
        if (kind == MAL_IH_SOME && truthy) {
            ret = mal_vm_iterator_close_normal(vm, &record) ? mal_value_new_boolean(true) : mal_value_new_undefined();
            goto done;
        }
        if (kind == MAL_IH_EVERY && !truthy) {
            ret = mal_vm_iterator_close_normal(vm, &record) ? mal_value_new_boolean(false) : mal_value_new_undefined();
            goto done;
        }
        if (kind == MAL_IH_FIND && truthy) {
            ret = mal_vm_iterator_close_normal(vm, &record) ? value : mal_value_new_undefined();
            goto done;
        }
    }

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    mal_gc_unroot(&rec_span);
    return ret;
}

static MalValue mal_ih_method_some(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_predicate(vm, this_value, args, arg_count, MAL_IH_SOME);
}
static MalValue mal_ih_method_every(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_predicate(vm, this_value, args, arg_count, MAL_IH_EVERY);
}
static MalValue mal_ih_method_find(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_ih_predicate(vm, this_value, args, arg_count, MAL_IH_FIND);
}

// --- Iterator constructor + Iterator.from + accessors ------------------------

static MalValue mal_iterator_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) callee;
    if (mal_value_is_undefined(new_target) || new_target == vm->intrinsics[MAL_INTRINSIC_ITERATOR_CONSTRUCTOR]) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Abstract class Iterator not directly constructable");
        return mal_value_new_undefined();
    }
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_ITERATOR_PROTOTYPE, &prototype)) {
        return mal_value_new_undefined();
    }
    return mal_value_from_object(mal_object_new(&vm->heap, prototype));
}

/** Whether value's [[Prototype]] chain includes %IteratorPrototype% (≈ instanceof %Iterator%). */
static bool mal_ih_is_iterator_instance(MalVm *vm, MalValue value) {
    if (!mal_value_is_object(value)) {
        return false;
    }
    MalObject *target = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE]);
    for (MalObject *proto = mal_value_to_object(value)->prototype; proto != nullptr; proto = proto->prototype) {
        if (proto == target) {
            return true;
        }
    }
    return false;
}

static MalValue mal_iterator_from(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue source = arg_count >= 1 ? args[0] : mal_value_new_undefined();

    MalIteratorRecord record;
    if (mal_value_is_string(source)) {
        // Step 1: a String is ToObject'd; its @@iterator (on %String.prototype%)
        // is callable, so GetIteratorFlattenable opens the string iterator.
        MalValue method;
        if (!mal_vm_get_property(vm, source, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &method) ||
            !mal_value_is_callable(method)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "String is not iterable");
            return mal_value_new_undefined();
        }
        MalCompletion completion = mal_vm_call_value(vm, method, source, nullptr, 0);
        if (completion.kind != MAL_COMPLETION_NORMAL || !mal_value_is_object(completion.value)) {
            if (completion.kind == MAL_COMPLETION_NORMAL) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator is not an object");
            }
            return mal_value_new_undefined();
        }
        MalValue next;
        if (!mal_vm_get_property(
                vm, completion.value,
                mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_NEXT), &next)) {
            return mal_value_new_undefined();
        }
        record.iterator = completion.value;
        record.next_method = next;
    } else if (!mal_ih_get_flattenable(vm, source, &record)) {
        // Step 2: any other non-object throws (no respecting iterability of
        // primitives); objects fall back to GetIteratorDirect when @@iterator
        // is absent.
        return mal_value_new_undefined();
    }

    // Already an Iterator instance (has the helpers): hand it back as-is.
    if (mal_ih_is_iterator_instance(vm, record.iterator)) {
        return record.iterator;
    }
    // Otherwise wrap so the result has %IteratorPrototype% in its chain.
    return mal_ih_new(vm, MAL_ITERATOR_HELPER_WRAP, &record, mal_value_new_undefined(), 0.0);
}

static MalValue mal_iterator_tag_get(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    return mal_value_from_string(mal_intrinsic_ascii(vm, "Iterator"));
}

static MalValue mal_iterator_ctor_get(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    return vm->intrinsics[MAL_INTRINSIC_ITERATOR_CONSTRUCTOR];
}

/**
 * Spec SetterThatIgnoresPrototypeProperties(home, p, v): throw if `this` is not
 * an Object or is `home` itself (%Iterator.prototype%); otherwise create the
 * own data property if absent, else Set it through the receiver.
 */
static MalValue mal_iterator_proto_setter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalKey key) {
    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();

    if (!mal_value_is_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator.prototype setter called on non-object");
        return mal_value_new_undefined();
    }
    if (this_value == vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE]) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot assign to read-only property of %Iterator.prototype%");
        return mal_value_new_undefined();
    }

    MalObject *object = mal_value_to_object(this_value);
    MalPropertyLookup own = mal_object_get_own(object, key);
    if (own.present) {
        // Set(this, p, v, true): a non-writable own property throws here.
        mal_vm_set_property(vm, this_value, key, value, this_value);
    } else {
        MalPropertyDesc desc = mal_intrinsic_data_desc(
            value,
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE
        );
        mal_object_define_own(object, key, &desc);
    }
    return mal_value_new_undefined();
}
static MalValue mal_iterator_tag_set(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_iterator_proto_setter(vm, this_value, args, arg_count, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG));
}
static MalValue mal_iterator_ctor_set(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_iterator_proto_setter(vm, this_value, args, arg_count, mal_intrinsic_string_key(vm, "constructor"));
}

// --- Iterator.concat ---------------------------------------------------------

static MalValue mal_iterator_concat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    MalArrayObject *iterables = mal_intrinsic_new_array(vm, 0);
    MalArrayObject *methods = mal_intrinsic_new_array(vm, 0);

    // Validate every argument in order: each must be an Object exposing a
    // callable @@iterator (GetMethod). The methods are captured but not yet
    // called — they open lazily as iteration reaches each source.
    for (i32 i = 0; i < arg_count; i++) {
        MalValue item = args[i];
        if (!mal_value_is_object(item)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator.concat argument is not an object");
            return mal_value_new_undefined();
        }
        MalValue method;
        if (!mal_vm_get_property(vm, item, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &method)) {
            return mal_value_new_undefined();
        }
        // GetMethod: undefined/null means "no method", which concat rejects.
        if (mal_value_is_nil(method) || !mal_value_is_callable(method)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator.concat argument is not iterable");
            return mal_value_new_undefined();
        }
        mal_array_object_store(iterables, mal_key_index(i), item);
        mal_array_object_store(methods, mal_key_index(i), method);
    }

    // No underlying record: concat draws solely from its source list.
    MalIteratorRecord empty = {.iterator = mal_value_new_undefined(), .next_method = mal_value_new_undefined()};
    MalValue helper_value = mal_ih_new(vm, MAL_ITERATOR_HELPER_CONCAT, &empty, mal_value_new_undefined(), 0.0);
    MalIteratorHelperObject *helper = mal_value_to_iterator_helper_object(helper_value);
    helper->sources = mal_value_from_array_object(iterables);
    helper->source_methods = mal_value_from_array_object(methods);
    return helper_value;
}

/** Close every iterator collected so far (during input/padding setup). */
static void mal_ih_zip_close_collected(MalVm *vm, MalValue sources, MalValue methods, i32 count) {
    for (i32 i = count - 1; i >= 0; i--) {
        MalValue iter = mal_ih_zip_get(vm, sources, i);
        if (!mal_value_is_object(iter)) {
            continue;
        }
        MalIteratorRecord record = {.iterator = iter, .next_method = mal_ih_zip_get(vm, methods, i)};
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_vm_iterator_close(vm, &record);
        } else {
            mal_vm_iterator_close_normal(vm, &record);
        }
    }
}

/** GetOptionsObject + read "mode" and (for longest) "padding". */
static bool mal_ih_zip_read_options(MalVm *vm, MalValue options_arg, MalIteratorZipMode *mode_out, MalValue *padding_out) {
    MalValue options;
    if (mal_value_is_undefined(options_arg)) {
        options = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    } else if (mal_value_is_object(options_arg)) {
        options = options_arg;
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator.zip options is not an object");
        return false;
    }

    MalValue mode_value;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "mode"), &mode_value)) {
        return false;
    }
    MalIteratorZipMode mode = MAL_ITERATOR_ZIP_SHORTEST;
    if (mal_value_is_undefined(mode_value)) {
        mode = MAL_ITERATOR_ZIP_SHORTEST;
    } else if (mal_value_is_string(mode_value)) {
        MalString *string = mal_value_to_string(mode_value);
        if (mal_string_equals(string, mal_intrinsic_ascii(vm, "shortest"))) {
            mode = MAL_ITERATOR_ZIP_SHORTEST;
        } else if (mal_string_equals(string, mal_intrinsic_ascii(vm, "longest"))) {
            mode = MAL_ITERATOR_ZIP_LONGEST;
        } else if (mal_string_equals(string, mal_intrinsic_ascii(vm, "strict"))) {
            mode = MAL_ITERATOR_ZIP_STRICT;
        } else {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator.zip mode must be 'shortest', 'longest', or 'strict'");
            return false;
        }
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator.zip mode must be a string");
        return false;
    }

    MalValue padding = mal_value_new_undefined();
    if (mode == MAL_ITERATOR_ZIP_LONGEST) {
        if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "padding"), &padding)) {
            return false;
        }
        if (!mal_value_is_undefined(padding) && !mal_value_is_object(padding)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator.zip padding is not an object");
            return false;
        }
    }

    *mode_out = mode;
    *padding_out = padding;
    return true;
}

/**
 * Build the helper from collected input iterators (`sources`/`methods`, length
 * `count`) and the padding configuration. `padding_values` (length `count`, or
 * undefined) is the already-resolved padding for zipKeyed; for plain zip pass
 * undefined and the padding iterable is drained here. `keys` is undefined for
 * zip or the key array for zipKeyed. Closes the collected iterators on abrupt.
 */
static MalValue mal_ih_zip_assemble(MalVm *vm, MalValue sources, MalValue methods, i32 count, MalIteratorZipMode mode, MalValue padding_option, MalValue padding_values, MalValue keys) {
    MalValue padding = mal_value_new_undefined();
    if (mode == MAL_ITERATOR_ZIP_LONGEST) {
        MalArrayObject *padding_array = mal_intrinsic_new_array(vm, (u32) count);
        padding = mal_value_from_array_object(padding_array);
        if (!mal_value_is_undefined(padding_values)) {
            // zipKeyed: padding already resolved per key.
            for (i32 i = 0; i < count; i++) {
                mal_array_object_store(padding_array, mal_key_index(i), mal_ih_zip_get(vm, padding_values, i));
            }
        } else if (mal_value_is_undefined(padding_option)) {
            for (i32 i = 0; i < count; i++) {
                mal_array_object_store(padding_array, mal_key_index(i), mal_value_new_undefined());
            }
        } else {
            MalIteratorRecord pad_iter;
            if (!mal_vm_get_iterator(vm, padding_option, &pad_iter)) {
                mal_ih_zip_close_collected(vm, sources, methods, count);
                return mal_value_new_undefined();
            }
            i32 i = 0;
            bool exhausted = false;
            while (i < count) {
                MalValue value;
                bool done;
                if (!mal_vm_iterator_step(vm, &pad_iter, &value, &done)) {
                    mal_ih_zip_close_collected(vm, sources, methods, count);
                    return mal_value_new_undefined();
                }
                if (done) {
                    exhausted = true;
                    break;
                }
                mal_array_object_store(padding_array, mal_key_index(i++), value);
            }
            for (; i < count; i++) {
                mal_array_object_store(padding_array, mal_key_index(i), mal_value_new_undefined());
            }
            if (!exhausted) {
                mal_vm_iterator_close(vm, &pad_iter);
                if (vm->completion.kind == MAL_COMPLETION_THROW) {
                    mal_ih_zip_close_collected(vm, sources, methods, count);
                    return mal_value_new_undefined();
                }
            }
        }
    }

    MalIteratorRecord empty = {.iterator = mal_value_new_undefined(), .next_method = mal_value_new_undefined()};
    MalValue helper_value = mal_ih_new(vm, MAL_ITERATOR_HELPER_ZIP, &empty, mal_value_new_undefined(), 0.0);
    MalIteratorHelperObject *helper = mal_value_to_iterator_helper_object(helper_value);
    helper->sources = sources;
    helper->source_methods = methods;
    helper->zip_padding = padding;
    helper->zip_keys = keys;
    helper->zip_mode = mode;
    return helper_value;
}

static MalValue mal_iterator_zip(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    MalValue iterables = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(iterables)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator.zip called on a non-object");
        return mal_value_new_undefined();
    }

    MalIteratorZipMode mode;
    MalValue padding_option;
    if (!mal_ih_zip_read_options(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), &mode, &padding_option)) {
        return mal_value_new_undefined();
    }

    MalIteratorRecord input_iter;
    if (!mal_vm_get_iterator(vm, iterables, &input_iter)) {
        return mal_value_new_undefined();
    }

    MalValue sources = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalValue methods = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    i32 count = 0;
    while (true) {
        MalValue value;
        bool done;
        if (!mal_vm_iterator_step(vm, &input_iter, &value, &done)) {
            mal_ih_zip_close_collected(vm, sources, methods, count);
            return mal_value_new_undefined();
        }
        if (done) {
            break;
        }
        MalIteratorRecord record;
        if (!mal_ih_get_flattenable(vm, value, &record)) {
            mal_ih_zip_close_collected(vm, sources, methods, count);
            return mal_value_new_undefined();
        }
        mal_ih_zip_set(vm, sources, count, record.iterator);
        mal_ih_zip_set(vm, methods, count, record.next_method);
        count++;
    }

    return mal_ih_zip_assemble(vm, sources, methods, count, mode, padding_option, mal_value_new_undefined(), mal_value_new_undefined());
}

static MalValue mal_iterator_zip_keyed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    MalValue iterables = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(iterables)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator.zipKeyed called on a non-object");
        return mal_value_new_undefined();
    }

    MalIteratorZipMode mode;
    MalValue padding_option;
    if (!mal_ih_zip_read_options(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), &mode, &padding_option)) {
        return mal_value_new_undefined();
    }

    // Snapshot the enumerable own keys (string + symbol) in property order.
    MalKey collected[256];
    i32 key_count = 0;
    MalPropertyIter iter;
    mal_property_iter_init(&iter, mal_value_to_object(iterables), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
    MalKey iter_key;
    MalPropertyDesc desc;
    while (key_count < 256 && mal_property_iter_next(&iter, &iter_key, &desc)) {
        collected[key_count++] = iter_key;
    }

    MalValue sources = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalValue methods = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalValue keys = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalValue padding_values = mode == MAL_ITERATOR_ZIP_LONGEST
        ? mal_value_from_array_object(mal_intrinsic_new_array(vm, 0))
        : mal_value_new_undefined();

    i32 stored = 0;
    for (i32 i = 0; i < key_count; i++) {
        MalKey key = collected[i];
        MalValue value;
        if (!mal_vm_get_property(vm, iterables, key, &value)) {
            mal_ih_zip_close_collected(vm, sources, methods, stored);
            return mal_value_new_undefined();
        }
        // A key whose value is undefined is omitted from the result entirely.
        if (mal_value_is_undefined(value)) {
            continue;
        }
        MalIteratorRecord record;
        if (!mal_ih_get_flattenable(vm, value, &record)) {
            mal_ih_zip_close_collected(vm, sources, methods, stored);
            return mal_value_new_undefined();
        }
        mal_ih_zip_set(vm, sources, stored, record.iterator);
        mal_ih_zip_set(vm, methods, stored, record.next_method);
        MalValue key_value = key.kind == MAL_KEY_INDEX
            ? mal_value_from_string(mal_ops_to_string(&vm->heap, key.value))
            : key.value;
        mal_ih_zip_set(vm, keys, stored, key_value);

        if (mode == MAL_ITERATOR_ZIP_LONGEST) {
            MalValue pad = mal_value_new_undefined();
            if (mal_value_is_object(padding_option) && !mal_vm_get_property(vm, padding_option, key, &pad)) {
                mal_ih_zip_set(vm, sources, stored, record.iterator);
                mal_ih_zip_close_collected(vm, sources, methods, stored + 1);
                return mal_value_new_undefined();
            }
            mal_ih_zip_set(vm, padding_values, stored, pad);
        }
        stored++;
    }

    return mal_ih_zip_assemble(vm, sources, methods, stored, mode, padding_option, padding_values, keys);
}

static void mal_iterator_define_accessor(MalVm *vm, MalObject *object, MalKey key, MalNativeFunctionCallback getter, MalNativeFunctionCallback setter, const byte *get_name, const byte *set_name) {
    mal_intrinsic_define_accessor_n(
        vm, object, key, get_name, 0, getter, set_name, 1, setter,
        MAL_PROPERTY_CONFIGURABLE);
}

void mal_builtin_iterator_helpers_install(MalVm *vm) {
    MalObject *iterator_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE]);

    mal_intrinsic_define_method_n(vm, iterator_prototype, "map", 1, mal_ih_method_map);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "filter", 1, mal_ih_method_filter);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "take", 1, mal_ih_method_take);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "drop", 1, mal_ih_method_drop);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "flatMap", 1, mal_ih_method_flatmap);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "reduce", 1, mal_ih_method_reduce);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "toArray", 0, mal_ih_method_to_array);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "forEach", 1, mal_ih_method_for_each);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "some", 1, mal_ih_method_some);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "every", 1, mal_ih_method_every);
    mal_intrinsic_define_method_n(vm, iterator_prototype, "find", 1, mal_ih_method_find);

    mal_iterator_define_accessor(vm, iterator_prototype, mal_intrinsic_string_key(vm, "constructor"), mal_iterator_ctor_get, mal_iterator_ctor_set, "get constructor", "set constructor");
    mal_iterator_define_accessor(vm, iterator_prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), mal_iterator_tag_get, mal_iterator_tag_set, "get [Symbol.toStringTag]", "set [Symbol.toStringTag]");

    // %IteratorHelperPrototype%: shared next/return, inherits %IteratorPrototype%.
    MalObject *helper_prototype = mal_object_new(&vm->heap, iterator_prototype);
    vm->intrinsics[MAL_INTRINSIC_ITERATOR_HELPER_PROTOTYPE] = mal_value_from_object(helper_prototype);
    mal_intrinsic_define_method_n(vm, helper_prototype, "next", 0, mal_ih_proto_next);
    mal_intrinsic_define_method_n(vm, helper_prototype, "return", 0, mal_ih_proto_return);
    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "Iterator Helper")),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(helper_prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "Iterator"),
        0,
        mal_iterator_constructor
    );
    vm->intrinsics[MAL_INTRINSIC_ITERATOR_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "from", 1, mal_iterator_from);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "concat", 0, mal_iterator_concat);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "zip", 1, mal_iterator_zip);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "zipKeyed", 1, mal_iterator_zip_keyed);
}
