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
 *   2 true when slot 3 is an explicit thisArg
 *   3 explicit thisArg
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
        mal_native_function_object_get_slot(function, 2))
        && mal_value_to_boolean(mal_native_function_object_get_slot(function, 2));
    MalValue this_arg = has_this
        ? mal_native_function_object_get_slot(function, 3)
        : receiver;

    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, context);
    MalCompletion completion =
        mal_vm_call_value(vm, target, this_arg, args, argc);
    mal_async_context_scope_exit(vm, &scope);
    return completion.value;
}

static MalValue async_new_bound(
    MalVm *vm, MalValue target, MalAsyncContext *context, bool has_this,
    MalValue this_arg) {
    i32 length = async_callable_length(vm, target);
    if (length < 0) {
        return mal_value_new_undefined();
    }
    MalValue slots[] = {
        target,
        mal_async_internal_value((MalHeapHeader *) context),
        mal_value_new_boolean(has_this),
        this_arg,
    };
    return mal_value_from_native_function_object(
        async_function_with_slots(
            vm, "bound", length, async_bound_call, slots, countof(slots)));
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
        vm, callback, state->context, has_this,
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
    (void) callee;
    MalValue callback = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_callable(callback)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"fn\" argument must be a function");
        return mal_value_new_undefined();
    }
    MalValue type = argc > 1 ? args[1] : mal_value_new_undefined();
    if (mal_value_is_truthy(type) && !mal_value_is_string(type)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The \"type\" argument must be of type string");
        return mal_value_new_undefined();
    }
    bool has_this = argc > 2 && !mal_value_is_undefined(args[2]);
    return async_new_bound(
        vm, callback, mal_async_context_capture(vm), has_this,
        has_this ? args[2] : mal_value_new_undefined());
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

static MalValue async_local_storage_current_store(
    MalVm *vm, MalAsyncLocalStorageState *state) {
    MalValue store;
    return mal_async_context_lookup(vm, state, &store)
        ? store
        : state->default_value;
}

static MalValue async_local_storage_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
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
        argc > 0 ? args[0] : mal_value_new_undefined(),
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
    if (!mal_value_is_undefined(roots[4])
        && (!mal_value_is_object(roots[4])
            || mal_value_is_array_object(roots[4])
            || mal_value_is_callable(roots[4]))) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "The \"options\" argument must be of type object");
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (!mal_value_is_undefined(roots[4])) {
        if (!mal_vm_get_property(
                vm, roots[4], mal_intrinsic_string_key(vm, "defaultValue"),
                &roots[5])
            || !mal_vm_get_property(
                vm, roots[4], mal_intrinsic_string_key(vm, "name"),
                &roots[6])) {
            mal_gc_unroot(&root);
            return mal_value_new_undefined();
        }
        if (!mal_value_is_undefined(roots[6])) {
            MalString *name;
            if (!mal_vm_to_string(vm, roots[6], &name)) {
                mal_gc_unroot(&root);
                return mal_value_new_undefined();
            }
            roots[6] = mal_value_from_string(name);
        }
    }
    roots[2] = mal_async_internal_value(
        (MalHeapHeader *) mal_async_local_storage_state_new(vm));
    MalAsyncLocalStorageState *state =
        mal_async_local_storage_state_from_value(roots[2]);
    state->default_value = roots[5];
    state->name = roots[6];
    roots[3] = mal_value_from_object(
        mal_object_new(&vm->heap, mal_value_to_object(roots[0])));
    async_define_private_state(
        mal_value_to_object(roots[3]), roots[1], roots[2]);
    MalValue instance = roots[3];
    mal_gc_unroot(&root);
    return instance;
}

static MalValue async_local_storage_get_name(
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
    return mal_value_is_undefined(state->name)
        ? mal_value_from_string(mal_intrinsic_ascii(vm, ""))
        : state->name;
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
    return async_local_storage_current_store(vm, state);
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

    MalValue current = async_local_storage_current_store(vm, state);
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
    if (!state->enabled && mal_value_is_undefined(state->default_value)) {
        return mal_vm_call_value(
            vm, callback, mal_value_new_null(),
            argc > 1 ? args + 1 : nullptr, argc > 1 ? argc - 1 : 0).value;
    }

    state->enabled = true;
    MalAsyncContext *context = mal_async_context_push(
        vm, state, mal_value_new_undefined(), true);
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
        vm, callback, mal_async_context_capture(vm), false,
        mal_value_new_undefined());
}

/* ------------------------------------------------------------------------- */
/* AsyncLocalStorage RunScope                                                */
/* ------------------------------------------------------------------------- */

static MalAsyncRunScopeState *async_run_scope_require_receiver(
    MalVm *vm, MalValue receiver, MalValue callee) {
    MalValue brand = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    MalAsyncRunScopeState *state = mal_async_run_scope_state_from_value(
        async_private_state(receiver, brand));
    if (state != nullptr) {
        return state;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                       "RunScope method called on incompatible receiver");
    return nullptr;
}

static MalValue async_run_scope_new(
    MalVm *vm, MalAsyncLocalStorageState *storage, MalValue store,
    MalValue previous_store, MalValue prototype, MalValue brand) {
    MalValue roots[] = {
        store,
        previous_store,
        prototype,
        brand,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[4] = mal_async_internal_value((MalHeapHeader *)
        mal_async_run_scope_state_new(vm, storage, roots[1]));
    roots[5] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(roots[2])));
    async_define_private_state(
        mal_value_to_object(roots[5]), roots[3], roots[4]);
    storage->enabled = true;
    vm->async_context =
        mal_async_context_push(vm, storage, roots[0], true);
    MalValue result = roots[5];
    mal_gc_unroot(&root);
    return result;
}

static MalValue async_run_scope_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Class constructor RunScope cannot be invoked without 'new'");
        return mal_value_new_undefined();
    }
    MalNativeFunctionObject *function =
        mal_value_to_native_function_object(callee);
    MalValue storage_brand =
        mal_native_function_object_get_slot(function, 0);
    MalValue scope_brand =
        mal_native_function_object_get_slot(function, 1);
    MalValue storage_value =
        argc > 0 ? args[0] : mal_value_new_undefined();
    MalAsyncLocalStorageState *storage =
        mal_async_local_storage_state_from_value(
            async_private_state(storage_value, storage_brand));
    if (storage == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "RunScope storage must be an AsyncLocalStorage");
        return mal_value_new_undefined();
    }
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
        return mal_value_new_undefined();
    }
    return async_run_scope_new(
        vm, storage,
        argc > 1 ? args[1] : mal_value_new_undefined(),
        async_local_storage_current_store(vm, storage),
        mal_value_from_object(prototype), scope_brand);
}

static MalValue async_local_storage_with_scope(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    MalAsyncLocalStorageState *storage =
        async_local_storage_require_receiver(vm, receiver, callee);
    if (storage == nullptr) {
        return mal_value_new_undefined();
    }
    MalNativeFunctionObject *function =
        mal_value_to_native_function_object(callee);
    return async_run_scope_new(
        vm, storage,
        argc > 0 ? args[0] : mal_value_new_undefined(),
        async_local_storage_current_store(vm, storage),
        mal_native_function_object_get_slot(function, 1),
        mal_native_function_object_get_slot(function, 2));
}

static MalValue async_run_scope_dispose(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    MalAsyncRunScopeState *state =
        async_run_scope_require_receiver(vm, receiver, callee);
    if (state == nullptr || state->disposed) {
        return mal_value_new_undefined();
    }
    state->disposed = true;
    state->storage->enabled = true;
    vm->async_context = mal_async_context_push(
        vm, state->storage, state->previous_store, true);
    return mal_value_new_undefined();
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
        SCOPE_PROTO,
        SCOPE_CTOR,
        RESOURCE_BRAND,
        STORAGE_BRAND,
        SCOPE_BRAND,
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
    roots[SCOPE_BRAND] =
        mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    roots[RESOURCE_PROTO] = mal_value_from_object(mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));
    roots[STORAGE_PROTO] = mal_value_from_object(mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));
    roots[SCOPE_PROTO] = mal_value_from_object(mal_object_new(
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

    roots[TEMP] = mal_value_from_native_function_object(
        async_function_with_slots(
            vm, "bind", 1, async_resource_static_bind, nullptr, 0));
    mal_intrinsic_define_data(
        vm, (MalObject *) resource_constructor, (const byte *) "bind",
        roots[TEMP], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    MalValue scope_constructor_slots[] = {
        roots[STORAGE_BRAND], roots[SCOPE_BRAND]};
    MalNativeFunctionObject *scope_constructor =
        async_function_with_slots(
            vm, "RunScope", 2, async_run_scope_constructor,
            scope_constructor_slots, countof(scope_constructor_slots));
    mal_native_function_object_set_constructor(scope_constructor);
    roots[SCOPE_CTOR] =
        mal_value_from_native_function_object(scope_constructor);
    mal_intrinsic_define_data(
        vm, (MalObject *) scope_constructor, (const byte *) "prototype",
        roots[SCOPE_PROTO], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[SCOPE_PROTO]),
        (const byte *) "constructor", roots[SCOPE_CTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    roots[TEMP] = mal_value_from_native_function_object(
        async_function_with_brand(
            vm, "dispose", 0, async_run_scope_dispose,
            roots[SCOPE_BRAND]));
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[SCOPE_PROTO]), (const byte *) "dispose",
        roots[TEMP], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    roots[TEMP] = mal_value_from_native_function_object(
        async_function_with_brand(
            vm, "[Symbol.dispose]", 0, async_run_scope_dispose,
            roots[SCOPE_BRAND]));
    MalPropertyDesc symbol_dispose_desc = mal_intrinsic_data_desc(
        roots[TEMP], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(
        mal_value_to_object(roots[SCOPE_PROTO]),
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_DISPOSE),
        &symbol_dispose_desc);

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

    roots[TEMP] = mal_value_from_native_function_object(
        async_function_with_brand(
            vm, "get name", 0, async_local_storage_get_name,
            roots[STORAGE_BRAND]));
    MalPropertyDesc name_desc = mal_intrinsic_accessor_desc(
        roots[TEMP], mal_value_new_undefined(), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(
        mal_value_to_object(roots[STORAGE_PROTO]),
        mal_intrinsic_string_key(vm, "name"), &name_desc);

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

    MalValue with_scope_slots[] = {
        roots[STORAGE_BRAND], roots[SCOPE_PROTO], roots[SCOPE_BRAND]};
    roots[TEMP] = mal_value_from_native_function_object(
        async_function_with_slots(
            vm, "withScope", 1, async_local_storage_with_scope,
            with_scope_slots, countof(with_scope_slots)));
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[STORAGE_PROTO]),
        (const byte *) "withScope", roots[TEMP],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

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
