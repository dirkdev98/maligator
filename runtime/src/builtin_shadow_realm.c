#include "builtin_shadow_realm.h"

#if MAL_REALMS

#include <math.h>
#include <stdlib.h>

#include "builtin_eval.h"
#include "function_object.h"
#include "gc.h"
#include "object_ops.h"
#include "proxy_object.h"
#include "shadow_realm_object.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

#define MAL_SHADOW_REALM_CONSTRUCTOR_SLOT_PROTOTYPE 0
#define MAL_SHADOW_REALM_WRAPPER_SLOT_TARGET 0

static MalValue mal_shadow_realm_arg(const MalValue *args, i32 arg_count, i32 index) {
    return index < arg_count ? args[index] : mal_value_new_undefined();
}

static void mal_shadow_realm_throw_boundary_type_error(
    MalVm *vm,
    MalRealm *caller_realm,
    const byte *message
) {
    mal_vm_realm_switch_to(vm, caller_realm);
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message);
}

static bool mal_shadow_realm_get_own_property(
    MalVm *vm,
    MalValue object,
    MalKey key,
    bool *present_out,
    MalPropertyDesc *desc_out
) {
    if (mal_value_is_proxy_object(object)) {
        return mal_proxy_get_own_property_descriptor(
            vm,
            mal_value_to_proxy_object(object),
            key,
            present_out,
            desc_out
        );
    }

    MalPropertyLookup lookup = mal_object_get_own(
        mal_value_to_object(object), key);
    *present_out = lookup.present;
    if (lookup.present) *desc_out = lookup.desc;
    return true;
}

/** CopyNameAndLength, including the observable HasOwnProperty/Get sequence. */
static bool mal_shadow_realm_copy_name_and_length(
    MalVm *vm,
    MalRealm *caller_realm,
    MalNativeFunctionObject *wrapper,
    MalValue target
) {
    MalValue roots[3] = {
        mal_value_from_native_function_object(wrapper),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 3);

    MalKey length_key = mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_LENGTH);
    MalKey name_key = mal_intrinsic_hot_string_key(vm, MAL_HOT_KEY_NAME);
    bool target_is_proxy = mal_value_is_proxy_object(target);
    bool has_own_length;
    MalPropertyDesc own_length = {0};
    if (!mal_shadow_realm_get_own_property(
            vm, target, length_key, &has_own_length, &own_length)) {
        mal_shadow_realm_throw_boundary_type_error(
            vm, caller_realm, "ShadowRealm wrapped function length lookup failed");
        mal_gc_unroot(&root_span);
        return false;
    }

    f64 length = 0.0;
    if (has_own_length) {
        if (!target_is_proxy && !(own_length.flags & MAL_PROPERTY_ACCESSOR)) {
            roots[1] = own_length.value;
        } else if (!mal_vm_get_property(vm, target, length_key, &roots[1])) {
            mal_shadow_realm_throw_boundary_type_error(
                vm, caller_realm, "ShadowRealm wrapped function length lookup failed");
            mal_gc_unroot(&root_span);
            return false;
        }
        if (mal_ops_is_number(roots[1])) {
            f64 number = mal_ops_to_number(roots[1]);
            if (number > 0.0) {
                length = isinf(number) ? number : trunc(number);
            }
        }
    }

    MalPropertyDesc length_desc = mal_intrinsic_data_desc(
        mal_ops_number_value(length), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own((MalObject *) wrapper, length_key, &length_desc);

    bool direct_name = false;
    if (!target_is_proxy) {
        MalPropertyLookup own_name = mal_object_get_own(
            mal_value_to_object(target), name_key);
        if (own_name.present && !(own_name.desc.flags & MAL_PROPERTY_ACCESSOR)) {
            roots[2] = own_name.desc.value;
            direct_name = true;
        }
    }
    if (!direct_name && !mal_vm_get_property(vm, target, name_key, &roots[2])) {
        mal_shadow_realm_throw_boundary_type_error(
            vm, caller_realm, "ShadowRealm wrapped function name lookup failed");
        mal_gc_unroot(&root_span);
        return false;
    }

    MalValue name = mal_value_is_string(roots[2])
        ? roots[2]
        : mal_value_from_string(mal_intrinsic_ascii(vm, ""));
    MalPropertyDesc name_desc = mal_intrinsic_data_desc(name, MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(
        (MalObject *) wrapper, name_key, &name_desc);
    wrapper->name = mal_value_to_string(name);
    mal_gc_card(&wrapper->object.header, name);

    mal_gc_unroot(&root_span);
    return true;
}

static MalValue mal_shadow_realm_wrapped_call(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
);

/** GetWrappedValue(destinationRealm, value), with no wrapper identity cache. */
static bool mal_shadow_realm_wrap_value(
    MalVm *vm,
    MalRealm *destination_realm,
    MalValue value,
    MalValue *wrapped_out
) {
    MalRealm *saved_realm = vm->current_realm;

    if (!mal_value_is_object(value)) {
        *wrapped_out = value;
        return true;
    }
    if (!mal_value_is_callable(value)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ShadowRealm cannot transfer a non-callable object"
        );
        return false;
    }

    MalValue roots[2] = {value, mal_value_new_undefined()};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);

    // The wrapper belongs to destination_realm, but CopyNameAndLength remains
    // in the invoking context so observable lookup failures are caller errors.
    mal_vm_realm_switch_to(vm, destination_realm);
    MalNativeFunctionObject *wrapper = mal_native_function_object_new_with_slots(
        &vm->heap,
        mal_value_to_object(destination_realm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_hot_ascii(vm, MAL_HOT_KEY_EMPTY),
        mal_shadow_realm_wrapped_call,
        roots,
        1
    );
    roots[1] = mal_value_from_native_function_object(wrapper);
    mal_vm_realm_switch_to(vm, saved_realm);

    bool copied = mal_shadow_realm_copy_name_and_length(
        vm, saved_realm, wrapper, roots[0]);
    if (copied) {
        *wrapped_out = roots[1];
    }

    mal_gc_unroot(&root_span);
    mal_vm_realm_switch_to(vm, saved_realm);
    return copied;
}

static MalValue mal_shadow_realm_wrapped_call(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) new_target;

    MalRealm *caller_realm = vm->current_realm;
    MalValue roots[3] = {
        mal_native_function_object_get_slot(
            mal_value_to_native_function_object(callee),
            MAL_SHADOW_REALM_WRAPPER_SLOT_TARGET
        ),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 3);

    MalValue inline_args[8];
    bool heap_args = (usize) arg_count > countof(inline_args);
    MalValue *wrapped_args = heap_args
        ? malloc(sizeof(MalValue) * (usize) arg_count)
        : inline_args;
    MalRootSpan args_span;
    mal_gc_root(&args_span, wrapped_args, 0);
    mal_gc_native_rooted_begin(vm);

    MalValue result = mal_value_new_undefined();
    MalRealm *target_realm;
    if (!mal_vm_get_function_realm(vm, roots[0], &target_realm)) {
        mal_shadow_realm_throw_boundary_type_error(
            vm, caller_realm, "ShadowRealm wrapped target realm lookup failed");
        goto done;
    }

    for (i32 index = 0; index < arg_count; index++) {
        MalValue argument = args[index];
        if (!mal_value_is_object(argument)) {
            wrapped_args[index] = argument;
        } else if (!mal_shadow_realm_wrap_value(
                       vm, target_realm, argument, &wrapped_args[index])) {
            mal_shadow_realm_throw_boundary_type_error(
                vm, caller_realm, "ShadowRealm wrapped argument transfer failed");
            goto done;
        }
        args_span.count = index + 1;
    }

    if (!mal_value_is_object(this_value)) {
        roots[1] = this_value;
    } else if (!mal_shadow_realm_wrap_value(
                   vm, target_realm, this_value, &roots[1])) {
        mal_shadow_realm_throw_boundary_type_error(
            vm, caller_realm, "ShadowRealm wrapped this transfer failed");
        goto done;
    }

    {
        MalCompletion completion = mal_vm_call_value(
            vm, roots[0], roots[1], wrapped_args, arg_count);
        roots[2] = completion.value;
        if (completion.kind != MAL_COMPLETION_NORMAL) {
            mal_shadow_realm_throw_boundary_type_error(
                vm, caller_realm, "ShadowRealm wrapped function threw");
            goto done;
        }
    }

    if (!mal_value_is_object(roots[2])) {
        result = roots[2];
    } else if (!mal_shadow_realm_wrap_value(
                   vm, caller_realm, roots[2], &result)) {
        goto done;
    }

done:
    mal_vm_realm_switch_to(vm, caller_realm);
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&args_span);
    mal_gc_unroot(&root_span);
    if (heap_args) free(wrapped_args);
    return result;
}

static MalValue mal_builtin_shadow_realm_constructor(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    (void) args;
    (void) arg_count;

    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Constructor ShadowRealm requires 'new'");
        return mal_value_new_undefined();
    }

    MalValue prototype_slot_value = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee),
        MAL_SHADOW_REALM_CONSTRUCTOR_SLOT_PROTOTYPE
    );
    MalIntrinsic prototype_slot = (MalIntrinsic) mal_value_to_i32(prototype_slot_value);
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, prototype_slot, &prototype)) {
        return mal_value_new_undefined();
    }

    MalValue prototype_root = mal_value_from_object(prototype);
    MalValue instance = mal_value_from_shadow_realm_object(mal_shadow_realm_object_new(
        &vm->heap, mal_value_to_object(prototype_root), nullptr));
    MalValue roots[2] = {prototype_root, instance};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);
    mal_gc_native_rooted_begin(vm);

    MalRealm *shadow_realm = mal_realm_create(vm, nullptr, nullptr);
    MalValue result = mal_value_new_undefined();
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_value_to_shadow_realm_object(roots[1])->shadow_realm = shadow_realm;
        result = roots[1];
    }

    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue mal_builtin_shadow_realm_evaluate(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) new_target;
    (void) callee;

    if (!mal_value_is_shadow_realm_object(this_value)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ShadowRealm.prototype.evaluate called on incompatible receiver"
        );
        return mal_value_new_undefined();
    }

    MalValue source = mal_shadow_realm_arg(args, arg_count, 0);
    if (!mal_value_is_string(source)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ShadowRealm.prototype.evaluate requires a primitive string"
        );
        return mal_value_new_undefined();
    }

    MalRealm *caller_realm = vm->current_realm;
    MalRealm *target_realm = mal_value_to_shadow_realm_object(this_value)->shadow_realm;
    MalValue roots[2] = {source, mal_value_new_undefined()};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);
    mal_gc_native_rooted_begin(vm);

    MalValue result = mal_value_new_undefined();
    MalShadowRealmEvalFailure failure;
    MalCompletion completion = mal_shadow_realm_eval_script(
        vm, caller_realm, target_realm, roots[0], &failure);
    roots[1] = completion.value;
    if (completion.kind != MAL_COMPLETION_NORMAL) {
        switch (failure) {
        case MAL_SHADOW_REALM_EVAL_FAILURE_CALLER_PARSE:
        case MAL_SHADOW_REALM_EVAL_FAILURE_CALLER_POLICY:
            break;
        case MAL_SHADOW_REALM_EVAL_FAILURE_NONE:
        case MAL_SHADOW_REALM_EVAL_FAILURE_SANITIZE:
            mal_shadow_realm_throw_boundary_type_error(
                vm, caller_realm, "ShadowRealm evaluation threw");
            break;
        }
        goto done;
    }

    if (!mal_value_is_object(roots[1])) {
        result = roots[1];
    } else {
        mal_shadow_realm_wrap_value(vm, caller_realm, roots[1], &result);
    }

done:
    mal_vm_realm_switch_to(vm, caller_realm);
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue mal_builtin_shadow_realm_import_value(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
) {
    (void) new_target;
    (void) callee;

    if (!mal_value_is_shadow_realm_object(this_value)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ShadowRealm.prototype.importValue called on incompatible receiver"
        );
        return mal_value_new_undefined();
    }

    MalValue roots[2] = {
        mal_shadow_realm_arg(args, arg_count, 0),
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);
    mal_gc_native_rooted_begin(vm);

    MalString *specifier;
    if (!mal_vm_to_string(vm, roots[0], &specifier)) {
        mal_gc_native_rooted_end(vm);
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    roots[1] = mal_value_from_string(specifier);

    MalValue export_name = mal_shadow_realm_arg(args, arg_count, 1);
    if (!mal_value_is_string(export_name)) {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ShadowRealm.prototype.importValue requires a primitive string export name"
        );
    } else {
        mal_vm_throw_error(
            vm,
            MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "ShadowRealm importValue has no module loader"
        );
    }

    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&root_span);
    return mal_value_new_undefined();
}

void mal_builtin_shadow_realm_install(
    MalVm *vm,
    MalIntrinsic constructor_slot,
    MalIntrinsic prototype_slot
) {
    MalObject *prototype = mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])
    );
    MalValue constructor_slots[1] = {mal_value_from_i32((i32) prototype_slot)};
    MalNativeFunctionObject *constructor = mal_native_function_object_new_with_slots(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "ShadowRealm"),
        mal_builtin_shadow_realm_constructor,
        constructor_slots,
        1
    );
    mal_native_function_object_set_constructor(constructor);

    vm->intrinsics[constructor_slot] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[prototype_slot] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(
        vm, (MalObject *) constructor, "prototype", vm->intrinsics[prototype_slot], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(
        vm,
        prototype,
        "constructor",
        vm->intrinsics[constructor_slot],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE
    );
    mal_intrinsic_define_method_n(
        vm, prototype, "evaluate", 1, mal_builtin_shadow_realm_evaluate);
    mal_intrinsic_define_method_n(
        vm, prototype, "importValue", 2, mal_builtin_shadow_realm_import_value);

    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "ShadowRealm")),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(
        prototype,
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG),
        &tag_desc
    );
}

#endif // MAL_REALMS

#include "generated/known_native_builtin_shadow_realm_c.inc"
