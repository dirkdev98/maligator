#include "intrinsics.h"

#include <math.h>

#include "builtin_array.h"
#include "builtin_array_buffer.h"
#include "builtin_bigint.h"
#include "builtin_boolean.h"
#include "builtin_console.h"
#include "builtin_data_view.h"
#include "builtin_typed_array.h"
#include "builtin_error.h"
#include "builtin_function.h"
#include "builtin_generator.h"
#include "builtin_iterator.h"
#include "builtin_json.h"
#include "builtin_map.h"
#include "builtin_math.h"
#include "builtin_number.h"
#include "builtin_object.h"
#include "builtin_set.h"
#include "builtin_string.h"
#include "builtin_symbol.h"
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

MalKey mal_intrinsic_symbol_key(MalVm *vm, MalIntrinsic symbol_slot) {
    return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = vm->intrinsics[symbol_slot]};
}

MalValue mal_intrinsic_define_symbol_method(
    MalVm *vm,
    MalObject *object,
    MalIntrinsic symbol_slot,
    const byte *display_name,
    MalNativeFunctionCallback callback
) {
    MalNativeFunctionObject *function = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, display_name),
        callback
    );
    MalValue value = mal_value_from_native_function_object(function);
    MalPropertyDesc desc = mal_intrinsic_data_desc(value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(object, mal_intrinsic_symbol_key(vm, symbol_slot), &desc);
    return value;
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

static MalValue mal_intrinsic_species_getter(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) args;
    (void) arg_count;
    (void) new_target;
    return this_value;
}

void mal_intrinsic_define_species(MalVm *vm, MalObject *constructor) {
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, "get [Symbol.species]"),
            mal_intrinsic_species_getter
        )),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(constructor, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_SPECIES), &desc);
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

/**
 * %Function.prototype% is itself a function that accepts any arguments and
 * returns undefined, but has no [[Construct]].
 */
static MalValue mal_intrinsic_function_prototype_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    (void) args;
    (void) arg_count;

    if (!mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Function.prototype is not a constructor");
    }

    return mal_value_new_undefined();
}

void mal_intrinsics_init(MalVm *vm) {
    // The prototypes are created upfront, so the builtin install passes can
    // reference them in any order.
    MalObject *object_prototype = mal_object_new(&vm->heap, nullptr);
    MalObject *function_prototype = (MalObject *) mal_native_function_object_new(
        &vm->heap,
        object_prototype,
        mal_string_new_ascii(&vm->heap, "", 0),
        mal_intrinsic_function_prototype_callback
    );
    MalObject *array_prototype = (MalObject *) mal_array_object_new(&vm->heap, object_prototype);

    vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE] = mal_value_from_object(object_prototype);
    vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE] = mal_value_from_object(function_prototype);
    vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE] = mal_value_from_object(array_prototype);

    mal_builtin_object_install(vm);
    // Well-known symbols install before any pass that defines symbol-keyed
    // properties (Function.prototype[@@hasInstance], iterator wiring,
    // toStringTag); the iterator prototypes install before the passes that
    // expose iteration methods over them.
    mal_builtin_symbol_install(vm);
    mal_builtin_bigint_install(vm);
    mal_builtin_function_install(vm);
    mal_builtin_iterator_install(vm);
    mal_builtin_generator_install(vm);
    mal_builtin_array_install(vm);
    mal_builtin_map_install(vm);
    mal_builtin_set_install(vm);
    mal_builtin_array_buffer_install(vm);
    mal_builtin_typed_array_install(vm);
    mal_builtin_data_view_install(vm);
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
    mal_intrinsic_define_data(vm, global_this, "Symbol", vm->intrinsics[MAL_INTRINSIC_SYMBOL_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "BigInt", vm->intrinsics[MAL_INTRINSIC_BIGINT_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Map", vm->intrinsics[MAL_INTRINSIC_MAP_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Set", vm->intrinsics[MAL_INTRINSIC_SET_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "WeakMap", vm->intrinsics[MAL_INTRINSIC_WEAK_MAP_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "WeakSet", vm->intrinsics[MAL_INTRINSIC_WEAK_SET_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "ArrayBuffer", vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "SharedArrayBuffer", vm->intrinsics[MAL_INTRINSIC_SHARED_ARRAY_BUFFER_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Int8Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_INT8_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Uint8Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Uint8ClampedArray", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_CLAMPED_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Int16Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_INT16_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Uint16Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT16_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Int32Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_INT32_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Uint32Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT32_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Float32Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_FLOAT32_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "Float64Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_FLOAT64_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "BigInt64Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_BIGINT64_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "BigUint64Array", vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_BIGUINT64_CONSTRUCTOR], flags);
    mal_intrinsic_define_data(vm, global_this, "DataView", vm->intrinsics[MAL_INTRINSIC_DATA_VIEW_CONSTRUCTOR], flags);
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
