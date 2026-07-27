#include "builtin_iterator.h"

#include "array_object.h"
#include "builtin_array.h"
#include "builtin_regexp.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "map_object.h"
#include "typed_array_object.h"
#include "value_ops.h"

MalNativeFunctionCallback mal_array_iterator_next_callback = nullptr;
#include "vm.h"
#include "vm_ops.h"
#include "utf16.h"

MalValue mal_vm_create_iter_result(MalVm *vm, MalValue value, bool done) {
    MalValue values[2] = {value, mal_value_new_boolean(done)};
    MalRootSpan span;
    mal_gc_root(&span, values, 2);
    if (vm->iterator_result_shape == nullptr) {
        MalString *keys[2] = {
            mal_intrinsic_hot_ascii(vm, MAL_HOT_KEY_VALUE),
            mal_intrinsic_hot_ascii(vm, MAL_HOT_KEY_DONE),
        };
        vm->iterator_result_shape = mal_shape_from_string_keys(keys, 2);
    }
    MalValue result =
        mal_vm_create_object_shaped(vm, vm->iterator_result_shape, values, 2);
    mal_gc_unroot(&span);
    return result;
}

static MalIntrinsic mal_vm_iterator_prototype_slot(MalIteratorKind kind) {
    switch (kind) {
        case MAL_ITERATOR_MAP_KEYS:
        case MAL_ITERATOR_MAP_VALUES:
        case MAL_ITERATOR_MAP_ENTRIES:
            return MAL_INTRINSIC_MAP_ITERATOR_PROTOTYPE;
        case MAL_ITERATOR_SET_VALUES:
        case MAL_ITERATOR_SET_ENTRIES:
            return MAL_INTRINSIC_SET_ITERATOR_PROTOTYPE;
        case MAL_ITERATOR_ARRAY_KEYS:
        case MAL_ITERATOR_ARRAY_VALUES:
        case MAL_ITERATOR_ARRAY_ENTRIES:
            return MAL_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE;
        case MAL_ITERATOR_STRING_VALUES:
            return MAL_INTRINSIC_STRING_ITERATOR_PROTOTYPE;
    }

    return MAL_INTRINSIC_ITERATOR_PROTOTYPE;
}

MalValue mal_vm_new_builtin_iterator(MalVm *vm, MalIteratorKind kind, MalValue target) {
    MalIteratorObject *iterator = mal_iterator_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[mal_vm_iterator_prototype_slot(kind)]),
        kind,
        target
    );

    return mal_value_from_iterator_object(iterator);
}

static MalValue mal_builtin_iterator_pair(MalVm *vm, MalValue first, MalValue second) {
    MalArrayObject *pair = mal_intrinsic_new_array(vm, 2);
    mal_object_set((MalObject *) pair, mal_key_index(0), first);
    mal_object_set((MalObject *) pair, mal_key_index(1), second);

    return mal_value_from_array_object(pair);
}

// The builtin iterator `next` functions are factored into an "advance" core that
// writes (value, done) directly into out-params instead of allocating a
// {value,done} result object. The public `next` methods wrap the result
// (CreateIterResultObject), while `mal_vm_iterator_step`'s fast path consumes the
// (value, done) pair directly — skipping the per-step result-object allocation.
// Each returns false (with vm->completion set THROW) on a throwing element/length
// access. The full advance runs with collection suppressed (see iterator_step), so
// values held across an internal allocation (an entries pair) are not swept.

static bool mal_builtin_iterator_map_advance(
    MalVm *vm, MalIteratorObject *iterator, MalValue *value_out, bool *done_out
) {
    MalMapObject *map = mal_value_to_map_object(iterator->target);

    MalTableIter table_iter;
    mal_table_iter_init(&table_iter, map->entries, MAL_TABLE_ITER_STORAGE);
    table_iter.index = (usize) iterator->index;

    MalKey key;
    void *entry;
    if (!mal_table_iter_next(&table_iter, &key, &entry)) {
        iterator->done = true;
        *value_out = mal_value_new_undefined();
        *done_out = true;
        return true;
    }

    iterator->index = (u64) table_iter.index;
    *done_out = false;

    switch (iterator->kind) {
        case MAL_ITERATOR_MAP_KEYS:
        case MAL_ITERATOR_SET_VALUES:
            *value_out = key.value;
            return true;
        case MAL_ITERATOR_MAP_VALUES:
            *value_out = mal_table_entry_value(map->entries, entry);
            return true;
        case MAL_ITERATOR_MAP_ENTRIES:
            *value_out =
                mal_builtin_iterator_pair(vm, key.value, mal_table_entry_value(map->entries, entry));
            return true;
        case MAL_ITERATOR_SET_ENTRIES:
            *value_out = mal_builtin_iterator_pair(vm, key.value, key.value);
            return true;
        default:
            *value_out = mal_value_new_undefined();
            *done_out = true;
            return true;
    }
}

static bool mal_builtin_iterator_array_advance(
    MalVm *vm, MalIteratorObject *iterator, MalValue *value_out, bool *done_out
) {
    // Fast path: a real array (not an array-like the iterator was .call'd on) reads
    // its live length from the header and a present element straight from the dense
    // vector — no Get calls. A KEYS or VALUES step needs no allocation; ENTRIES (a
    // pair), a hole, or an out-of-dense index falls through to the Get-based path.
    if (mal_value_is_heap_type(iterator->target, MAL_HEAP_ARRAY_OBJECT) &&
        iterator->kind != MAL_ITERATOR_ARRAY_ENTRIES) {
        MalArrayObject *array = (MalArrayObject *) mal_value_to_heap(iterator->target);
        u64 index = iterator->index;
        if (index >= array->length) {
            iterator->done = true;
            *value_out = mal_value_new_undefined();
            *done_out = true;
            return true;
        }
        if (iterator->kind == MAL_ITERATOR_ARRAY_KEYS) {
            iterator->index++;
            *value_out = mal_value_from_i32((i32) index);
            *done_out = false;
            return true;
        }
        MalValue element;
        if (mal_array_object_dense_get(array, (u32) index, &element)) {
            iterator->index++;
            *value_out = element; // MAL_ITERATOR_ARRAY_VALUES
            *done_out = false;
            return true;
        }
        // Hole / beyond the dense region (still < length): fall through so the
        // Get-based path reads it (prototype-aware → undefined for a clean hole).
    }

    if (mal_value_is_typed_array_object(iterator->target) &&
        mal_typed_array_object_is_out_of_bounds(
            mal_value_to_typed_array_object(iterator->target))) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "TypedArray iterator target is out of bounds");
        return false;
    }

    // Length reads live each step, so growth during iteration is visited.
    MalValue length_value;
    if (!mal_vm_get_property(vm, iterator->target, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_LENGTH), &length_value)) {
        return false;
    }

    f64 length = mal_ops_to_number(length_value);
    if (!(length > 0)) {
        length = 0;
    }

    if ((f64) iterator->index >= length) {
        iterator->done = true;
        *value_out = mal_value_new_undefined();
        *done_out = true;
        return true;
    }

    u64 index = iterator->index;
    iterator->index++;
    *done_out = false;

    if (iterator->kind == MAL_ITERATOR_ARRAY_KEYS) {
        *value_out = mal_value_from_i32((i32) index);
        return true;
    }

    MalValue element;
    if (!mal_vm_get_property(
        vm,
        iterator->target,
        mal_key_index(index),
        &element
    )) {
        return false;
    }

    if (iterator->kind == MAL_ITERATOR_ARRAY_ENTRIES) {
        *value_out = mal_builtin_iterator_pair(vm, mal_value_from_i32((i32) index), element);
        return true;
    }

    *value_out = element;
    return true;
}

static bool mal_builtin_iterator_string_advance(
    MalVm *vm, MalIteratorObject *iterator, MalValue *value_out, bool *done_out
) {
    MalString *string = mal_value_to_string(iterator->target);
    usize length = mal_string_length(string);
    usize index = (usize) iterator->index;

    if (index >= length) {
        iterator->done = true;
        *value_out = mal_value_new_undefined();
        *done_out = true;
        return true;
    }

    const c16 *code_units = mal_string_code_units(string);
    usize count = mal_utf16_code_point_width(code_units, length, index);

    iterator->index += count;
    *done_out = false;
    *value_out = mal_value_from_string(
        count == 1
            ? mal_intrinsic_code_unit(vm, code_units[index])
            : mal_string_new_slice(&vm->heap, string, index, count)
    );
    return true;
}

/**
 * Advance a builtin iterator one step, writing (value, done) without allocating a
 * result object. Dispatches on the iterator's own kind (no family check — callers
 * have already established the receiver matches). Returns false with
 * vm->completion set on a throwing access.
 */
static bool mal_builtin_iterator_object_advance(
    MalVm *vm, MalIteratorObject *iterator, MalValue *value_out, bool *done_out
) {
    if (iterator->done) {
        *value_out = mal_value_new_undefined();
        *done_out = true;
        return true;
    }

    switch (iterator->kind) {
        case MAL_ITERATOR_MAP_KEYS:
        case MAL_ITERATOR_MAP_VALUES:
        case MAL_ITERATOR_MAP_ENTRIES:
        case MAL_ITERATOR_SET_VALUES:
        case MAL_ITERATOR_SET_ENTRIES:
            return mal_builtin_iterator_map_advance(vm, iterator, value_out, done_out);
        case MAL_ITERATOR_ARRAY_KEYS:
        case MAL_ITERATOR_ARRAY_VALUES:
        case MAL_ITERATOR_ARRAY_ENTRIES:
            return mal_builtin_iterator_array_advance(vm, iterator, value_out, done_out);
        case MAL_ITERATOR_STRING_VALUES:
            return mal_builtin_iterator_string_advance(vm, iterator, value_out, done_out);
    }

    *value_out = mal_value_new_undefined();
    *done_out = true;
    return true;
}

/**
 * Shared next() implementation. family_first/family_last bound the iterator
 * kinds each prototype's next accepts, so e.g. %MapIteratorPrototype%.next
 * rejects a Set iterator receiver. Wraps the (value, done) advance core in a
 * result object.
 */
static MalValue mal_builtin_iterator_next(
    MalVm *vm,
    MalValue this_value,
    MalIteratorKind family_first,
    MalIteratorKind family_last,
    const byte *family_name
) {
    if (!mal_value_is_iterator_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, family_name);
        return mal_value_new_undefined();
    }

    MalIteratorObject *iterator = mal_value_to_iterator_object(this_value);
    if (iterator->kind < family_first || iterator->kind > family_last) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, family_name);
        return mal_value_new_undefined();
    }

    MalValue value;
    bool done;
    if (!mal_builtin_iterator_object_advance(vm, iterator, &value, &done)) {
        return mal_value_new_undefined();
    }
    return mal_vm_create_iter_result(vm, value, done);
}

static MalValue mal_builtin_map_iterator_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_iterator_next(vm, this_value, MAL_ITERATOR_MAP_KEYS, MAL_ITERATOR_MAP_ENTRIES, "Receiver is not a Map iterator");
}

static MalValue mal_builtin_set_iterator_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_iterator_next(vm, this_value, MAL_ITERATOR_SET_VALUES, MAL_ITERATOR_SET_ENTRIES, "Receiver is not a Set iterator");
}

static MalValue mal_builtin_array_iterator_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_iterator_next(vm, this_value, MAL_ITERATOR_ARRAY_KEYS, MAL_ITERATOR_ARRAY_ENTRIES, "Receiver is not an Array iterator");
}

static MalValue mal_builtin_string_iterator_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_iterator_next(vm, this_value, MAL_ITERATOR_STRING_VALUES, MAL_ITERATOR_STRING_VALUES, "Receiver is not a String iterator");
}

/**
 * The builtin `next` callback installed on the prototype of an iterator of the
 * given kind. `mal_vm_iterator_step` compares an iterator's captured next method
 * against this to decide whether it may advance the iterator directly (bypassing
 * the result-object allocation) — sound only when the method is that exact
 * builtin. Returning the callback keyed on the iterator's OWN kind means a
 * matching pointer also implies the right family, so calling it would not throw.
 */
static MalNativeFunctionCallback mal_builtin_iterator_expected_next(MalIteratorKind kind) {
    switch (kind) {
        case MAL_ITERATOR_MAP_KEYS:
        case MAL_ITERATOR_MAP_VALUES:
        case MAL_ITERATOR_MAP_ENTRIES:
            return mal_builtin_map_iterator_next;
        case MAL_ITERATOR_SET_VALUES:
        case MAL_ITERATOR_SET_ENTRIES:
            return mal_builtin_set_iterator_next;
        case MAL_ITERATOR_ARRAY_KEYS:
        case MAL_ITERATOR_ARRAY_VALUES:
        case MAL_ITERATOR_ARRAY_ENTRIES:
            return mal_builtin_array_iterator_next;
        case MAL_ITERATOR_STRING_VALUES:
            return mal_builtin_string_iterator_next;
    }
    return nullptr;
}

static MalValue mal_builtin_iterator_prototype_iterator(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) args;
    (void) arg_count;
    return this_value;
}

bool mal_vm_get_iterator(MalVm *vm, MalValue value, MalIteratorRecord *record_out) {
    MalValue method;
    if (!mal_vm_get_property(vm, value, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &method)) {
        return false;
    }

    return mal_vm_get_iterator_from_method(vm, value, method, record_out);
}

bool mal_vm_get_iterator_from_method(
    MalVm *vm, MalValue value, MalValue method, MalIteratorRecord *record_out) {
    if (!mal_value_is_callable(method)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not iterable");
        return false;
    }

    MalCompletion completion = mal_vm_call_value(vm, method, value, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return false;
    }

    if (!mal_value_is_object(completion.value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator is not an object");
        return false;
    }

    MalValue roots[2] = {completion.value, mal_value_new_undefined()};
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 2);
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_NEXT), &roots[1])) {
        mal_gc_unroot(&roots_span);
        return false;
    }

    record_out->iterator = roots[0];
    record_out->next_method = roots[1];
    mal_gc_unroot(&roots_span);

    return true;
}

bool mal_vm_iterator_step(MalVm *vm, const MalIteratorRecord *record, MalValue *value_out, bool *done_out) {
    *value_out = mal_value_new_undefined();
    *done_out = false;

    // Fast path: a builtin iterator whose captured `next` is still its own builtin
    // method. Advancing it directly is observably identical to calling next() — the
    // method's only effect is producing the {value,done} — but skips that per-step
    // result-object allocation and the call dispatch. The callback-identity check
    // makes it robust: an overridden next, a cross-wired receiver, or any
    // non-builtin iterator fails it and falls through to the generic protocol.
    // Collection is suppressed across the advance exactly as across the equivalent
    // native next() call (the iterator internals — e.g. building an entries pair —
    // assume that), so a value held mid-step cannot be swept.
    if (mal_value_is_iterator_object(record->iterator) &&
        mal_value_is_native_function_object(record->next_method)) {
        MalIteratorObject *iterator = mal_value_to_iterator_object(record->iterator);
        MalNativeFunctionCallback next_callback =
            mal_native_function_object_callback(mal_value_to_native_function_object(record->next_method));
        if (next_callback == mal_builtin_iterator_expected_next(iterator->kind)) {
            vm->gc_native_frames++;
            bool ok = mal_builtin_iterator_object_advance(vm, iterator, value_out, done_out);
            vm->gc_native_frames--;
            return ok;
        }
    }

    int regexp_step = mal_regexp_try_exact_iterator_step(
        vm, record->iterator, record->next_method, value_out, done_out);
    if (regexp_step != 0) {
        return regexp_step > 0;
    }

    MalCompletion completion = mal_vm_call_value(vm, record->next_method, record->iterator, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return false;
    }

    if (!mal_value_is_object(completion.value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator result is not an object");
        return false;
    }

    MalValue done;
    if (!mal_vm_get_property(vm, completion.value, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_DONE), &done)) {
        return false;
    }

    if (mal_value_is_truthy(done)) {
        *done_out = true;
        return true;
    }

    return mal_vm_get_property(
        vm, completion.value, mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_VALUE), value_out);
}

static bool mal_vm_iterator_close_normal_impl(MalVm *vm, const MalIteratorRecord *record);

void mal_vm_iterator_close(MalVm *vm, const MalIteratorRecord *record) {
    // The pending completion (usually a throw) must survive the return()
    // call, and the sticky-throw guard would refuse calls while it is set.
    MalCompletion pending = vm->completion;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};

    // Clearing vm->completion drops the only root for the pending throw value, and
    // return() re-enters JS (which can collect), so root it (and the record's
    // iterator/next_method) across the call. Cast away const: the scan only reads.
    MalRootSpan pending_span, record_span;
    mal_gc_root(&pending_span, &pending.value, 1);
    mal_gc_root(&record_span, (MalValue *) &record->iterator, 2);

    MalValue return_method;
    if (mal_vm_get_property(vm, record->iterator, mal_intrinsic_string_key(vm, "return"), &return_method) &&
        mal_value_is_callable(return_method)) {
        mal_vm_call_value(vm, return_method, record->iterator, nullptr, 0);
    }

    mal_gc_unroot(&record_span);
    mal_gc_unroot(&pending_span);

    // Secondary errors from return() are swallowed in favor of the original.
    vm->completion = pending;
}

bool mal_vm_iterator_close_normal(MalVm *vm, const MalIteratorRecord *record) {
    // return() re-enters JS and can collect; root the record's iterator/next_method
    // so the caller's record stays valid across the call (the caller roots any
    // value it carries past the close itself).
    MalRootSpan record_span;
    mal_gc_root(&record_span, (MalValue *) &record->iterator, 2);
    bool result = mal_vm_iterator_close_normal_impl(vm, record);
    mal_gc_unroot(&record_span);
    return result;
}

static bool mal_vm_iterator_close_normal_impl(MalVm *vm, const MalIteratorRecord *record) {
    MalValue return_method;
    if (!mal_vm_get_property(vm, record->iterator, mal_intrinsic_string_key(vm, "return"), &return_method)) {
        return false; // a throwing return getter propagates
    }

    // GetMethod: undefined/null means "no return", which is a no-op close.
    if (mal_value_is_nil(return_method)) {
        return true;
    }

    if (!mal_value_is_callable(return_method)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator return is not a function");
        return false;
    }

    MalCompletion completion = mal_vm_call_value(vm, return_method, record->iterator, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return false; // a throwing return propagates
    }

    if (!mal_value_is_object(completion.value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator return result is not an object");
        return false;
    }

    return true;
}

static MalObject *mal_builtin_iterator_prototype_new(MalVm *vm, MalIntrinsic slot, MalObject *parent, const byte *tag) {
    MalObject *prototype = mal_object_new(&vm->heap, parent);
    vm->intrinsics[slot] = mal_value_from_object(prototype);

    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, tag)),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    return prototype;
}

void mal_builtin_iterator_install(MalVm *vm) {
    MalObject *iterator_prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE] = mal_value_from_object(iterator_prototype);
    mal_intrinsic_define_symbol_method(vm, iterator_prototype, MAL_INTRINSIC_SYMBOL_ITERATOR, "[Symbol.iterator]", mal_builtin_iterator_prototype_iterator);

    MalObject *map_iterator = mal_builtin_iterator_prototype_new(vm, MAL_INTRINSIC_MAP_ITERATOR_PROTOTYPE, iterator_prototype, "Map Iterator");
    mal_intrinsic_define_method_n(vm, map_iterator, "next", 0, mal_builtin_map_iterator_next);

    MalObject *set_iterator = mal_builtin_iterator_prototype_new(vm, MAL_INTRINSIC_SET_ITERATOR_PROTOTYPE, iterator_prototype, "Set Iterator");
    mal_intrinsic_define_method_n(vm, set_iterator, "next", 0, mal_builtin_set_iterator_next);

    MalObject *array_iterator = mal_builtin_iterator_prototype_new(vm, MAL_INTRINSIC_ARRAY_ITERATOR_PROTOTYPE, iterator_prototype, "Array Iterator");
    mal_intrinsic_define_method_n(vm, array_iterator, "next", 0, mal_builtin_array_iterator_next);
    // Cache the array-iterator next for the inline iterator-step fast path's
    // protocol-intact check (mal_vm_iterator_step_fast).
    mal_array_iterator_next_callback = mal_builtin_array_iterator_next;

    MalObject *string_iterator = mal_builtin_iterator_prototype_new(vm, MAL_INTRINSIC_STRING_ITERATOR_PROTOTYPE, iterator_prototype, "String Iterator");
    mal_intrinsic_define_method_n(vm, string_iterator, "next", 0, mal_builtin_string_iterator_next);
}
