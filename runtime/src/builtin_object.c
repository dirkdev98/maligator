#include "builtin_object.h"

#include <math.h>
#include <stdlib.h>

#include "heap_string.h"
#include "property_iter.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static MalValue mal_builtin_object_arg(const MalValue *args, i32 arg_count, i32 index) {
    return index < arg_count ? args[index] : mal_value_new_undefined();
}

static bool mal_builtin_object_desc_get_bool(MalVm *vm, MalObject *object, const byte *name) {
    MalPropertyResolution resolution = mal_object_resolve_property(object, mal_intrinsic_string_key(vm, name));
    return resolution.found && mal_value_is_truthy(resolution.desc.value);
}

static bool mal_builtin_object_desc_get_value(MalVm *vm, MalObject *object, const byte *name, MalValue *out) {
    MalPropertyResolution resolution = mal_object_resolve_property(object, mal_intrinsic_string_key(vm, name));
    if (!resolution.found) {
        return false;
    }

    *out = resolution.desc.value;
    return true;
}

static MalPropertyDesc mal_builtin_object_parse_descriptor(MalVm *vm, MalObject *descriptor) {
    MalPropertyDesc desc = mal_intrinsic_data_desc(mal_value_new_undefined(), MAL_PROPERTY_NONE);
    MalValue field = mal_value_new_undefined();

    if (mal_builtin_object_desc_get_value(vm, descriptor, "value", &field)) {
        desc.value = field;
    }
    if (mal_builtin_object_desc_get_bool(vm, descriptor, "writable")) {
        desc.flags |= MAL_PROPERTY_WRITABLE;
    }
    if (mal_builtin_object_desc_get_bool(vm, descriptor, "enumerable")) {
        desc.flags |= MAL_PROPERTY_ENUMERABLE;
    }
    if (mal_builtin_object_desc_get_bool(vm, descriptor, "configurable")) {
        desc.flags |= MAL_PROPERTY_CONFIGURABLE;
    }
    if (mal_builtin_object_desc_get_value(vm, descriptor, "get", &field)) {
        desc.flags |= MAL_PROPERTY_ACCESSOR;
        desc.getter = field;
    }
    if (mal_builtin_object_desc_get_value(vm, descriptor, "set", &field)) {
        desc.flags |= MAL_PROPERTY_ACCESSOR;
        desc.setter = field;
    }

    return desc;
}

static void mal_builtin_object_define_from_value(MalVm *vm, MalObject *target, MalKey key, MalValue descriptor_value) {
    if (!mal_value_is_object(descriptor_value)) {
        return;
    }

    MalPropertyDesc desc = mal_builtin_object_parse_descriptor(vm, mal_value_to_object(descriptor_value));
    mal_object_define_own(target, key, &desc);
}

static MalValue mal_builtin_object_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    if (arg_count > 0 && mal_value_is_object(args[0])) {
        return args[0];
    }

    return mal_value_from_object(mal_intrinsic_new_object(vm));
}

static MalValue mal_builtin_object_define_property(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    if (arg_count < 3 || !mal_value_is_object(args[0]) || !mal_value_is_object(args[2])) {
        return arg_count > 0 ? args[0] : mal_value_new_undefined();
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(vm, args[1], &key)) {
        return args[0];
    }

    mal_builtin_object_define_from_value(vm, mal_value_to_object(args[0]), key, args[2]);
    return args[0];
}

static MalValue mal_builtin_object_define_properties(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    if (arg_count < 2 || !mal_value_is_object(args[0]) || !mal_value_is_object(args[1])) {
        return arg_count > 0 ? args[0] : mal_value_new_undefined();
    }

    MalPropertyIter iter;
    mal_property_iter_init(&iter, mal_value_to_object(args[1]), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        mal_builtin_object_define_from_value(vm, mal_value_to_object(args[0]), key, desc.value);
    }

    return args[0];
}

static MalValue mal_builtin_object_get_own_property_descriptor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return mal_value_new_undefined();
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(vm, mal_builtin_object_arg(args, arg_count, 1), &key)) {
        return mal_value_new_undefined();
    }

    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(args[0]), key);
    if (!lookup.present) {
        return mal_value_new_undefined();
    }

    MalObject *result = mal_intrinsic_new_object(vm);
    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;

    if (lookup.desc.flags & MAL_PROPERTY_ACCESSOR) {
        mal_intrinsic_define_data(vm, result, "get", lookup.desc.getter, flags);
        mal_intrinsic_define_data(vm, result, "set", lookup.desc.setter, flags);
    } else {
        mal_intrinsic_define_data(vm, result, "value", lookup.desc.value, flags);
        mal_intrinsic_define_data(vm, result, "writable", mal_value_new_boolean(lookup.desc.flags & MAL_PROPERTY_WRITABLE), flags);
    }

    mal_intrinsic_define_data(vm, result, "enumerable", mal_value_new_boolean(lookup.desc.flags & MAL_PROPERTY_ENUMERABLE), flags);
    mal_intrinsic_define_data(vm, result, "configurable", mal_value_new_boolean(lookup.desc.flags & MAL_PROPERTY_CONFIGURABLE), flags);

    return mal_value_from_object(result);
}

typedef enum MalBuiltinObjectCollect {
    MAL_BUILTIN_OBJECT_COLLECT_KEYS,
    MAL_BUILTIN_OBJECT_COLLECT_VALUES,
    MAL_BUILTIN_OBJECT_COLLECT_ENTRIES,
} MalBuiltinObjectCollect;

static MalValue mal_builtin_object_key_to_string(MalVm *vm, MalKey key) {
    if (key.kind == MAL_KEY_INDEX) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, key.value));
    }

    return key.value;
}

static MalValue mal_builtin_object_collect(MalVm *vm, MalValue target, MalPropertyIterKind iter_kind, MalBuiltinObjectCollect collect) {
    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    if (!mal_value_is_object(target)) {
        return mal_value_from_array_object(result);
    }

    MalPropertyIter iter;
    mal_property_iter_init(&iter, mal_value_to_object(target), iter_kind);

    u32 count = 0;
    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        // Symbol keys are excluded from string-keyed property collections.
        if (key.kind == MAL_KEY_SYMBOL) {
            continue;
        }

        MalValue element;
        switch (collect) {
            case MAL_BUILTIN_OBJECT_COLLECT_KEYS:
                element = mal_builtin_object_key_to_string(vm, key);
                break;
            case MAL_BUILTIN_OBJECT_COLLECT_VALUES:
                element = desc.value;
                break;
            case MAL_BUILTIN_OBJECT_COLLECT_ENTRIES: {
                MalArrayObject *entry = mal_intrinsic_new_array(vm, 2);
                mal_object_set((MalObject *) entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, mal_builtin_object_key_to_string(vm, key));
                mal_object_set((MalObject *) entry, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(1)}, desc.value);
                element = mal_value_from_array_object(entry);
                break;
            }
        }

        mal_array_object_store(result, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count)}, element);
        count++;
    }

    return mal_value_from_array_object(result);
}

static MalValue mal_builtin_object_keys(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    return mal_builtin_object_collect(
        vm,
        mal_builtin_object_arg(args, arg_count, 0),
        MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER,
        MAL_BUILTIN_OBJECT_COLLECT_KEYS
    );
}

static MalValue mal_builtin_object_values(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    return mal_builtin_object_collect(
        vm,
        mal_builtin_object_arg(args, arg_count, 0),
        MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER,
        MAL_BUILTIN_OBJECT_COLLECT_VALUES
    );
}

static MalValue mal_builtin_object_entries(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    return mal_builtin_object_collect(
        vm,
        mal_builtin_object_arg(args, arg_count, 0),
        MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER,
        MAL_BUILTIN_OBJECT_COLLECT_ENTRIES
    );
}

static MalValue mal_builtin_object_get_own_property_names(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    return mal_builtin_object_collect(
        vm,
        mal_builtin_object_arg(args, arg_count, 0),
        MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER,
        MAL_BUILTIN_OBJECT_COLLECT_KEYS
    );
}

static MalValue mal_builtin_object_assign(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return arg_count > 0 ? args[0] : mal_value_new_undefined();
    }

    MalObject *target = mal_value_to_object(args[0]);
    for (i32 i = 1; i < arg_count; i++) {
        if (!mal_value_is_object(args[i])) {
            continue;
        }

        MalPropertyIter iter;
        mal_property_iter_init(&iter, mal_value_to_object(args[i]), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            mal_object_set(target, key, desc.value);
        }
    }

    return args[0];
}

static MalValue mal_builtin_object_create(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    MalValue prototype_value = mal_builtin_object_arg(args, arg_count, 0);
    if (!mal_value_is_object(prototype_value) && !mal_value_is_null(prototype_value)) {
        // TODO(errors): should throw a TypeError once Error objects exist.
        return mal_value_new_undefined();
    }

    MalObject *prototype = mal_value_is_object(prototype_value) ? mal_value_to_object(prototype_value) : nullptr;
    MalObject *result = mal_object_new(&vm->heap, prototype);

    MalValue properties = mal_builtin_object_arg(args, arg_count, 1);
    if (mal_value_is_object(properties)) {
        MalPropertyIter iter;
        mal_property_iter_init(&iter, mal_value_to_object(properties), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);

        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            mal_builtin_object_define_from_value(vm, result, key, desc.value);
        }
    }

    return mal_value_from_object(result);
}

static MalValue mal_builtin_object_get_prototype_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return mal_value_new_undefined();
    }

    MalObject *prototype = mal_object_get_prototype(mal_value_to_object(args[0]));
    return prototype != nullptr ? mal_value_from_object(prototype) : mal_value_new_null();
}

static MalValue mal_builtin_object_set_prototype_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    if (arg_count < 2 || !mal_value_is_object(args[0])) {
        return arg_count > 0 ? args[0] : mal_value_new_undefined();
    }

    if (mal_value_is_object(args[1])) {
        mal_object_set_prototype(mal_value_to_object(args[0]), mal_value_to_object(args[1]));
    } else if (mal_value_is_null(args[1])) {
        mal_object_set_prototype(mal_value_to_object(args[0]), nullptr);
    }

    return args[0];
}

static MalValue mal_builtin_object_prevent_extensions(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return arg_count > 0 ? args[0] : mal_value_new_undefined();
    }

    mal_object_set_extensible(mal_value_to_object(args[0]), false);
    return args[0];
}

static MalValue mal_builtin_object_is_extensible(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return mal_value_new_boolean(false);
    }

    return mal_value_new_boolean(mal_object_is_extensible(mal_value_to_object(args[0])));
}

static MalValue mal_builtin_object_freeze(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return arg_count > 0 ? args[0] : mal_value_new_undefined();
    }

    MalObject *object = mal_value_to_object(args[0]);
    MalTable *table = mal_object_properties(object);
    usize count = mal_table_size(table);
    MalKey *keys = malloc(sizeof(MalKey) * count);
    usize key_count = 0;

    MalPropertyIter iter;
    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_STORAGE_ORDER);

    MalKey key;
    MalPropertyDesc desc;
    while (key_count < count && mal_property_iter_next(&iter, &key, &desc)) {
        keys[key_count++] = key;
    }

    for (usize i = 0; i < key_count; i++) {
        MalPropertyLookup lookup = mal_object_get_own(object, keys[i]);
        if (!lookup.present) {
            continue;
        }

        MalPropertyDesc frozen = lookup.desc;
        frozen.flags &= ~MAL_PROPERTY_CONFIGURABLE;
        if (!(frozen.flags & MAL_PROPERTY_ACCESSOR)) {
            frozen.flags &= ~MAL_PROPERTY_WRITABLE;
        }

        mal_property_write_entry(table, lookup.entry, &frozen);
    }

    free(keys);
    mal_object_set_extensible(object, false);
    return args[0];
}

static MalValue mal_builtin_object_is_frozen(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    if (arg_count < 1 || !mal_value_is_object(args[0])) {
        return mal_value_new_boolean(true);
    }

    MalObject *object = mal_value_to_object(args[0]);
    if (mal_object_is_extensible(object)) {
        return mal_value_new_boolean(false);
    }

    MalPropertyIter iter;
    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_STORAGE_ORDER);

    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (desc.flags & MAL_PROPERTY_CONFIGURABLE) {
            return mal_value_new_boolean(false);
        }
        if (!(desc.flags & MAL_PROPERTY_ACCESSOR) && (desc.flags & MAL_PROPERTY_WRITABLE)) {
            return mal_value_new_boolean(false);
        }
    }

    return mal_value_new_boolean(true);
}

static bool mal_builtin_object_is_negative_zero(MalValue value) {
    if (value == MAL_VALUE_NEGATIVE_ZERO) {
        return true;
    }

    return mal_value_is_f64(value) && mal_value_to_f64(value) == 0.0 && signbit(mal_value_to_f64(value));
}

static MalValue mal_builtin_object_is(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) this_value;
    MalValue left = mal_builtin_object_arg(args, arg_count, 0);
    MalValue right = mal_builtin_object_arg(args, arg_count, 1);

    if (mal_value_is_nan(left) && mal_value_is_nan(right)) {
        return mal_value_new_boolean(true);
    }

    if (mal_builtin_object_is_negative_zero(left) != mal_builtin_object_is_negative_zero(right)) {
        return mal_value_new_boolean(false);
    }

    return mal_ops_strict_equal(left, right);
}

static MalValue mal_builtin_object_has_own_with_target(MalVm *vm, MalValue target, MalValue key_value) {
    MalKey key;
    if (!mal_value_is_object(target) || !mal_vm_value_to_property_key(vm, key_value, &key)) {
        return mal_value_new_boolean(false);
    }

    return mal_value_new_boolean(mal_object_get_own(mal_value_to_object(target), key).present);
}

static MalValue mal_builtin_object_has_own(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) this_value;
    return mal_builtin_object_has_own_with_target(
        vm,
        mal_builtin_object_arg(args, arg_count, 0),
        mal_builtin_object_arg(args, arg_count, 1)
    );
}

static MalValue mal_builtin_object_prototype_has_own_property(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    return mal_builtin_object_has_own_with_target(vm, this_value, mal_builtin_object_arg(args, arg_count, 0));
}

static MalValue mal_builtin_object_prototype_is_prototype_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    if (!mal_value_is_object(this_value) || arg_count < 1 || !mal_value_is_object(args[0])) {
        return mal_value_new_boolean(false);
    }

    MalObject *target = mal_value_to_object(this_value);
    MalObject *prototype = mal_object_get_prototype(mal_value_to_object(args[0]));
    while (prototype != nullptr) {
        if (prototype == target) {
            return mal_value_new_boolean(true);
        }

        prototype = mal_object_get_prototype(prototype);
    }

    return mal_value_new_boolean(false);
}

static MalValue mal_builtin_object_prototype_property_is_enumerable(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    MalKey key;
    if (!mal_value_is_object(this_value) || !mal_vm_value_to_property_key(vm, mal_builtin_object_arg(args, arg_count, 0), &key)) {
        return mal_value_new_boolean(false);
    }

    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(this_value), key);
    return mal_value_new_boolean(lookup.present && (lookup.desc.flags & MAL_PROPERTY_ENUMERABLE));
}

static MalValue mal_builtin_object_prototype_value_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) vm;
    (void) args;
    (void) arg_count;
    return this_value;
}

static MalValue mal_builtin_object_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    (void) args;
    (void) arg_count;

    const byte *tag = "[object Object]";
    if (mal_value_is_undefined(this_value)) {
        tag = "[object Undefined]";
    } else if (mal_value_is_null(this_value)) {
        tag = "[object Null]";
    } else if (mal_value_is_array_object(this_value)) {
        tag = "[object Array]";
    } else if (mal_value_is_callable(this_value)) {
        tag = "[object Function]";
    } else if (mal_value_is_string(this_value)) {
        tag = "[object String]";
    } else if (mal_value_is_boolean(this_value)) {
        tag = "[object Boolean]";
    } else if (mal_value_is_int32(this_value) || mal_value_is_f64_or_nan(this_value)) {
        tag = "[object Number]";
    }

    return mal_value_from_string(mal_intrinsic_ascii(vm, tag));
}

void mal_builtin_object_install(MalVm *vm) {
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalNativeFunctionObject *constructor = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "Object"),
        mal_builtin_object_constructor
    );
    MalObject *constructor_object = (MalObject *) constructor;
    vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE], MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    vm->intrinsics[MAL_INTRINSIC_OBJECT_DEFINE_PROPERTY] =
        mal_intrinsic_define_method(vm, constructor_object, "defineProperty", mal_builtin_object_define_property);
    mal_intrinsic_define_method(vm, constructor_object, "defineProperties", mal_builtin_object_define_properties);
    mal_intrinsic_define_method(vm, constructor_object, "getOwnPropertyDescriptor", mal_builtin_object_get_own_property_descriptor);
    mal_intrinsic_define_method(vm, constructor_object, "getOwnPropertyNames", mal_builtin_object_get_own_property_names);
    mal_intrinsic_define_method(vm, constructor_object, "keys", mal_builtin_object_keys);
    mal_intrinsic_define_method(vm, constructor_object, "values", mal_builtin_object_values);
    mal_intrinsic_define_method(vm, constructor_object, "entries", mal_builtin_object_entries);
    mal_intrinsic_define_method(vm, constructor_object, "assign", mal_builtin_object_assign);
    mal_intrinsic_define_method(vm, constructor_object, "create", mal_builtin_object_create);
    mal_intrinsic_define_method(vm, constructor_object, "getPrototypeOf", mal_builtin_object_get_prototype_of);
    mal_intrinsic_define_method(vm, constructor_object, "setPrototypeOf", mal_builtin_object_set_prototype_of);
    mal_intrinsic_define_method(vm, constructor_object, "preventExtensions", mal_builtin_object_prevent_extensions);
    mal_intrinsic_define_method(vm, constructor_object, "isExtensible", mal_builtin_object_is_extensible);
    mal_intrinsic_define_method(vm, constructor_object, "freeze", mal_builtin_object_freeze);
    mal_intrinsic_define_method(vm, constructor_object, "isFrozen", mal_builtin_object_is_frozen);
    mal_intrinsic_define_method(vm, constructor_object, "is", mal_builtin_object_is);
    mal_intrinsic_define_method(vm, constructor_object, "hasOwn", mal_builtin_object_has_own);

    mal_intrinsic_define_method(vm, prototype, "hasOwnProperty", mal_builtin_object_prototype_has_own_property);
    mal_intrinsic_define_method(vm, prototype, "isPrototypeOf", mal_builtin_object_prototype_is_prototype_of);
    mal_intrinsic_define_method(vm, prototype, "propertyIsEnumerable", mal_builtin_object_prototype_property_is_enumerable);
    mal_intrinsic_define_method(vm, prototype, "valueOf", mal_builtin_object_prototype_value_of);
    mal_intrinsic_define_method(vm, prototype, "toString", mal_builtin_object_prototype_to_string);
}
