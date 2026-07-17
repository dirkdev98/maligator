#include "node_async_hooks.h"

#if MAL_NODE

#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"
#include "vm_ops.h"

static MalValue async_resource_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Class constructor AsyncResource cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {
        mal_value_new_undefined(),
        mal_native_function_object_get_slot(
            mal_value_to_native_function_object(callee), 0),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    roots[0] = mal_value_from_object(prototype);
    if (argc < 1 || !mal_value_is_string(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"type\" argument must be of type string");
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }

    roots[2] = mal_value_from_object(
        mal_object_new(&vm->heap, mal_value_to_object(roots[0])));
    MalPropertyDesc brand_desc =
        mal_intrinsic_data_desc(mal_value_new_boolean(true), MAL_PROPERTY_NONE);
    mal_object_define_own(
        mal_value_to_object(roots[2]),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = roots[1]}, &brand_desc);
    MalValue instance = roots[2];
    mal_gc_unroot(&root);
    return instance;
}

static bool async_resource_require_receiver(
    MalVm *vm, MalValue receiver, MalValue callee) {
    if (mal_value_is_object(receiver)) {
        MalValue brand = mal_native_function_object_get_slot(
            mal_value_to_native_function_object(callee), 0);
        MalPropertyLookup lookup = mal_object_get_own(
            mal_value_to_object(receiver),
            (MalKey) {.kind = MAL_KEY_SYMBOL, .value = brand});
        if (lookup.present && mal_value_is_boolean(lookup.desc.value)
            && mal_value_to_boolean(lookup.desc.value)) {
            return true;
        }
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                       "AsyncResource method called on incompatible receiver");
    return false;
}

static MalValue async_resource_run_in_async_scope(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    if (!async_resource_require_receiver(vm, receiver, callee)) {
        return mal_value_new_undefined();
    }

    MalValue callback = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"fn\" argument must be a function");
        return mal_value_new_undefined();
    }
    /* Maligator has no async-context substrate yet. This curated slice only
     * preserves Node's synchronous invocation contract; it invents no IDs or
     * context transitions around the call. */
    MalValue this_arg = argc > 1 ? args[1] : mal_value_new_undefined();
    return mal_vm_call_value(vm, callback, this_arg,
                             argc > 2 ? args + 2 : nullptr,
                             argc > 2 ? argc - 2 : 0).value;
}

static MalNativeFunctionObject *async_resource_function_with_brand(
    MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    MalValue brand) {
    MalNativeFunctionObject *function = mal_native_function_object_new_with_slots(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), callback, &brand, 1);
    MalValue function_value = mal_value_from_native_function_object(function);
    MalRootSpan root;
    mal_gc_root(&root, &function_value, 1);
    function->length = length;
    mal_intrinsic_define_data(vm, (MalObject *) function, (const byte *) "length",
                              mal_value_from_i32(length), MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
    return function;
}

void mal_host_install_node_async_hooks(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue roots[] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));

    roots[3] = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    roots[0] = mal_value_from_object(mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));

    MalNativeFunctionObject *constructor = async_resource_function_with_brand(
        vm, "AsyncResource", 1, async_resource_constructor, roots[3]);
    mal_native_function_object_set_constructor(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor,
                              (const byte *) "prototype", roots[0], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
                              (const byte *) "constructor", roots[1],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    roots[2] = mal_value_from_native_function_object(
        async_resource_function_with_brand(vm, "runInAsyncScope", 2,
            async_resource_run_in_async_scope, roots[3]));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
                              (const byte *) "runInAsyncScope", roots[2],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    roots[0] = mal_value_from_object(mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
                              (const byte *) "AsyncResource", roots[1],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                                  MAL_PROPERTY_CONFIGURABLE);

    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "AsyncResource") == 0) {
            vm->globals[slots[i].slot] = roots[1];
        } else if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = roots[0];
        }
    }
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
