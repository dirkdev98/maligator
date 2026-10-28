#include "builtin_set.h"

#include <math.h>

#include "builtin_iterator.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "perf_stats.h"
#include "set_object.h"
#include "weak_collection.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static MalSetObject *mal_builtin_set_this(MalVm *vm, MalValue this_value, const byte *message) {
    if (!mal_value_is_set_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        return nullptr;
    }

    return mal_value_to_set_object(this_value);
}

static MalWeakSetObject *mal_builtin_weak_set_this(MalVm *vm, MalValue value) {
    if (!mal_value_is_weak_set_object(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not a WeakSet");
        return nullptr;
    }
    return mal_value_to_weak_set_object(value);
}

static MalValue mal_builtin_weak_set_prototype_add(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee);

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
    MalIntrinsic constructor_slot =
        weak ? MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR : MAL_INTRINSIC_SET_CONSTRUCTOR;
    // An intrinsic constructor's own `prototype` is non-writable and non-configurable.
    if (new_target == vm->intrinsics[constructor_slot]) {
        prototype = mal_value_to_object(vm->intrinsics[prototype_slot]);
    } else if (!mal_vm_get_prototype_from_constructor(vm, new_target, prototype_slot, &prototype)) {
        return mal_value_new_undefined();
    }

    MalValue set_value = weak
        ? mal_value_from_weak_set_object(mal_weak_set_object_new(&vm->heap, prototype))
        : mal_value_from_set_object(mal_set_object_new(&vm->heap, prototype));
    MalSetObject *set = weak ? nullptr : mal_value_to_set_object(set_value);
    MalWeakSetObject *weak_set = weak ? mal_value_to_weak_set_object(set_value) : nullptr;

    if (arg_count < 1 || mal_value_is_nil(args[0])) {
        return set_value;
    }

    MalValue roots[3] = {
        set_value,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalIteratorRecord record = {
        .iterator = mal_value_new_undefined(),
        .next_method = mal_value_new_undefined(),
    };
    MalRootSpan rec_span, span;
    mal_gc_root(&rec_span, &record.iterator, 2);
    mal_gc_root(&span, roots, countof(roots));
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();
    MalExactScriptCall runtime_callback;
    bool nominated = false;

    // Adder and iterator getters can explicitly collect before population starts.
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_ADD), &roots[1])) {
        goto done;
    }
    if (!mal_value_is_callable(roots[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Set adder is not callable");
        goto done;
    }
    bool direct_set_adder = !weak &&
        roots[1] == vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_ADD];
    bool direct_weak_adder = weak &&
        mal_value_is_native_function_object(roots[1]) &&
        mal_native_function_object_callback(
            mal_value_to_native_function_object(roots[1])) ==
            mal_builtin_weak_set_prototype_add;
#if MAL_REALMS
    // Invalid weak keys must throw in the captured adder's realm.
    direct_weak_adder = direct_weak_adder &&
        mal_vm_callee_realm(vm, roots[1]) == vm->current_realm;
#endif
    bool direct_adder = direct_set_adder || direct_weak_adder;
    MalArrayValuesDeferredCursor array_cursor;
    // The builtin adder runs no code, so nothing can observe the ArrayIterator this skips.
    if (direct_set_adder && mal_vm_array_values_deferred_begin(vm, args[0], &array_cursor)) {
        record.iterator = args[0];
        (void) mal_set_object_reserve(
            set, mal_array_object_length(mal_value_to_array_object(record.iterator)));
        while (true) {
            bool done;
            if (!mal_vm_array_values_deferred_step(
                    vm, record.iterator, &array_cursor, &roots[2], &done)) {
                goto done;
            }
            if (done) {
                ret = roots[0];
                goto done;
            }
            mal_set_object_add(set, roots[2]);
        }
    }
    if (!mal_vm_get_iterator(vm, args[0], &record)) {
        goto done;
    }
    nominated = !direct_adder &&
        (vm->exact_script_call == nullptr || vm->exact_script_call->callee != roots[1]) &&
        mal_vm_prepare_builtin_callback(vm, roots[1], &runtime_callback);
    if (nominated) {
        vm->exact_script_call = &runtime_callback;
        if (weak) MAL_PERF_COUNT(collection_constructor_weak_set_nominations);
        else MAL_PERF_COUNT(collection_constructor_set_nominations);
    }

    MalIteratorObject *dense_array_cursor = direct_set_adder
        ? mal_vm_iterator_dense_array_cursor(&record)
        : nullptr;
    MalIteratorObject *set_values_cursor = direct_set_adder
        ? mal_vm_iterator_protocol_cursor(&record, MAL_ITERATOR_CURSOR_SET)
        : nullptr;
    bool direct_set_values = set_values_cursor != nullptr &&
        set_values_cursor->kind == MAL_ITERATOR_SET_VALUES;

    usize size_hint;
    if (direct_adder &&
        mal_vm_builtin_iterator_size_hint(&record, &size_hint)) {
        if (weak) (void) mal_weak_set_object_reserve(weak_set, size_hint);
        else (void) mal_set_object_reserve(set, size_hint);
    }

    while (true) {
        bool done;
        bool stepped;
        if (direct_set_values) {
            mal_vm_iterator_step_set_values_cursor(
                set_values_cursor, &roots[2], &done);
            stepped = true;
        } else {
            stepped = dense_array_cursor != nullptr
                ? mal_vm_iterator_step_dense_array_cursor(
                    vm, dense_array_cursor, &record, &roots[2], &done)
                : mal_vm_iterator_step(vm, &record, &roots[2], &done);
        }
        if (!stepped) {
            goto done;
        }

        if (done) {
            ret = roots[0];
            goto done;
        }

        if (direct_adder) {
            if (direct_weak_adder &&
                !mal_weak_key_can_be_held(roots[2])) {
                mal_vm_throw_error(
                    vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    "Invalid value used in weak set");
                mal_vm_iterator_close(vm, &record);
                goto done;
            }
            if (direct_weak_adder) mal_weak_set_object_add(weak_set, roots[2]);
            else mal_set_object_add(set, roots[2]);
            continue;
        }

        MalCompletion completion = mal_vm_call_builtin_callback(
            vm, roots[1], roots[0], &roots[2], 1);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            mal_vm_iterator_close(vm, &record);
            goto done;
        }
    }

done:
    if (nominated) vm->exact_script_call = runtime_callback.previous;
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
    MalSetObject *set = mal_builtin_set_this(vm, this_value, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    mal_set_object_add(set, value);

    return this_value;
}

static MalValue mal_builtin_set_prototype_has(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalSetObject *set = mal_builtin_set_this(vm, this_value, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_set_object_has(set, arg_count >= 1 ? args[0] : mal_value_new_undefined()));
}

static MalValue mal_builtin_set_prototype_delete(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalSetObject *set = mal_builtin_set_this(vm, this_value, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_set_object_delete(set, arg_count >= 1 ? args[0] : mal_value_new_undefined()));
}

MalValue mal_builtin_set_add_value(MalVm *vm, MalValue this_value, MalValue value) {
    (void) vm;
    mal_set_object_add(mal_value_to_set_object(this_value), value);
    return this_value;
}

MalValue mal_builtin_set_add_known(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    return mal_builtin_set_add_value(vm, this_value, arg_count >= 1 ? args[0] : MAL_VALUE_UNDEFINED);
}

bool mal_builtin_set_has_value(MalVm *vm, MalValue this_value, MalValue value) {
    (void) vm;
    return mal_set_object_has(mal_value_to_set_object(this_value), value);
}

MalValue mal_builtin_set_has_known(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    return mal_value_new_boolean(mal_builtin_set_has_value(vm, this_value, arg_count >= 1 ? args[0] : MAL_VALUE_UNDEFINED));
}

bool mal_builtin_set_delete_value(MalVm *vm, MalValue this_value, MalValue value) {
    (void) vm;
    return mal_set_object_delete(mal_value_to_set_object(this_value), value);
}

MalValue mal_builtin_set_add_number(MalVm *vm, MalValue this_value, f64 value) {
    (void) vm;
    mal_set_object_add_canonical(
        mal_value_to_set_object(this_value), mal_collection_canonical_number(value));
    return this_value;
}

bool mal_builtin_set_has_number(MalVm *vm, MalValue this_value, f64 value) {
    (void) vm;
    return mal_set_object_has_canonical(
        mal_value_to_set_object(this_value), mal_collection_canonical_number(value));
}

bool mal_builtin_set_delete_number(MalVm *vm, MalValue this_value, f64 value) {
    (void) vm;
    return mal_set_object_delete_canonical(
        mal_value_to_set_object(this_value), mal_collection_canonical_number(value));
}

MalValue mal_builtin_set_delete_known(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    return mal_value_new_boolean(mal_builtin_set_delete_value(vm, this_value, arg_count >= 1 ? args[0] : MAL_VALUE_UNDEFINED));
}

static MalValue mal_builtin_set_prototype_clear(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;

    MalSetObject *set = mal_builtin_set_this(vm, this_value, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    mal_set_object_clear(set);

    return mal_value_new_undefined();
}

static MalValue mal_builtin_set_prototype_size_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;

    MalSetObject *set = mal_builtin_set_this(vm, this_value, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_from_i32((i32) mal_set_object_size(set));
}

MalValue mal_builtin_set_prototype_for_each(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalSetObject *set = mal_builtin_set_this(vm, this_value, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    if (arg_count < 1 || !mal_value_is_callable(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Set.prototype.forEach callback is not a function");
        return mal_value_new_undefined();
    }

    MalValue this_arg = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    mal_set_storage_pin(set->entries);
    MalSetIter iter;
    mal_set_iter_init(&iter, set->entries);

    // A Proxy apply getter can remove the current member before publishing arguments.
    MalValue callback_args[3] = {MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, this_value};
    MalRootSpan span;
    mal_gc_root(&span, callback_args, countof(callback_args));
    mal_gc_native_rooted_begin(vm);
    MalValue key;
    while (mal_set_iter_next(&iter, &key)) {
        callback_args[0] = callback_args[1] = key;
        MalExactScriptCall *exact = vm->exact_script_call;
        MalCompletion completion = exact != nullptr && exact->callee == args[0]
            ? mal_vm_call_builtin_callback(vm, args[0], this_arg, callback_args, 3)
            : mal_vm_call_cached(vm, args[0], this_arg, callback_args, 3);
        if (completion.kind != MAL_COMPLETION_NORMAL) break;
    }
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&span);
    mal_set_storage_unpin(set->entries);
    mal_set_object_compact(set);

    return mal_value_new_undefined();
}

static MalValue mal_builtin_set_prototype_iterator(MalVm *vm, MalValue this_value, MalIteratorKind kind) {
    if (mal_builtin_set_this(vm, this_value, "Receiver is not a Set") == nullptr) {
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

bool mal_builtin_weak_set_has_key(MalValue receiver, MalValue key) {
    return mal_weak_set_object_has(mal_value_to_weak_set_object(receiver), key);
}

bool mal_builtin_weak_set_delete_key(MalValue receiver, MalValue key) {
    return mal_weak_set_object_delete(mal_value_to_weak_set_object(receiver), key);
}

MalValue mal_builtin_weak_set_add_key(MalVm *vm, MalValue receiver, MalValue key) {
    if (!mal_weak_key_can_be_held(key)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid value used in weak set");
        return mal_value_new_undefined();
    }
    mal_weak_set_object_add(mal_value_to_weak_set_object(receiver), key);
    return receiver;
}

static MalValue mal_builtin_weak_set_prototype_add(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalWeakSetObject *set = mal_builtin_weak_set_this(vm, this_value);
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_builtin_weak_set_add_key(
        vm, this_value, arg_count >= 1 ? args[0] : MAL_VALUE_UNDEFINED);
}

static MalValue mal_builtin_weak_set_prototype_has(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalWeakSetObject *set = mal_builtin_weak_set_this(vm, this_value);
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_weak_set_object_has(set, arg_count >= 1 ? args[0] : mal_value_new_undefined()));
}

static MalValue mal_builtin_weak_set_prototype_delete(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalWeakSetObject *set = mal_builtin_weak_set_this(vm, this_value);
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_weak_set_object_delete(set, arg_count >= 1 ? args[0] : mal_value_new_undefined()));
}

typedef struct MalSetRecord {
    MalValue set_object;
    MalValue has;
    MalValue keys;
    f64 size;
    /** Exact same-Realm Set internals when captured has/keys are unmodified. */
    MalSetObject *native_set;
} MalSetRecord;

static bool mal_builtin_set_get_set_record(MalVm *vm, MalValue obj, MalSetRecord *record_out) {
    if (!mal_value_is_object(obj)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Set-like argument is not an object");
        return false;
    }

    // The protector covers inherited size/has/keys only for an unmodified intrinsic instance.
    if (mal_vm_primitive_methods_intact(vm) && mal_value_is_set_object(obj)) {
        MalSetObject *candidate = mal_value_to_set_object(obj);
        MalObject *object = &candidate->object;
        if (mal_object_prototype(object) ==
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE]) &&
            object->shape->inline_count == 0 && mal_object_overflow(object) == nullptr) {
            *record_out = (MalSetRecord) {
                .set_object = obj,
                .has = vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_HAS],
                .keys = vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_VALUES],
                .size = (f64) mal_set_object_size(candidate),
                .native_set = candidate,
            };
            return true;
        }
    }

    MalSetRecord record = {
        .set_object = obj,
        .has = mal_value_new_undefined(),
        .keys = mal_value_new_undefined(),
    };
    MalValue raw_size = mal_value_new_undefined();
    MalRootSpan record_span, size_span;
    mal_gc_root(&record_span, &record.set_object, 3);
    mal_gc_root(&size_span, &raw_size, 1);
    bool ok = false;

    // Later getters can explicitly collect a freshly returned earlier method or size object.
    if (!mal_vm_get_property(vm, obj, mal_intrinsic_string_key(vm, "size"), &raw_size)) {
        goto done;
    }
    f64 num_size;
    if (!mal_vm_to_number(vm, raw_size, &num_size)) goto done;
    if (isnan(num_size)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Set-like size is NaN");
        goto done;
    }
    record.size = trunc(num_size);
    if (record.size < 0.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Set-like size is negative");
        goto done;
    }
    if (!mal_vm_get_property(vm, obj, mal_intrinsic_string_key(vm, "has"), &record.has)) {
        goto done;
    }
    if (!mal_value_is_callable(record.has)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Set-like 'has' is not callable");
        goto done;
    }
    if (!mal_vm_get_property(vm, obj, mal_intrinsic_string_key(vm, "keys"), &record.keys)) {
        goto done;
    }
    if (!mal_value_is_callable(record.keys)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Set-like 'keys' is not callable");
        goto done;
    }
    if (mal_value_is_set_object(obj) &&
        record.has == vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_HAS] &&
        record.keys == vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE_VALUES]) {
        record.native_set = mal_value_to_set_object(obj);
    }
    *record_out = record;
    ok = true;

done:
    mal_gc_unroot(&size_span);
    mal_gc_unroot(&record_span);
    return ok;
}

typedef struct MalSetExecution {
    MalValue values[2]; // result (or undefined), current iterator/key value
    MalIteratorRecord iterator;
    MalRootSpan record_span;
    MalRootSpan values_span;
    MalRootSpan iterator_span;
    MalExactScriptCall has_callback;
    bool nominated_has;
} MalSetExecution;

static void mal_builtin_set_execution_begin(
    MalVm *vm, MalSetRecord *record, MalValue result, MalSetExecution *execution,
    bool calls_has
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
    execution->nominated_has = calls_has &&
        (vm->exact_script_call == nullptr || vm->exact_script_call->callee != record->has) &&
        mal_vm_prepare_builtin_callback(vm, record->has, &execution->has_callback);
    if (execution->nominated_has) {
        vm->exact_script_call = &execution->has_callback;
        MAL_PERF_COUNT(set_algebra_has_callback_nominations);
    }
}

static void mal_builtin_set_execution_end(MalVm *vm, MalSetExecution *execution) {
    if (execution->nominated_has) vm->exact_script_call = execution->has_callback.previous;
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

static bool mal_builtin_set_record_has(MalVm *vm, const MalSetRecord *record, MalValue value, bool *out) {
    MalCompletion completion = mal_vm_call_builtin_callback(vm, record->has, record->set_object, &value, 1);
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
static MalSetObject *mal_builtin_set_new_result(
    MalVm *vm, const MalSetObject *seed, usize reserve_size
) {
    MalSetObject *result = mal_set_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE]));

    if (seed != nullptr && reserve_size < mal_set_object_size(seed)) {
        reserve_size = mal_set_object_size(seed);
    }
    (void) mal_set_object_reserve(result, reserve_size);

    if (seed != nullptr) {
        MalSetIter iter;
        mal_set_iter_init(&iter, seed->entries);
        MalValue key;
        while (mal_set_iter_next(&iter, &key)) {
            mal_set_object_add_canonical(result, key);
        }
    }

    return result;
}

static MalValue mal_builtin_set_prototype_union(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalSetObject *set = mal_builtin_set_this(vm, this_value, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalSetRecord record;
    if (!mal_builtin_set_get_set_record(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    if (record.native_set == set) {
        return mal_value_from_set_object(mal_builtin_set_new_result(
            vm, set, mal_set_object_size(set)));
    }

    if (record.native_set != nullptr) {
        if (mal_set_object_size(set) == 0) {
            return mal_value_from_set_object(mal_builtin_set_new_result(
                vm, record.native_set,
                mal_set_object_size(record.native_set)));
        }
        if (mal_set_object_size(record.native_set) == 0) {
            return mal_value_from_set_object(mal_builtin_set_new_result(
                vm, set, mal_set_object_size(set)));
        }
    }

    usize reserve_size = mal_set_object_size(set);
    if (record.native_set != nullptr &&
        SIZE_MAX - reserve_size >= mal_set_object_size(record.native_set)) {
        reserve_size += mal_set_object_size(record.native_set);
    }
    if (record.native_set != nullptr) {
        MalSetObject *result = mal_builtin_set_new_result(vm, set, reserve_size);
        MalSetIter iter;
        mal_set_iter_init(&iter, record.native_set->entries);
        MalValue key;
        while (mal_set_iter_next(&iter, &key)) {
            mal_set_object_add_canonical(result, key);
        }
        return mal_value_from_set_object(result);
    }

    MalSetExecution execution;
    mal_builtin_set_execution_begin(
        vm, &record, this_value, &execution, false);
    MalValue ret = mal_value_new_undefined();
    if (!mal_builtin_set_record_keys_iterator(vm, &record, &execution.iterator)) {
        goto done;
    }

    // GetIteratorFromMethod, including the observable `next` lookup, precedes
    // copying the receiver's SetData. User code reached by that lookup can
    // mutate the receiver, and the result must reflect the updated contents.
    set = mal_value_to_set_object(this_value);
    MalSetObject *result = mal_builtin_set_new_result(vm, set, reserve_size);
    execution.values[0] = mal_value_from_set_object(result);

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

        // Insertion canonicalizes signed zero and deduplicates members.
        result = mal_value_to_set_object(execution.values[0]);
        mal_set_object_add(result, execution.values[1]);
    }

done:
    mal_builtin_set_execution_end(vm, &execution);
    return ret;
}

static MalValue mal_builtin_set_prototype_intersection(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalSetObject *set = mal_builtin_set_this(vm, this_value, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalSetRecord record;
    if (!mal_builtin_set_get_set_record(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    if (record.native_set == set) {
        return mal_value_from_set_object(mal_builtin_set_new_result(
            vm, set, mal_set_object_size(set)));
    }

    usize set_size = mal_set_object_size(set);
    if (set_size == 0 ||
        (record.native_set != nullptr &&
         mal_set_object_size(record.native_set) == 0)) {
        return mal_value_from_set_object(
            mal_builtin_set_new_result(vm, nullptr, 0));
    }

    usize reserve_size = set_size;
    if ((f64) set_size > record.size) {
        // This branch proves record.size is finite and no larger than a live
        // table size, so the ToIntegerOrInfinity result fits usize.
        reserve_size = (usize) record.size;
    }

    MalSetObject *result = mal_builtin_set_new_result(
        vm, nullptr, reserve_size);

    if ((f64) set_size <= record.size) {
        if (record.native_set != nullptr) {
            MalSetIter iter;
            mal_set_iter_init(&iter, set->entries);
            MalValue key;
            while (mal_set_iter_next(&iter, &key)) {
                if (mal_set_object_has_canonical(record.native_set, key)) {
                    mal_set_object_add_canonical(result, key);
                }
            }
            return mal_value_from_set_object(result);
        }

        // other.has() may mutate the receiver. A pinned storage walk naturally
        // follows the spec's dynamically refreshed SetData length, including a
        // delete-then-reinsert appended entry; the result table deduplicates it.
        mal_set_storage_pin(set->entries);
        MalSetExecution execution;
        mal_builtin_set_execution_begin(
            vm, &record, mal_value_from_set_object(result), &execution, true);
        MalValue ret = mal_value_new_undefined();
        MalSetIter iter;
        mal_set_iter_init(&iter, set->entries);
        MalValue key;
        while (mal_set_iter_next(&iter, &key)) {
            execution.values[1] = key;
            bool in_other;
            if (!mal_builtin_set_record_has(
                    vm, &record, execution.values[1], &in_other)) {
                goto receiver_done;
            }
            if (in_other) {
                result = mal_value_to_set_object(execution.values[0]);
                mal_set_object_add(result, execution.values[1]);
            }
        }
        ret = execution.values[0];

receiver_done:
        mal_builtin_set_execution_end(vm, &execution);
        mal_set_storage_unpin(set->entries);
        mal_set_object_compact(set);
        return ret;
    } else {
        if (record.native_set != nullptr) {
            MalSetIter iter;
            mal_set_iter_init(&iter, record.native_set->entries);
            MalValue key;
            while (mal_set_iter_next(&iter, &key)) {
                if (mal_set_object_has_canonical(set, key)) {
                    mal_set_object_add_canonical(result, key);
                }
            }
            return mal_value_from_set_object(result);
        }

        // Walk other's keys; keep those the receiver still contains, deduped.
        MalSetExecution execution;
        mal_builtin_set_execution_begin(
            vm, &record, mal_value_from_set_object(result), &execution, false);
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
            if (mal_set_object_has(set, execution.values[1])) {
                result = mal_value_to_set_object(execution.values[0]);
                mal_set_object_add(result, execution.values[1]);
            }
        }
        ret = execution.values[0];

iterator_done:
        mal_builtin_set_execution_end(vm, &execution);
        return ret;
    }
}

static MalValue mal_builtin_set_prototype_difference(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalSetObject *set = mal_builtin_set_this(vm, this_value, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalSetRecord record;
    if (!mal_builtin_set_get_set_record(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    if (record.native_set == set) {
        return mal_value_from_set_object(
            mal_builtin_set_new_result(vm, nullptr, 0));
    }

    if (mal_set_object_size(set) == 0) {
        return mal_value_from_set_object(
            mal_builtin_set_new_result(vm, nullptr, 0));
    }
    if (record.native_set != nullptr &&
        mal_set_object_size(record.native_set) == 0) {
        return mal_value_from_set_object(mal_builtin_set_new_result(
            vm, set, mal_set_object_size(set)));
    }

    MalSetObject *result = mal_builtin_set_new_result(
        vm, set, mal_set_object_size(set));

    if ((f64) mal_set_object_size(set) <= record.size) {
        // The spec walks the private result-data copy, not the receiver: a
        // user-defined has() can mutate the receiver but cannot add callbacks or
        // entries to this fixed worklist.
        mal_set_storage_pin(result->entries);
        if (record.native_set != nullptr) {
            MalSetIter iter;
            mal_set_iter_init(&iter, result->entries);
            MalValue key;
            while (mal_set_iter_next(&iter, &key)) {
                if (mal_set_object_has_canonical(record.native_set, key)) {
                    mal_set_object_delete_canonical(result, key);
                }
            }
            mal_set_storage_unpin(result->entries);
            mal_set_object_compact(result);
            return mal_value_from_set_object(result);
        }

        MalSetExecution execution;
        mal_builtin_set_execution_begin(
            vm, &record, mal_value_from_set_object(result), &execution, true);
        MalValue ret = mal_value_new_undefined();
        MalSetIter iter;
        mal_set_iter_init(&iter, result->entries);
        MalValue key;
        while (mal_set_iter_next(&iter, &key)) {
            execution.values[1] = key;
            bool in_other;
            if (!mal_builtin_set_record_has(
                    vm, &record, execution.values[1], &in_other)) {
                goto result_done;
            }
            if (in_other) {
                result = mal_value_to_set_object(execution.values[0]);
                mal_set_object_delete(result, execution.values[1]);
            }
        }
        ret = execution.values[0];

result_done:
        mal_builtin_set_execution_end(vm, &execution);
        mal_set_storage_unpin(result->entries);
        mal_set_object_compact(result);
        return ret;
    } else {
        if (record.native_set != nullptr) {
            MalSetIter iter;
            mal_set_iter_init(&iter, record.native_set->entries);
            MalValue key;
            while (mal_set_iter_next(&iter, &key)) {
                mal_set_object_delete_canonical(result, key);
            }
            return mal_value_from_set_object(result);
        }

        // Remove every key other yields from the receiver's copy.
        MalSetExecution execution;
        mal_builtin_set_execution_begin(
            vm, &record, mal_value_from_set_object(result), &execution, false);
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
            result = mal_value_to_set_object(execution.values[0]);
            mal_set_object_delete(result, execution.values[1]);
        }
        ret = execution.values[0];

iterator_done:
        mal_builtin_set_execution_end(vm, &execution);
        return ret;
    }
}

static MalValue mal_builtin_set_prototype_symmetric_difference(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalSetObject *set = mal_builtin_set_this(vm, this_value, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalSetRecord record;
    if (!mal_builtin_set_get_set_record(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    if (record.native_set == set) {
        return mal_value_from_set_object(
            mal_builtin_set_new_result(vm, nullptr, 0));
    }

    if (record.native_set != nullptr) {
        if (mal_set_object_size(set) == 0) {
            return mal_value_from_set_object(mal_builtin_set_new_result(
                vm, record.native_set,
                mal_set_object_size(record.native_set)));
        }
        if (mal_set_object_size(record.native_set) == 0) {
            return mal_value_from_set_object(mal_builtin_set_new_result(
                vm, set, mal_set_object_size(set)));
        }
    }

    usize reserve_size = mal_set_object_size(set);
    if (record.native_set != nullptr &&
        SIZE_MAX - reserve_size >= mal_set_object_size(record.native_set)) {
        reserve_size += mal_set_object_size(record.native_set);
    }
    if (record.native_set != nullptr) {
        MalSetObject *result = mal_builtin_set_new_result(vm, set, reserve_size);
        MalSetIter iter;
        mal_set_iter_init(&iter, record.native_set->entries);
        MalValue key;
        while (mal_set_iter_next(&iter, &key)) {
            if (mal_set_object_has_canonical(set, key)) {
                mal_set_object_delete_canonical(result, key);
            } else {
                mal_set_object_add_canonical(result, key);
            }
        }
        return mal_value_from_set_object(result);
    }

    MalSetExecution execution;
    mal_builtin_set_execution_begin(
        vm, &record, this_value, &execution, false);
    MalValue ret = mal_value_new_undefined();
    if (!mal_builtin_set_record_keys_iterator(vm, &record, &execution.iterator)) {
        goto done;
    }

    // As in union, capture the iterator's `next` before copying the receiver.
    set = mal_value_to_set_object(this_value);
    MalSetObject *result = mal_builtin_set_new_result(vm, set, reserve_size);
    execution.values[0] = mal_value_from_set_object(result);

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
        result = mal_value_to_set_object(execution.values[0]);
        if (mal_set_object_has(set, execution.values[1])) {
            mal_set_object_delete(result, execution.values[1]);
        } else {
            mal_set_object_add(result, execution.values[1]);
        }
    }

done:
    mal_builtin_set_execution_end(vm, &execution);
    return ret;
}

static MalValue mal_builtin_set_prototype_is_subset_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalSetObject *set = mal_builtin_set_this(vm, this_value, "Receiver is not a Set");
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

    if (mal_set_object_size(set) == 0) {
        return mal_value_new_boolean(true);
    }

    if ((f64) mal_set_object_size(set) > record.size) {
        return mal_value_new_boolean(false);
    }

    if (record.native_set != nullptr) {
        MalSetIter iter;
        mal_set_iter_init(&iter, set->entries);
        MalValue key;
        while (mal_set_iter_next(&iter, &key)) {
            if (!mal_set_object_has_canonical(record.native_set, key)) {
                return mal_value_new_boolean(false);
            }
        }
        return mal_value_new_boolean(true);
    }

    mal_set_storage_pin(set->entries);
    MalSetExecution execution;
    mal_builtin_set_execution_begin(
        vm, &record, mal_value_new_undefined(), &execution, true);
    MalValue ret = mal_value_new_undefined();
    MalSetIter iter;
    mal_set_iter_init(&iter, set->entries);
    MalValue key;
    while (mal_set_iter_next(&iter, &key)) {
        execution.values[1] = key;
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
    mal_set_storage_unpin(set->entries);
    mal_set_object_compact(set);
    return ret;
}

static MalValue mal_builtin_set_prototype_is_superset_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalSetObject *set = mal_builtin_set_this(vm, this_value, "Receiver is not a Set");
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

    if (record.native_set != nullptr &&
        mal_set_object_size(record.native_set) == 0) {
        return mal_value_new_boolean(true);
    }

    if ((f64) mal_set_object_size(set) < record.size) {
        return mal_value_new_boolean(false);
    }

    if (record.native_set != nullptr) {
        MalSetIter iter;
        mal_set_iter_init(&iter, record.native_set->entries);
        MalValue key;
        while (mal_set_iter_next(&iter, &key)) {
            if (!mal_set_object_has_canonical(set, key)) {
                return mal_value_new_boolean(false);
            }
        }
        return mal_value_new_boolean(true);
    }

    MalSetExecution execution;
    mal_builtin_set_execution_begin(
        vm, &record, mal_value_new_undefined(), &execution, false);
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
        if (!mal_set_object_has(set, execution.values[1])) {
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
    MalSetObject *set = mal_builtin_set_this(vm, this_value, "Receiver is not a Set");
    if (set == nullptr) {
        return mal_value_new_undefined();
    }

    MalSetRecord record;
    if (!mal_builtin_set_get_set_record(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &record)) {
        return mal_value_new_undefined();
    }

    if (record.native_set == set) {
        return mal_value_new_boolean(mal_set_object_size(set) == 0);
    }

    if (mal_set_object_size(set) == 0 ||
        (record.native_set != nullptr &&
         mal_set_object_size(record.native_set) == 0)) {
        return mal_value_new_boolean(true);
    }

    if ((f64) mal_set_object_size(set) <= record.size) {
        if (record.native_set != nullptr) {
            MalSetIter iter;
            mal_set_iter_init(&iter, set->entries);
            MalValue key;
            while (mal_set_iter_next(&iter, &key)) {
                if (mal_set_object_has_canonical(record.native_set, key)) {
                    return mal_value_new_boolean(false);
                }
            }
            return mal_value_new_boolean(true);
        }

        mal_set_storage_pin(set->entries);
        MalSetExecution execution;
        mal_builtin_set_execution_begin(
            vm, &record, mal_value_new_undefined(), &execution, true);
        MalValue ret = mal_value_new_undefined();
        MalSetIter iter;
        mal_set_iter_init(&iter, set->entries);
        MalValue key;
        while (mal_set_iter_next(&iter, &key)) {
            execution.values[1] = key;
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
        mal_set_storage_unpin(set->entries);
        mal_set_object_compact(set);
        return ret;
    } else {
        if (record.native_set != nullptr) {
            MalSetIter iter;
            mal_set_iter_init(&iter, record.native_set->entries);
            MalValue key;
            while (mal_set_iter_next(&iter, &key)) {
                if (mal_set_object_has_canonical(set, key)) {
                    return mal_value_new_boolean(false);
                }
            }
            return mal_value_new_boolean(true);
        }

        MalSetExecution execution;
        mal_builtin_set_execution_begin(
            vm, &record, mal_value_new_undefined(), &execution, false);
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
            if (mal_set_object_has(set, execution.values[1])) {
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

    vm->intrinsics[MAL_INTRINSIC_WEAK_SET_PROTOTYPE_ADD] =
        mal_intrinsic_define_method_n(vm, weak_prototype, "add", 1, mal_builtin_weak_set_prototype_add);
    vm->intrinsics[MAL_INTRINSIC_WEAK_SET_PROTOTYPE_HAS] =
        mal_intrinsic_define_method_n(vm, weak_prototype, "has", 1, mal_builtin_weak_set_prototype_has);
    vm->intrinsics[MAL_INTRINSIC_WEAK_SET_PROTOTYPE_DELETE] =
        mal_intrinsic_define_method_n(vm, weak_prototype, "delete", 1, mal_builtin_weak_set_prototype_delete);
}

#include "generated/known_native_builtin_set_c.inc"
