#include "builtin_iterator.h"

#include <assert.h>

#include "array_object.h"
#include "builtin_array.h"
#include "builtin_generator.h"
#include "builtin_iterator_helpers.h"
#include "builtin_regexp.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "map_object.h"
#include "set_object.h"
#include "perf_stats.h"
#include "typed_array_object.h"
#include "value_ops.h"

#include "vm.h"
#include "vm_ops.h"
#include "utf16.h"

MalValue mal_vm_create_iter_result(MalVm *vm, MalValue value, bool done) {
    MalValue values[2] = {value, mal_value_new_boolean(done)};
    if (vm->iterator_result_shape == nullptr) {
        MalString *keys[2] = {
            mal_intrinsic_hot_ascii(vm, MAL_HOT_KEY_VALUE),
            mal_intrinsic_hot_ascii(vm, MAL_HOT_KEY_DONE),
        };
        vm->iterator_result_shape = mal_shape_from_string_keys(&vm->heap, keys, 2);
    }
    MAL_PERF_COUNT(object_shaped_creations);
    MalObject *prototype =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    // Allocation cannot collect before the local value pair is copied into the cell.
    return mal_value_from_object(mal_object_new_shaped(
        &vm->heap, prototype, vm->iterator_result_shape, values, 2));
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

    if (mal_value_is_array_object(target)) {
        mal_perf_collection_iteration_start(mal_value_to_array_object(target));
    } else if (mal_value_is_map_object(target) || mal_value_is_set_object(target)) {
        mal_perf_collection_iteration_start(mal_value_to_object(target));
    }

    return mal_value_from_iterator_object(iterator);
}

static MalValue mal_builtin_iterator_pair(MalVm *vm, MalValue first, MalValue second) {
    return mal_value_from_array_object(
        mal_intrinsic_new_dense_pair(vm, first, second));
}

// The builtin iterator `next` functions are factored into an "advance" core that
// writes (value, done) directly into out-params instead of allocating a
// {value,done} result object. The public `next` methods wrap the result
// (CreateIterResultObject), while `mal_vm_iterator_step`'s fast path consumes the
// (value, done) pair directly — skipping the per-step result-object allocation.
// Each returns false (with vm->completion set THROW) on a throwing element/length
// access. The full advance runs with collection suppressed (see iterator_step), so
// values held across an internal allocation (an entries pair) are not swept.

static void mal_builtin_iterator_set_take_entry(
    MalIteratorObject *iterator,
    MalValue *key_out,
    bool *done_out
) {
    MalSetObject *set = mal_value_to_set_object(iterator->target);
    MalSetIter iter;
    mal_set_iter_init(&iter, set->entries);
    iter.index = (usize) iterator->index;
    if (!mal_set_iter_next(&iter, key_out)) {
        iterator->done = true;
        mal_iterator_object_release_collection_pin(iterator);
        *key_out = MAL_VALUE_UNDEFINED;
        *done_out = true;
        return;
    }
    iterator->index = (u64) iter.index;
    mal_perf_collection_iteration_step(set);
    *done_out = false;
}

static inline __attribute__((always_inline)) void mal_builtin_iterator_map_take_entry(
    MalIteratorObject *iterator,
    MalValue *key_out,
    MalValue *mapped_out,
    bool *done_out
) {
    MalMapObject *map = mal_value_to_map_object(iterator->target);
    MalMapIter map_iter;
    mal_map_iter_init(&map_iter, map->entries);
    map_iter.index = (usize) iterator->index;

    if (!mal_map_iter_next(&map_iter, key_out, mapped_out)) {
        iterator->done = true;
        mal_iterator_object_release_collection_pin(iterator);
        *key_out = mal_value_new_undefined();
        *mapped_out = mal_value_new_undefined();
        *done_out = true;
        return;
    }

    iterator->index = (u64) map_iter.index;
    mal_perf_collection_iteration_step(map);
    *done_out = false;
}

static bool mal_builtin_iterator_map_advance(
    MalVm *vm, MalIteratorObject *iterator, MalValue *value_out, bool *done_out
) {
    MalValue key;
    MalValue mapped;
    mal_builtin_iterator_map_take_entry(iterator, &key, &mapped, done_out);
    if (*done_out) {
        *value_out = mal_value_new_undefined();
        return true;
    }

    switch (iterator->kind) {
        case MAL_ITERATOR_MAP_KEYS:
            *value_out = key;
            return true;
        case MAL_ITERATOR_MAP_VALUES:
            *value_out = mapped;
            return true;
        case MAL_ITERATOR_MAP_ENTRIES:
            *value_out = mal_builtin_iterator_pair(vm, key, mapped);
            return true;
        default:
            *value_out = mal_value_new_undefined();
            *done_out = true;
            return true;
    }
}

static bool mal_builtin_iterator_set_advance(
    MalVm *vm, MalIteratorObject *iterator, MalValue *value_out, bool *done_out
) {
    mal_builtin_iterator_set_take_entry(iterator, value_out, done_out);
    if (!*done_out && iterator->kind == MAL_ITERATOR_SET_ENTRIES) {
        *value_out = mal_builtin_iterator_pair(vm, *value_out, *value_out);
    }
    return true;
}

static bool mal_builtin_iterator_array_advance(
    MalVm *vm, MalIteratorObject *iterator, MalValue *value_out, bool *done_out
) {
    // Fast path: a real array (not an array-like the iterator was .call'd on) reads
    // its live length from the header and a present element straight from the dense
    // vector — no Get calls. A hole or out-of-dense index falls through to the
    // Get-based path so inherited indexed properties remain observable.
    if (mal_value_is_array_object(iterator->target)) {
        MalArrayObject *array = mal_value_to_array_object(iterator->target);
        u64 index = iterator->index;
        if (index >= array->length) {
            iterator->done = true;
            *value_out = mal_value_new_undefined();
            *done_out = true;
            return true;
        }
        if (iterator->kind == MAL_ITERATOR_ARRAY_KEYS) {
            iterator->index++;
            *value_out = mal_ops_number_value((f64) index);
            *done_out = false;
            mal_perf_collection_iteration_step(array);
            return true;
        }
        MalValue element;
        if (mal_array_object_dense_get(array, (u32) index, &element)) {
            iterator->index++;
            *value_out = iterator->kind == MAL_ITERATOR_ARRAY_ENTRIES
                ? mal_builtin_iterator_pair(
                    vm, mal_ops_number_value((f64) index), element)
                : element;
            *done_out = false;
            mal_perf_collection_iteration_step(array);
            return true;
        }
        // Hole / beyond the dense region (still < length): fall through so the
        // Get-based path reads it (prototype-aware → undefined for a clean hole).
    }

    if (mal_value_is_typed_array_object(iterator->target)) {
        MalTypedArrayObject *array =
            mal_value_to_typed_array_object(iterator->target);
        if (mal_typed_array_object_is_out_of_bounds(array)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "TypedArray iterator target is out of bounds");
            return false;
        }
        u64 index = iterator->index;
        if (index >= mal_typed_array_object_length(array)) {
            iterator->done = true;
            *value_out = mal_value_new_undefined();
            *done_out = true;
            return true;
        }
        iterator->index++;
        *done_out = false;
        if (iterator->kind == MAL_ITERATOR_ARRAY_KEYS) {
            *value_out = mal_ops_number_value((f64) index);
            return true;
        }
        MalValue element = mal_typed_array_object_get(vm, array, (u32) index);
        *value_out = iterator->kind == MAL_ITERATOR_ARRAY_ENTRIES
            ? mal_builtin_iterator_pair(
                vm, mal_ops_number_value((f64) index), element)
            : element;
        return true;
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
        *value_out = mal_ops_number_value((f64) index);
        if (mal_value_is_array_object(iterator->target)) {
            mal_perf_collection_iteration_step(
                mal_value_to_array_object(iterator->target));
        }
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
        *value_out = mal_builtin_iterator_pair(
            vm, mal_ops_number_value((f64) index), element);
        if (mal_value_is_array_object(iterator->target)) {
            mal_perf_collection_iteration_step(
                mal_value_to_array_object(iterator->target));
        }
        return true;
    }

    *value_out = element;
    if (mal_value_is_array_object(iterator->target)) {
        mal_perf_collection_iteration_step(
            mal_value_to_array_object(iterator->target));
    }
    return true;
}

static c16 mal_builtin_iterator_string_unit(
    MalIteratorObject *iterator, MalString *string, usize index
) {
    if (iterator->string_cursor == nullptr) {
        if (string->storage == MAL_STRING_STORAGE_DEPENDENT) {
            index += string->slice_offset;
            string = string->parent;
        }
        return mal_string_flat_code_unit_at(string, index);
    }
    MalStringCursor *cursor = iterator->string_cursor;
    MalStringIterator *frontier = cursor->iterator;
    if (cursor->local == frontier->current.length) {
        MalStringSegment segment;
        if (!mal_string_cursor_segment(cursor, &segment)) abort();
    }
    c16 unit = mal_string_flat_code_unit_at(frontier->current.string,
        frontier->current.offset + cursor->local++);
    cursor->position++;
    return unit;
}

static bool mal_builtin_iterator_string_advance(
    MalVm *vm, MalIteratorObject *iterator, MalValue *value_out, bool *done_out
) {
    MalString *string = mal_value_to_string(iterator->target);
    usize length = mal_string_length(string);
    usize index = (usize) iterator->index;

    if (index >= length) {
        iterator->done = true;
        if (iterator->string_cursor != nullptr) {
            mal_string_cursor_dispose(iterator->string_cursor);
            mal_gc_write_barrier(mal_value_from_heap(&iterator->string_cursor->header));
            iterator->string_cursor = nullptr;
        }
        *value_out = mal_value_new_undefined();
        *done_out = true;
        return true;
    }

    if (iterator->string_cursor == nullptr && string->storage == MAL_STRING_STORAGE_CONS) {
        iterator->string_cursor = mal_string_cursor_new(&vm->heap, string);
        mal_gc_card(&iterator->object.header,
            mal_value_from_heap(&iterator->string_cursor->header));
    }
    c16 units[2] = {mal_builtin_iterator_string_unit(iterator, string, index), 0};
    usize count = 1;
    if (mal_utf16_is_lead_surrogate(units[0]) && index + 1 < length) {
        units[1] = mal_builtin_iterator_string_unit(iterator, string, index + 1);
        if (mal_utf16_is_trail_surrogate(units[1])) count = 2;
        else if (iterator->string_cursor != nullptr) {
            // The lookahead can enter the next leaf; leave its first unit pending.
            iterator->string_cursor->local--;
            iterator->string_cursor->position--;
        }
    }

    iterator->index += count;
    *done_out = false;
    *value_out = mal_value_from_string(
        count == 1
            ? mal_intrinsic_code_unit(vm, units[0])
            : mal_string_new_copy(&vm->heap, units, count)
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
            return mal_builtin_iterator_map_advance(vm, iterator, value_out, done_out);
        case MAL_ITERATOR_SET_VALUES:
        case MAL_ITERATOR_SET_ENTRIES:
            return mal_builtin_iterator_set_advance(vm, iterator, value_out, done_out);
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

// A builtin iterator still driven by its intrinsic next method.
static inline __attribute__((always_inline)) MalIteratorObject *mal_vm_iterator_exact_cursor(
    const MalIteratorRecord *record
) {
    if (!mal_value_is_iterator_object(record->iterator) ||
        !mal_value_is_native_function_object(record->next_method)) {
        return nullptr;
    }
    MalIteratorObject *cursor = mal_value_to_iterator_object(record->iterator);
    if (mal_native_function_object_callback(
            mal_value_to_native_function_object(record->next_method)) !=
        mal_builtin_iterator_expected_next(cursor->kind)) {
        return nullptr;
    }
    return cursor;
}

MalIteratorObject *mal_vm_iterator_protocol_cursor(
    const MalIteratorRecord *record, MalIteratorCursorProtocol protocol
) {
    MalIteratorObject *iterator = mal_vm_iterator_exact_cursor(record);
    if (iterator == nullptr) return nullptr;
    switch (protocol) {
        case MAL_ITERATOR_CURSOR_ARRAY_VALUES:
            return iterator->kind == MAL_ITERATOR_ARRAY_VALUES &&
                    mal_value_is_array_object(iterator->target)
                ? iterator
                : nullptr;
        case MAL_ITERATOR_CURSOR_STRING_VALUES:
            return iterator->kind == MAL_ITERATOR_STRING_VALUES &&
                    mal_value_is_string(iterator->target)
                ? iterator
                : nullptr;
        case MAL_ITERATOR_CURSOR_TYPED_ARRAY_VALUES:
            return iterator->kind == MAL_ITERATOR_ARRAY_VALUES &&
                    mal_value_is_typed_array_object(iterator->target)
                ? iterator
                : nullptr;
        case MAL_ITERATOR_CURSOR_MAP:
            return iterator->kind >= MAL_ITERATOR_MAP_KEYS &&
                    iterator->kind <= MAL_ITERATOR_MAP_ENTRIES &&
                    mal_value_is_map_object(iterator->target)
                ? iterator
                : nullptr;
        case MAL_ITERATOR_CURSOR_SET:
            return iterator->kind >= MAL_ITERATOR_SET_VALUES &&
                    iterator->kind <= MAL_ITERATOR_SET_ENTRIES &&
                    mal_value_is_set_object(iterator->target)
                ? iterator
                : nullptr;
    }
    return nullptr;
}

bool mal_vm_array_values_deferred_begin(
    MalVm *vm, MalValue source, MalArrayValuesDeferredCursor *cursor
) {
    cursor->active = false;
    if (!mal_value_is_array_object(source)) return false;
    MalObject *object = mal_value_to_object(source);
    // The protector covers Array.prototype @@iterator and ArrayIterator next/return.
    if (!object->for_in_keys &&
        (!mal_vm_primitive_methods_intact(vm) ||
         mal_object_prototype(object) !=
             mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]) ||
         ((object->shape->inline_count != 0 || mal_object_overflow(object) != nullptr) &&
          mal_object_get_own(
              object, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR)).present))) {
        return false;
    }
    cursor->index = 0;
    cursor->done = false;
    cursor->active = true;
    MAL_PERF_COUNT(iterator_deferred_array_begins);
    mal_perf_collection_iteration_start(mal_value_to_array_object(source));
    return true;
}

bool mal_vm_array_values_deferred_get(
    MalVm *vm, MalValue array, u64 index, MalValue *value_out
) {
    if (!mal_vm_get_property(vm, array, mal_key_index(index), value_out)) {
        return false;
    }
    mal_perf_collection_iteration_step(mal_value_to_array_object(array));
    return true;
}

bool mal_vm_array_values_deferred_close(
    MalVm *vm,
    MalValue array,
    const MalArrayValuesDeferredCursor *cursor,
    bool normal
) {
    if (mal_vm_primitive_methods_intact(vm) || mal_value_to_object(array)->for_in_keys) return true;
    MAL_PERF_COUNT(iterator_deferred_array_materializations);
    MalValue roots[1] = {mal_vm_new_builtin_iterator(vm, MAL_ITERATOR_ARRAY_VALUES, array)};
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 1);
    MalIteratorObject *iterator = mal_value_to_iterator_object(roots[0]);
    iterator->index = cursor->index;
    iterator->done = cursor->done;
    MalIteratorRecord record = {.iterator = roots[0], .next_method = mal_value_new_undefined()};
    bool ok = true;
    if (normal) {
        ok = mal_vm_iterator_close_normal(vm, &record);
    } else {
        mal_vm_iterator_close(vm, &record);
    }
    mal_gc_unroot(&roots_span);
    return ok;
}

bool mal_vm_iterator_step_protocol_cursor(
    MalVm *vm,
    MalIteratorObject *cursor,
    const MalIteratorRecord *record,
    MalValue *value_out,
    bool *done_out
) {
#if MAL_REALMS
    // Allocations and errors belong to captured next, not the iterator's creation realm.
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(vm, mal_vm_callee_realm(vm, record->next_method));
#else
    (void) record;
#endif
    // Advance retains unrooted intermediates under native next's GC suppression.
    vm->gc_native_frames++;
    bool ok = mal_builtin_iterator_object_advance(vm, cursor, value_out, done_out);
    vm->gc_native_frames--;
#if MAL_REALMS
    mal_vm_realm_switch_to(vm, saved_realm);
#endif
    return ok;
}

void mal_vm_iterator_step_map_entries_cursor(
    MalIteratorObject *cursor,
    MalValue *key_out,
    MalValue *value_out,
    bool *done_out
) {
    assert(cursor->kind == MAL_ITERATOR_MAP_ENTRIES);
    assert(mal_value_is_map_object(cursor->target));
    if (cursor->done) {
        *key_out = mal_value_new_undefined();
        *value_out = mal_value_new_undefined();
        *done_out = true;
        return;
    }
    mal_builtin_iterator_map_take_entry(cursor, key_out, value_out, done_out);
}

void mal_vm_iterator_step_set_values_cursor(
    MalIteratorObject *cursor,
    MalValue *value_out,
    bool *done_out
) {
    assert(cursor->kind == MAL_ITERATOR_SET_VALUES);
    assert(mal_value_is_set_object(cursor->target));
    if (cursor->done) {
        *value_out = mal_value_new_undefined();
        *done_out = true;
        return;
    }
    mal_builtin_iterator_set_take_entry(cursor, value_out, done_out);
}

static bool mal_vm_iterator_entry_pair_done(
    MalValue *first_out, MalValue *second_out, bool *done_out
) {
    *first_out = mal_value_new_undefined();
    *second_out = mal_value_new_undefined();
    *done_out = true;
    return true;
}

static inline __attribute__((always_inline)) bool mal_vm_iterator_cursor_entry_pair(
    MalVm *vm,
    const MalIteratorRecord *record,
    MalIteratorObject *cursor,
    MalValue *first_out,
    MalValue *second_out,
    bool *done_out
) {
    switch (cursor->kind) {
        case MAL_ITERATOR_MAP_ENTRIES:
            if (!mal_value_is_map_object(cursor->target)) return false;
            if (cursor->done) return mal_vm_iterator_entry_pair_done(first_out, second_out, done_out);
            mal_builtin_iterator_map_take_entry(cursor, first_out, second_out, done_out);
            return true;
        case MAL_ITERATOR_SET_ENTRIES:
            if (!mal_value_is_set_object(cursor->target)) return false;
            if (cursor->done) return mal_vm_iterator_entry_pair_done(first_out, second_out, done_out);
            mal_builtin_iterator_set_take_entry(cursor, first_out, done_out);
            *second_out = *first_out;
            return true;
        case MAL_ITERATOR_ARRAY_ENTRIES: {
            if (!mal_value_is_array_object(cursor->target)) return false;
#if MAL_REALMS
            // A sparse element Get can throw in the captured next method's realm.
            if (mal_vm_callee_realm(vm, record->next_method) != vm->current_realm) {
                return false;
            }
#else
            (void) record;
#endif
            if (cursor->done) return mal_vm_iterator_entry_pair_done(first_out, second_out, done_out);
            MalArrayObject *array = mal_value_to_array_object(cursor->target);
            u64 index = cursor->index;
            if (index >= array->length) {
                cursor->done = true;
                return mal_vm_iterator_entry_pair_done(first_out, second_out, done_out);
            }
            cursor->index++;
            MalValue element;
            if (!mal_array_object_dense_get(array, (u32) index, &element) &&
                !mal_vm_get_property(vm, cursor->target, mal_key_index(index), &element)) {
                return false;
            }
            *first_out = mal_ops_number_value((f64) index);
            *second_out = element;
            *done_out = false;
            return true;
        }
        default:
            return false;
    }
}

bool mal_vm_iterator_step_collection_entry_pair(
    MalVm *vm,
    const MalIteratorRecord *record,
    MalValue *first_out,
    MalValue *second_out,
    bool *done_out
) {
    MalIteratorObject *cursor = mal_vm_iterator_exact_cursor(record);
    return cursor != nullptr &&
        mal_vm_iterator_cursor_entry_pair(vm, record, cursor, first_out, second_out, done_out);
}

static inline __attribute__((always_inline)) bool mal_vm_array_take_element_pair(
    MalVm *vm,
    MalArrayObject *array,
    u64 *index_inout,
    MalValue *first_out,
    MalValue *second_out,
    bool *done_out
) {
    u64 index = *index_inout;
    MalValue element;
    bool first_done;
    bool second_done;
    if (index >= array->length ||
        !mal_array_object_dense_get(array, (u32) index, &element) ||
        !mal_builtin_array_pair_destructure_try(
            vm, element, first_out, &first_done, second_out, &second_done) ||
        second_done) {
        return false;
    }
    *index_inout = index + 1;
    mal_perf_collection_iteration_step(array);
    *done_out = false;
    return true;
}

bool mal_vm_iterator_step_entry_pair_protocol_cursor(
    MalVm *vm,
    const MalIteratorRecord *record,
    MalValue *first_out,
    MalValue *second_out,
    bool *done_out
) {
    MalIteratorObject *cursor = mal_vm_iterator_exact_cursor(record);
    if (cursor == nullptr) return false;
    if (cursor->kind != MAL_ITERATOR_ARRAY_VALUES) {
        return mal_vm_iterator_cursor_entry_pair(
            vm, record, cursor, first_out, second_out, done_out);
    }
    return mal_value_is_array_object(cursor->target) && !cursor->done &&
        mal_vm_array_take_element_pair(
            vm, mal_value_to_array_object(cursor->target), &cursor->index,
            first_out, second_out, done_out);
}

bool mal_vm_array_values_deferred_entry_pair_step(
    MalVm *vm,
    MalValue array,
    MalArrayValuesDeferredCursor *cursor,
    MalValue *first_out,
    MalValue *second_out,
    bool *done_out
) {
    return !cursor->done &&
        mal_vm_array_take_element_pair(
            vm, mal_value_to_array_object(array), &cursor->index,
            first_out, second_out, done_out);
}

static MalValue mal_builtin_iterator_prototype_iterator(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) args;
    (void) arg_count;
    return this_value;
}

/** %IteratorPrototype%[@@dispose] closes an iterator and discards its result. */
static MalValue mal_builtin_iterator_prototype_dispose(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;

    MalValue return_method;
    if (!mal_vm_get_property(
            vm,
            this_value,
            mal_intrinsic_string_key(vm, "return"),
            &return_method)) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_nil(return_method)) {
        return mal_value_new_undefined();
    }
    if (!mal_value_is_callable(return_method)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Iterator return is not a function"
        );
        return mal_value_new_undefined();
    }
    MalCompletion completion =
        mal_vm_call_value(vm, return_method, this_value, nullptr, 0);
    return completion.kind == MAL_COMPLETION_NORMAL
        ? mal_value_new_undefined()
        : completion.value;
}

/**
 * [[Get]] for an iteration-protocol key that a receiver inherits only through
 * watched built-in prototypes. While the watched-method protector holds none of
 * those prototypes has changed, so the resolved data value is a per-prototype
 * constant. Returns false when the lookup needs the generic path.
 */
static bool mal_vm_watched_inherited_get(
    MalVm *vm, MalValue receiver, MalKey key, MalValue *value_out
) {
    if (!mal_vm_primitive_methods_intact(vm)) return false;
    const MalObject *prototype;
    if (mal_value_is_string(receiver)) {
        // String exotic own keys are indices and "length".
        if (key.kind != MAL_KEY_SYMBOL) return false;
        prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_STRING_PROTOTYPE]);
    } else {
        bool generator = mal_value_is_heap_type(receiver, MAL_HEAP_GENERATOR_OBJECT);
        if (!generator &&
            !mal_value_is_heap_type(receiver, MAL_HEAP_ARRAY_OBJECT) &&
            !mal_value_is_heap_type(receiver, MAL_HEAP_MAP_OBJECT) &&
            !mal_value_is_heap_type(receiver, MAL_HEAP_SET_OBJECT) &&
            !mal_value_is_heap_type(receiver, MAL_HEAP_ITERATOR_OBJECT) &&
            !mal_value_is_heap_type(receiver, MAL_HEAP_OBJECT)) {
            return false;
        }
        MalObject *object = mal_value_to_object(receiver);
        // Named own properties live in shape slots or the overflow table.
        if ((object->shape->inline_count != 0 || mal_object_overflow(object) != nullptr) &&
            mal_object_get_own(object, key).present) {
            return false;
        }
        prototype = mal_object_prototype(object);
        // A generator first inherits from its function's ordinary prototype object,
        // which nothing watches, so that one object is checked on every lookup.
        if (generator && prototype != nullptr && !prototype->watched_method_proto) {
            if (prototype->header.type != MAL_HEAP_OBJECT ||
                ((prototype->shape->inline_count != 0 || mal_object_overflow(prototype) != nullptr) &&
                 mal_object_get_own(prototype, key).present)) {
                return false;
            }
            prototype = mal_object_prototype(prototype);
        }
    }
    if (prototype == nullptr || !prototype->watched_method_proto) return false;
    u64 hash = ((u64) (uptr) prototype >> 4) ^ (key.value * UINT64_C(0x9e3779b97f4a7c15));
    MalWatchedLookupEntry *entry = &vm->watched_lookup_cache[
        (hash ^ (hash >> 32)) & (MAL_WATCHED_LOOKUP_CACHE_CAPACITY - 1)];
    if (entry->prototype == prototype && entry->key == key.value) {
        *value_out = entry->value;
        return true;
    }
    MalValue value = mal_value_new_undefined();
    for (MalObject *cursor = (MalObject *) prototype; cursor != nullptr;
         cursor = mal_object_prototype(cursor)) {
        if (!cursor->watched_method_proto) return false;
        MalPropertyLookup own = mal_object_get_own(cursor, key);
        if (own.present) {
            if (own.desc.flags & MAL_PROPERTY_ACCESSOR) return false;
            value = own.desc.value;
            break;
        }
    }
    *entry = (MalWatchedLookupEntry) {.prototype = prototype, .key = key.value, .value = value};
    *value_out = value;
    return true;
}

// EnumerateObjectProperties iterates internally: no @@iterator, next or return lookup.
static bool mal_vm_get_for_in_iterator(MalVm *vm, MalValue keys, MalIteratorRecord *record_out) {
    MalValue roots[2] = {keys, mal_value_new_undefined()};
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 2);
    if (mal_value_is_undefined(vm->for_in_iterator_next)) {
        vm->for_in_iterator_next = mal_value_from_native_function_object(
            mal_native_function_object_new(
                &vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, "next"), mal_builtin_array_iterator_next));
    }
    roots[1] = mal_value_from_iterator_object(
        mal_iterator_object_new(&vm->heap, nullptr, MAL_ITERATOR_ARRAY_VALUES, roots[0]));
    record_out->iterator = roots[1];
    record_out->next_method = vm->for_in_iterator_next;
    mal_gc_unroot(&roots_span);
    return true;
}

/**
 * The builtin iterator kind `value[@@iterator]()` creates while the watched-method
 * protector holds: an Array, Set, or Map on its own realm's intrinsic prototype
 * without an own @@iterator still has the default method.
 */
static bool mal_vm_default_iterator_kind(
    MalVm *vm, MalValue value, MalIteratorKind *kind_out
) {
    MalIntrinsic prototype_slot;
    MalIteratorKind kind;
    if (mal_value_is_array_object(value)) {
        prototype_slot = MAL_INTRINSIC_ARRAY_PROTOTYPE;
        kind = MAL_ITERATOR_ARRAY_VALUES;
    } else if (mal_value_is_set_object(value)) {
        prototype_slot = MAL_INTRINSIC_SET_PROTOTYPE;
        kind = MAL_ITERATOR_SET_VALUES;
    } else if (mal_value_is_map_object(value)) {
        prototype_slot = MAL_INTRINSIC_MAP_PROTOTYPE;
        kind = MAL_ITERATOR_MAP_ENTRIES;
    } else {
        return false;
    }
    if (!mal_vm_primitive_methods_intact(vm)) return false;
    MalObject *object = mal_value_to_object(value);
    const MalObject *prototype = mal_object_prototype(object);
    if (prototype == nullptr || !prototype->watched_method_proto ||
        prototype != mal_value_to_object(vm->intrinsics[prototype_slot])) {
        return false;
    }
    if ((object->shape->inline_count != 0 || mal_object_overflow(object) != nullptr) &&
        mal_object_get_own(
            object, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR)).present) {
        return false;
    }
    *kind_out = kind;
    return true;
}

static bool mal_vm_iterator_record_from(
    MalVm *vm, MalValue iterator, MalIteratorRecord *record_out
) {
    MalValue roots[2] = {iterator, mal_value_new_undefined()};
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 2);
    MalKey next_key = mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_NEXT);
    if (!mal_vm_watched_inherited_get(vm, roots[0], next_key, &roots[1]) &&
        !mal_vm_get_property(vm, roots[0], next_key, &roots[1])) {
        mal_gc_unroot(&roots_span);
        return false;
    }

    record_out->iterator = roots[0];
    record_out->next_method = roots[1];
    mal_gc_unroot(&roots_span);

    return true;
}

bool mal_vm_get_iterator(MalVm *vm, MalValue value, MalIteratorRecord *record_out) {
    if (mal_value_is_array_object(value) && mal_value_to_object(value)->for_in_keys) {
        return mal_vm_get_for_in_iterator(vm, value, record_out);
    }
    // The default method only creates the builtin iterator, so skip its lookup and call.
    MalIteratorKind kind;
    if (mal_vm_default_iterator_kind(vm, value, &kind)) {
        MalRootSpan value_span;
        mal_gc_root(&value_span, &value, 1);
        MalValue iterator = mal_vm_new_builtin_iterator(vm, kind, value);
        mal_gc_unroot(&value_span);
        return mal_vm_iterator_record_from(vm, iterator, record_out);
    }
    MalValue method;
    MalKey key = mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR);
    if (!mal_vm_watched_inherited_get(vm, value, key, &method) &&
        !mal_vm_get_property(vm, value, key, &method)) {
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

    MalValue iterator = value;
    // %IteratorPrototype%[@@iterator], which generators inherit, only returns its receiver.
    if (!mal_value_is_native_function_object(method) ||
        mal_native_function_object_callback(mal_value_to_native_function_object(method)) !=
            mal_builtin_iterator_prototype_iterator) {
        MalCompletion completion = mal_vm_call_value(vm, method, value, nullptr, 0);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            return false;
        }
        iterator = completion.value;
    }

    if (!mal_value_is_object(iterator)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator is not an object");
        return false;
    }

    return mal_vm_iterator_record_from(vm, iterator, record_out);
}

bool mal_vm_builtin_iterator_size_hint(
    const MalIteratorRecord *record, usize *size_out
) {
    if (!mal_value_is_iterator_object(record->iterator) ||
        !mal_value_is_native_function_object(record->next_method)) {
        return false;
    }

    MalIteratorObject *iterator = mal_value_to_iterator_object(record->iterator);
    if (iterator->done ||
        mal_native_function_object_callback(
            mal_value_to_native_function_object(record->next_method)) !=
            mal_builtin_iterator_expected_next(iterator->kind)) {
        return false;
    }

    switch (iterator->kind) {
        case MAL_ITERATOR_ARRAY_KEYS:
        case MAL_ITERATOR_ARRAY_VALUES:
        case MAL_ITERATOR_ARRAY_ENTRIES:
            if (mal_value_is_array_object(iterator->target)) {
                usize length = mal_array_object_length(
                    mal_value_to_array_object(iterator->target));
                *size_out = iterator->index < length
                    ? length - (usize) iterator->index
                    : 0;
                return true;
            }
            if (mal_value_is_typed_array_object(iterator->target)) {
                MalTypedArrayObject *array =
                    mal_value_to_typed_array_object(iterator->target);
                if (mal_typed_array_object_is_out_of_bounds(array)) {
                    return false;
                }
                usize length = mal_typed_array_object_length(array);
                *size_out = iterator->index < length
                    ? length - (usize) iterator->index
                    : 0;
                return true;
            }
            return false;
        case MAL_ITERATOR_MAP_KEYS:
        case MAL_ITERATOR_MAP_VALUES:
        case MAL_ITERATOR_MAP_ENTRIES:
            if (iterator->index != 0 ||
                !mal_value_is_map_object(iterator->target)) {
                return false;
            }
            *size_out = mal_map_object_size(
                mal_value_to_map_object(iterator->target));
            return true;
        case MAL_ITERATOR_SET_VALUES:
        case MAL_ITERATOR_SET_ENTRIES:
            if (iterator->index != 0 ||
                !mal_value_is_set_object(iterator->target)) {
                return false;
            }
            *size_out = mal_set_object_size(
                mal_value_to_set_object(iterator->target));
            return true;
        case MAL_ITERATOR_STRING_VALUES: {
            usize length = mal_string_length(
                mal_value_to_string(iterator->target));
            *size_out = iterator->index < length
                ? length - (usize) iterator->index
                : 0;
            return true;
        }
    }

    return false;
}

bool mal_vm_iterator_drain_set_values_to_fresh_dense_array(
    const MalIteratorRecord *record, MalArrayObject *array
) {
    MalIteratorObject *cursor = mal_vm_iterator_protocol_cursor(
        record, MAL_ITERATOR_CURSOR_SET);
    if (cursor == nullptr || cursor->kind != MAL_ITERATOR_SET_VALUES ||
        cursor->done || cursor->index != 0) {
        return false;
    }

    MalSetObject *set = mal_value_to_set_object(cursor->target);
    usize size = mal_set_object_size(set);
    if (size > UINT32_MAX ||
        !mal_array_object_fresh_dense_reserve_exact(array, (u32) size)) {
        return false;
    }

    MalSetIter iter;
    mal_set_iter_init(&iter, set->entries);
    MalValue key;
    while (mal_set_iter_next(&iter, &key)) {
        mal_array_object_fresh_dense_append_reserved(array, key);
        cursor->index = (u64) iter.index;
    }
    cursor->done = true;
    mal_iterator_object_release_collection_pin(cursor);
    return true;
}

/**
 * A Set value, Map key or value, or dense Array element step that allocates nothing
 * and is not the last; false leaves every other step to the protocol cursor, which
 * rereads the same position.
 */
static bool mal_vm_iterator_try_step_in_place(
    MalIteratorObject *iterator, MalValue *value_out
) {
    if (iterator->done) return false;
    switch (iterator->kind) {
        case MAL_ITERATOR_SET_VALUES: {
            MalSetObject *set = mal_value_to_set_object(iterator->target);
            MalSetIter iter;
            mal_set_iter_init(&iter, set->entries);
            iter.index = (usize) iterator->index;
            if (!mal_set_iter_next(&iter, value_out)) return false;
            iterator->index = (u64) iter.index;
            mal_perf_collection_iteration_step(set);
            return true;
        }
        case MAL_ITERATOR_MAP_KEYS:
        case MAL_ITERATOR_MAP_VALUES: {
            MalMapObject *map = mal_value_to_map_object(iterator->target);
            MalMapIter iter;
            mal_map_iter_init(&iter, map->entries);
            iter.index = (usize) iterator->index;
            MalValue key;
            MalValue mapped;
            if (!mal_map_iter_next(&iter, &key, &mapped)) return false;
            iterator->index = (u64) iter.index;
            mal_perf_collection_iteration_step(map);
            *value_out = iterator->kind == MAL_ITERATOR_MAP_KEYS ? key : mapped;
            return true;
        }
        case MAL_ITERATOR_ARRAY_VALUES: {
            if (!mal_value_is_array_object(iterator->target)) return false;
            MalArrayObject *array = mal_value_to_array_object(iterator->target);
            u64 index = iterator->index;
            if (index >= array->length ||
                !mal_array_object_dense_get(array, (u32) index, value_out)) {
                return false;
            }
            iterator->index++;
            mal_perf_collection_iteration_step(array);
            return true;
        }
        default:
            return false;
    }
}

static bool mal_vm_iterator_result_get(
    MalVm *vm, MalValue result, const byte *name, MalHotIntrinsicKey key, MalValue *out
) {
    MalObject *object = mal_value_to_object(result);
    if (object->header.type == MAL_HEAP_OBJECT) {
        MalPropertyLookup own = mal_object_get_own_static(vm, object, name);
        if (own.present && !(own.desc.flags & MAL_PROPERTY_ACCESSOR)) {
            *out = own.desc.value;
            return true;
        }
    }
    return mal_vm_get_property(vm, result, mal_intrinsic_hot_string_key(vm, key), out);
}

bool mal_vm_iterator_step(MalVm *vm, const MalIteratorRecord *record, MalValue *value_out, bool *done_out) {
    *value_out = mal_value_new_undefined();
    *done_out = false;

    if (mal_value_is_iterator_object(record->iterator) &&
        mal_value_is_native_function_object(record->next_method)) {
        MalIteratorObject *iterator = mal_value_to_iterator_object(record->iterator);
        MalNativeFunctionCallback next_callback =
            mal_native_function_object_callback(mal_value_to_native_function_object(record->next_method));
        if (next_callback == mal_builtin_iterator_expected_next(iterator->kind)) {
            if (mal_vm_iterator_try_step_in_place(iterator, value_out)) return true;
            return mal_vm_iterator_step_protocol_cursor(
                vm, iterator, record, value_out, done_out);
        }
    }

    if (mal_value_is_heap_type(record->iterator, MAL_HEAP_GENERATOR_OBJECT)) {
        int generator_step = mal_generator_try_exact_iterator_step(
            vm, record->iterator, record->next_method, value_out, done_out);
        if (generator_step != 0) {
            return generator_step > 0;
        }
    } else if (mal_value_is_heap_type(record->iterator, MAL_HEAP_ITERATOR_HELPER_OBJECT)) {
        int helper_step = mal_builtin_iterator_helper_try_step(
            vm, record, value_out, done_out);
        if (helper_step != 0) {
            return helper_step > 0;
        }
    } else if (mal_value_is_heap_type(record->iterator, MAL_HEAP_REGEXP_STRING_ITERATOR_OBJECT)) {
        int regexp_step = mal_regexp_try_exact_iterator_step(
            vm, record->iterator, record->next_method, value_out, done_out);
        if (regexp_step != 0) {
            return regexp_step > 0;
        }
    }

    MalValue result = mal_vm_call_cached_value(vm, record->next_method, record->iterator, nullptr, 0);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return false;
    }

    if (!mal_value_is_object(result)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator result is not an object");
        return false;
    }

    // Getting `done` can re-enter user code and collect. Keep the iterator result
    // alive until the subsequent `value` read has finished as well.
    MalRootSpan result_span;
    mal_gc_root(&result_span, &result, 1);

    MalValue done;
    if (!mal_vm_iterator_result_get(vm, result, (const byte *) "done", MAL_HOT_KEY_DONE, &done)) {
        mal_gc_unroot(&result_span);
        return false;
    }

    if (mal_value_is_truthy(done)) {
        mal_gc_unroot(&result_span);
        *done_out = true;
        return true;
    }

    bool ok = mal_vm_iterator_result_get(
        vm, result, (const byte *) "value", MAL_HOT_KEY_VALUE, value_out);
    mal_gc_unroot(&result_span);
    return ok;
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
    MalKey return_key = mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_RETURN);
    if (!mal_vm_watched_inherited_get(vm, record->iterator, return_key, &return_method) &&
        !mal_vm_get_property(vm, record->iterator, return_key, &return_method)) {
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
    mal_intrinsic_define_symbol_method(vm, iterator_prototype, MAL_INTRINSIC_SYMBOL_DISPOSE, "[Symbol.dispose]", mal_builtin_iterator_prototype_dispose);

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

#include "generated/known_native_builtin_iterator_c.inc"
