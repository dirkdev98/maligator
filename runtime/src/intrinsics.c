#include "intrinsics.h"

#include <math.h>

#include "builtin_array.h"
#include "builtin_boolean.h"
#include "builtin_console.h"
#include "builtin_error.h"
#include "builtin_function.h"
#include "builtin_json.h"
#include "builtin_math.h"
#include "builtin_number.h"
#include "builtin_object.h"
#include "builtin_string.h"
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

static void mal_intrinsics_init_global_this(MalVm *vm);

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
    mal_builtin_string_install(vm);
    mal_builtin_number_install(vm);
    mal_builtin_boolean_install(vm);
    mal_builtin_math_install(vm);
    mal_builtin_json_install(vm);
    mal_builtin_console_install(vm);

    vm->intrinsics[MAL_INTRINSIC_NAN_VALUE] = mal_value_new_nan();
    vm->intrinsics[MAL_INTRINSIC_INFINITY_VALUE] = mal_value_from_f64_convert_nan(INFINITY);
    mal_intrinsics_init_global_this(vm);
}

/**
 * Expose the intrinsics as properties of a globalThis namespace object.
 */
static void mal_intrinsics_init_global_this(MalVm *vm) {
    MalObject *global_this = mal_intrinsic_new_object(vm);
    vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS] = mal_value_from_object(global_this);

    MalPropertyFlags flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(vm, global_this, "globalThis", vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS], flags);
    mal_intrinsic_define_data(vm, global_this, "Object", vm->intrinsics[MAL_INTRINSIC_OBJECT_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Array", vm->intrinsics[MAL_INTRINSIC_ARRAY_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Function", vm->intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Error", vm->intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "TypeError", vm->intrinsics[MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "RangeError", vm->intrinsics[MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "ReferenceError", vm->intrinsics[MAL_INTRINSIC_REFERENCE_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "SyntaxError", vm->intrinsics[MAL_INTRINSIC_SYNTAX_ERROR_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "String", vm->intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Number", vm->intrinsics[MAL_INTRINSIC_NUMBER_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Boolean", vm->intrinsics[MAL_INTRINSIC_BOOLEAN_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "parseInt", vm->intrinsics[MAL_INTRINSIC_PARSE_INT], flags);
    mal_intrinsic_define_data(vm, global_this, "parseFloat", vm->intrinsics[MAL_INTRINSIC_PARSE_FLOAT], flags);
    mal_intrinsic_define_data(vm, global_this, "isNaN", vm->intrinsics[MAL_INTRINSIC_IS_NAN], flags);
    mal_intrinsic_define_data(vm, global_this, "isFinite", vm->intrinsics[MAL_INTRINSIC_IS_FINITE], flags);
    mal_intrinsic_define_data(vm, global_this, "Math", vm->intrinsics[MAL_INTRINSIC_MATH], flags);
    mal_intrinsic_define_data(vm, global_this, "JSON", vm->intrinsics[MAL_INTRINSIC_JSON], flags);
    mal_intrinsic_define_data(vm, global_this, "console", vm->intrinsics[MAL_INTRINSIC_CONSOLE], flags);
    mal_intrinsic_define_data(vm, global_this, "NaN", vm->intrinsics[MAL_INTRINSIC_NAN_VALUE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, global_this, "Infinity", vm->intrinsics[MAL_INTRINSIC_INFINITY_VALUE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, global_this, "undefined", mal_value_new_undefined(), MAL_PROPERTY_NONE);
}
