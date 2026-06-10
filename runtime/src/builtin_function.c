#include "builtin_function.h"

#include <stdlib.h>
#include <string.h>

#include "bound_function_object.h"
#include "heap_string.h"
#include "vm.h"
#include "vm_ops.h"

static MalValue mal_builtin_function_forward_completion(MalVm *vm, MalCompletion completion) {
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return mal_value_new_undefined();
    }

    return completion.value;
}

static MalValue mal_builtin_function_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "The Function constructor is not supported");
    return mal_value_new_undefined();
}

static MalValue mal_builtin_function_prototype_call(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_value_is_callable(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Function.prototype.call called on a non-callable");
        return mal_value_new_undefined();
    }

    MalValue this_arg = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    return mal_builtin_function_forward_completion(vm, mal_vm_call_value(
        vm,
        this_value,
        this_arg,
        arg_count > 1 ? args + 1 : nullptr,
        arg_count > 1 ? arg_count - 1 : 0
    ));
}

static MalValue mal_builtin_function_prototype_apply(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_value_is_callable(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Function.prototype.apply called on a non-callable");
        return mal_value_new_undefined();
    }

    MalValue this_arg = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue arguments_value = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    if (mal_value_is_nil(arguments_value)) {
        return mal_builtin_function_forward_completion(vm, mal_vm_call_value(vm, this_value, this_arg, nullptr, 0));
    }

    if (!mal_value_is_array_object(arguments_value)) {
        // TODO(functions): general array-likes need a length + indexed read path.
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Function.prototype.apply expects an array of arguments");
        return mal_value_new_undefined();
    }

    u32 length = mal_array_object_length(mal_value_to_array_object(arguments_value));
    MalValue *call_args = length > 0 ? malloc(sizeof(MalValue) * length) : nullptr;
    for (u32 index = 0; index < length; index++) {
        MalPropertyResolution resolution = mal_object_resolve_property(
            mal_value_to_object(arguments_value),
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)}
        );
        call_args[index] = mal_value_new_undefined();
        if (resolution.found && !mal_vm_desc_read(vm, resolution.desc, arguments_value, &call_args[index])) {
            free(call_args);
            return mal_value_new_undefined();
        }
    }

    MalCompletion completion = mal_vm_call_value(vm, this_value, this_arg, call_args, (i32) length);
    free(call_args);
    return mal_builtin_function_forward_completion(vm, completion);
}

static MalValue mal_builtin_function_prototype_bind(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_value_is_callable(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Function.prototype.bind called on a non-callable");
        return mal_value_new_undefined();
    }

    MalBoundFunctionObject *bound = mal_bound_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        this_value,
        arg_count >= 1 ? args[0] : mal_value_new_undefined(),
        arg_count > 1 ? args + 1 : nullptr,
        arg_count > 1 ? arg_count - 1 : 0
    );

    return mal_value_from_bound_function_object(bound);
}

static MalValue mal_builtin_function_prototype_has_instance(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_value_new_boolean(mal_vm_ordinary_has_instance(
        vm,
        this_value,
        arg_count >= 1 ? args[0] : mal_value_new_undefined()
    ));
}

static MalValue mal_builtin_function_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    if (!mal_value_is_callable(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Function.prototype.toString called on a non-callable");
        return mal_value_new_undefined();
    }

    static const byte prefix[] = "function ";
    static const byte suffix[] = "() { [native code] }";
    MalString *name = mal_vm_callable_name(vm, this_value);
    usize name_length = name != nullptr ? mal_string_length(name) : 0;
    usize total_length = lengthof(prefix) + name_length + lengthof(suffix);

    c16 *code_units = malloc(sizeof(c16) * total_length);
    usize offset = 0;
    for (usize i = 0; i < lengthof(prefix); i++) {
        code_units[offset++] = (c16) prefix[i];
    }
    if (name != nullptr) {
        memcpy(code_units + offset, mal_string_code_units(name), (usize) sizeof(c16) * name_length);
        offset += name_length;
    }
    for (usize i = 0; i < lengthof(suffix); i++) {
        code_units[offset++] = (c16) suffix[i];
    }

    MalString *result = mal_string_new_copy(&vm->heap, code_units, total_length);
    free(code_units);
    return mal_value_from_string(result);
}

void mal_builtin_function_install(MalVm *vm) {
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalNativeFunctionObject *constructor = mal_native_function_object_new(
        &vm->heap,
        prototype,
        mal_intrinsic_ascii(vm, "Function"),
        mal_builtin_function_constructor
    );
    vm->intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE], MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_method(vm, prototype, "call", mal_builtin_function_prototype_call);
    mal_intrinsic_define_method(vm, prototype, "apply", mal_builtin_function_prototype_apply);
    mal_intrinsic_define_method(vm, prototype, "bind", mal_builtin_function_prototype_bind);
    mal_intrinsic_define_method(vm, prototype, "toString", mal_builtin_function_prototype_to_string);

    // The default @@hasInstance every callable inherits; instanceof
    // dispatches through it. Non-writable non-configurable per spec.
    MalPropertyDesc has_instance_desc = mal_intrinsic_data_desc(
        mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap,
            prototype,
            mal_intrinsic_ascii(vm, "[Symbol.hasInstance]"),
            mal_builtin_function_prototype_has_instance
        )),
        MAL_PROPERTY_NONE
    );
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_HAS_INSTANCE), &has_instance_desc);
}
