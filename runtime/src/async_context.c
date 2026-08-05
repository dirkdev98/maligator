#include "async_context.h"

#include <limits.h>

#include "function_object.h"
#include "intrinsics.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

MalAsyncLocalStorageState *mal_async_local_storage_state_new(MalVm *vm) {
    MalAsyncLocalStorageState *state = mal_heap_alloc(
        &vm->heap, sizeof(MalAsyncLocalStorageState),
        MAL_HEAP_ASYNC_LOCAL_STORAGE_STATE);
    state->generation = 0;
    state->default_value = mal_value_new_undefined();
    state->name = mal_value_new_undefined();
    state->enabled = false;
    return state;
}

MalAsyncResourceState *mal_async_resource_state_new(MalVm *vm) {
    MalAsyncResourceState *state = mal_heap_alloc(
        &vm->heap, sizeof(MalAsyncResourceState), MAL_HEAP_ASYNC_RESOURCE_STATE);
#if MAL_NODE
    state->context = vm->async_context;
#else
    state->context = nullptr;
#endif
    return state;
}

MalAsyncRunScopeState *mal_async_run_scope_state_new(
    MalVm *vm,
    MalAsyncLocalStorageState *storage,
    MalValue previous_store
) {
    MalAsyncRunScopeState *state = mal_heap_alloc(
        &vm->heap, sizeof(MalAsyncRunScopeState),
        MAL_HEAP_ASYNC_RUN_SCOPE_STATE);
    state->storage = storage;
    state->previous_store = previous_store;
    state->disposed = false;
    return state;
}

MalValue mal_async_internal_value(MalHeapHeader *cell) {
    return cell == nullptr ? mal_value_new_undefined() : mal_value_from_heap(cell);
}

MalAsyncLocalStorageState *mal_async_local_storage_state_from_value(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_ASYNC_LOCAL_STORAGE_STATE)
        ? (MalAsyncLocalStorageState *) mal_value_to_heap(value)
        : nullptr;
}

MalAsyncResourceState *mal_async_resource_state_from_value(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_ASYNC_RESOURCE_STATE)
        ? (MalAsyncResourceState *) mal_value_to_heap(value)
        : nullptr;
}

MalAsyncRunScopeState *mal_async_run_scope_state_from_value(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_ASYNC_RUN_SCOPE_STATE)
        ? (MalAsyncRunScopeState *) mal_value_to_heap(value)
        : nullptr;
}

MalAsyncContext *mal_async_context_capture(const MalVm *vm) {
#if MAL_NODE
    return vm->async_context;
#else
    (void) vm;
    return nullptr;
#endif
}

MalAsyncContext *mal_async_context_push(
    MalVm *vm,
    MalAsyncLocalStorageState *storage,
    MalValue store,
    bool has_store
) {
#if MAL_NODE
    MalAsyncContext *context = mal_heap_alloc(
        &vm->heap, sizeof(MalAsyncContext), MAL_HEAP_ASYNC_CONTEXT);
    context->parent = vm->async_context;
    context->storage = storage;
    context->store = store;
    context->generation = storage->generation;
    context->has_store = has_store;
    return context;
#else
    (void) vm;
    (void) storage;
    (void) store;
    (void) has_store;
    return nullptr;
#endif
}

bool mal_async_context_lookup(
    const MalVm *vm,
    const MalAsyncLocalStorageState *storage,
    MalValue *store
) {
#if MAL_NODE
    if (!storage->enabled) {
        return false;
    }
    for (MalAsyncContext *context = vm->async_context;
         context != nullptr; context = context->parent) {
        if (context->storage != storage) {
            continue;
        }
        if (context->generation != storage->generation || !context->has_store) {
            return false;
        }
        *store = context->store;
        return true;
    }
#else
    (void) vm;
    (void) storage;
    (void) store;
#endif
    return false;
}

void mal_async_context_scope_enter(
    MalVm *vm, MalAsyncContextScope *scope, MalAsyncContext *context) {
#if MAL_NODE
    scope->previous = vm->async_context;
    scope->roots[0] = mal_async_internal_value((MalHeapHeader *) scope->previous);
    scope->roots[1] = mal_async_internal_value((MalHeapHeader *) context);
    mal_gc_root(&scope->root, scope->roots, countof(scope->roots));
    vm->async_context = context;
#else
    (void) vm;
    (void) scope;
    (void) context;
#endif
}

void mal_async_context_scope_exit(MalVm *vm, MalAsyncContextScope *scope) {
#if MAL_NODE
    vm->async_context = scope->previous;
    mal_gc_unroot(&scope->root);
#else
    (void) vm;
    (void) scope;
#endif
}

#if MAL_NODE
static MalValue mal_async_bound_callback_call(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) new_target;
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    MalValue callback = mal_native_function_object_get_slot(function, 0);
    MalValue raw_context = mal_native_function_object_get_slot(function, 1);
    MalAsyncContext *context = mal_value_is_heap_type(
        raw_context, MAL_HEAP_ASYNC_CONTEXT)
        ? (MalAsyncContext *) mal_value_to_heap(raw_context)
        : nullptr;
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, context);
    MalCompletion completion =
        mal_vm_call_value(vm, callback, receiver, args, argc);
    mal_async_context_scope_exit(vm, &scope);
    return completion.value;
}
#endif

MalValue mal_async_context_bind_callback(
    MalVm *vm, MalValue callback, MalAsyncContext *context) {
#if MAL_NODE
    i32 length = 0;
    MalValue raw_length;
    if (!mal_vm_get_property(
            vm, callback, mal_intrinsic_string_key(vm, "length"), &raw_length)) {
        return mal_value_new_undefined();
    }
    if (mal_ops_is_number(raw_length)) {
        f64 number =
            mal_ops_number_to_integer_or_infinity(mal_ops_to_number(raw_length));
        if (number > 0) {
            length = number >= INT_MAX ? INT_MAX : (i32) number;
        }
    }
    MalValue slots[] = {
        callback, mal_async_internal_value((MalHeapHeader *) context)};
    return mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots_arity(
            &vm->heap,
            mal_value_to_object(
                vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, "bound"), length,
            mal_async_bound_callback_call, slots, countof(slots)));
#else
    (void) vm;
    (void) context;
    return callback;
#endif
}
