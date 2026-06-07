#include "builtin_error.h"

#include <stdlib.h>
#include <string.h>

#include "heap_string.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/**
 * Allocate an error object backed by the given prototype slot, with the
 * message (when defined) stored as an own non-enumerable property.
 */
static MalValue mal_builtin_error_make(MalVm *vm, MalIntrinsic prototype_slot, const MalValue *args, i32 arg_count) {
    MalObject *error = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[prototype_slot]));

    if (arg_count >= 1 && !mal_value_is_undefined(args[0])) {
        MalValue message = mal_value_from_string(mal_ops_to_string(&vm->heap, args[0]));
        mal_intrinsic_define_data(vm, error, "message", message, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }

    return mal_value_from_object(error);
}

// Error constructors behave identically when called and when constructed, so
// plain native callbacks cover both paths.
static MalValue mal_builtin_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, args, arg_count);
}

static MalValue mal_builtin_type_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, args, arg_count);
}

static MalValue mal_builtin_range_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, args, arg_count);
}

static MalValue mal_builtin_reference_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE, args, arg_count);
}

static MalValue mal_builtin_syntax_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, args, arg_count);
}

static MalValue mal_builtin_uri_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, args, arg_count);
}

static MalValue mal_builtin_eval_error_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) this_value;
    return mal_builtin_error_make(vm, MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE, args, arg_count);
}

static MalString *mal_builtin_error_resolve_string(MalVm *vm, MalObject *error, const byte *name) {
    MalPropertyResolution resolution = mal_object_resolve_property(error, mal_intrinsic_string_key(vm, name));
    if (!resolution.found) {
        return nullptr;
    }

    MalValue value;
    if (!mal_vm_desc_read(vm, resolution.desc, mal_value_from_object(error), &value) || mal_value_is_undefined(value)) {
        return nullptr;
    }

    return mal_ops_to_string(&vm->heap, value);
}

static MalValue mal_builtin_error_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) args;
    (void) arg_count;
    if (!mal_value_is_object(this_value)) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, "Error"));
    }

    MalObject *error = mal_value_to_object(this_value);
    MalString *name = mal_builtin_error_resolve_string(vm, error, "name");
    MalString *message = mal_builtin_error_resolve_string(vm, error, "message");

    if (name == nullptr) {
        name = mal_intrinsic_ascii(vm, "Error");
    }
    if (message == nullptr || mal_string_length(message) == 0) {
        return mal_value_from_string(name);
    }
    if (mal_string_length(name) == 0) {
        return mal_value_from_string(message);
    }

    usize name_length = mal_string_length(name);
    usize message_length = mal_string_length(message);
    usize total_length = name_length + 2 + message_length;
    c16 *code_units = malloc(sizeof(c16) * total_length);

    memcpy(code_units, mal_string_code_units(name), (usize) sizeof(c16) * name_length);
    code_units[name_length] = ':';
    code_units[name_length + 1] = ' ';
    memcpy(code_units + name_length + 2, mal_string_code_units(message), (usize) sizeof(c16) * message_length);

    MalString *result = mal_string_new_copy(&vm->heap, code_units, total_length);
    free(code_units);
    return mal_value_from_string(result);
}

void mal_vm_throw_error(MalVm *vm, MalIntrinsic prototype_slot, const byte *message) {
    mal_vm_throw_error_value(vm, prototype_slot, mal_value_from_string(mal_intrinsic_ascii(vm, message)));
}

void mal_vm_throw_error_value(MalVm *vm, MalIntrinsic prototype_slot, MalValue message) {
    vm->completion = (MalCompletion) {
        .kind = MAL_COMPLETION_THROW,
        .value = mal_builtin_error_make(vm, prototype_slot, &message, 1),
    };
}

static MalObject *mal_builtin_error_install_kind(
    MalVm *vm,
    const byte *name,
    MalIntrinsic constructor_slot,
    MalIntrinsic prototype_slot,
    MalObject *parent_prototype,
    MalNativeFunctionCallback constructor_callback
) {
    MalObject *prototype = mal_object_new(&vm->heap, parent_prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name),
        constructor_callback
    );

    vm->intrinsics[constructor_slot] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[prototype_slot] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[prototype_slot], MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[constructor_slot], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "name", mal_value_from_string(mal_intrinsic_ascii(vm, name)), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "message", mal_value_from_string(mal_intrinsic_ascii(vm, "")), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    return prototype;
}

void mal_builtin_error_install(MalVm *vm) {
    MalObject *error_prototype = mal_builtin_error_install_kind(
        vm,
        "Error",
        MAL_INTRINSIC_ERROR_CONSTRUCTOR,
        MAL_INTRINSIC_ERROR_PROTOTYPE,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]),
        mal_builtin_error_constructor
    );
    mal_intrinsic_define_method(vm, error_prototype, "toString", mal_builtin_error_prototype_to_string);

    mal_builtin_error_install_kind(vm, "TypeError", MAL_INTRINSIC_TYPE_ERROR_CONSTRUCTOR, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, error_prototype, mal_builtin_type_error_constructor);
    mal_builtin_error_install_kind(vm, "RangeError", MAL_INTRINSIC_RANGE_ERROR_CONSTRUCTOR, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, error_prototype, mal_builtin_range_error_constructor);
    mal_builtin_error_install_kind(vm, "ReferenceError", MAL_INTRINSIC_REFERENCE_ERROR_CONSTRUCTOR, MAL_INTRINSIC_REFERENCE_ERROR_PROTOTYPE, error_prototype, mal_builtin_reference_error_constructor);
    mal_builtin_error_install_kind(vm, "SyntaxError", MAL_INTRINSIC_SYNTAX_ERROR_CONSTRUCTOR, MAL_INTRINSIC_SYNTAX_ERROR_PROTOTYPE, error_prototype, mal_builtin_syntax_error_constructor);
    mal_builtin_error_install_kind(vm, "URIError", MAL_INTRINSIC_URI_ERROR_CONSTRUCTOR, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, error_prototype, mal_builtin_uri_error_constructor);
    mal_builtin_error_install_kind(vm, "EvalError", MAL_INTRINSIC_EVAL_ERROR_CONSTRUCTOR, MAL_INTRINSIC_EVAL_ERROR_PROTOTYPE, error_prototype, mal_builtin_eval_error_constructor);
}
