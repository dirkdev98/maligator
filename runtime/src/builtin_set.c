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

    MalIteratorRecord record;
    if (!mal_vm_get_iterator(vm, args[0], &record)) {
        return mal_value_new_undefined();
    }

    // Each step and the adder re-enter JS and can collect; root the record, the
    // set being built, and the adder across the loop, and lift GC suppression.
    // (The item is the adder's argument → rooted by the call seam during the call.)
    MalValue roots[2] = {set_value, adder};
    MalRootSpan rec_span, span;
    mal_gc_root(&rec_span, &record.iterator, 2);
    mal_gc_root(&span, roots, 2);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();

    while (true) {
        MalValue item;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &item, &done)) {
            goto done;
        }

        if (done) {
            ret = set_value;
            goto done;
        }

        MalCompletion completion = mal_vm_call_value(vm, adder, set_value, &item, 1);
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
    f64 size;
    MalValue has;
    MalValue keys;
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

    *record_out = (MalSetRecord) {.set_object = obj, .size = int_size, .has = has, .keys = keys};
    return true;
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

    MalValue next_method;
    if (!mal_vm_get_property(vm, completion.value, mal_intrinsic_string_key(vm, "next"), &next_method)) {
        return false;
    }

    iter_out->iterator = completion.value;
    iter_out->next_method = next_method;
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
static MalMapObject *mal_builtin_set_new_result(MalVm *vm, const MalMapObject *seed) {
    MalMapObject *result = mal_map_object_new(
        &vm->heap,
        MAL_HEAP_SET_OBJECT,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_SET_PROTOTYPE]),
        false
    );

    if (seed != nullptr) {
        MalTableIter iter;
        mal_table_iter_init(&iter, ((MalMapObject *) seed)->entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            mal_map_object_set(result, key.value, key.value);
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

    MalIteratorRecord iter;
    if (!mal_builtin_set_record_keys_iterator(vm, &record, &iter)) {
        return mal_value_new_undefined();
    }

    MalMapObject *result = mal_builtin_set_new_result(vm, set);

    while (true) {
        MalValue next_value;
        bool done;
        if (!mal_vm_iterator_step(vm, &iter, &next_value, &done)) {
            return mal_value_new_undefined();
        }
        if (done) {
            return mal_value_from_map_object(result);
        }

        // mal_map_object_set canonicalizes (-0 -> +0) and dedups on insert.
        mal_map_object_set(result, next_value, next_value);
    }
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

    MalMapObject *result = mal_builtin_set_new_result(vm, nullptr);

    if ((f64) mal_map_object_size(set) <= record.size) {
        // Walk the receiver's live entries; keep those other.has() accepts.
        MalTableIter iter;
        mal_table_iter_init(&iter, set->entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            bool in_other;
            if (!mal_builtin_set_record_has(vm, &record, key.value, &in_other)) {
                return mal_value_new_undefined();
            }
            // has() may have mutated the receiver; only keep still-live keys.
            if (in_other && mal_map_object_has(set, key.value)) {
                mal_map_object_set(result, key.value, key.value);
            }
        }
    } else {
        // Walk other's keys; keep those the receiver still contains, deduped.
        MalIteratorRecord iter;
        if (!mal_builtin_set_record_keys_iterator(vm, &record, &iter)) {
            return mal_value_new_undefined();
        }
        while (true) {
            MalValue next_value;
            bool done;
            if (!mal_vm_iterator_step(vm, &iter, &next_value, &done)) {
                return mal_value_new_undefined();
            }
            if (done) {
                break;
            }
            if (mal_map_object_has(set, next_value)) {
                mal_map_object_set(result, next_value, next_value);
            }
        }
    }

    return mal_value_from_map_object(result);
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

    MalMapObject *result = mal_builtin_set_new_result(vm, set);

    if ((f64) mal_map_object_size(set) <= record.size) {
        // Remove receiver elements that other.has() accepts.
        MalTableIter iter;
        mal_table_iter_init(&iter, set->entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            bool in_other;
            if (!mal_builtin_set_record_has(vm, &record, key.value, &in_other)) {
                return mal_value_new_undefined();
            }
            if (in_other) {
                mal_map_object_delete(result, key.value);
            }
        }
    } else {
        // Remove every key other yields from the receiver's copy.
        MalIteratorRecord iter;
        if (!mal_builtin_set_record_keys_iterator(vm, &record, &iter)) {
            return mal_value_new_undefined();
        }
        while (true) {
            MalValue next_value;
            bool done;
            if (!mal_vm_iterator_step(vm, &iter, &next_value, &done)) {
                return mal_value_new_undefined();
            }
            if (done) {
                break;
            }
            mal_map_object_delete(result, next_value);
        }
    }

    return mal_value_from_map_object(result);
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

    MalIteratorRecord iter;
    if (!mal_builtin_set_record_keys_iterator(vm, &record, &iter)) {
        return mal_value_new_undefined();
    }

    MalMapObject *result = mal_builtin_set_new_result(vm, set);

    while (true) {
        MalValue next_value;
        bool done;
        if (!mal_vm_iterator_step(vm, &iter, &next_value, &done)) {
            return mal_value_new_undefined();
        }
        if (done) {
            return mal_value_from_map_object(result);
        }

        // Membership is checked against the original receiver, not the result,
        // so duplicates other yields cannot resurrect a removed element.
        if (mal_map_object_has(set, next_value)) {
            mal_map_object_delete(result, next_value);
        } else {
            mal_map_object_set(result, next_value, next_value);
        }
    }
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

    if ((f64) mal_map_object_size(set) > record.size) {
        return mal_value_new_boolean(false);
    }

    MalTableIter iter;
    mal_table_iter_init(&iter, set->entries, MAL_TABLE_ITER_STORAGE);
    MalKey key;
    void *entry;
    while (mal_table_iter_next(&iter, &key, &entry)) {
        bool in_other;
        if (!mal_builtin_set_record_has(vm, &record, key.value, &in_other)) {
            return mal_value_new_undefined();
        }
        if (!in_other) {
            return mal_value_new_boolean(false);
        }
    }

    return mal_value_new_boolean(true);
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

    if ((f64) mal_map_object_size(set) < record.size) {
        return mal_value_new_boolean(false);
    }

    MalIteratorRecord iter;
    if (!mal_builtin_set_record_keys_iterator(vm, &record, &iter)) {
        return mal_value_new_undefined();
    }

    while (true) {
        MalValue next_value;
        bool done;
        if (!mal_vm_iterator_step(vm, &iter, &next_value, &done)) {
            return mal_value_new_undefined();
        }
        if (done) {
            return mal_value_new_boolean(true);
        }
        if (!mal_map_object_has(set, next_value)) {
            mal_vm_iterator_close(vm, &iter);
            return mal_value_new_boolean(false);
        }
    }
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

    if ((f64) mal_map_object_size(set) <= record.size) {
        MalTableIter iter;
        mal_table_iter_init(&iter, set->entries, MAL_TABLE_ITER_STORAGE);
        MalKey key;
        void *entry;
        while (mal_table_iter_next(&iter, &key, &entry)) {
            bool in_other;
            if (!mal_builtin_set_record_has(vm, &record, key.value, &in_other)) {
                return mal_value_new_undefined();
            }
            if (in_other) {
                return mal_value_new_boolean(false);
            }
        }
    } else {
        MalIteratorRecord iter;
        if (!mal_builtin_set_record_keys_iterator(vm, &record, &iter)) {
            return mal_value_new_undefined();
        }
        while (true) {
            MalValue next_value;
            bool done;
            if (!mal_vm_iterator_step(vm, &iter, &next_value, &done)) {
                return mal_value_new_undefined();
            }
            if (done) {
                break;
            }
            if (mal_map_object_has(set, next_value)) {
                mal_vm_iterator_close(vm, &iter);
                return mal_value_new_boolean(false);
            }
        }
    }

    return mal_value_new_boolean(true);
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

    mal_intrinsic_define_method_n(vm, prototype, "add", 1, mal_builtin_set_prototype_add);
    mal_intrinsic_define_method_n(vm, prototype, "has", 1, mal_builtin_set_prototype_has);
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
    MalValue values = mal_intrinsic_define_method_n(vm, prototype, "values", 0, mal_builtin_set_prototype_values);

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
