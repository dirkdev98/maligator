#include "builtin_boolean.h"

#include "heap_string.h"
#include "value_ops.h"
#include "vm.h"

static MalValue mal_builtin_boolean_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    // TODO(booleans): no wrapper objects, constructing also returns the primitive.
    return mal_value_new_boolean(arg_count >= 1 && mal_value_is_truthy(args[0]));
}

static MalValue mal_builtin_boolean_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_value_from_string(mal_intrinsic_ascii(vm, mal_value_is_truthy(this_value) ? "true" : "false"));
}

static MalValue mal_builtin_boolean_prototype_value_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) args;
    (void) arg_count;
    return mal_value_new_boolean(mal_value_is_truthy(this_value));
}

void mal_builtin_boolean_install(MalVm *vm) {
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "Boolean"),
        1,
        mal_builtin_boolean_constructor
    );

    vm->intrinsics[MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_BOOLEAN_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_BOOLEAN_PROTOTYPE], MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, mal_builtin_boolean_prototype_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0, mal_builtin_boolean_prototype_value_of);
}
