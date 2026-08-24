#include "builtin_function.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "bound_function_object.h"
#include "builtin_eval.h"
#include "checked_size.h"
#include "heap_string.h"
#include "object_ops.h"
#include "proxy_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static bool mal_builtin_function_throw_string_length(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
    return false;
}

static MalValue mal_builtin_function_forward_completion(MalVm *vm, MalCompletion completion) {
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        vm->completion = completion;
        return mal_value_new_undefined();
    }

    return completion.value;
}

static MalValue mal_builtin_function_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    // `Function(...)` and `new Function(...)` both produce the dynamically
    // compiled function (the result is the function, not an instance).
    MalRootSpan args_span;
    mal_gc_root(&args_span, (MalValue *) args, arg_count);
    mal_gc_native_rooted_begin(vm);
    MalValue result = mal_vm_construct_function(
        vm, args, arg_count, MAL_DYNAMIC_FUNCTION_NORMAL, new_target, callee);
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&args_span);
    return result;
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

    MalValue inline_args[8];
    MalValue *call_args;
    i32 call_arg_count;
    if (!mal_vm_create_list_from_array_like(
            vm, arguments_value, inline_args, countof(inline_args),
            &call_args, &call_arg_count)) {
        return mal_value_new_undefined();
    }
    if (call_arg_count == 0) {
        return mal_builtin_function_forward_completion(
            vm, mal_vm_call_value(vm, this_value, this_arg, nullptr, 0));
    }

    // Keep the materialized list alive across proxy/native dispatch checkpoints.
    MalRootSpan args_span;
    mal_gc_root(&args_span, call_args, call_arg_count);
    mal_gc_native_rooted_begin(vm);
    MalCompletion completion = mal_vm_call_value(
        vm, this_value, this_arg, call_args, call_arg_count);
    MalValue ret = mal_builtin_function_forward_completion(vm, completion);
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&args_span);
    if (call_args != inline_args) free(call_args);
    return ret;
}

static MalValue mal_builtin_function_prototype_bind(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (!mal_value_is_callable(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Function.prototype.bind called on a non-callable");
        return mal_value_new_undefined();
    }

    i32 bound_count = arg_count > 1 ? arg_count - 1 : 0;
    // BoundFunctionCreate (10.4.1.3): the bound function's [[Prototype]] is the
    // target's [[GetPrototypeOf]](), not unconditionally %Function.prototype%.
    MalObject *bound_prototype;
    if (mal_value_is_proxy_object(this_value)) {
        MalValue prototype_value;
        if (!mal_proxy_get_prototype_of(
                vm, mal_value_to_proxy_object(this_value), &prototype_value)) {
            return mal_value_new_undefined();
        }
        bound_prototype = mal_value_is_object(prototype_value)
            ? mal_value_to_object(prototype_value)
            : nullptr;
    } else {
        bound_prototype = mal_object_get_prototype(mal_value_to_object(this_value));
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
    MalValue bound_roots[2] = {bound_value, mal_value_new_undefined()};
    MalRootSpan bound_root;
    mal_gc_root(&bound_root, bound_roots, countof(bound_roots));

    // SetFunctionLength: L = max(0, ToIntegerOrInfinity(target.length) - bound
    // args), but ONLY when target HAS AN OWN "length" property that is a Number
    // (spec step: targetHasLength = HasOwnProperty(Target, "length")); otherwise
    // L is 0. Infinity and values beyond int32 are preserved. Materialized as a
    // real { writable: false, enumerable: false, configurable: true } own property.
    MalKey length_key = mal_intrinsic_string_key(vm, "length");
    bool has_own_length;
    MalPropertyLookup own_length = {0};
    if (mal_value_is_proxy_object(this_value)) {
        bool present;
        MalPropertyDesc desc;
        if (!mal_proxy_get_own_property_descriptor(vm, mal_value_to_proxy_object(this_value), length_key, &present, &desc)) {
            mal_gc_unroot(&bound_root);
            return mal_value_new_undefined();
        }
        has_own_length = present;
    } else {
        own_length = mal_object_get_own(mal_value_to_object(this_value), length_key);
        has_own_length = own_length.present;
    }

    f64 length_num = 0;
    if (has_own_length) {
        MalValue target_length;
        bool read = mal_value_is_proxy_object(this_value)
            ? mal_vm_get_property(vm, this_value, length_key, &target_length)
            : mal_vm_desc_read(vm, own_length.desc, this_value, &target_length);
        if (!read) {
            mal_gc_unroot(&bound_root);
            return mal_value_new_undefined();
        }
        // mal_ops_is_number covers int32, f64, NaN, ±0 and the ±Infinity statics.
        if (mal_ops_is_number(target_length)) {
            f64 numeric = mal_ops_to_number(target_length);
            // ToIntegerOrInfinity: NaN/±0 -> +0, ±Infinity preserved, else trunc.
            f64 integer = mal_ops_number_to_integer_or_infinity(numeric);
            length_num = integer - (f64) bound_count;
            // max(0, ·); also normalizes a -0 (e.g. trunc(-0.5)) to +0.
            if (!(length_num > 0)) {
                length_num = 0.0;
            }
        }
    }
    // SetFunctionName: "bound " ++ (target.name if a string, else "").
    MalKey name_key = mal_intrinsic_string_key(vm, "name");
    bool read_name = false;
    if (!mal_value_is_proxy_object(this_value)) {
        MalPropertyLookup own_name =
            mal_object_get_own(mal_value_to_object(this_value), name_key);
        if (own_name.present) {
            read_name = mal_vm_desc_read(
                vm, own_name.desc, this_value, &bound_roots[1]);
        }
    }
    if (!read_name && vm->completion.kind != MAL_COMPLETION_THROW) {
        read_name = mal_vm_get_property(
            vm, this_value, name_key, &bound_roots[1]);
    }
    if (!read_name) {
        mal_gc_unroot(&bound_root);
        return mal_value_new_undefined();
    }
    MalString *prefix = mal_intrinsic_ascii(vm, "bound ");
    MalValue name_value = mal_value_from_string(prefix);
    if (mal_value_is_string(bound_roots[1])) {
        MalString *combined;
        if (!mal_string_new_cons_checked(
                &vm->heap, prefix, mal_value_to_string(bound_roots[1]), &combined)) {
            mal_builtin_function_throw_string_length(vm);
            mal_gc_unroot(&bound_root);
            return mal_value_new_undefined();
        }
        name_value = mal_value_from_string(combined);
    }
    mal_bound_function_object_init_metadata(
        bound, length_key, mal_ops_number_value(length_num), name_key, name_value);

    mal_gc_unroot(&bound_root);
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
    usize total_length;
    usize bytes;
    if (!mal_checked_size_add(
            lengthof(prefix), name_length, MAL_STRING_MAX_CODE_UNITS, &total_length) ||
        !mal_checked_size_add(
            total_length, lengthof(suffix), MAL_STRING_MAX_CODE_UNITS, &total_length) ||
        !mal_checked_size_multiply(sizeof(c16), total_length, SIZE_MAX, &bytes)) {
        mal_builtin_function_throw_string_length(vm);
        return mal_value_new_undefined();
    }

    c16 *code_units = mal_heap_alloc_raw(&vm->heap, bytes);
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

    MalString *result = mal_string_new_owned(&vm->heap, code_units, total_length);
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

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_FUNCTION_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE_CALL] =
        mal_intrinsic_define_method_n(vm, prototype, "call", 1,
            mal_builtin_function_prototype_call);
    mal_intrinsic_define_method_n(vm, prototype, "apply", 2, mal_builtin_function_prototype_apply);
    mal_intrinsic_define_method_n(vm, prototype, "bind", 1, mal_builtin_function_prototype_bind);
    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, mal_builtin_function_prototype_to_string);

    // The default @@hasInstance every callable inherits; instanceof
    // dispatches through it. Non-writable non-configurable per spec.
    MalPropertyDesc has_instance_desc = mal_intrinsic_data_desc(
        mal_value_from_native_function_object(mal_native_function_object_new_arity(
            &vm->heap,
            prototype,
            mal_intrinsic_ascii(vm, "[Symbol.hasInstance]"),
            1,
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
    MalPropertyDesc poison = mal_intrinsic_accessor_desc(
        thrower_value, thrower_value, MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_string_key(vm, "caller"), &poison);
    mal_object_define_own(prototype, mal_intrinsic_string_key(vm, "arguments"), &poison);
}
