#include "builtin_reflect.h"

#include <stdlib.h>

#include "array_object.h"
#include "bound_function_object.h"
#include "builtin_object.h"
#include "function_object.h"
#include "heap_symbol.h"
#include "module_namespace_object.h"
#include "object_ops.h"
#include "property_iter.h"
#include "typed_array_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static MalValue mal_reflect_arg(const MalValue *args, i32 arg_count, i32 index) {
    return index < arg_count ? args[index] : mal_value_new_undefined();
}

static MalValue mal_reflect_forward(MalVm *vm, MalCompletion completion) {
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return mal_value_new_undefined();
    }
    return completion.value;
}

/**
 * Reflect operations other than apply/construct require their first argument to
 * be an object. Reports the shared TypeError and returns false otherwise.
 */
static bool mal_reflect_require_object(MalVm *vm, MalValue target, const byte *method) {
    if (mal_value_is_object(target)) {
        return true;
    }
    (void) method;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reflect called on non-object");
    return false;
}

/**
 * IsConstructor, pragmatically: bound functions defer to their target, script
 * functions must be ordinary (non-generator/async), native functions are
 * assumed constructible (the runtime does not yet flag native non-constructors).
 */
static bool mal_reflect_is_constructor(MalVm *vm, MalValue value) {
    while (mal_value_is_bound_function_object(value)) {
        value = mal_value_to_bound_function_object(value)->target;
    }
    if (mal_value_is_native_function_object(value)) {
        return mal_native_function_object_is_constructor(mal_value_to_native_function_object(value));
    }
    if (mal_value_is_function_object(value)) {
        i32 index = mal_function_object_function_index(mal_value_to_function_object(value));
        return vm->definition->functions[index].kind == MAL_FUNCTION_KIND_NORMAL;
    }
    return false;
}

/**
 * CreateListFromArrayLike over an object: read its ToLength(length) and each
 * integer-indexed element into a freshly malloc'd array (caller frees). Returns
 * false with a pending completion on a non-object list or a throwing read.
 */
static bool mal_reflect_create_list(MalVm *vm, MalValue list, MalValue **out, i32 *count_out) {
    *out = nullptr;
    *count_out = 0;

    if (!mal_value_is_object(list)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reflect arguments list must be an object");
        return false;
    }

    MalValue length_value;
    if (!mal_vm_get_property(vm, list, mal_intrinsic_string_key(vm, "length"), &length_value)) {
        return false;
    }

    f64 length_number;
    if (!mal_vm_to_number(vm, length_value, &length_number)) {
        return false;
    }

    // ToLength: truncate toward zero, NaN/negative → 0. Capped pragmatically so
    // an absurd length cannot demand an unbounded allocation.
    i64 length = 0;
    if (length_number >= 1.0) {
        length = length_number > 2147483647.0 ? 2147483647 : (i64) length_number;
    }
    if (length == 0) {
        return true;
    }

    MalValue *items = malloc(sizeof(MalValue) * (usize) length);
    for (i64 index = 0; index < length; index++) {
        MalKey key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)};
        if (!mal_vm_get_property(vm, list, key, &items[index])) {
            free(items);
            return false;
        }
    }

    *out = items;
    *count_out = (i32) length;
    return true;
}

static MalValue mal_reflect_key_to_value(MalVm *vm, MalKey key) {
    if (key.kind == MAL_KEY_INDEX) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, key.value));
    }
    return key.value;
}

static MalValue mal_reflect_apply(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_value_is_callable(target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reflect.apply target is not a function");
        return mal_value_new_undefined();
    }

    MalValue *list;
    i32 count;
    if (!mal_reflect_create_list(vm, mal_reflect_arg(args, arg_count, 2), &list, &count)) {
        return mal_value_new_undefined();
    }

    MalCompletion completion = mal_vm_call_value(vm, target, mal_reflect_arg(args, arg_count, 1), list, count);
    free(list);
    return mal_reflect_forward(vm, completion);
}

static MalValue mal_reflect_construct(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_is_constructor(vm, target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reflect.construct target is not a constructor");
        return mal_value_new_undefined();
    }

    MalValue new_target_arg = arg_count > 2 ? args[2] : target;
    if (!mal_reflect_is_constructor(vm, new_target_arg)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reflect.construct newTarget is not a constructor");
        return mal_value_new_undefined();
    }

    MalValue *list;
    i32 count;
    if (!mal_reflect_create_list(vm, mal_reflect_arg(args, arg_count, 1), &list, &count)) {
        return mal_value_new_undefined();
    }

    MalCompletion completion = mal_vm_construct_value_with_target(vm, target, list, count, new_target_arg);
    free(list);
    return mal_reflect_forward(vm, completion);
}

static MalValue mal_reflect_get(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.get")) {
        return mal_value_new_undefined();
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(vm, mal_reflect_arg(args, arg_count, 1), &key)) {
        return mal_value_new_undefined();
    }

    MalValue receiver = arg_count > 2 ? args[2] : target;
    MalValue out;
    mal_vm_get_property_with_receiver(vm, target, key, receiver, &out);
    return out;
}

static MalValue mal_reflect_set(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.set")) {
        return mal_value_new_undefined();
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(vm, mal_reflect_arg(args, arg_count, 1), &key)) {
        return mal_value_new_undefined();
    }

    MalValue value = mal_reflect_arg(args, arg_count, 2);
    MalValue receiver = arg_count > 3 ? args[3] : target;
    bool ok = mal_vm_set_property(vm, target, key, value, receiver);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(ok);
}

static MalValue mal_reflect_has(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.has")) {
        return mal_value_new_undefined();
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(vm, mal_reflect_arg(args, arg_count, 1), &key)) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_vm_has_property(vm, target, key));
}

static MalValue mal_reflect_delete_property(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.deleteProperty")) {
        return mal_value_new_undefined();
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(vm, mal_reflect_arg(args, arg_count, 1), &key)) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_vm_delete_property(vm, target, key));
}

static MalValue mal_reflect_define_property(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.defineProperty")) {
        return mal_value_new_undefined();
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(vm, mal_reflect_arg(args, arg_count, 1), &key)) {
        return mal_value_new_undefined();
    }

    MalDefineOwnStatus status = mal_builtin_object_try_define(vm, mal_value_to_object(target), key, mal_reflect_arg(args, arg_count, 2));
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(status == MAL_DEFINE_OWN_APPLIED);
}

static MalValue mal_reflect_get_own_property_descriptor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.getOwnPropertyDescriptor")) {
        return mal_value_new_undefined();
    }

    MalKey key;
    if (!mal_vm_value_to_property_key(vm, mal_reflect_arg(args, arg_count, 1), &key)) {
        return mal_value_new_undefined();
    }

    // Array length lives in the header rather than the property table.
    if (mal_value_is_array_object(target) && mal_array_key_is_length(key)) {
        MalArrayObject *array = mal_value_to_array_object(target);
        MalPropertyDesc desc = {
            .flags = array->length_writable ? MAL_PROPERTY_WRITABLE : MAL_PROPERTY_NONE,
            .value = mal_value_from_i32((i32) mal_array_object_length(array)),
            .getter = mal_value_new_undefined(),
            .setter = mal_value_new_undefined(),
        };
        return mal_builtin_object_descriptor_object(vm, desc);
    }

    MalPropertyLookup lookup = mal_object_get_own(mal_value_to_object(target), key);
    if (!lookup.present) {
        return mal_value_new_undefined();
    }
    return mal_builtin_object_descriptor_object(vm, lookup.desc);
}

static MalValue mal_reflect_own_keys(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.ownKeys")) {
        return mal_value_new_undefined();
    }

    MalObject *object = mal_value_to_object(target);
    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 count = 0;

    // A module namespace's own keys: sorted string exports, then @@toStringTag.
    if (mal_value_is_module_namespace_object(target)) {
        MalModuleNamespaceObject *ns = mal_value_to_module_namespace_object(target);
        for (i32 i = 0; i < ns->export_count; i++) {
            mal_array_object_store(
                result,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)},
                mal_value_from_string(ns->exports[i].name)
            );
        }
        mal_array_object_store(
            result,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)},
            mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG).value
        );
        return mal_value_from_array_object(result);
    }

    bool is_typed_array = mal_value_is_typed_array_object(target);
    // TypedArray canonical numeric indices are exotic own keys, not table slots.
    if (is_typed_array) {
        u32 length = mal_typed_array_object_length(mal_value_to_typed_array_object(target));
        for (u32 index = 0; index < length; index++) {
            mal_array_object_store(
                result,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)},
                mal_value_from_string(mal_ops_to_string(&vm->heap, mal_value_from_i32((i32) index)))
            );
        }
    }

    // Array length is a synthetic own string key that sits right after the
    // integer-index keys in spec own-key order.
    bool is_array = mal_value_is_array_object(target);
    bool length_pending = is_array;

    MalPropertyIter iter;
    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_OWN_PROPERTY_ORDER);

    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        // Private-member symbols never surface through reflection.
        if (key.kind == MAL_KEY_SYMBOL && mal_symbol_is_private(mal_value_to_symbol(key.value))) {
            continue;
        }
        // TypedArray indices were already emitted from the canonical range.
        if (is_typed_array && key.kind == MAL_KEY_INDEX) {
            continue;
        }
        if (length_pending && key.kind != MAL_KEY_INDEX) {
            mal_array_object_store(
                result,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)},
                mal_value_from_string(mal_intrinsic_ascii(vm, "length"))
            );
            length_pending = false;
        }
        mal_array_object_store(
            result,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)},
            mal_reflect_key_to_value(vm, key)
        );
    }

    if (length_pending) {
        mal_array_object_store(
            result,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) count++)},
            mal_value_from_string(mal_intrinsic_ascii(vm, "length"))
        );
    }

    return mal_value_from_array_object(result);
}

static MalValue mal_reflect_get_prototype_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.getPrototypeOf")) {
        return mal_value_new_undefined();
    }

    MalObject *prototype = mal_object_get_prototype(mal_value_to_object(target));
    return prototype != nullptr ? mal_value_from_object(prototype) : mal_value_new_null();
}

static MalValue mal_reflect_set_prototype_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.setPrototypeOf")) {
        return mal_value_new_undefined();
    }

    MalValue proto_value = mal_reflect_arg(args, arg_count, 1);
    if (!mal_value_is_object(proto_value) && !mal_value_is_null(proto_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reflect.setPrototypeOf prototype must be an object or null");
        return mal_value_new_undefined();
    }

    MalObject *prototype = mal_value_is_object(proto_value) ? mal_value_to_object(proto_value) : nullptr;
    return mal_value_new_boolean(mal_object_set_prototype(mal_value_to_object(target), prototype));
}

static MalValue mal_reflect_is_extensible(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.isExtensible")) {
        return mal_value_new_undefined();
    }

    return mal_value_new_boolean(mal_object_is_extensible(mal_value_to_object(target)));
}

static MalValue mal_reflect_prevent_extensions(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.preventExtensions")) {
        return mal_value_new_undefined();
    }

    mal_object_set_extensible(mal_value_to_object(target), false);
    return mal_value_new_boolean(true);
}

void mal_builtin_reflect_install(MalVm *vm) {
    MalObject *reflect = mal_intrinsic_new_object(vm);
    vm->intrinsics[MAL_INTRINSIC_REFLECT] = mal_value_from_object(reflect);

    mal_intrinsic_define_method_n(vm, reflect, "apply", 3, mal_reflect_apply);
    mal_intrinsic_define_method_n(vm, reflect, "construct", 2, mal_reflect_construct);
    mal_intrinsic_define_method_n(vm, reflect, "defineProperty", 3, mal_reflect_define_property);
    mal_intrinsic_define_method_n(vm, reflect, "deleteProperty", 2, mal_reflect_delete_property);
    mal_intrinsic_define_method_n(vm, reflect, "get", 2, mal_reflect_get);
    mal_intrinsic_define_method_n(vm, reflect, "getOwnPropertyDescriptor", 2, mal_reflect_get_own_property_descriptor);
    mal_intrinsic_define_method_n(vm, reflect, "getPrototypeOf", 1, mal_reflect_get_prototype_of);
    mal_intrinsic_define_method_n(vm, reflect, "has", 2, mal_reflect_has);
    mal_intrinsic_define_method_n(vm, reflect, "isExtensible", 1, mal_reflect_is_extensible);
    mal_intrinsic_define_method_n(vm, reflect, "ownKeys", 1, mal_reflect_own_keys);
    mal_intrinsic_define_method_n(vm, reflect, "preventExtensions", 1, mal_reflect_prevent_extensions);
    mal_intrinsic_define_method_n(vm, reflect, "set", 3, mal_reflect_set);
    mal_intrinsic_define_method_n(vm, reflect, "setPrototypeOf", 2, mal_reflect_set_prototype_of);

    // Reflect[@@toStringTag] = "Reflect" so Object.prototype.toString tags it.
    MalPropertyDesc tag = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "Reflect")),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(reflect, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag);
}
