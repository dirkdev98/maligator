#include "async_function.h"

#include "builtin_promise.h"
#include "gc.h"
#include "generator_object.h"
#include "microtask.h"
#include "perf_stats.h"
#include "promise_object.h"
#include "vm.h"

static MalCompletion mal_async_normal(void) {
    return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

MalAsyncFunctionState *mal_async_function_state_new(MalVm *vm) {
    if (vm->async_function_state_pool_count == 0) {
        MalAsyncFunctionState *state = mal_heap_alloc_uninitialized(
            &vm->heap, sizeof(MalAsyncFunctionState), MAL_HEAP_ASYNC_FUNCTION_STATE);
        // The collector may see a never-suspended activation during its first call.
        state->activation = (MalCoroutineActivation) {
            .frame = {
                .this_value = MAL_VALUE_UNDEFINED,
                .arguments_object = MAL_VALUE_UNDEFINED,
                .callee = MAL_VALUE_UNDEFINED,
                .new_target = MAL_VALUE_UNDEFINED,
            },
            .promise = MAL_VALUE_UNDEFINED,
            .awaited_by = nullptr,
            .resume_value_register = -1,
            .resume_mode_register = -1,
            .state = MAL_GENERATOR_SUSPENDED_START,
        };
        state->registers[0] = MAL_VALUE_UNDEFINED;
        state->registers[1] = MAL_VALUE_UNDEFINED;
        return state;
    }
    u32 index = --vm->async_function_state_pool_count;
    MalAsyncFunctionState *state = vm->async_function_state_pool[index];
    vm->async_function_state_pool[index] = nullptr;
    return state;
}

void mal_async_function_release_frame(MalVm *vm, MalAsyncFunctionState *state) {
    MalVmFrame *frame = &state->activation.frame;
    if (mal_gc_marking_active && frame->function != nullptr) {
        frame->function = &vm->live_runtime_image.functions[frame->function_index];
        mal_gc_satb_shade_frame(frame);
    }
    if (frame->registers != state->registers) {
        mal_vm_release_shaded_coroutine_buffer(vm, frame->registers);
    }
    mal_vm_release_shaded_coroutine_buffer(vm, frame->arguments);
    frame->registers = nullptr;
    frame->arguments = nullptr;
    frame->argument_count = 0;
}

static void mal_async_function_release_completed(MalVm *vm, MalAsyncFunctionState *state) {
    MalPromiseObject *promise = mal_value_to_promise_object(state->activation.promise);
    // A completed body contributes no future async stack. Detach every backend's
    // owner before recycling so an await on its result cannot link to a reused state.
    mal_gc_write_barrier(mal_value_from_heap(&state->header));
    promise->async_owner = nullptr;
    mal_gc_write_barrier(state->activation.promise);
    state->activation.promise = MAL_VALUE_UNDEFINED;
    if (state->activation.awaited_by != nullptr) {
        mal_gc_write_barrier(mal_value_from_heap(state->activation.awaited_by));
        state->activation.awaited_by = nullptr;
    }
    // Both backends released their live frame before settlement. The interpreter's
    // saved snapshot can still name those buffers, so clear it without freeing again.
    state->activation.frame = (MalVmFrame) {0};
    state->registers[0] = MAL_VALUE_UNDEFINED;
    state->registers[1] = MAL_VALUE_UNDEFINED;
    mal_heap_cell_owns_nothing(&state->header);
    if (vm->async_function_state_pool_count < MAL_ASYNC_FUNCTION_STATE_POOL_LIMIT) {
        vm->async_function_state_pool[vm->async_function_state_pool_count++] = state;
    }
}

void mal_async_function_start(MalVm *vm, MalVmFrame *frame) {
    MalPromiseObject *promise = mal_promise_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
    MalValue promise_value = mal_value_from_promise_object(promise);
    MalRootSpan promise_root;
    mal_gc_root(&promise_root, &promise_value, 1);

    MalAsyncFunctionState *state = mal_async_function_state_new(vm);
    state->activation.promise = promise_value;
    mal_gc_remember_if_old(&state->header);
    state->activation.state = MAL_GENERATOR_EXECUTING;
    frame->async_function = state;

    // Link the result promise back to this async state so an awaiting function
    // can record itself as our `awaited_by` (async stack stitching).
    promise = mal_value_to_promise_object(promise_value);
    promise->async_owner = state;
    mal_gc_remember_if_old(&promise->object.header);
    mal_promise_note_direct_async_result();

    // Hand the result promise to the caller now (the body keeps running in this
    // frame until its first await/return/throw). Clearing the caller link makes
    // RETURN and an uncaught throw settle the promise instead of writing a
    // caller register.
    if (frame->caller_frame_index < 0) {
        // No caller: this is the program entry (a top-level-await module). Record
        // its result promise so the run can detect a rejected module evaluation.
        vm->entry_async_promise = promise_value;
    } else if (frame->return_register >= 0) {
        vm->frames[frame->caller_frame_index].registers[frame->return_register] = promise_value;
    }
    frame->return_register = -1;
    frame->caller_frame_index = -1;
    mal_gc_unroot(&promise_root);
}

void mal_async_function_await(MalVm *vm, MalHeapHeader *state, MalValue awaited) {
    // PromiseResolve(%Promise%, primitive) creates a fulfilled Promise whose
    // identity cannot escape Await. Preserve the mandatory asynchronous turn
    // by queueing the already-typed continuation directly.
    if (!mal_value_is_object(awaited)) {
        MAL_PERF_COUNT(promise_await_typed_continuations);
        mal_vm_enqueue_await_job(
            vm,
            mal_value_from_heap(state),
            false,
            awaited);
        return;
    }

    MalValue promise;
    if (!mal_promise_resolve_value(vm, awaited, &promise)) {
        // PromiseResolve threw; deliver it to the body as a throw resumption.
        MalValue error = vm->completion.value;
        vm->completion = mal_async_normal();
        mal_vm_resume_coroutine(vm, state, error, MAL_GENERATOR_RESUME_THROW);
        return;
    }

    // Async stack stitching: if we are awaiting another async function's result
    // promise, record this state as that function's awaiter, so a capture taken
    // while it runs can splice in our frame (and our awaiters) as the async
    // ancestors. Only native promises with a known async owner stitch; arbitrary
    // thenables do not.
    if (mal_value_is_promise_object(promise)) {
        MalAsyncFunctionState *owner = mal_value_to_promise_object(promise)->async_owner;
        if (owner != nullptr) {
            // SATB: awaited_by is a traced edge (gc.c shades it); a second awaiter of
            // the same result promise overwrites it, so shade the previous awaiter.
            if (owner->activation.awaited_by != nullptr) {
                mal_gc_write_barrier(mal_value_from_heap(owner->activation.awaited_by));
            }
            owner->activation.awaited_by = state;
            // An old awaitee gaining a young awaiter: remember it (trace shades
            // awaited_by) so the minor keeps the awaiter's async chain alive.
            mal_gc_remember_if_old(&owner->header);
        }
    }

    mal_promise_perform_await(vm, promise, state);
}

void mal_async_function_settle_return(MalVm *vm, MalAsyncFunctionState *state, MalValue value) {
    mal_promise_settle_direct(
        vm,
        state->activation.promise,
        vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR],
        false,
        value);
    mal_async_function_release_completed(vm, state);
    vm->completion = mal_async_normal();
}

void mal_async_function_settle_throw(MalVm *vm, MalAsyncFunctionState *state, MalValue reason) {
    mal_promise_settle_direct(
        vm,
        state->activation.promise,
        vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR],
        true,
        reason);
    mal_async_function_release_completed(vm, state);
    vm->completion = mal_async_normal();
}
