#include "microtask.h"

#include <stdlib.h>

#include "vm.h"

static MalCompletion mal_completion_normal(void) {
    return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

static MalJob *mal_job_new(MalJobKind kind) {
    MalJob *job = malloc(sizeof(MalJob));
    job->next = nullptr;
    job->kind = kind;
    job->handler = mal_value_new_undefined();
    job->is_reject = false;
    job->cap_resolve = mal_value_new_undefined();
    job->cap_reject = mal_value_new_undefined();
    job->argument = mal_value_new_undefined();
    job->then = mal_value_new_undefined();
    job->thenable = mal_value_new_undefined();
    job->resolve_fn = mal_value_new_undefined();
    job->reject_fn = mal_value_new_undefined();
    return job;
}

static void mal_vm_enqueue(MalVm *vm, MalJob *job) {
    if (vm->job_tail == nullptr) {
        vm->job_head = job;
    } else {
        vm->job_tail->next = job;
    }
    vm->job_tail = job;
}

void mal_vm_enqueue_reaction_job(
    MalVm *vm,
    MalValue handler,
    bool is_reject,
    MalValue cap_resolve,
    MalValue cap_reject,
    MalValue argument
) {
    MalJob *job = mal_job_new(MAL_JOB_PROMISE_REACTION);
    job->handler = handler;
    job->is_reject = is_reject;
    job->cap_resolve = cap_resolve;
    job->cap_reject = cap_reject;
    job->argument = argument;
    mal_vm_enqueue(vm, job);
}

void mal_vm_enqueue_thenable_job(
    MalVm *vm,
    MalValue then,
    MalValue thenable,
    MalValue resolve_fn,
    MalValue reject_fn
) {
    MalJob *job = mal_job_new(MAL_JOB_PROMISE_RESOLVE_THENABLE);
    job->then = then;
    job->thenable = thenable;
    job->resolve_fn = resolve_fn;
    job->reject_fn = reject_fn;
    mal_vm_enqueue(vm, job);
}

bool mal_vm_has_pending_jobs(const MalVm *vm) {
    return vm->job_head != nullptr;
}

/**
 * Invoke a capability's resolve/reject function with one argument, clearing any
 * pending throw first so the call is not poisoned by the just-finished handler.
 */
static void mal_vm_settle_capability(MalVm *vm, MalValue cap_fn, MalValue argument) {
    if (!mal_value_is_callable(cap_fn)) {
        return;
    }
    vm->completion = mal_completion_normal();
    mal_vm_call_value(vm, cap_fn, mal_value_new_undefined(), &argument, 1);
}

/** PromiseReactionJob: run the handler (or default), then settle the dependent. */
static void mal_vm_run_reaction_job(MalVm *vm, MalJob *job) {
    MalCompletion result;
    if (mal_value_is_callable(job->handler)) {
        vm->completion = mal_completion_normal();
        result = mal_vm_call_value(vm, job->handler, mal_value_new_undefined(), &job->argument, 1);
    } else if (job->is_reject) {
        // Default reject handler rethrows the reason.
        result = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = job->argument};
    } else {
        // Default fulfill handler passes the value through.
        result = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = job->argument};
    }

    if (result.kind == MAL_COMPLETION_THROW) {
        mal_vm_settle_capability(vm, job->cap_reject, result.value);
    } else {
        mal_vm_settle_capability(vm, job->cap_resolve, result.value);
    }
}

/** PromiseResolveThenableJob: call then(thenable, resolve, reject), routing a throw to reject. */
static void mal_vm_run_thenable_job(MalVm *vm, MalJob *job) {
    MalValue args[2] = {job->resolve_fn, job->reject_fn};
    vm->completion = mal_completion_normal();
    MalCompletion result = mal_vm_call_value(vm, job->then, job->thenable, args, 2);
    if (result.kind == MAL_COMPLETION_THROW) {
        mal_vm_settle_capability(vm, job->reject_fn, result.value);
    }
}

void mal_vm_drain_microtasks(MalVm *vm) {
    while (vm->job_head != nullptr) {
        MalJob *job = vm->job_head;
        vm->job_head = job->next;
        if (vm->job_head == nullptr) {
            vm->job_tail = nullptr;
        }

        // Keep the dequeued job's MalValues reachable: the handler can trigger a
        // collection, and its capabilities are settled afterwards.
        vm->active_job = job;
        if (job->kind == MAL_JOB_PROMISE_REACTION) {
            mal_vm_run_reaction_job(vm, job);
        } else {
            mal_vm_run_thenable_job(vm, job);
        }
        vm->active_job = nullptr;

        free(job);

        // A job must not leave a pending throw behind to poison the next job's
        // calls; settlement of dependents has already captured anything it
        // needed.
        vm->completion = mal_completion_normal();
    }

    // Microtask checkpoint: report promises that rejected and were never handled,
    // and release WeakRef targets pinned during this turn (ClearKeptObjects).
    mal_vm_report_unhandled_rejections(vm);
    mal_vm_clear_kept_objects(vm);
}
