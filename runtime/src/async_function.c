#include "async_function.h"

#include "builtin_promise.h"
#include "function_object.h"
#include "generator_object.h"
#include "intrinsics.h"
#include "promise_object.h"
#include "vm.h"

// Resume-closure internal slot: the hidden async state to resume.
enum {
    MAL_ASYNC_RESUME_SLOT_STATE = 0,
};

static MalCompletion mal_async_normal(void) {
    return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

static MalGeneratorObject *mal_async_state_from_callee(MalValue callee) {
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue state = mal_native_function_object_get_slot(self, MAL_ASYNC_RESUME_SLOT_STATE);
    return (MalGeneratorObject *) mal_value_to_heap(state);
}

static MalValue mal_async_on_fulfilled(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    mal_vm_resume_generator(vm, mal_async_state_from_callee(callee), arg_count >= 1 ? args[0] : mal_value_new_undefined(), MAL_GENERATOR_RESUME_NEXT);
    return mal_value_new_undefined();
}

static MalValue mal_async_on_rejected(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    mal_vm_resume_generator(vm, mal_async_state_from_callee(callee), arg_count >= 1 ? args[0] : mal_value_new_undefined(), MAL_GENERATOR_RESUME_THROW);
    return mal_value_new_undefined();
}

void mal_async_function_start(MalVm *vm, MalVmFrame *frame) {
    MalPromiseObject *promise = mal_promise_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_PROMISE_PROTOTYPE]));
    MalValue promise_value = mal_value_from_promise_object(promise);

    MalValue resolve;
    MalValue reject;
    mal_promise_create_resolving(vm, promise_value, &resolve, &reject);

    // The hidden async state reuses the generator suspendable-frame object.
    MalGeneratorObject *state = mal_generator_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    state->is_async = true;
    state->async_resolve = resolve;
    state->async_reject = reject;
    state->state = MAL_GENERATOR_EXECUTING;
    frame->generator = state;

    // Hand the result promise to the caller now (the body keeps running in this
    // frame until its first await/return/throw). Clearing the caller link makes
    // RETURN and an uncaught throw settle the promise instead of writing a
    // caller register.
    if (frame->caller_frame_index >= 0 && frame->return_register >= 0) {
        vm->frames[frame->caller_frame_index].registers[frame->return_register] = promise_value;
    }
    frame->return_register = -1;
    frame->caller_frame_index = -1;
}

void mal_async_function_await(MalVm *vm, MalGeneratorObject *state, MalValue awaited) {
    MalValue promise;
    if (!mal_promise_resolve_value(vm, awaited, &promise)) {
        // PromiseResolve threw; deliver it to the body as a throw resumption.
        MalValue error = vm->completion.value;
        vm->completion = mal_async_normal();
        mal_vm_resume_generator(vm, state, error, MAL_GENERATOR_RESUME_THROW);
        return;
    }

    MalValue state_value = mal_value_from_object((MalObject *) state);
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalValue on_fulfilled = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(&vm->heap, function_prototype, nullptr, mal_async_on_fulfilled, &state_value, 1));
    MalValue on_rejected = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(&vm->heap, function_prototype, nullptr, mal_async_on_rejected, &state_value, 1));

    // No result capability: the reactions resume the function themselves.
    mal_promise_perform_then(vm, promise, on_fulfilled, on_rejected, mal_value_new_undefined(), mal_value_new_undefined());
}

void mal_async_function_settle_return(MalVm *vm, MalGeneratorObject *state, MalValue value) {
    mal_vm_call_value(vm, state->async_resolve, mal_value_new_undefined(), &value, 1);
    vm->completion = mal_async_normal();
}

void mal_async_function_settle_throw(MalVm *vm, MalGeneratorObject *state, MalValue reason) {
    mal_vm_call_value(vm, state->async_reject, mal_value_new_undefined(), &reason, 1);
    vm->completion = mal_async_normal();
}
