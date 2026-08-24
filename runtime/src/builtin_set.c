#include "builtin_set.h"

#include <math.h>

#include "builtin_iterator.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "map_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/**
 * Unwrap a Set-family receiver with the right weak brand, or throw.
 */
static MalMapObject *mal_builtin_set_this(MalVm *vm, MalValue this_value, bool weak, const byte *message) {
    if (!mal_value_is_set_object(this_value) || mal_value_to_map_object(this_value)->weak != weak) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        return nullptr;
    }

    return mal_value_to_map_object(this_value);
}

/**
 * Spec CanBeHeldWeakly: objects and non-registered symbols qualify.
 */
static bool mal_builtin_set_can_be_held_weakly(MalValue value) {
    if (mal_value_is_object(value)) {
        return true;
    }

    return mal_value_is_symbol(value) && !mal_value_to_symbol(value)->registered;
}

static MalValue mal_builtin_weak_set_prototype_add(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee);

/**
 * Shared Set/WeakSet constructor tail: populate the fresh set from an
 * optional iterable through this.add, closing the iterator on abrupt
 * completions.
 */
static MalValue mal_builtin_set_construct(
    MalVm *vm,
    MalValue new_target,
    const MalValue *args,
    i32 arg_count,
    MalIntrinsic prototype_slot,
    bool weak,
    const byte *require_new_message
) {
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, require_new_message);
        return mal_value_new_undefined();
    }

    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(vm, new_target, prototype_slot, &prototype)) {
        return mal_value_new_undefined();
    }

    MalMapObject *set = mal_map_object_new(&vm->heap, MAL_HEAP_SET_OBJECT, prototype, weak);
    MalValue set_value = mal_value_from_map_object(set);

    if (arg_count < 1 || mal_value_is_nil(args[0])) {
        return set_value;
    }

    MalValue adder;
    if (!mal_vm_get_property(vm, set_value, mal_intrinsic_string_key(vm, "add"), &adder)) {
        return mal_value_new_undefined();
    }

    if (!mal_value_is_callable(adder)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Set adder is not callable");
        return mal_value_new_undefined();
    }
    bool direct_set_adder = !weak &&
        adder == vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_ADD];
    bool direct_weak_adder = weak &&
        mal_value_is_native_function_object(adder) &&
        mal_native_function_object_callback(
            mal_value_to_native_function_object(adder)) ==
            mal_builtin_weak_set_prototype_add;
    bool direct_adder = direct_set_adder || direct_weak_adder;

    MalIteratorRecord record;
    if (!mal_vm_get_iterator(vm, args[0], &record)) {
        return mal_value_new_undefined();
    }

    usize size_hint;
    if (direct_adder &&
        mal_vm_builtin_iterator_size_hint(&record, &size_hint)) {
        (void) mal_table_reserve(set->entries, size_hint);
    }

    // Each step and the adder re-enter JS and can collect. A callable Proxy may
    // allocate its apply-argument array before the generic call seam publishes
    // those arguments, so keep the current item rooted as well.
    MalValue roots[3] = {
        set_value,
        adder,
        mal_value_new_undefined(), // current item
    };
    MalRootSpan rec_span, span;
    mal_gc_root(&rec_span, &record.iterator, 2);
    mal_gc_root(&span, roots, countof(roots));
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();

    while (true) {
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &roots[2], &done)) {
            goto done;
        }

        if (done) {
            ret = roots[0];
            goto done;
        }

        // The exact built-in Set.prototype.add has no observable call seam.
        // Its identity was captured before iterator acquisition, so direct
        // insertion remains valid even if later iterator effects replace add.
        if (direct_adder) {
            if (direct_weak_adder &&
                !mal_builtin_set_can_be_held_weakly(roots[2])) {
                mal_vm_throw_error(
                    vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Invalid value used in weak set");
                mal_vm_iterator_close(vm, &record);
                goto done;
            }
            mal_map_object_set(set, roots[2], roots[2]);
            continue;
        }

        MalCompletion completion = mal_vm_call_value(
            vm, roots[1], roots[0], &roots[2], 1);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            mal_vm_iterator_close(vm, &record);
            goto done;
        }
    }

done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    mal_gc_unroot(&rec_span);
    return ret;
}

static MalValue mal_builtin_set_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_set_construct(vm, new_target, args, arg_count, MAL_INTRINSIC_SET_PROTOTYPE, false, "Constructor Set requires 'new'");
}

static MalValue mal_builtin_weak_set_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_set_construct(vm, new_target, args, arg_count, MAL_INTRINSIC_WEAK_SET_PROTOTYPE, true, "Constructor WeakSet requires 'new'");
}

static MalValue mal_builtin_set_prototype_add(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    mal_map_object_set(set, value, value);

    return this_value;
}

static MalValue mal_builtin_set_prototype_has(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_map_object_has(set, arg_count >= 1 ? args[0] : mal_value_new_undefined()));
}

static MalValue mal_builtin_set_prototype_delete(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_map_object_delete(set, arg_count >= 1 ? args[0] : mal_value_new_undefined()));
}

static MalValue mal_builtin_set_prototype_clear(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;

    MalMapObject *set = mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    mal_map_object_clear(set);

    return mal_value_new_undefined();
}

static MalValue mal_builtin_set_prototype_size_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;

    MalMapObject *set = mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_from_i32((i32) mal_map_object_size(set));
}

static MalValue mal_builtin_set_prototype_for_each(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    if (arg_count < 1 || !mal_value_is_callable(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Set.prototype.forEach callback is not a function");
        return mal_value_new_undefined();
    }

    MalValue this_arg = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    mal_table_pin(set->entries);
    MalTableIter iter;
    mal_table_iter_init(&iter, set->entries, MAL_TABLE_ITER_STORAGE);

    // The callback can collect; lift this builtin's GC suppression for the loop.
    // No explicit roots needed: the receiver Set is rooted by the call seam, its
    // entries table is traced through it, so each callback argument is reachable.
    mal_gc_native_rooted_begin(vm);
    MalKey key;
    void *entry;
    while (mal_table_iter_next(&iter, &key, &entry)) {
        // The callback receives (value, value, set): sets have no distinct keys.
        MalValue callback_args[3] = {key.value, key.value, this_value};
        MalCompletion completion = mal_vm_call_value(vm, args[0], this_arg, callback_args, 3);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            break;
        }
    }
    mal_gc_native_rooted_end(vm);
    mal_table_unpin(set->entries);

    return mal_value_new_undefined();
}

static MalValue mal_builtin_set_prototype_iterator(MalVm *vm, MalValue this_value, MalIteratorKind kind) {
    if (mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set") == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_vm_new_builtin_iterator(vm, kind, this_value);
}

static MalValue mal_builtin_set_prototype_values(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_set_prototype_iterator(vm, this_value, MAL_ITERATOR_SET_VALUES);
}

static MalValue mal_builtin_set_prototype_entries(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_set_prototype_iterator(vm, this_value, MAL_ITERATOR_SET_ENTRIES);
}

static MalValue mal_builtin_weak_set_prototype_add(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, true, "Receiver is not a WeakSet");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_builtin_set_can_be_held_weakly(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid value used in weak set");
        return mal_value_new_undefined();
    }

    mal_map_object_set(set, value, value);

    return this_value;
}

static MalValue mal_builtin_weak_set_prototype_has(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, true, "Receiver is not a WeakSet");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_map_object_has(set, arg_count >= 1 ? args[0] : mal_value_new_undefined()));
}

static MalValue mal_builtin_weak_set_prototype_delete(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, true, "Receiver is not a WeakSet");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_map_object_delete(set, arg_count >= 1 ? args[0] : mal_value_new_undefined()));
}

/**
 * Spec Set Record: the set-like object together with its coerced size and the
 * has/keys methods captured by GetSetRecord (read once, eagerly).
 */
typedef struct MalSetRecord {
    MalValue set_object;
    MalValue has;
    MalValue keys;
    f64 size;
    /** Exact same-Realm Set internals when captured has/keys are unmodified. */
    MalMapObject *native_set;
} MalSetRecord;

/**
 * Spec GetSetRecord(obj): validate obj is a set-like object and capture its
 * size (coerced through ToNumber, NaN -> TypeError), has, and keys. Reads
 * happen in the spec order: size, has, keys. Returns false on a throw.
 */
static bool mal_builtin_set_get_set_record(MalVm *vm, MalValue obj, MalSetRecord *record_out) {
    if (!mal_value_is_object(obj)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Set-like argument is not an object");
        return false;
    }

    /*
     * An exact same-Realm Set inherits all three observable record properties
     * from the protected intrinsic prototype. Avoid resolving those properties
     * and coercing the already-integral native size on the overwhelmingly common
     * Set-vs-Set composition path. Own overrides and subclass prototypes remain
     * observable below; mutations of %Set.prototype% invalidate the monotonic
     * method protector before this path can be taken again.
     */
    if (mal_primitive_method_protector && mal_value_is_set_object(obj)) {
        MalMapObject *candidate = mal_value_to_map_object(obj);
        MalObject *object = &candidate->object;
        if (!candidate->weak &&
            object->prototype ==
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE]) &&
            object->shape->inline_count == 0 && object->overflow == nullptr) {
            *record_out = (MalSetRecord) {
                .set_object = obj,
                .has = vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_HAS],
                .keys = vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_VALUES],
                .size = (f64) mal_map_object_size(candidate),
                .native_set = candidate,
            };
            return true;
        }
    }

    MalValue raw_size;
    if (!mal_vm_get_property(vm, obj, mal_intrinsic_string_key(vm, "size"), &raw_size)) {
        return false;
    }

    f64 num_size;
    if (!mal_vm_to_number(vm, raw_size, &num_size)) {
        return false;
    }

    if (isnan(num_size)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Set-like size is NaN");
        return false;
    }

    // ToIntegerOrInfinity for the negativity check (NaN already excluded).
    f64 int_size = trunc(num_size);
    if (int_size < 0.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Set-like size is negative");
        return false;
    }

    MalValue has;
    if (!mal_vm_get_property(vm, obj, mal_intrinsic_string_key(vm, "has"), &has)) {
        return false;
    }
    if (!mal_value_is_callable(has)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Set-like 'has' is not callable");
        return false;
    }

    MalValue keys;
    if (!mal_vm_get_property(vm, obj, mal_intrinsic_string_key(vm, "keys"), &keys)) {
        return false;
    }
    if (!mal_value_is_callable(keys)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Set-like 'keys' is not callable");
        return false;
    }

    MalMapObject *native_set = nullptr;
    if (mal_value_is_set_object(obj)) {
        MalMapObject *candidate = mal_value_to_map_object(obj);
        if (!candidate->weak &&
            has == vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_HAS] &&
            keys == vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_VALUES]) {
            native_set = candidate;
        }
    }

    *record_out = (MalSetRecord) {
        .set_object = obj,
        .has = has,
        .keys = keys,
        .size = int_size,
        .native_set = native_set,
    };
    return true;
}

/** Root/lift state shared by the generic, user-code-reentering Set paths. */
typedef struct MalSetExecution {
    MalValue values[2]; // result (or undefined), current iterator/key value
    MalIteratorRecord iterator;
    MalRootSpan record_span;
    MalRootSpan values_span;
    MalRootSpan iterator_span;
} MalSetExecution;

static void mal_builtin_set_execution_begin(
    MalVm *vm, MalSetRecord *record, MalValue result, MalSetExecution *execution
) {
    execution->values[0] = result;
    execution->values[1] = mal_value_new_undefined();
    execution->iterator = (MalIteratorRecord) {
        .iterator = mal_value_new_undefined(),
        .next_method = mal_value_new_undefined(),
    };
    mal_gc_root(&execution->record_span, &record->set_object, 3);
    mal_gc_root(&execution->values_span, execution->values, 2);
    mal_gc_root(&execution->iterator_span, &execution->iterator.iterator, 2);
    mal_gc_native_rooted_begin(vm);
}

static void mal_builtin_set_execution_end(MalVm *vm, MalSetExecution *execution) {
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&execution->iterator_span);
    mal_gc_unroot(&execution->values_span);
    mal_gc_unroot(&execution->record_span);
}

/**
 * Spec GetIteratorFromMethod over the set record's keys method: call keys()
 * with the set object as receiver and build an iterator record from the
 * result. Returns false on a throw.
 */
static bool mal_builtin_set_record_keys_iterator(MalVm *vm, const MalSetRecord *record, MalIteratorRecord *iter_out) {
    MalCompletion completion = mal_vm_call_value(vm, record->keys, record->set_object, nullptr, 0);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return false;
    }

    if (!mal_value_is_object(completion.value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Set-like keys() did not return an object");
        return false;
    }

    // Publish the fresh iterator into the caller's rooted record before its
    // observable `next` lookup can allocate or collect.
    iter_out->iterator = completion.value;
    if (!mal_vm_get_property(
            vm, iter_out->iterator, mal_intrinsic_string_key(vm, "next"),
            &iter_out->next_method)) {
        return false;
    }
    return true;
}

/**
 * Invoke the set record's has(value) and coerce the result to a boolean.
 * Returns false on a throw; otherwise *out carries the truthiness.
 */
static bool mal_builtin_set_record_has(MalVm *vm, const MalSetRecord *record, MalValue value, bool *out) {
    MalCompletion completion = mal_vm_call_value(vm, record->has, record->set_object, &value, 1);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return false;
    }

    *out = mal_value_is_truthy(completion.value);
    return true;
}

/**
 * Allocate the always-plain %Set% result the set-composition methods return
 * (never the receiver's species or subclass), seeded with `seed`'s entries.
 */
static MalMapObject *mal_builtin_set_new_result(
    MalVm *vm, const MalMapObject *seed, usize reserve_size
) {
    MalMapObject *result = mal_map_object_new(
        &vm->heap,
        MAL_HEAP_SET_OBJECT,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE]),
        false
    );

    if (seed != nullptr && reserve_size < mal_map_object_size(seed)) {
        reserve_size = mal_map_object_size(seed);
    }
    (void) mal_table_reserve(result->entries, reserve_size);

    if (seed != nullptr) {
        MalTableIter iter;
        mal_table_iter_init(&iter, ((MalMapObject *) seed)->entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            mal_map_object_set_canonical(result, key, key.value);
        }
    }

    return result;
}

static MalValue mal_builtin_set_prototype_union(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalSetRecord record;
    if (!mal_builtin_set_get_set_record(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    if (record.native_set == set) {
        return mal_value_from_map_object(mal_builtin_set_new_result(
            vm, set, mal_map_object_size(set)));
    }

    usize reserve_size = mal_map_object_size(set);
    if (record.native_set != nullptr &&
        SIZE_MAX - reserve_size >= mal_map_object_size(record.native_set)) {
        reserve_size += mal_map_object_size(record.native_set);
    }
    if (record.native_set != nullptr) {
        MalMapObject *result = mal_builtin_set_new_result(vm, set, reserve_size);
        MalTableIter iter;
        mal_table_iter_init(&iter, record.native_set->entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            mal_map_object_set_canonical(result, key, key.value);
        }
        return mal_value_from_map_object(result);
    }

    MalSetExecution execution;
    mal_builtin_set_execution_begin(
        vm, &record, this_value, &execution);
    MalValue ret = mal_value_new_undefined();
    if (!mal_builtin_set_record_keys_iterator(vm, &record, &execution.iterator)) {
        goto done;
    }

    // GetIteratorFromMethod, including the observable `next` lookup, precedes
    // copying the receiver's SetData. User code reached by that lookup can
    // mutate the receiver, and the result must reflect the updated contents.
    set = mal_value_to_map_object(this_value);
    MalMapObject *result = mal_builtin_set_new_result(vm, set, reserve_size);
    execution.values[0] = mal_value_from_map_object(result);

    while (true) {
        bool done;
        if (!mal_vm_iterator_step(
                vm, &execution.iterator, &execution.values[1], &done)) {
            goto done;
        }
        if (done) {
            ret = execution.values[0];
            goto done;
        }

        // mal_map_object_set canonicalizes (-0 -> +0) and dedups on insert.
        result = mal_value_to_map_object(execution.values[0]);
        mal_map_object_set(result, execution.values[1], execution.values[1]);
    }

done:
    mal_builtin_set_execution_end(vm, &execution);
    return ret;
}

static MalValue mal_builtin_set_prototype_intersection(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalSetRecord record;
    if (!mal_builtin_set_get_set_record(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    if (record.native_set == set) {
        return mal_value_from_map_object(mal_builtin_set_new_result(
            vm, set, mal_map_object_size(set)));
    }

    MalMapObject *result = mal_builtin_set_new_result(
        vm, nullptr, mal_map_object_size(set));

    if ((f64) mal_map_object_size(set) <= record.size) {
        if (record.native_set != nullptr) {
            MalTableIter iter;
            mal_table_iter_init(&iter, set->entries, MAL_TABLE_ITER_STORAGE);
            MalKey key;
            void *entry;
            while (mal_table_iter_next(&iter, &key, &entry)) {
                if (mal_map_object_has_canonical(record.native_set, key)) {
                    mal_map_object_set_canonical(result, key, key.value);
                }
            }
            return mal_value_from_map_object(result);
        }

        // other.has() may mutate the receiver. A pinned storage walk naturally
        // follows the spec's dynamically refreshed SetData length, including a
        // delete-then-reinsert appended entry; the result table deduplicates it.
        mal_table_pin(set->entries);
        MalSetExecution execution;
        mal_builtin_set_execution_begin(
            vm, &record, mal_value_from_map_object(result), &execution);
        MalValue ret = mal_value_new_undefined();
        MalTableIter iter;
        mal_table_iter_init(&iter, set->entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            execution.values[1] = key.value;
            bool in_other;
            if (!mal_builtin_set_record_has(
                    vm, &record, execution.values[1], &in_other)) {
                goto receiver_done;
            }
            if (in_other) {
                result = mal_value_to_map_object(execution.values[0]);
                mal_map_object_set(
                    result, execution.values[1], execution.values[1]);
            }
        }
        ret = execution.values[0];

receiver_done:
        mal_builtin_set_execution_end(vm, &execution);
        mal_table_unpin(set->entries);
        return ret;
    } else {
        if (record.native_set != nullptr) {
            MalTableIter iter;
            mal_table_iter_init(
                &iter, record.native_set->entries, MAL_TABLE_ITER_STORAGE);
            MalKey key;
            void *entry;
            while (mal_table_iter_next(&iter, &key, &entry)) {
                if (mal_map_object_has_canonical(set, key)) {
                    mal_map_object_set_canonical(result, key, key.value);
                }
            }
            return mal_value_from_map_object(result);
        }

        // Walk other's keys; keep those the receiver still contains, deduped.
        MalSetExecution execution;
        mal_builtin_set_execution_begin(
            vm, &record, mal_value_from_map_object(result), &execution);
        MalValue ret = mal_value_new_undefined();
        if (!mal_builtin_set_record_keys_iterator(
                vm, &record, &execution.iterator)) {
            goto iterator_done;
        }
        while (true) {
            bool done;
            if (!mal_vm_iterator_step(
                    vm, &execution.iterator, &execution.values[1], &done)) {
                goto iterator_done;
            }
            if (done) {
                break;
            }
            if (mal_map_object_has(set, execution.values[1])) {
                result = mal_value_to_map_object(execution.values[0]);
                mal_map_object_set(
                    result, execution.values[1], execution.values[1]);
            }
        }
        ret = execution.values[0];

iterator_done:
        mal_builtin_set_execution_end(vm, &execution);
        return ret;
    }
}

static MalValue mal_builtin_set_prototype_difference(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalSetRecord record;
    if (!mal_builtin_set_get_set_record(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    if (record.native_set == set) {
        return mal_value_from_map_object(
            mal_builtin_set_new_result(vm, nullptr, 0));
    }

    MalMapObject *result = mal_builtin_set_new_result(
        vm, set, mal_map_object_size(set));

    if ((f64) mal_map_object_size(set) <= record.size) {
        // The spec walks the private result-data copy, not the receiver: a
        // user-defined has() can mutate the receiver but cannot add callbacks or
        // entries to this fixed worklist.
        mal_table_pin(result->entries);
        if (record.native_set != nullptr) {
            MalTableIter iter;
            mal_table_iter_init(&iter, result->entries, MAL_TABLE_ITER_STORAGE);
            MalKey key;
            void *entry;
            while (mal_table_iter_next(&iter, &key, &entry)) {
                if (mal_map_object_has_canonical(record.native_set, key)) {
                    mal_map_object_delete_canonical(result, key);
                }
            }
            mal_table_unpin(result->entries);
            return mal_value_from_map_object(result);
        }

        MalSetExecution execution;
        mal_builtin_set_execution_begin(
            vm, &record, mal_value_from_map_object(result), &execution);
        MalValue ret = mal_value_new_undefined();
        MalTableIter iter;
        mal_table_iter_init(&iter, result->entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            execution.values[1] = key.value;
            bool in_other;
            if (!mal_builtin_set_record_has(
                    vm, &record, execution.values[1], &in_other)) {
                goto result_done;
            }
            if (in_other) {
                result = mal_value_to_map_object(execution.values[0]);
                mal_map_object_delete(result, execution.values[1]);
            }
        }
        ret = execution.values[0];

result_done:
        mal_builtin_set_execution_end(vm, &execution);
        mal_table_unpin(result->entries);
        return ret;
    } else {
        if (record.native_set != nullptr) {
            MalTableIter iter;
            mal_table_iter_init(
                &iter, record.native_set->entries, MAL_TABLE_ITER_STORAGE);
            MalKey key;
            void *entry;
            while (mal_table_iter_next(&iter, &key, &entry)) {
                mal_map_object_delete_canonical(result, key);
            }
            return mal_value_from_map_object(result);
        }

        // Remove every key other yields from the receiver's copy.
        MalSetExecution execution;
        mal_builtin_set_execution_begin(
            vm, &record, mal_value_from_map_object(result), &execution);
        MalValue ret = mal_value_new_undefined();
        if (!mal_builtin_set_record_keys_iterator(
                vm, &record, &execution.iterator)) {
            goto iterator_done;
        }
        while (true) {
            bool done;
            if (!mal_vm_iterator_step(
                    vm, &execution.iterator, &execution.values[1], &done)) {
                goto iterator_done;
            }
            if (done) {
                break;
            }
            result = mal_value_to_map_object(execution.values[0]);
            mal_map_object_delete(result, execution.values[1]);
        }
        ret = execution.values[0];

iterator_done:
        mal_builtin_set_execution_end(vm, &execution);
        return ret;
    }
}

static MalValue mal_builtin_set_prototype_symmetric_difference(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalSetRecord record;
    if (!mal_builtin_set_get_set_record(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    if (record.native_set == set) {
        return mal_value_from_map_object(
            mal_builtin_set_new_result(vm, nullptr, 0));
    }

    usize reserve_size = mal_map_object_size(set);
    if (record.native_set != nullptr &&
        SIZE_MAX - reserve_size >= mal_map_object_size(record.native_set)) {
        reserve_size += mal_map_object_size(record.native_set);
    }
    if (record.native_set != nullptr) {
        MalMapObject *result = mal_builtin_set_new_result(vm, set, reserve_size);
        MalTableIter iter;
        mal_table_iter_init(
            &iter, record.native_set->entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            if (mal_map_object_has_canonical(set, key)) {
                mal_map_object_delete_canonical(result, key);
            } else {
                mal_map_object_set_canonical(result, key, key.value);
            }
        }
        return mal_value_from_map_object(result);
    }

    MalSetExecution execution;
    mal_builtin_set_execution_begin(
        vm, &record, this_value, &execution);
    MalValue ret = mal_value_new_undefined();
    if (!mal_builtin_set_record_keys_iterator(vm, &record, &execution.iterator)) {
        goto done;
    }

    // As in union, capture the iterator's `next` before copying the receiver.
    set = mal_value_to_map_object(this_value);
    MalMapObject *result = mal_builtin_set_new_result(vm, set, reserve_size);
    execution.values[0] = mal_value_from_map_object(result);

    while (true) {
        bool done;
        if (!mal_vm_iterator_step(
                vm, &execution.iterator, &execution.values[1], &done)) {
            goto done;
        }
        if (done) {
            ret = execution.values[0];
            goto done;
        }

        // Membership is checked against the original receiver, not the result,
        // so duplicates other yields cannot resurrect a removed element.
        result = mal_value_to_map_object(execution.values[0]);
        if (mal_map_object_has(set, execution.values[1])) {
            mal_map_object_delete(result, execution.values[1]);
        } else {
            mal_map_object_set(result, execution.values[1], execution.values[1]);
        }
    }

done:
    mal_builtin_set_execution_end(vm, &execution);
    return ret;
}

static MalValue mal_builtin_set_prototype_is_subset_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalSetRecord record;
    if (!mal_builtin_set_get_set_record(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    if (record.native_set == set) {
        return mal_value_new_boolean(true);
    }

    if ((f64) mal_map_object_size(set) > record.size) {
        return mal_value_new_boolean(false);
    }

    if (record.native_set != nullptr) {
        MalTableIter iter;
        mal_table_iter_init(&iter, set->entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            if (!mal_map_object_has_canonical(record.native_set, key)) {
                return mal_value_new_boolean(false);
            }
        }
        return mal_value_new_boolean(true);
    }

    mal_table_pin(set->entries);
    MalSetExecution execution;
    mal_builtin_set_execution_begin(
        vm, &record, mal_value_new_undefined(), &execution);
    MalValue ret = mal_value_new_undefined();
    MalTableIter iter;
    mal_table_iter_init(&iter, set->entries, MAL_TABLE_ITER_STORAGE);
    MalKey key;
    void *entry;
    while (mal_table_iter_next(&iter, &key, &entry)) {
        execution.values[1] = key.value;
        bool in_other;
        if (!mal_builtin_set_record_has(
                vm, &record, execution.values[1], &in_other)) {
            goto done;
        }
        if (!in_other) {
            ret = mal_value_new_boolean(false);
            goto done;
        }
    }
    ret = mal_value_new_boolean(true);

done:
    mal_builtin_set_execution_end(vm, &execution);
    mal_table_unpin(set->entries);
    return ret;
}

static MalValue mal_builtin_set_prototype_is_superset_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalSetRecord record;
    if (!mal_builtin_set_get_set_record(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    if (record.native_set == set) {
        return mal_value_new_boolean(true);
    }

    if ((f64) mal_map_object_size(set) < record.size) {
        return mal_value_new_boolean(false);
    }

    if (record.native_set != nullptr) {
        MalTableIter iter;
        mal_table_iter_init(
            &iter, record.native_set->entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            if (!mal_map_object_has_canonical(set, key)) {
                return mal_value_new_boolean(false);
            }
        }
        return mal_value_new_boolean(true);
    }

    MalSetExecution execution;
    mal_builtin_set_execution_begin(
        vm, &record, mal_value_new_undefined(), &execution);
    MalValue ret = mal_value_new_undefined();
    if (!mal_builtin_set_record_keys_iterator(vm, &record, &execution.iterator)) {
        goto done;
    }
    while (true) {
        bool done;
        if (!mal_vm_iterator_step(
                vm, &execution.iterator, &execution.values[1], &done)) {
            goto done;
        }
        if (done) {
            ret = mal_value_new_boolean(true);
            goto done;
        }
        if (!mal_map_object_has(set, execution.values[1])) {
            if (mal_vm_iterator_close_normal(vm, &execution.iterator)) {
                ret = mal_value_new_boolean(false);
            }
            goto done;
        }
    }

done:
    mal_builtin_set_execution_end(vm, &execution);
    return ret;
}

static MalValue mal_builtin_set_prototype_is_disjoint_from(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *set = mal_builtin_set_this(vm, this_value, false, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalSetRecord record;
    if (!mal_builtin_set_get_set_record(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    if (record.native_set == set) {
        return mal_value_new_boolean(mal_map_object_size(set) == 0);
    }

    if ((f64) mal_map_object_size(set) <= record.size) {
        if (record.native_set != nullptr) {
            MalTableIter iter;
            mal_table_iter_init(&iter, set->entries, MAL_TABLE_ITER_STORAGE);
            MalKey key;
            void *entry;
            while (mal_table_iter_next(&iter, &key, &entry)) {
                if (mal_map_object_has_canonical(record.native_set, key)) {
                    return mal_value_new_boolean(false);
                }
            }
            return mal_value_new_boolean(true);
        }

        mal_table_pin(set->entries);
        MalSetExecution execution;
        mal_builtin_set_execution_begin(
            vm, &record, mal_value_new_undefined(), &execution);
        MalValue ret = mal_value_new_undefined();
        MalTableIter iter;
        mal_table_iter_init(&iter, set->entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            execution.values[1] = key.value;
            bool in_other;
            if (!mal_builtin_set_record_has(
                    vm, &record, execution.values[1], &in_other)) {
                goto receiver_done;
            }
            if (in_other) {
                ret = mal_value_new_boolean(false);
                goto receiver_done;
            }
        }
        ret = mal_value_new_boolean(true);

receiver_done:
        mal_builtin_set_execution_end(vm, &execution);
        mal_table_unpin(set->entries);
        return ret;
    } else {
        if (record.native_set != nullptr) {
            MalTableIter iter;
            mal_table_iter_init(
                &iter, record.native_set->entries, MAL_TABLE_ITER_STORAGE);
            MalKey key;
            void *entry;
            while (mal_table_iter_next(&iter, &key, &entry)) {
                if (mal_map_object_has_canonical(set, key)) {
                    return mal_value_new_boolean(false);
                }
            }
            return mal_value_new_boolean(true);
        }

        MalSetExecution execution;
        mal_builtin_set_execution_begin(
            vm, &record, mal_value_new_undefined(), &execution);
        MalValue ret = mal_value_new_undefined();
        if (!mal_builtin_set_record_keys_iterator(
                vm, &record, &execution.iterator)) {
            goto iterator_done;
        }
        while (true) {
            bool done;
            if (!mal_vm_iterator_step(
                    vm, &execution.iterator, &execution.values[1], &done)) {
                goto iterator_done;
            }
            if (done) {
                break;
            }
            if (mal_map_object_has(set, execution.values[1])) {
                if (mal_vm_iterator_close_normal(vm, &execution.iterator)) {
                    ret = mal_value_new_boolean(false);
                }
                goto iterator_done;
            }
        }
        ret = mal_value_new_boolean(true);

iterator_done:
        mal_builtin_set_execution_end(vm, &execution);
        return ret;
    }
}

static MalObject *mal_builtin_set_scaffold(
    MalVm *vm,
    const byte *name,
    MalNativeFunctionCallback constructor_callback,
    MalIntrinsic constructor_slot,
    MalIntrinsic prototype_slot,
    const byte *tag
) {
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name),
        0,
        constructor_callback
    );
    mal_native_function_object_set_handles_new_target_prototype(constructor);

    vm->intrinsics[constructor_slot] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[prototype_slot] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[prototype_slot], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[constructor_slot], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, tag)),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    return prototype;
}

static void mal_builtin_set_define_size(MalVm *vm, MalObject *prototype, MalNativeFunctionCallback getter) {
    mal_intrinsic_define_getter(
        vm, prototype, "size", "get size", getter, MAL_PROPERTY_CONFIGURABLE);
}

void mal_builtin_set_install(MalVm *vm) {
    MalObject *prototype = mal_builtin_set_scaffold(
        vm,
        "Set",
        mal_builtin_set_constructor,
        MAL_INTRINSIC_SET_CONSTRUCTOR,
        MAL_INTRINSIC_SET_PROTOTYPE,
        "Set"
    );

    vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_ADD] =
        mal_intrinsic_define_method_n(vm, prototype, "add", 1, mal_builtin_set_prototype_add);
    vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_HAS] =
        mal_intrinsic_define_method_n(vm, prototype, "has", 1, mal_builtin_set_prototype_has);
    vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_DELETE] =
        mal_intrinsic_define_method_n(vm, prototype, "delete", 1, mal_builtin_set_prototype_delete);
    mal_intrinsic_define_method_n(vm, prototype, "clear", 0, mal_builtin_set_prototype_clear);
    mal_intrinsic_define_method_n(vm, prototype, "forEach", 1, mal_builtin_set_prototype_for_each);
    mal_intrinsic_define_method_n(vm, prototype, "union", 1, mal_builtin_set_prototype_union);
    mal_intrinsic_define_method_n(vm, prototype, "intersection", 1, mal_builtin_set_prototype_intersection);
    mal_intrinsic_define_method_n(vm, prototype, "difference", 1, mal_builtin_set_prototype_difference);
    mal_intrinsic_define_method_n(vm, prototype, "symmetricDifference", 1, mal_builtin_set_prototype_symmetric_difference);
    mal_intrinsic_define_method_n(vm, prototype, "isSubsetOf", 1, mal_builtin_set_prototype_is_subset_of);
    mal_intrinsic_define_method_n(vm, prototype, "isSupersetOf", 1, mal_builtin_set_prototype_is_superset_of);
    mal_intrinsic_define_method_n(vm, prototype, "isDisjointFrom", 1, mal_builtin_set_prototype_is_disjoint_from);
    mal_intrinsic_define_method_n(vm, prototype, "entries", 0, mal_builtin_set_prototype_entries);
    MalValue values = mal_intrinsic_define_method_n(
        vm, prototype, "values", 0, mal_builtin_set_prototype_values);
    vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_VALUES] = values;

    // Set.prototype.keys and Set.prototype[Symbol.iterator] are the same
    // function object as Set.prototype.values.
    mal_intrinsic_define_data(vm, prototype, "keys", values, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    MalPropertyDesc iterator_desc = mal_intrinsic_data_desc(values, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &iterator_desc);

    mal_builtin_set_define_size(vm, prototype, mal_builtin_set_prototype_size_getter);
    mal_intrinsic_define_species(vm, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_SET_CONSTRUCTOR]));

    MalObject *weak_prototype = mal_builtin_set_scaffold(
        vm,
        "WeakSet",
        mal_builtin_weak_set_constructor,
        MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR,
        MAL_INTRINSIC_WEAK_SET_PROTOTYPE,
        "WeakSet"
    );

    mal_intrinsic_define_method_n(vm, weak_prototype, "add", 1, mal_builtin_weak_set_prototype_add);
    mal_intrinsic_define_method_n(vm, weak_prototype, "has", 1, mal_builtin_weak_set_prototype_has);
    mal_intrinsic_define_method_n(vm, weak_prototype, "delete", 1, mal_builtin_weak_set_prototype_delete);
}
