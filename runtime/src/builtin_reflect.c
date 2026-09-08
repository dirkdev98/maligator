#include "builtin_reflect.h"

#include <stdlib.h>

#include "array_object.h"
#include "bound_function_object.h"
#include "builtin_object.h"
#include "function_object.h"
#include "object_ops.h"
#include "primordials.h"
#include "proxy_object.h"
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

static MalValue mal_reflect_apply(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_value_is_callable(target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reflect.apply target is not a function");
        return mal_value_new_undefined();
    }

    MalValue inline_list[8];
    MalValue *list;
    i32 count;
    if (!mal_vm_create_list_from_array_like(
            vm, mal_reflect_arg(args, arg_count, 2),
            inline_list, countof(inline_list), &list, &count)) {
        return mal_value_new_undefined();
    }
    if (count == 0) {
        return mal_reflect_forward(vm, mal_vm_call_value(
            vm, target, mal_reflect_arg(args, arg_count, 1), nullptr, 0));
    }

    MalRootSpan list_root;
    mal_gc_root(&list_root, list, count);
    MalCompletion completion = mal_vm_call_value(
        vm, target, mal_reflect_arg(args, arg_count, 1), list, count);
    mal_gc_unroot(&list_root);
    if (list != inline_list) free(list);
    return mal_reflect_forward(vm, completion);
}

static MalValue mal_reflect_construct(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_vm_is_constructor(vm, target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reflect.construct target is not a constructor");
        return mal_value_new_undefined();
    }

    MalValue new_target_arg = arg_count > 2 ? args[2] : target;
    if (!mal_vm_is_constructor(vm, new_target_arg)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Reflect.construct newTarget is not a constructor");
        return mal_value_new_undefined();
    }

    MalValue inline_list[8];
    MalValue *list;
    i32 count;
    if (!mal_vm_create_list_from_array_like(
            vm, mal_reflect_arg(args, arg_count, 1),
            inline_list, countof(inline_list), &list, &count)) {
        return mal_value_new_undefined();
    }
    if (count == 0) {
        return mal_reflect_forward(vm, mal_vm_construct_value_with_target(
            vm, target, nullptr, 0, new_target_arg));
    }

    MalRootSpan list_root;
    mal_gc_root(&list_root, list, count);
    MalCompletion completion = mal_vm_construct_value_with_target(
        vm, target, list, count, new_target_arg);
    mal_gc_unroot(&list_root);
    if (list != inline_list) free(list);
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
    if (!mal_vm_to_property_key(vm, mal_reflect_arg(args, arg_count, 1), &key)) {
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
    if (!mal_vm_to_property_key(vm, mal_reflect_arg(args, arg_count, 1), &key)) {
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
    if (!mal_vm_to_property_key(vm, mal_reflect_arg(args, arg_count, 1), &key)) {
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
    if (!mal_vm_to_property_key(vm, mal_reflect_arg(args, arg_count, 1), &key)) {
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
    if (!mal_vm_to_property_key(vm, mal_reflect_arg(args, arg_count, 1), &key)) {
        return mal_value_new_undefined();
    }

    if (mal_value_is_proxy_object(target)) {
        bool ok = mal_proxy_define_own_property(vm, mal_value_to_proxy_object(target), key, mal_reflect_arg(args, arg_count, 2));
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
        return mal_value_new_boolean(ok);
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
    if (!mal_vm_to_property_key(vm, mal_reflect_arg(args, arg_count, 1), &key)) {
        return mal_value_new_undefined();
    }

    bool present;
    MalPropertyDesc desc;
    if (!mal_vm_get_own_property(vm, target, key, &present, &desc) || !present) {
        return mal_value_new_undefined();
    }
    return mal_builtin_object_descriptor_object(vm, desc);
}

static MalValue mal_reflect_own_keys(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.ownKeys")) {
        return mal_value_new_undefined();
    }

    MalValue keys;
    if (!mal_vm_own_property_keys(vm, target, &keys)) {
        return mal_value_new_undefined();
    }
    return keys;
}

static MalValue mal_reflect_get_prototype_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.getPrototypeOf")) {
        return mal_value_new_undefined();
    }

    if (mal_value_is_proxy_object(target)) {
        MalValue proto;
        if (!mal_proxy_get_prototype_of(vm, mal_value_to_proxy_object(target), &proto)) {
            return mal_value_new_undefined();
        }
        return proto;
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

    if (mal_value_is_proxy_object(target)) {
        bool success;
        if (!mal_proxy_set_prototype_of(vm, mal_value_to_proxy_object(target), proto_value, &success)) {
            return mal_value_new_undefined();
        }
        return mal_value_new_boolean(success);
    }

    MalObject *prototype = mal_value_is_object(proto_value) ? mal_value_to_object(proto_value) : nullptr;
    MalObject *target_object = mal_value_to_object(target);
    bool success = mal_object_set_prototype(target_object, prototype);
    if (!success && mal_object_is_locked_primordial(target_object)) {
        mal_primordials_throw_mutation(
            vm, "Cannot set prototype of locked primordial");
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(success);
}

static MalValue mal_reflect_is_extensible(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalValue target = mal_reflect_arg(args, arg_count, 0);
    if (!mal_reflect_require_object(vm, target, "Reflect.isExtensible")) {
        return mal_value_new_undefined();
    }

    if (mal_value_is_proxy_object(target)) {
        bool extensible;
        if (!mal_proxy_is_extensible(vm, mal_value_to_proxy_object(target), &extensible)) {
            return mal_value_new_undefined();
        }
        return mal_value_new_boolean(extensible);
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

    if (mal_value_is_proxy_object(target)) {
        bool success;
        if (!mal_proxy_prevent_extensions(vm, mal_value_to_proxy_object(target), &success)) {
            return mal_value_new_undefined();
        }
        return mal_value_new_boolean(success);
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

#include "generated/known_native_builtin_reflect_c.inc"
