#include "builtin_boolean.h"

#include "gc.h"
#include "heap_string.h"
#include "primitive_wrapper_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

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

    MalValue roots[2] = {
        mal_value_new_boolean(value),
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_BOOLEAN_PROTOTYPE, &prototype)) {
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    roots[1] = mal_value_from_object(prototype);

    MalValue result = mal_value_from_primitive_wrapper(mal_primitive_wrapper_object_new(
        &vm->heap,
        mal_value_to_object(roots[1]),
        MAL_PRIMITIVE_WRAPPER_BOOLEAN,
        roots[0]
    ));
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue mal_builtin_boolean_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    bool value;
    if (!mal_builtin_boolean_this(vm, this_value, &value)) {
        return mal_value_new_undefined();
    }
    return mal_value_from_string(mal_intrinsic_hot_ascii(
        vm, value ? MAL_HOT_KEY_TRUE : MAL_HOT_KEY_FALSE
    ));
}

static MalValue mal_builtin_boolean_prototype_value_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    MalValue primitive;
    if (!mal_value_this_boolean_value(this_value, &primitive)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Boolean.prototype method called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return primitive;
}

MalValue mal_builtin_boolean_value_of_known(MalValue this_value) {
    return this_value;
}

const MalNativeFunctionCallback mal_builtin_boolean_callbacks[3] = {
    mal_builtin_boolean_constructor,
    mal_builtin_boolean_prototype_value_of,
    mal_builtin_boolean_prototype_to_string,
};

bool mal_builtin_boolean_try_direct(
    MalVm *vm, MalBooleanOperation operation, MalValue callee, MalValue receiver,
    MalValue argument, MalValue *result
) {
    if (!mal_builtin_boolean_callee_matches(operation, callee)) return false;
    if (operation == MAL_BOOLEAN_CALL) {
        *result = mal_value_new_boolean(mal_value_is_truthy(argument));
    } else {
        if (!mal_value_is_boolean(receiver)) return false;
        *result = operation == MAL_BOOLEAN_VALUE_OF ? receiver
            : mal_value_from_string(mal_intrinsic_hot_ascii(vm,
                mal_value_to_boolean(receiver) ? MAL_HOT_KEY_TRUE : MAL_HOT_KEY_FALSE));
    }
    return true;
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

#include "generated/known_native_builtin_boolean_c.inc"
