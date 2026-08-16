#include "builtin_map.h"

#include "builtin_iterator.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "map_object.h"
#include "perf_stats.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/**
 * Unwrap a Map-family receiver with the right weak brand, or throw.
 */
static MalMapObject *mal_builtin_map_this(MalVm *vm, MalValue this_value, bool weak, const byte *message) {
    if (!mal_value_is_map_object(this_value) || mal_value_to_map_object(this_value)->weak != weak) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
        return nullptr;
    }

    return mal_value_to_map_object(this_value);
}

/**
 * Spec CanBeHeldWeakly: objects and non-registered symbols qualify.
 */
static bool mal_builtin_map_can_be_held_weakly(MalValue value) {
    if (mal_value_is_object(value)) {
        return true;
    }

    return mal_value_is_symbol(value) && !mal_value_to_symbol(value)->registered;
}

/**
 * Shared Map/WeakMap constructor tail: populate the fresh map from an
 * optional iterable of [key, value] entries through this.set, closing the
 * iterator on abrupt completions.
 */
static MalValue mal_builtin_map_construct(
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

    MalMapObject *map = mal_map_object_new(&vm->heap, MAL_HEAP_MAP_OBJECT, prototype, weak);
    MalValue map_value = mal_value_from_map_object(map);

    if (arg_count < 1 || mal_value_is_nil(args[0])) {
        return map_value;
    }

    MalValue adder;
    if (!mal_vm_get_property(vm, map_value, mal_intrinsic_string_key(vm, "set"), &adder)) {
        return mal_value_new_undefined();
    }

    if (!mal_value_is_callable(adder)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Map adder is not callable");
        return mal_value_new_undefined();
    }

    MalIteratorRecord record;
    if (!mal_vm_get_iterator(vm, args[0], &record)) {
        return mal_value_new_undefined();
    }

    // Each step, the entry index Gets, and the adder all re-enter JS and can
    // collect; root the record, the map being built, the adder, and the current
    // entry across the loop, and lift GC suppression. (The extracted key/value are
    // the adder's args → rooted by the call seam during that call.)
    MalValue roots[3] = {map_value, adder, mal_value_new_undefined()};
    MalRootSpan rec_span, span;
    mal_gc_root(&rec_span, &record.iterator, 2);
    mal_gc_root(&span, roots, 3);
    mal_gc_native_rooted_begin(vm);
    MalValue ret = mal_value_new_undefined();

    while (true) {
        MalValue item;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &item, &done)) {
            goto done;
        }

        if (done) {
            ret = map_value;
            goto done;
        }
        roots[2] = item;

        if (!mal_value_is_object(item)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator entry is not an object");
            mal_vm_iterator_close(vm, &record);
            goto done;
        }

        MalValue entry_args[2];
        if (!mal_vm_get_property(vm, item, mal_key_index(0), &entry_args[0]) ||
            !mal_vm_get_property(vm, item, mal_key_index(1), &entry_args[1])) {
            mal_vm_iterator_close(vm, &record);
            goto done;
        }

        MalCompletion completion = mal_vm_call_value(vm, adder, map_value, entry_args, 2);
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

static MalValue mal_builtin_map_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_map_construct(vm, new_target, args, arg_count, MAL_INTRINSIC_MAP_PROTOTYPE, false, "Constructor Map requires 'new'");
}

static MalValue mal_builtin_map_group_by(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;

    if (arg_count < 2 || !mal_value_is_callable(args[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Callback is not a function");
        return mal_value_new_undefined();
    }

    MalIteratorRecord record;
    if (arg_count < 1 || !mal_vm_get_iterator(vm, args[0], &record)) {
        return mal_value_new_undefined();
    }

    MalMapObject *result = mal_map_object_new(
        &vm->heap,
        MAL_HEAP_MAP_OBJECT,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_MAP_PROTOTYPE]),
        false
    );
    i32 index = 0;
    while (true) {
        MalValue element;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &element, &done)) {
            return mal_value_new_undefined();
        }

        if (done) {
            return mal_value_from_map_object(result);
        }

        MalValue callback_args[] = {element, mal_value_from_i32(index)};
        index++;
        MalCompletion completion = mal_vm_call_value(vm, args[1], mal_value_new_undefined(), callback_args, 2);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            vm->completion = completion;
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }

        MalValue group = mal_map_object_get(result, completion.value);
        if (!mal_map_object_has(result, completion.value)) {
            group = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
            mal_map_object_set(result, completion.value, group);
        }

        MalArrayObject *group_array = mal_value_to_array_object(group);
        mal_array_object_store(
            group_array,
            mal_key_index(mal_array_object_length(group_array)),
            element
        );
    }
}

static MalValue mal_builtin_weak_map_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_map_construct(vm, new_target, args, arg_count, MAL_INTRINSIC_WEAK_MAP_PROTOTYPE, true, "Constructor WeakMap requires 'new'");
}

static MalValue mal_builtin_map_get_value(
    MalVm *vm, MalValue this_value, MalMapObject *map, MalValue key_value
) {
    MalKey key = mal_map_key_from_value(key_value);
    MalTableLookup lookup = mal_table_lookup(map->entries, key);
    if (!lookup.present) {
        return mal_value_new_undefined();
    }

    vm->map_get_set_cache = (MalMapGetSetCacheEntry) {
        .collection = this_value,
        .canonical_key = key.value,
        .table = map->entries,
        .entry = lookup.entry,
        .table_handle_epoch = mal_table_handle_epoch(map->entries),
    };
    return mal_table_entry_value(map->entries, lookup.entry);
}

static MalValue mal_builtin_map_set_value(
    MalVm *vm, MalValue this_value, MalMapObject *map, MalValue key, MalValue value
) {
    MalKey canonical_key = mal_map_key_from_value(key);
    MalMapGetSetCacheEntry *cache = &vm->map_get_set_cache;
    void *entry = nullptr;

    if (cache->entry != nullptr && cache->collection == this_value) {
        MAL_PERF_COUNT(map_get_set_cache_checks);
        if (cache->table == map->entries &&
            cache->table_handle_epoch == mal_table_handle_epoch(map->entries) &&
            mal_key_value_equals(cache->canonical_key, canonical_key.value) &&
            mal_table_entry_matches(
                map->entries, cache->entry, cache->table_handle_epoch, canonical_key)) {
            MAL_PERF_COUNT(map_get_set_cache_hits);
            entry = cache->entry;
        } else {
            MAL_PERF_COUNT(map_get_set_cache_misses);
        }
    }

    if (entry == nullptr) {
        entry = mal_table_upsert_entry(map->entries, canonical_key, nullptr);
    }
    mal_table_entry_set_value(map->entries, entry, value);
    mal_gc_card(&map->object.header, key);
    mal_gc_card(&map->object.header, value);

    return this_value;
}

static MalValue mal_builtin_map_prototype_get(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, false, "Receiver is not a Map");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_builtin_map_get_value(
        vm, this_value, map,
        arg_count >= 1 ? args[0] : mal_value_new_undefined());
}

MalValue mal_builtin_map_get_known(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    return mal_builtin_map_prototype_get(
        vm,
        this_value,
        args,
        arg_count,
        mal_value_new_undefined(),
        mal_value_new_undefined());
}

static MalValue mal_builtin_map_prototype_set(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, false, "Receiver is not a Map");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_builtin_map_set_value(
        vm, this_value, map,
        arg_count >= 1 ? args[0] : mal_value_new_undefined(),
        arg_count >= 2 ? args[1] : mal_value_new_undefined());
}

MalCompletion mal_builtin_collection_direct(
    MalVm *vm,
    MalCallCache *fallback_cache,
    MalBuiltinCollectionDirectOp operation,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    MalIntrinsic expected;
    switch (operation) {
        case MAL_BUILTIN_COLLECTION_MAP_GET:
            expected = MAL_INTRINSIC_MAP_PROTOTYPE_GET;
            break;
        case MAL_BUILTIN_COLLECTION_MAP_SET:
            expected = MAL_INTRINSIC_MAP_PROTOTYPE_SET;
            break;
        case MAL_BUILTIN_COLLECTION_SET_ADD:
            expected = MAL_INTRINSIC_SET_PROTOTYPE_ADD;
            break;
        default:
            abort();
    }

    if (arg_count >= 0 && callee == vm->intrinsics[expected] &&
        mal_value_is_native_function_object(callee)) {
        if (operation == MAL_BUILTIN_COLLECTION_MAP_GET &&
            mal_value_is_map_object(this_value)) {
            MalMapObject *map = mal_value_to_map_object(this_value);
            if (!map->weak) {
                MAL_PERF_COUNT(collection_direct_map_get_hits);
                return (MalCompletion) {
                    .kind = MAL_COMPLETION_NORMAL,
                    .value = mal_builtin_map_get_value(
                        vm, this_value, map,
                        arg_count >= 1 ? args[0] : mal_value_new_undefined()),
                };
            }
        } else if (operation == MAL_BUILTIN_COLLECTION_MAP_SET &&
                   mal_value_is_map_object(this_value)) {
            MalMapObject *map = mal_value_to_map_object(this_value);
            if (!map->weak) {
                MAL_PERF_COUNT(collection_direct_map_set_hits);
                return (MalCompletion) {
                    .kind = MAL_COMPLETION_NORMAL,
                    .value = mal_builtin_map_set_value(
                        vm, this_value, map,
                        arg_count >= 1 ? args[0] : mal_value_new_undefined(),
                        arg_count >= 2 ? args[1] : mal_value_new_undefined()),
                };
            }
        } else if (operation == MAL_BUILTIN_COLLECTION_SET_ADD &&
                   mal_value_is_set_object(this_value)) {
            MalMapObject *set = mal_value_to_map_object(this_value);
            if (!set->weak) {
                MalValue value =
                    arg_count >= 1 ? args[0] : mal_value_new_undefined();
                mal_map_object_set(set, value, value);
                MAL_PERF_COUNT(collection_direct_set_add_hits);
                return (MalCompletion) {
                    .kind = MAL_COMPLETION_NORMAL,
                    .value = this_value,
                };
            }
        }
    }

    MAL_PERF_COUNT(collection_direct_fallbacks);
    return mal_vm_call_cached(
        vm, fallback_cache, callee, this_value, args, arg_count);
}

static MalValue mal_builtin_map_prototype_has(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, false, "Receiver is not a Map");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_map_object_has(map, arg_count >= 1 ? args[0] : mal_value_new_undefined()));
}

static MalValue mal_builtin_map_prototype_delete(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, false, "Receiver is not a Map");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    if (vm->map_get_set_cache.collection == this_value) {
        mal_vm_invalidate_map_get_set_cache(vm);
    }
    return mal_value_new_boolean(mal_map_object_delete(map, arg_count >= 1 ? args[0] : mal_value_new_undefined()));
}

static MalValue mal_builtin_map_prototype_clear(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;

    MalMapObject *map = mal_builtin_map_this(vm, this_value, false, "Receiver is not a Map");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    if (vm->map_get_set_cache.collection == this_value) {
        mal_vm_invalidate_map_get_set_cache(vm);
    }
    mal_map_object_clear(map);

    return mal_value_new_undefined();
}

static MalValue mal_builtin_map_prototype_size_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;

    MalMapObject *map = mal_builtin_map_this(vm, this_value, false, "Receiver is not a Map");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_from_i32((i32) mal_map_object_size(map));
}

/**
 * Shared body for Map.prototype.getOrInsert / WeakMap.prototype.getOrInsert.
 * Returns the existing value for key, or stores and returns `value`.
 */
static MalValue mal_builtin_map_get_or_insert(MalVm *vm, MalMapObject *map, MalValue key, MalValue value) {
    if (mal_map_object_has(map, key)) {
        return mal_map_object_get(map, key);
    }

    mal_map_object_set(map, key, value);
    return value;
}

/**
 * Shared body for getOrInsertComputed: when key is absent, call callbackfn
 * with the canonicalized key, then upsert the computed value (overwriting any
 * entry the callback itself inserted) and return it.
 */
static MalValue mal_builtin_map_get_or_insert_computed(MalVm *vm, MalMapObject *map, MalValue key, MalValue callback) {
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Callback is not a function");
        return mal_value_new_undefined();
    }

    if (mal_map_object_has(map, key)) {
        return mal_map_object_get(map, key);
    }

    MalValue canonical_key = mal_map_key_from_value(key).value;
    MalCompletion completion = mal_vm_call_value(vm, callback, mal_value_new_undefined(), &canonical_key, 1);
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        return mal_value_new_undefined();
    }

    // Overwrite any entry the callback inserted for this key, then append.
    mal_map_object_set(map, key, completion.value);
    return completion.value;
}

static MalValue mal_builtin_map_prototype_get_or_insert(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, false, "Receiver is not a Map");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_builtin_map_get_or_insert(
        vm,
        map,
        arg_count >= 1 ? args[0] : mal_value_new_undefined(),
        arg_count >= 2 ? args[1] : mal_value_new_undefined()
    );
}

static MalValue mal_builtin_map_prototype_get_or_insert_computed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, false, "Receiver is not a Map");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_builtin_map_get_or_insert_computed(
        vm,
        map,
        arg_count >= 1 ? args[0] : mal_value_new_undefined(),
        arg_count >= 2 ? args[1] : mal_value_new_undefined()
    );
}

static MalValue mal_builtin_map_prototype_for_each(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, false, "Receiver is not a Map");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    if (arg_count < 1 || !mal_value_is_callable(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Map.prototype.forEach callback is not a function");
        return mal_value_new_undefined();
    }

    MalValue this_arg = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    // Storage-order walk: entries added during the callback are visited,
    // deleted entries are skipped.
    mal_table_pin(map->entries);
    MalTableIter iter;
    mal_table_iter_init(&iter, map->entries, MAL_TABLE_ITER_STORAGE);

    // The callback can collect; lift this builtin's GC suppression for the loop.
    // No explicit roots are needed: the receiver Map is rooted by the call seam,
    // its entries table is traced through it, and every callback argument
    // (entry value, key, this) is therefore reachable from a root.
    mal_gc_native_rooted_begin(vm);
    MalKey key;
    void *entry;
    while (mal_table_iter_next(&iter, &key, &entry)) {
        MalValue callback_args[3] = {
            mal_table_entry_value(map->entries, entry),
            key.value,
            this_value,
        };
        MalCompletion completion = mal_vm_call_value(vm, args[0], this_arg, callback_args, 3);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            break;
        }
    }
    mal_gc_native_rooted_end(vm);
    mal_table_unpin(map->entries);

    return mal_value_new_undefined();
}

static MalValue mal_builtin_map_prototype_iterator(MalVm *vm, MalValue this_value, MalIteratorKind kind) {
    if (mal_builtin_map_this(vm, this_value, false, "Receiver is not a Map") == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_vm_new_builtin_iterator(vm, kind, this_value);
}

static MalValue mal_builtin_map_prototype_entries(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_map_prototype_iterator(vm, this_value, MAL_ITERATOR_MAP_ENTRIES);
}

static MalValue mal_builtin_map_prototype_keys(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_map_prototype_iterator(vm, this_value, MAL_ITERATOR_MAP_KEYS);
}

static MalValue mal_builtin_map_prototype_values(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_map_prototype_iterator(vm, this_value, MAL_ITERATOR_MAP_VALUES);
}

static MalValue mal_builtin_weak_map_prototype_get(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, true, "Receiver is not a WeakMap");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_map_object_get(map, arg_count >= 1 ? args[0] : mal_value_new_undefined());
}

static MalValue mal_builtin_weak_map_prototype_set(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, true, "Receiver is not a WeakMap");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    MalValue key = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_builtin_map_can_be_held_weakly(key)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid value used as weak map key");
        return mal_value_new_undefined();
    }

    mal_map_object_set(map, key, arg_count >= 2 ? args[1] : mal_value_new_undefined());

    return this_value;
}

static MalValue mal_builtin_weak_map_prototype_has(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, true, "Receiver is not a WeakMap");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_map_object_has(map, arg_count >= 1 ? args[0] : mal_value_new_undefined()));
}

static MalValue mal_builtin_weak_map_prototype_delete(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, true, "Receiver is not a WeakMap");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_map_object_delete(map, arg_count >= 1 ? args[0] : mal_value_new_undefined()));
}

static MalValue mal_builtin_weak_map_prototype_get_or_insert(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, true, "Receiver is not a WeakMap");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    MalValue key = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_builtin_map_can_be_held_weakly(key)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid value used as weak map key");
        return mal_value_new_undefined();
    }

    return mal_builtin_map_get_or_insert(vm, map, key, arg_count >= 2 ? args[1] : mal_value_new_undefined());
}

static MalValue mal_builtin_weak_map_prototype_get_or_insert_computed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, true, "Receiver is not a WeakMap");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    MalValue callback = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Callback is not a function");
        return mal_value_new_undefined();
    }

    MalValue key = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_builtin_map_can_be_held_weakly(key)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid value used as weak map key");
        return mal_value_new_undefined();
    }

    return mal_builtin_map_get_or_insert_computed(vm, map, key, callback);
}

/**
 * Define the shared constructor/prototype scaffolding for one collection.
 */
static MalObject *mal_builtin_map_scaffold(
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

static void mal_builtin_map_define_size(MalVm *vm, MalObject *prototype, MalNativeFunctionCallback getter) {
    mal_intrinsic_define_getter(
        vm, prototype, "size", "get size", getter, MAL_PROPERTY_CONFIGURABLE);
}

void mal_builtin_map_install(MalVm *vm) {
    MalObject *prototype = mal_builtin_map_scaffold(
        vm,
        "Map",
        mal_builtin_map_constructor,
        MAL_INTRINSIC_MAP_CONSTRUCTOR,
        MAL_INTRINSIC_MAP_PROTOTYPE,
        "Map"
    );

    mal_intrinsic_define_method_n(vm, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_MAP_CONSTRUCTOR]), "groupBy", 2, mal_builtin_map_group_by);

    vm->intrinsics[MAL_INTRINSIC_MAP_PROTOTYPE_GET] =
        mal_intrinsic_define_method_n(vm, prototype, "get", 1, mal_builtin_map_prototype_get);
    mal_intrinsic_define_method_n(vm, prototype, "getOrInsert", 2, mal_builtin_map_prototype_get_or_insert);
    mal_intrinsic_define_method_n(vm, prototype, "getOrInsertComputed", 2, mal_builtin_map_prototype_get_or_insert_computed);
    vm->intrinsics[MAL_INTRINSIC_MAP_PROTOTYPE_SET] =
        mal_intrinsic_define_method_n(vm, prototype, "set", 2, mal_builtin_map_prototype_set);
    mal_intrinsic_define_method_n(vm, prototype, "has", 1, mal_builtin_map_prototype_has);
    mal_intrinsic_define_method_n(vm, prototype, "delete", 1, mal_builtin_map_prototype_delete);
    mal_intrinsic_define_method_n(vm, prototype, "clear", 0, mal_builtin_map_prototype_clear);
    mal_intrinsic_define_method_n(vm, prototype, "forEach", 1, mal_builtin_map_prototype_for_each);
    mal_intrinsic_define_method_n(vm, prototype, "keys", 0, mal_builtin_map_prototype_keys);
    mal_intrinsic_define_method_n(vm, prototype, "values", 0, mal_builtin_map_prototype_values);
    MalValue entries = mal_intrinsic_define_method_n(vm, prototype, "entries", 0, mal_builtin_map_prototype_entries);

    // Map.prototype[Symbol.iterator] === Map.prototype.entries
    MalPropertyDesc iterator_desc = mal_intrinsic_data_desc(entries, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &iterator_desc);

    mal_builtin_map_define_size(vm, prototype, mal_builtin_map_prototype_size_getter);
    mal_intrinsic_define_species(vm, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_MAP_CONSTRUCTOR]));

    MalObject *weak_prototype = mal_builtin_map_scaffold(
        vm,
        "WeakMap",
        mal_builtin_weak_map_constructor,
        MAL_INTRINSIC_WEAK_MAP_CONSTRUCTOR,
        MAL_INTRINSIC_WEAK_MAP_PROTOTYPE,
        "WeakMap"
    );

    mal_intrinsic_define_method_n(vm, weak_prototype, "get", 1, mal_builtin_weak_map_prototype_get);
    mal_intrinsic_define_method_n(vm, weak_prototype, "getOrInsert", 2, mal_builtin_weak_map_prototype_get_or_insert);
    mal_intrinsic_define_method_n(vm, weak_prototype, "getOrInsertComputed", 2, mal_builtin_weak_map_prototype_get_or_insert_computed);
    mal_intrinsic_define_method_n(vm, weak_prototype, "set", 2, mal_builtin_weak_map_prototype_set);
    mal_intrinsic_define_method_n(vm, weak_prototype, "has", 1, mal_builtin_weak_map_prototype_has);
    mal_intrinsic_define_method_n(vm, weak_prototype, "delete", 1, mal_builtin_weak_map_prototype_delete);
}
