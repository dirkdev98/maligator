#include "builtin_set.h"

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

static MalObject *mal_builtin_set_resolve_prototype(MalVm *vm, MalValue new_target, MalIntrinsic fallback_slot) {
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

    MalObject *prototype = mal_builtin_set_resolve_prototype(vm, new_target, prototype_slot);
    if (prototype == nullptr) {
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

    while (true) {
        MalValue item;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &item, &done)) {
            return mal_value_new_undefined();
        }

        if (done) {
            return set_value;
        }

        MalCompletion completion = mal_vm_call_value(vm, adder, set_value, &item, 1);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            mal_vm_iterator_close(vm, &record);
            return mal_value_new_undefined();
        }
    }
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

    MalKey key;
    void *entry;
    while (mal_table_iter_next(&iter, &key, &entry)) {
        // The callback receives (value, value, set): sets have no distinct keys.
        MalValue callback_args[3] = {key.value, key.value, this_value};
        MalCompletion completion = mal_vm_call_value(vm, args[0], this_arg, callback_args, 3);
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            return mal_value_new_undefined();
        }
    }

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

static MalObject *mal_builtin_set_scaffold(
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

static void mal_builtin_set_define_size(MalVm *vm, MalObject *prototype, MalNativeFunctionCallback getter) {
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

void mal_builtin_set_install(MalVm *vm) {
    MalObject *prototype = mal_builtin_set_scaffold(
        vm,
        "Set",
        mal_builtin_set_constructor,
        MAL_INTRINSIC_SET_CONSTRUCTOR,
        MAL_INTRINSIC_SET_PROTOTYPE,
        "Set"
    );

    mal_intrinsic_define_method(vm, prototype, "add", mal_builtin_set_prototype_add);
    mal_intrinsic_define_method(vm, prototype, "has", mal_builtin_set_prototype_has);
    mal_intrinsic_define_method(vm, prototype, "delete", mal_builtin_set_prototype_delete);
    mal_intrinsic_define_method(vm, prototype, "clear", mal_builtin_set_prototype_clear);
    mal_intrinsic_define_method(vm, prototype, "forEach", mal_builtin_set_prototype_for_each);
    mal_intrinsic_define_method(vm, prototype, "entries", mal_builtin_set_prototype_entries);
    MalValue values = mal_intrinsic_define_method(vm, prototype, "values", mal_builtin_set_prototype_values);

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

    mal_intrinsic_define_method(vm, weak_prototype, "add", mal_builtin_weak_set_prototype_add);
    mal_intrinsic_define_method(vm, weak_prototype, "has", mal_builtin_weak_set_prototype_has);
    mal_intrinsic_define_method(vm, weak_prototype, "delete", mal_builtin_weak_set_prototype_delete);
}
