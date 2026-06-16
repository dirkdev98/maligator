#include "builtin_function.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "bound_function_object.h"
#include "heap_string.h"
#include "value_ops.h"
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

// %ThrowTypeError%: rejects any get/set of the poisoned `caller`/`arguments`
// accessors (and strict mapped-arguments `callee`).
static MalValue mal_builtin_throw_type_error(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "'caller', 'callee' and 'arguments' may not be accessed on strict mode functions");
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

    // CreateListFromArrayLike(argArray): any object with length + indices, not
    // only real arrays (so `fn.apply(t, arguments)` / a {length, 0, 1} work).
    if (!mal_value_is_object(arguments_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Function.prototype.apply expects an array-like arguments object");
        return mal_value_new_undefined();
    }

    MalValue length_value;
    if (!mal_vm_get_property(vm, arguments_value, mal_intrinsic_string_key(vm, "length"), &length_value)) {
        return mal_value_new_undefined();
    }
    f64 length_number;
    if (!mal_vm_to_number(vm, length_value, &length_number)) {
        return mal_value_new_undefined();
    }
    // ToLength clamp (capped at u32 for our calling convention).
    u32 length = (length_number != length_number || length_number <= 0)
        ? 0
        : (length_number >= (f64) UINT32_MAX ? UINT32_MAX : (u32) length_number);

    MalValue *call_args = length > 0 ? malloc(sizeof(MalValue) * length) : nullptr;
    for (u32 index = 0; index < length; index++) {
        if (!mal_vm_get_property(vm, arguments_value, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)}, &call_args[index])) {
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

    i32 bound_count = arg_count > 1 ? arg_count - 1 : 0;
    // BoundFunctionCreate (10.4.1.3): the bound function's [[Prototype]] is the
    // target's [[GetPrototypeOf]](), not unconditionally %Function.prototype%.
    MalObject *bound_prototype = mal_object_get_prototype(mal_value_to_object(this_value));
    if (bound_prototype == nullptr) {
        bound_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    }
    MalBoundFunctionObject *bound = mal_bound_function_object_new(
        &vm->heap,
        bound_prototype,
        this_value,
        arg_count >= 1 ? args[0] : mal_value_new_undefined(),
        arg_count > 1 ? args + 1 : nullptr,
        bound_count
    );
    MalValue bound_value = mal_value_from_bound_function_object(bound);

    // SetFunctionLength: max(0, ToIntegerOrInfinity(target.length) - bound args)
    // when target.length is a Number, else 0. Materialized as a real
    // { writable: false, enumerable: false, configurable: true } own property.
    MalValue target_length;
    if (!mal_vm_get_property(vm, this_value, mal_intrinsic_string_key(vm, "length"), &target_length)) {
        return mal_value_new_undefined();
    }
    i32 length = 0;
    bool target_length_is_number = mal_value_is_int32(target_length) ||
        mal_value_is_f64_or_nan(target_length) ||
        target_length == MAL_VALUE_NEGATIVE_ZERO;
    if (target_length_is_number) {
        f64 numeric = mal_ops_to_number(target_length);
        if (isfinite(numeric)) {
            i32 truncated = (i32) numeric - bound_count;
            length = truncated > 0 ? truncated : 0;
        }
    }
    MalPropertyDesc length_desc = mal_intrinsic_data_desc(mal_value_from_i32(length), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own((MalObject *) bound, mal_intrinsic_string_key(vm, "length"), &length_desc);

    // SetFunctionName: "bound " ++ (target.name if a string, else "").
    MalValue target_name;
    if (!mal_vm_get_property(vm, this_value, mal_intrinsic_string_key(vm, "name"), &target_name)) {
        return mal_value_new_undefined();
    }
    MalValue prefix = mal_value_from_string(mal_intrinsic_ascii(vm, "bound "));
    MalValue name_value = mal_value_is_string(target_name)
        ? mal_ops_add(&vm->heap, prefix, target_name)
        : prefix;
    MalPropertyDesc name_desc = mal_intrinsic_data_desc(name_value, MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own((MalObject *) bound, mal_intrinsic_string_key(vm, "name"), &name_desc);

    return bound_value;
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
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        prototype,
        mal_intrinsic_ascii(vm, "Function"),
        1,
        mal_builtin_function_constructor
    );
    vm->intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE], MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_method_n(vm, prototype, "call", 1, mal_builtin_function_prototype_call);
    mal_intrinsic_define_method_n(vm, prototype, "apply", 2, mal_builtin_function_prototype_apply);
    mal_intrinsic_define_method_n(vm, prototype, "bind", 1, mal_builtin_function_prototype_bind);
    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, mal_builtin_function_prototype_to_string);

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

    // %ThrowTypeError%: the shared poison function. Anonymous (name ""), length 0
    // — both non-writable/non-enumerable/non-configurable — and frozen (the
    // object is non-extensible).
    MalNativeFunctionObject *thrower = mal_native_function_object_new_arity(
        &vm->heap,
        prototype,
        mal_intrinsic_ascii(vm, ""),
        0,
        mal_builtin_throw_type_error
    );
    MalObject *thrower_object = (MalObject *) thrower;
    MalPropertyDesc thrower_length = mal_intrinsic_data_desc(mal_value_from_i32(0), MAL_PROPERTY_NONE);
    mal_object_define_own(thrower_object, mal_intrinsic_string_key(vm, "length"), &thrower_length);
    MalPropertyDesc thrower_name = mal_intrinsic_data_desc(mal_value_from_string(mal_intrinsic_ascii(vm, "")), MAL_PROPERTY_NONE);
    mal_object_define_own(thrower_object, mal_intrinsic_string_key(vm, "name"), &thrower_name);
    mal_object_set_extensible(thrower_object, false);
    MalValue thrower_value = mal_value_from_native_function_object(thrower);
    vm->intrinsics[MAL_INTRINSIC_THROW_TYPE_ERROR] = thrower_value;

    // AddRestrictedFunctionProperties: poison `caller`/`arguments` on
    // %Function.prototype% as accessors { get/set: %ThrowTypeError%,
    // enumerable: false, configurable: true }. Every function inherits these, so
    // reading or writing `.caller`/`.arguments` on any function throws.
    MalPropertyDesc poison = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = thrower_value,
        .setter = thrower_value,
    };
    mal_object_define_own(prototype, mal_intrinsic_string_key(vm, "caller"), &poison);
    mal_object_define_own(prototype, mal_intrinsic_string_key(vm, "arguments"), &poison);
}
