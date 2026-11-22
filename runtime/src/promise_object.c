#include "promise_object.h"

#include "async_context.h"
#include "gc.h"
#include "microtask.h"
#include "vm.h"

MalPromiseCombinatorState *mal_promise_combinator_state_new(
    MalVm *vm, MalValue promise, MalValue values, u32 count, MalPromiseCombinatorKind kind
) {
    MalPromiseCombinatorState *state = mal_heap_alloc(
        &vm->heap, sizeof(MalPromiseCombinatorState), MAL_HEAP_PROMISE_COMBINATOR_STATE);
    state->promise = promise;
    state->values = values;
    state->remaining = count;
    state->settled = false;
    state->kind = (u8) kind;
    return state;
}

MalPromiseObject *mal_promise_object_new(MalHeap *heap, MalObject *prototype) {
    MalPromiseObject *promise = mal_heap_alloc(heap, sizeof(MalPromiseObject), MAL_HEAP_PROMISE_OBJECT);
    mal_object_init_deferred(heap, &promise->object, prototype);
    promise->state = MAL_PROMISE_PENDING;
    promise->is_handled = false;
    promise->result = mal_value_new_undefined();
    promise->reactions_head = nullptr;
    promise->reactions_tail = nullptr;
    promise->async_owner = nullptr;

    return promise;
}

static void mal_promise_append_job(MalPromiseObject *promise, MalJob *job) {
    if (promise->reactions_tail == nullptr) {
        mal_heap_cell_needs_finalizer(&promise->object.header);
        promise->reactions_head = job;
    } else {
        promise->reactions_tail->next = job;
    }
    promise->reactions_tail = job;
    mal_gc_card(&promise->object.header, job->as.reaction.handler);
    mal_gc_card(&promise->object.header, job->as.reaction.cap_resolve);
    mal_gc_card(&promise->object.header, job->as.reaction.cap_reject);
    mal_gc_card(&promise->object.header, job->as.reaction.argument);
    MalAsyncContext *async_context = mal_job_async_context(job);
    if (async_context != nullptr) {
        mal_gc_card(&promise->object.header, mal_value_from_heap(&async_context->header));
    }
}

static MalJob *mal_promise_new_reaction(
    MalVm *vm, MalJobKind kind, MalValue handler, MalValue cap_resolve,
    MalValue cap_reject, MalValue on_rejected
) {
    MalJob *job = mal_vm_new_pending_job(vm, kind);
    job->as.reaction.handler = handler;
    job->as.reaction.cap_resolve = cap_resolve;
    job->as.reaction.cap_reject = cap_reject;
    job->as.reaction.argument = on_rejected;
    return job;
}

void mal_promise_append_reaction(
    MalVm *vm, MalPromiseObject *promise, MalValue on_fulfilled,
    MalValue on_rejected, MalValue cap_resolve, MalValue cap_reject
) {
    mal_promise_append_job(promise, mal_promise_new_reaction(
        vm, MAL_JOB_PROMISE_REACTION, on_fulfilled, cap_resolve, cap_reject, on_rejected));
}

void mal_promise_append_await_reaction(MalVm *vm, MalPromiseObject *promise, MalValue state) {
    mal_promise_append_job(promise, mal_promise_new_reaction(
        vm, MAL_JOB_ASYNC_AWAIT, state, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED));
}

void mal_promise_append_combinator_reaction(
    MalVm *vm, MalPromiseObject *promise, MalValue state, u32 index, MalValue realm_anchor
) {
    mal_promise_append_job(promise, mal_promise_new_reaction(
        vm, MAL_JOB_PROMISE_COMBINATOR, state, mal_value_from_u32(index),
        realm_anchor, MAL_VALUE_UNDEFINED));
}

void mal_promise_append_async_generator_return_reaction(
    MalVm *vm, MalPromiseObject *promise, MalValue generator, MalValue realm_anchor
) {
    mal_promise_append_job(promise, mal_promise_new_reaction(
        vm, MAL_JOB_ASYNC_GENERATOR_RETURN, generator, realm_anchor,
        MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED));
}

void mal_promise_append_async_from_sync_reaction(
    MalVm *vm, MalPromiseObject *promise, MalValue sync_iterator,
    MalValue result_promise, MalValue realm_anchor, bool done, bool close_on_rejection
) {
    MalJob *job = mal_promise_new_reaction(
        vm, MAL_JOB_ASYNC_FROM_SYNC, sync_iterator, result_promise, realm_anchor,
        MAL_VALUE_UNDEFINED);
    job->iterator_done = done;
    job->close_on_rejection = close_on_rejection;
    mal_promise_append_job(promise, job);
}

void mal_promise_append_dispose_resources_reaction(
    MalVm *vm, MalPromiseObject *promise, MalValue stack,
    MalValue result_promise, MalValue realm_anchor
) {
    mal_promise_append_job(promise, mal_promise_new_reaction(
        vm, MAL_JOB_DISPOSE_RESOURCES, stack, result_promise, realm_anchor,
        MAL_VALUE_UNDEFINED));
}

static void mal_promise_barrier_reactions(MalJob *job) {
    if (!mal_gc_marking_active) {
        return;
    }
    for (; job != nullptr; job = job->next) {
        mal_gc_write_barrier(job->as.reaction.handler);
        mal_gc_write_barrier(job->as.reaction.cap_resolve);
        mal_gc_write_barrier(job->as.reaction.cap_reject);
        mal_gc_write_barrier(job->as.reaction.argument);
        MalAsyncContext *async_context = mal_job_async_context(job);
        if (async_context != nullptr) {
            mal_gc_write_barrier(mal_value_from_heap(&async_context->header));
        }
    }
}

static void mal_promise_trigger_reactions(
    MalVm *vm, MalJob *list, bool is_reject, MalValue argument
) {
    while (list != nullptr) {
        MalJob *next = list->next;
        mal_vm_enqueue_pending_job(vm, list, is_reject, argument);
        list = next;
    }
}

/** Settlement hands the reactions to their jobs; the promise then owns nothing. */
static void mal_promise_detach_reactions(MalPromiseObject *promise) {
    if (promise->reactions_head == nullptr) return;
    promise->reactions_head = nullptr;
    promise->reactions_tail = nullptr;
    if (!mal_object_finalizes(&promise->object)) {
        mal_heap_cell_owns_nothing(&promise->object.header);
    }
}

void mal_promise_fulfill(MalVm *vm, MalPromiseObject *promise, MalValue value) {
    if (promise->state != MAL_PROMISE_PENDING) {
        return;
    }

    promise->result = value;
    mal_gc_card(&promise->object.header, value); // old promise -> young result
    promise->state = MAL_PROMISE_FULFILLED;

    MalJob *reactions = promise->reactions_head;
    mal_promise_barrier_reactions(reactions);
    mal_promise_detach_reactions(promise);
    mal_promise_trigger_reactions(vm, reactions, false, value);
}

void mal_promise_reject(MalVm *vm, MalPromiseObject *promise, MalValue reason) {
    if (promise->state != MAL_PROMISE_PENDING) {
        return;
    }

    promise->result = reason;
    mal_gc_card(&promise->object.header, reason); // old promise -> young result
    promise->state = MAL_PROMISE_REJECTED;

    MalJob *reactions = promise->reactions_head;
    mal_promise_barrier_reactions(reactions);
    mal_promise_detach_reactions(promise);

    // A promise that rejects with no handler attached is a candidate unhandled
    // rejection; the microtask checkpoint re-checks is_handled before reporting.
    if (!promise->is_handled) {
        mal_vm_note_unhandled_rejection(vm, mal_value_from_promise_object(promise));
    }

    mal_promise_trigger_reactions(vm, reactions, true, reason);
}
