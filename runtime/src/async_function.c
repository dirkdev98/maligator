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

MalGeneratorObject *mal_async_function_state_new(MalVm *vm) {
    if (vm->async_function_state_pool_count == 0) {
        return mal_generator_object_new_async(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]),
            false);
    }
    u32 index = --vm->async_function_state_pool_count;
    MalGeneratorObject *state = vm->async_function_state_pool[index];
    vm->async_function_state_pool[index] = nullptr;
#if MAL_REALMS
    mal_object_set_prototype(
        &state->object,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
#endif
    return state;
}

static void mal_async_function_release_completed(MalVm *vm, MalGeneratorObject *state) {
    MalPromiseObject *promise = mal_value_to_promise_object(state->async_data->promise);
    // A completed body contributes no future async stack. Detach every backend's
    // owner before recycling so an await on its result cannot link to a reused state.
    mal_gc_write_barrier(mal_value_from_object((MalObject *) state));
    promise->async_owner = nullptr;
    mal_gc_write_barrier(state->async_data->promise);
    state->async_data->promise = MAL_VALUE_UNDEFINED;
    if (state->async_data->awaited_by != nullptr) {
        mal_gc_write_barrier(mal_value_from_object(
            (MalObject *) state->async_data->awaited_by));
        state->async_data->awaited_by = nullptr;
    }
    // Both backends released their live frame before settlement. The interpreter's
    // saved snapshot can still name those buffers, so clear it without freeing again.
    state->frame = (MalVmFrame) {0};
    state->async_data->registers[0] = MAL_VALUE_UNDEFINED;
    state->async_data->registers[1] = MAL_VALUE_UNDEFINED;
    mal_generator_note_released_storage(state);
    if (vm->async_function_state_pool_count < MAL_ASYNC_FUNCTION_STATE_POOL_LIMIT) {
        vm->async_function_state_pool[vm->async_function_state_pool_count++] = state;
    }
}

void mal_async_function_start(MalVm *vm, MalVmFrame *frame) {
    MalPromiseObject *promise = mal_promise_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
    MalValue promise_value = mal_value_from_promise_object(promise);
    MalRootSpan promise_root;
    mal_gc_root(&promise_root, &promise_value, 1);

    MalGeneratorObject *state = mal_async_function_state_new(vm);
    state->async_data->promise = promise_value;
    mal_gc_remember_if_old(&state->object.header);
    state->state = MAL_GENERATOR_EXECUTING;
    frame->generator = state;

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

void mal_async_function_await(MalVm *vm, MalGeneratorObject *state, MalValue awaited) {
    // PromiseResolve(%Promise%, primitive) creates a fulfilled Promise whose
    // identity cannot escape Await. Preserve the mandatory asynchronous turn
    // by queueing the already-typed continuation directly.
    if (!mal_value_is_object(awaited)) {
        MAL_PERF_COUNT(promise_await_typed_continuations);
        mal_vm_enqueue_await_job(
            vm,
            mal_value_from_object((MalObject *) state),
            false,
            awaited);
        return;
    }

    MalValue promise;
    if (!mal_promise_resolve_value(vm, awaited, &promise)) {
        // PromiseResolve threw; deliver it to the body as a throw resumption.
        MalValue error = vm->completion.value;
        vm->completion = mal_async_normal();
        mal_vm_resume_generator(vm, state, error, MAL_GENERATOR_RESUME_THROW);
        return;
    }

    // Async stack stitching: if we are awaiting another async function's result
    // promise, record this state as that function's awaiter, so a capture taken
    // while it runs can splice in our frame (and our awaiters) as the async
    // ancestors. Only native promises with a known async owner stitch; arbitrary
    // thenables do not.
    if (mal_value_is_promise_object(promise)) {
        MalGeneratorObject *owner = mal_value_to_promise_object(promise)->async_owner;
        if (owner != nullptr) {
            // SATB: awaited_by is a traced edge (gc.c shades it); a second awaiter of
            // the same result promise overwrites it, so shade the previous awaiter.
            if (owner->async_data->awaited_by != nullptr) {
                mal_gc_write_barrier(mal_value_from_object(
                    (MalObject *) owner->async_data->awaited_by));
            }
            owner->async_data->awaited_by = state;
            // An old awaitee gaining a young awaiter: remember it (trace shades
            // awaited_by) so the minor keeps the awaiter's async chain alive.
            mal_gc_remember_if_old(&owner->object.header);
        }
    }

    mal_promise_perform_await(vm, promise, state);
}

void mal_async_function_settle_return(MalVm *vm, MalGeneratorObject *state, MalValue value) {
    mal_promise_settle_direct(
        vm,
        state->async_data->promise,
        vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR],
        false,
        value);
    mal_async_function_release_completed(vm, state);
    vm->completion = mal_async_normal();
}

void mal_async_function_settle_throw(MalVm *vm, MalGeneratorObject *state, MalValue reason) {
    mal_promise_settle_direct(
        vm,
        state->async_data->promise,
        vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR],
        true,
        reason);
    mal_async_function_release_completed(vm, state);
    vm->completion = mal_async_normal();
}
