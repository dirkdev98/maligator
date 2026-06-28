#include "builtin_boolean.h"

#include "heap_string.h"
#include "primitive_wrapper_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/**
 * Resolve the prototype for a construct call: new_target's prototype property
 * when it is an object, the given intrinsic slot otherwise
 * (OrdinaryCreateFromConstructor flavored).
 */
static MalObject *mal_builtin_boolean_resolve_prototype(MalVm *vm, MalValue new_target, MalIntrinsic fallback) {
    MalValue prototype;
    if (!mal_vm_get_property(vm, new_target, mal_intrinsic_string_key(vm, "prototype"), &prototype)) {
        return nullptr;
    }
    if (mal_value_is_object(prototype)) {
        return mal_value_to_object(prototype);
    }
    return mal_value_to_object(vm->intrinsics[fallback]);
}

/**
 * Spec thisBooleanValue: unwrap a Boolean primitive or Boolean wrapper receiver,
 * throwing a TypeError on a foreign receiver.
 */
static bool mal_builtin_boolean_this(MalVm *vm, MalValue this_value, bool *out) {
    MalValue primitive;
    if (!mal_value_this_boolean_value(this_value, &primitive)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Boolean.prototype method called on incompatible receiver");
        return false;
    }
    *out = mal_value_to_boolean(primitive);
    return true;
}

static MalValue mal_builtin_boolean_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    bool value = arg_count >= 1 && mal_value_is_truthy(args[0]);

    if (mal_value_is_undefined(new_target)) {
        return mal_value_new_boolean(value);
    }

    MalObject *prototype = mal_builtin_boolean_resolve_prototype(vm, new_target, MAL_INTRINSIC_BOOLEAN_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_from_primitive_wrapper(mal_primitive_wrapper_object_new(
        &vm->heap,
        prototype,
        MAL_PRIMITIVE_WRAPPER_BOOLEAN,
        mal_value_new_boolean(value)
    ));
}

static MalValue mal_builtin_boolean_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    bool value;
    if (!mal_builtin_boolean_this(vm, this_value, &value)) {
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_intrinsic_ascii(vm, value ? "true" : "false"));
}

static MalValue mal_builtin_boolean_prototype_value_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    bool value;
    if (!mal_builtin_boolean_this(vm, this_value, &value)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(value);
}

void mal_builtin_boolean_install(MalVm *vm) {
    // %Boolean.prototype% is itself a Boolean object with [[BooleanData]] =
    // false, so Boolean.prototype.valueOf()/toString() work on the prototype.
    MalObject *prototype = (MalObject *) mal_primitive_wrapper_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]),
        MAL_PRIMITIVE_WRAPPER_BOOLEAN,
        mal_value_new_boolean(false)
    );
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "Boolean"),
        1,
        mal_builtin_boolean_constructor
    );

    vm->intrinsics[MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_BOOLEAN_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_BOOLEAN_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, mal_builtin_boolean_prototype_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0, mal_builtin_boolean_prototype_value_of);
}
