#include "intrinsics.h"

#include "builtin_array.h"
#include "builtin_error.h"
#include "builtin_function.h"
#include "builtin_object.h"
#include "heap_string.h"
#include "vm.h"

MalString *mal_intrinsic_ascii(MalVm *vm, const byte *name) {
    usize length = 0;
    while (name[length] != '\0') {
        length++;
    }

    return mal_string_new_ascii(&vm->heap, name, length);
}

MalKey mal_intrinsic_string_key(MalVm *vm, const byte *name) {
    return (MalKey) {.kind = MAL_KEY_STRING, .value = mal_value_from_string(mal_intrinsic_ascii(vm, name))};
}

MalPropertyDesc mal_intrinsic_data_desc(MalValue value, MalPropertyFlags flags) {
    return (MalPropertyDesc) {
        .flags = flags,
        .value = value,
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
}

void mal_intrinsic_define_data(MalVm *vm, MalObject *object, const byte *name, MalValue value, MalPropertyFlags flags) {
    MalPropertyDesc desc = mal_intrinsic_data_desc(value, flags);
    mal_object_define_own(object, mal_intrinsic_string_key(vm, name), &desc);
}

MalValue mal_intrinsic_define_method(MalVm *vm, MalObject *object, const byte *name, MalNativeFunctionCallback callback) {
    MalNativeFunctionObject *function = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name),
        callback
    );
    MalValue value = mal_value_from_native_function_object(function);
    mal_intrinsic_define_data(vm, object, name, value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    return value;
}

MalObject *mal_intrinsic_new_object(MalVm *vm) {
    return mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
}

MalArrayObject *mal_intrinsic_new_array(MalVm *vm, u32 length) {
    MalArrayObject *array = mal_array_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]));
    mal_array_object_set_length(array, length);
    return array;
}

void mal_intrinsics_init(MalVm *vm) {
    // The prototypes are created upfront, so the builtin install passes can
    // reference them in any order.
    MalObject *object_prototype = mal_object_new(&vm->heap, nullptr);
    MalObject *function_prototype = mal_object_new(&vm->heap, object_prototype);
    MalObject *array_prototype = (MalObject *) mal_array_object_new(&vm->heap, object_prototype);

    vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE] = mal_value_from_object(object_prototype);
    vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE] = mal_value_from_object(function_prototype);
    vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE] = mal_value_from_object(array_prototype);

    mal_builtin_object_install(vm);
    mal_builtin_function_install(vm);
    mal_builtin_array_install(vm);
    mal_builtin_error_install(vm);
}
