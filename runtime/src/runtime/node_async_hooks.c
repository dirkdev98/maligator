#include "node_async_hooks.h"

#if MAL_NODE

#include <limits.h>
#include <math.h>
#include <string.h>

#include "async_context.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"
#include "value_ops.h"
#include "vm_ops.h"

static MalValue async_private_state(MalValue receiver, MalValue brand) {
    if (!mal_value_is_object(receiver)) {
        return mal_value_new_undefined();
    }
    MalPropertyLookup lookup = mal_object_get_own(
        mal_value_to_object(receiver),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = brand});
    return lookup.present ? lookup.desc.value : mal_value_new_undefined();
}

static void async_define_private_state(
    MalObject *object, MalValue brand, MalValue state) {
    MalPropertyDesc desc = mal_intrinsic_data_desc(state, MAL_PROPERTY_NONE);
    mal_object_define_own(
        object, (MalKey) {.kind = MAL_KEY_SYMBOL, .value = brand}, &desc);
}

static MalNativeFunctionObject *async_function_with_slots(
    MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    const MalValue *slots, i32 slot_count) {
    return mal_native_function_object_new_with_slots_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback,
        slots, slot_count);
}

static MalNativeFunctionObject *async_function_with_brand(
    MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    MalValue brand) {
    return async_function_with_slots(vm, name, length, callback, &brand, 1);
}

static i32 async_callable_length(MalVm *vm, MalValue callable) {
    MalValue length;
    if (!mal_vm_get_property(
            vm, callable, mal_intrinsic_string_key(vm, "length"), &length)) {
        return -1;
    }
    if (!mal_ops_is_number(length)) {
        return 0;
    }
    f64 number = mal_ops_number_to_integer_or_infinity(mal_ops_to_number(length));
    if (!(number > 0)) {
        return 0;
    }
    return number >= INT_MAX ? INT_MAX : (i32) number;
}

/**
 * Shared bound-context wrapper.
 *
 * slots:
 *   0 target callable
 *   1 captured MalAsyncContext (or undefined for the root context)
 *   2 AsyncResource object for the public asyncResource property, or undefined
 *   3 true when slot 4 is an explicit thisArg
 *   4 explicit thisArg
 */
static MalValue async_bound_call(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue target = mal_native_function_object_get_slot(function, 0);
    MalValue raw_context = mal_native_function_object_get_slot(function, 1);
    MalAsyncContext *context = mal_value_is_heap_type(
        raw_context, MAL_HEAP_ASYNC_CONTEXT)
        ? (MalAsyncContext *) mal_value_to_heap(raw_context)
        : nullptr;
    bool has_this = mal_value_is_boolean(
        mal_native_function_object_get_slot(function, 3))
        && mal_value_to_boolean(mal_native_function_object_get_slot(function, 3));
    MalValue this_arg = has_this
        ? mal_native_function_object_get_slot(function, 4)
        : receiver;

    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, context);
    MalCompletion completion =
        mal_vm_call_value(vm, target, this_arg, args, argc);
    mal_async_context_scope_exit(vm, &scope);
    return completion.value;
}

static MalValue async_new_bound(
    MalVm *vm, MalValue target, MalAsyncContext *context, MalValue resource,
    bool has_this, MalValue this_arg) {
    i32 length = async_callable_length(vm, target);
    if (length < 0) {
        return mal_value_new_undefined();
    }
    MalValue slots[] = {
        target,
        mal_async_internal_value((MalHeapHeader *) context),
        resource,
        mal_value_new_boolean(has_this),
        this_arg,
    };
    MalValue result = mal_value_from_native_function_object(
        async_function_with_slots(
            vm, "bound", length, async_bound_call, slots, countof(slots)));
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    if (!mal_value_is_undefined(resource)) {
        mal_intrinsic_define_data(
            vm, mal_value_to_object(result), (const byte *) "asyncResource",
            resource, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                MAL_PROPERTY_CONFIGURABLE);
    }
    mal_gc_unroot(&root);
    return result;
}

/* ------------------------------------------------------------------------- */
/* AsyncResource                                                             */
/* ------------------------------------------------------------------------- */

static MalAsyncResourceState *async_resource_require_receiver(
    MalVm *vm, MalValue receiver, MalValue callee) {
    MalValue brand = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    MalAsyncResourceState *state = mal_async_resource_state_from_value(
        async_private_state(receiver, brand));
    if (state != nullptr) {
        return state;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                       "AsyncResource method called on incompatible receiver");
    return nullptr;
}

static MalValue async_resource_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Class constructor AsyncResource cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    if (argc < 1 || !mal_value_is_string(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"type\" argument must be of type string");
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
    roots[2] = mal_async_internal_value(
        (MalHeapHeader *) mal_async_resource_state_new(vm));
    roots[3] = mal_value_from_object(
        mal_object_new(&vm->heap, mal_value_to_object(roots[0])));
    async_define_private_state(
        mal_value_to_object(roots[3]), roots[1], roots[2]);
    MalValue instance = roots[3];
    mal_gc_unroot(&root);
    return instance;
}

static MalValue async_resource_run_in_async_scope(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    MalAsyncResourceState *state =
        async_resource_require_receiver(vm, receiver, callee);
    if (state == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue callback = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"fn\" argument must be a function");
        return mal_value_new_undefined();
    }
    MalValue this_arg = argc > 1 ? args[1] : mal_value_new_undefined();
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, state->context);
    MalCompletion completion = mal_vm_call_value(
        vm, callback, this_arg, argc > 2 ? args + 2 : nullptr,
        argc > 2 ? argc - 2 : 0);
    mal_async_context_scope_exit(vm, &scope);
    return completion.value;
}

static MalValue async_resource_bind(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    MalAsyncResourceState *state =
        async_resource_require_receiver(vm, receiver, callee);
    if (state == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue callback = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"fn\" argument must be a function");
        return mal_value_new_undefined();
    }
    bool has_this = argc > 1 && !mal_value_is_undefined(args[1]);
    return async_new_bound(
        vm, callback, state->context, receiver, has_this,
        has_this ? args[1] : mal_value_new_undefined());
}

/**
 * Static AsyncResource.bind. Its slots carry [AsyncResource.prototype, brand].
 * The type is deliberately not surfaced because Maligator does not expose the
 * low-level createHook/async-id API; context capture is nevertheless complete.
 */
static MalValue async_resource_static_bind(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalValue callback = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"fn\" argument must be a function");
        return mal_value_new_undefined();
    }
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue roots[] = {
        mal_native_function_object_get_slot(function, 0),
        mal_native_function_object_get_slot(function, 1),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[2] = mal_async_internal_value(
        (MalHeapHeader *) mal_async_resource_state_new(vm));
    roots[3] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(roots[0])));
    async_define_private_state(
        mal_value_to_object(roots[3]), roots[1], roots[2]);
    MalAsyncResourceState *state =
        mal_async_resource_state_from_value(roots[2]);
    bool has_this = argc > 2 && !mal_value_is_undefined(args[2]);
    MalValue result = async_new_bound(
        vm, callback, state->context, roots[3], has_this,
        has_this ? args[2] : mal_value_new_undefined());
    mal_gc_unroot(&root);
    return result;
}

/* ------------------------------------------------------------------------- */
/* AsyncLocalStorage                                                         */
/* ------------------------------------------------------------------------- */

static MalAsyncLocalStorageState *async_local_storage_require_receiver(
    MalVm *vm, MalValue receiver, MalValue callee) {
    MalValue brand = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    MalAsyncLocalStorageState *state =
        mal_async_local_storage_state_from_value(
            async_private_state(receiver, brand));
    if (state != nullptr) {
        return state;
    }
    mal_vm_throw_error(
        vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "AsyncLocalStorage method called on incompatible receiver");
    return nullptr;
}

static MalValue async_local_storage_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Class constructor AsyncLocalStorage cannot be invoked without 'new'");
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
    roots[2] = mal_async_internal_value(
        (MalHeapHeader *) mal_async_local_storage_state_new(vm));
    roots[3] = mal_value_from_object(
        mal_object_new(&vm->heap, mal_value_to_object(roots[0])));
    async_define_private_state(
        mal_value_to_object(roots[3]), roots[1], roots[2]);
    MalValue instance = roots[3];
    mal_gc_unroot(&root);
    return instance;
}

static MalValue async_local_storage_disable(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    MalAsyncLocalStorageState *state =
        async_local_storage_require_receiver(vm, receiver, callee);
    if (state == nullptr) {
        return mal_value_new_undefined();
    }
    if (state->enabled) {
        state->enabled = false;
        state->generation++;
        if (state->generation == 0) {
            state->generation = 1;
        }
    }
    return mal_value_new_undefined();
}

static MalValue async_local_storage_get_store(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    MalAsyncLocalStorageState *state =
        async_local_storage_require_receiver(vm, receiver, callee);
    if (state == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue store;
    return mal_async_context_lookup(vm, state, &store)
        ? store
        : mal_value_new_undefined();
}

static MalValue async_local_storage_enter_with(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    MalAsyncLocalStorageState *state =
        async_local_storage_require_receiver(vm, receiver, callee);
    if (state == nullptr) {
        return mal_value_new_undefined();
    }
    state->enabled = true;
    vm->async_context = mal_async_context_push(
        vm, state, argc > 0 ? args[0] : mal_value_new_undefined(), true);
    return mal_value_new_undefined();
}

static MalValue async_local_storage_run(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    MalAsyncLocalStorageState *state =
        async_local_storage_require_receiver(vm, receiver, callee);
    if (state == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue store = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue callback = argc > 1 ? args[1] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"callback\" argument must be a function");
        return mal_value_new_undefined();
    }

    MalValue current = mal_value_new_undefined();
    (void) mal_async_context_lookup(vm, state, &current);
    if (mal_ops_same_value(store, current)) {
        return mal_vm_call_value(
            vm, callback, mal_value_new_null(),
            argc > 2 ? args + 2 : nullptr, argc > 2 ? argc - 2 : 0).value;
    }

    state->enabled = true;
    MalAsyncContext *context =
        mal_async_context_push(vm, state, store, true);
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, context);
    MalCompletion completion = mal_vm_call_value(
        vm, callback, mal_value_new_null(),
        argc > 2 ? args + 2 : nullptr, argc > 2 ? argc - 2 : 0);
    mal_async_context_scope_exit(vm, &scope);
    return completion.value;
}

static MalValue async_local_storage_exit(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    MalAsyncLocalStorageState *state =
        async_local_storage_require_receiver(vm, receiver, callee);
    if (state == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue callback = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"callback\" argument must be a function");
        return mal_value_new_undefined();
    }
    if (!state->enabled) {
        return mal_vm_call_value(
            vm, callback, mal_value_new_null(),
            argc > 1 ? args + 1 : nullptr, argc > 1 ? argc - 1 : 0).value;
    }

    MalAsyncContext *context = mal_async_context_push(
        vm, state, mal_value_new_undefined(), false);
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, context);
    MalCompletion completion = mal_vm_call_value(
        vm, callback, mal_value_new_null(),
        argc > 1 ? args + 1 : nullptr, argc > 1 ? argc - 1 : 0);
    mal_async_context_scope_exit(vm, &scope);
    return completion.value;
}

static MalValue async_local_storage_bind(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    (void) callee;
    MalValue callback = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"fn\" argument must be a function");
        return mal_value_new_undefined();
    }
    return async_new_bound(
        vm, callback, mal_async_context_capture(vm),
        mal_value_new_undefined(), false, mal_value_new_undefined());
}

/** Bound snapshot invocation: capturedContext((callback, ...args) => callback(...args)). */
static MalValue async_snapshot_call(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) new_target;
    MalValue callback = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"cb\" argument must be a function");
        return mal_value_new_undefined();
    }
    MalValue raw_context = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    MalAsyncContext *context = mal_value_is_heap_type(
        raw_context, MAL_HEAP_ASYNC_CONTEXT)
        ? (MalAsyncContext *) mal_value_to_heap(raw_context)
        : nullptr;
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, context);
    MalCompletion completion = mal_vm_call_value(
        vm, callback, mal_value_new_undefined(),
        argc > 1 ? args + 1 : nullptr, argc > 1 ? argc - 1 : 0);
    mal_async_context_scope_exit(vm, &scope);
    return completion.value;
}

static MalValue async_local_storage_snapshot(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalValue context = mal_async_internal_value(
        (MalHeapHeader *) mal_async_context_capture(vm));
    return mal_value_from_native_function_object(async_function_with_slots(
        vm, "bound", 1, async_snapshot_call, &context, 1));
}

/* ------------------------------------------------------------------------- */
/* Installer                                                                 */
/* ------------------------------------------------------------------------- */

void mal_host_install_node_async_hooks(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    enum {
        MODULE,
        RESOURCE_PROTO,
        RESOURCE_CTOR,
        STORAGE_PROTO,
        STORAGE_CTOR,
        RESOURCE_BRAND,
        STORAGE_BRAND,
        TEMP,
        ROOT_COUNT,
    };
    MalValue roots[ROOT_COUNT];
    for (i32 i = 0; i < ROOT_COUNT; i++) {
        roots[i] = mal_value_new_undefined();
    }
    MalRootSpan root;
    mal_gc_root(&root, roots, ROOT_COUNT);

    roots[RESOURCE_BRAND] =
        mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    roots[STORAGE_BRAND] =
        mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    roots[RESOURCE_PROTO] = mal_value_from_object(mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));
    roots[STORAGE_PROTO] = mal_value_from_object(mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));

    MalNativeFunctionObject *resource_constructor =
        async_function_with_brand(
            vm, "AsyncResource", 1, async_resource_constructor,
            roots[RESOURCE_BRAND]);
    mal_native_function_object_set_constructor(resource_constructor);
    roots[RESOURCE_CTOR] =
        mal_value_from_native_function_object(resource_constructor);
    mal_intrinsic_define_data(
        vm, (MalObject *) resource_constructor, (const byte *) "prototype",
        roots[RESOURCE_PROTO], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[RESOURCE_PROTO]),
        (const byte *) "constructor", roots[RESOURCE_CTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    roots[TEMP] = mal_value_from_native_function_object(
        async_function_with_brand(
            vm, "runInAsyncScope", 2, async_resource_run_in_async_scope,
            roots[RESOURCE_BRAND]));
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[RESOURCE_PROTO]),
        (const byte *) "runInAsyncScope", roots[TEMP],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    roots[TEMP] = mal_value_from_native_function_object(
        async_function_with_brand(
            vm, "bind", 1, async_resource_bind, roots[RESOURCE_BRAND]));
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[RESOURCE_PROTO]), (const byte *) "bind",
        roots[TEMP], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    MalValue static_resource_slots[] = {
        roots[RESOURCE_PROTO], roots[RESOURCE_BRAND]};
    roots[TEMP] = mal_value_from_native_function_object(
        async_function_with_slots(
            vm, "bind", 1, async_resource_static_bind,
            static_resource_slots, countof(static_resource_slots)));
    mal_intrinsic_define_data(
        vm, (MalObject *) resource_constructor, (const byte *) "bind",
        roots[TEMP], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    MalNativeFunctionObject *storage_constructor =
        async_function_with_brand(
            vm, "AsyncLocalStorage", 0, async_local_storage_constructor,
            roots[STORAGE_BRAND]);
    mal_native_function_object_set_constructor(storage_constructor);
    roots[STORAGE_CTOR] =
        mal_value_from_native_function_object(storage_constructor);
    mal_intrinsic_define_data(
        vm, (MalObject *) storage_constructor, (const byte *) "prototype",
        roots[STORAGE_PROTO], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[STORAGE_PROTO]),
        (const byte *) "constructor", roots[STORAGE_CTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    struct {
        const char *name;
        i32 length;
        MalNativeFunctionCallback callback;
    } storage_methods[] = {
        {"disable", 0, async_local_storage_disable},
        {"enterWith", 1, async_local_storage_enter_with},
        {"run", 2, async_local_storage_run},
        {"exit", 1, async_local_storage_exit},
        {"getStore", 0, async_local_storage_get_store},
    };
    for (usize i = 0; i < countof(storage_methods); i++) {
        roots[TEMP] = mal_value_from_native_function_object(
            async_function_with_brand(
                vm, storage_methods[i].name, storage_methods[i].length,
                storage_methods[i].callback, roots[STORAGE_BRAND]));
        mal_intrinsic_define_data(
            vm, mal_value_to_object(roots[STORAGE_PROTO]),
            (const byte *) storage_methods[i].name, roots[TEMP],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }

    roots[TEMP] = mal_value_from_native_function_object(
        async_function_with_slots(
            vm, "bind", 1, async_local_storage_bind, nullptr, 0));
    mal_intrinsic_define_data(
        vm, (MalObject *) storage_constructor, (const byte *) "bind",
        roots[TEMP], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    roots[TEMP] = mal_value_from_native_function_object(
        async_function_with_slots(
            vm, "snapshot", 0, async_local_storage_snapshot, nullptr, 0));
    mal_intrinsic_define_data(
        vm, (MalObject *) storage_constructor, (const byte *) "snapshot",
        roots[TEMP], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    roots[MODULE] = mal_value_from_object(mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[MODULE]), (const byte *) "AsyncResource",
        roots[RESOURCE_CTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
            MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[MODULE]),
        (const byte *) "AsyncLocalStorage", roots[STORAGE_CTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
            MAL_PROPERTY_CONFIGURABLE);

    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "AsyncResource") == 0) {
            vm->globals[slots[i].slot] = roots[RESOURCE_CTOR];
        } else if (strcmp(slots[i].name, "AsyncLocalStorage") == 0) {
            vm->globals[slots[i].slot] = roots[STORAGE_CTOR];
        } else if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = roots[MODULE];
        }
    }
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
