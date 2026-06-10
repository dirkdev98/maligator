#include "builtin_map.h"

#include "builtin_iterator.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "map_object.h"
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
 * Resolve the prototype for a construct call: new_target's prototype
 * property when it is an object, the given intrinsic slot otherwise
 * (OrdinaryCreateFromConstructor flavored).
 */
static MalObject *mal_builtin_map_resolve_prototype(MalVm *vm, MalValue new_target, MalIntrinsic fallback_slot) {
    MalValue prototype;
    if (!mal_vm_get_property(vm, new_target, mal_intrinsic_string_key(vm, "prototype"), &prototype)) {
        return nullptr;
    }

    if (mal_value_is_object(prototype)) {
        return mal_value_to_object(prototype);
    }

    return mal_value_to_object(vm->intrinsics[fallback_slot]);
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

    MalObject *prototype = mal_builtin_map_resolve_prototype(vm, new_target, prototype_slot);
    if (prototype == nullptr) {
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

    while (true) {
        MalValue item;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &item, &done)) {
            return mal_value_new_undefined();
        }

        if (done) {
            return map_value;
        }

        if (!mal_value_is_object(item)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Iterator entry is not an object");
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }

        MalValue entry_args[2];
        if (!mal_vm_get_property(vm, item, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, &entry_args[0]) ||
            !mal_vm_get_property(vm, item, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, &entry_args[1])) {
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }

        MalCompletion completion = mal_vm_call_value(vm, adder, map_value, entry_args, 2);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }
    }
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
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) mal_array_object_length(group_array))},
            element
        );
    }
}

static MalValue mal_builtin_weak_map_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    return mal_builtin_map_construct(vm, new_target, args, arg_count, MAL_INTRINSIC_WEAK_MAP_PROTOTYPE, true, "Constructor WeakMap requires 'new'");
}

static MalValue mal_builtin_map_prototype_get(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, false, "Receiver is not a Map");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_map_object_get(map, arg_count >= 1 ? args[0] : mal_value_new_undefined());
}

static MalValue mal_builtin_map_prototype_set(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalMapObject *map = mal_builtin_map_this(vm, this_value, false, "Receiver is not a Map");
    if (map == nullptr) {
        return mal_value_new_undefined();
    }

    MalValue key = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue value = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    mal_map_object_set(map, key, value);

    return this_value;
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

    return mal_value_new_boolean(mal_map_object_delete(map, arg_count >= 1 ? args[0] : mal_value_new_undefined()));
}

static MalValue mal_builtin_map_prototype_clear(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;

    MalMapObject *map = mal_builtin_map_this(vm, this_value, false, "Receiver is not a Map");
    if (map == nullptr) {
        return mal_value_new_undefined();
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
    MalTableIter iter;
    mal_table_iter_init(&iter, map->entries, MAL_TABLE_ITER_STORAGE);

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
            return mal_value_new_undefined();
        }
    }

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
    MalNativeFunctionObject *constructor = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name),
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

/**
 * Define a `size` accessor over the given getter callback.
 */
static void mal_builtin_map_define_size(MalVm *vm, MalObject *prototype, MalNativeFunctionCallback getter) {
    MalPropertyDesc size_desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, "get size"),
            getter
        )),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(prototype, mal_intrinsic_string_key(vm, "size"), &size_desc);
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

    mal_intrinsic_define_method(vm, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_MAP_CONSTRUCTOR]), "groupBy", mal_builtin_map_group_by);

    mal_intrinsic_define_method(vm, prototype, "get", mal_builtin_map_prototype_get);
    mal_intrinsic_define_method(vm, prototype, "set", mal_builtin_map_prototype_set);
    mal_intrinsic_define_method(vm, prototype, "has", mal_builtin_map_prototype_has);
    mal_intrinsic_define_method(vm, prototype, "delete", mal_builtin_map_prototype_delete);
    mal_intrinsic_define_method(vm, prototype, "clear", mal_builtin_map_prototype_clear);
    mal_intrinsic_define_method(vm, prototype, "forEach", mal_builtin_map_prototype_for_each);
    mal_intrinsic_define_method(vm, prototype, "keys", mal_builtin_map_prototype_keys);
    mal_intrinsic_define_method(vm, prototype, "values", mal_builtin_map_prototype_values);
    MalValue entries = mal_intrinsic_define_method(vm, prototype, "entries", mal_builtin_map_prototype_entries);

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

    mal_intrinsic_define_method(vm, weak_prototype, "get", mal_builtin_weak_map_prototype_get);
    mal_intrinsic_define_method(vm, weak_prototype, "set", mal_builtin_weak_map_prototype_set);
    mal_intrinsic_define_method(vm, weak_prototype, "has", mal_builtin_weak_map_prototype_has);
    mal_intrinsic_define_method(vm, weak_prototype, "delete", mal_builtin_weak_map_prototype_delete);
}
