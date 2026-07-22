#include "microtask.h"

#include <stdlib.h>

#include "builtin_promise.h"
#include "gc.h"
#include "generator_object.h"
#include "perf_stats.h"
#include "vm.h"

static u64 g_job_allocations = 0;
static u64 g_reaction_allocations = 0;
static u64 g_job_reuses = 0;
static u64 g_reaction_reuses = 0;

u64 mal_promise_job_allocation_count(void) {
    return g_job_allocations;
}

u64 mal_promise_reaction_allocation_count(void) {
    return g_reaction_allocations;
}

u64 mal_promise_job_reuse_count(void) {
    return g_job_reuses;
}

u64 mal_promise_reaction_reuse_count(void) {
    return g_reaction_reuses;
}

void mal_promise_note_reaction_allocation(void) {
    g_reaction_allocations++;
}

void mal_promise_note_reaction_reuse(void) {
    g_reaction_reuses++;
}

static MalCompletion mal_completion_normal(void) {
    return (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
}

static MalJob *mal_job_new(MalVm *vm, MalJobKind kind) {
    MalJob *job = vm->job_pool;
    if (job == nullptr) {
        job = malloc(sizeof(MalJob));
        g_job_allocations++;
    } else {
        vm->job_pool = job->next;
        vm->job_pool_count--;
        g_job_reuses++;
    }
    job->next = nullptr;
    job->kind = kind;
    job->is_reject = false;
    return job;
}

static void mal_job_recycle(MalVm *vm, MalJob *job) {
    if (job->kind == MAL_JOB_PROMISE_REACTION || job->kind == MAL_JOB_ASYNC_AWAIT) {
        mal_gc_write_barrier(job->as.reaction.handler);
        mal_gc_write_barrier(job->as.reaction.cap_resolve);
        mal_gc_write_barrier(job->as.reaction.cap_reject);
        mal_gc_write_barrier(job->as.reaction.argument);
        job->as.reaction.handler = mal_value_new_undefined();
        job->as.reaction.cap_resolve = mal_value_new_undefined();
        job->as.reaction.cap_reject = mal_value_new_undefined();
        job->as.reaction.argument = mal_value_new_undefined();
    } else {
        mal_gc_write_barrier(job->as.thenable.then);
        mal_gc_write_barrier(job->as.thenable.thenable);
        mal_gc_write_barrier(job->as.thenable.resolve_fn);
        mal_gc_write_barrier(job->as.thenable.reject_fn);
        job->as.thenable.then = mal_value_new_undefined();
        job->as.thenable.thenable = mal_value_new_undefined();
        job->as.thenable.resolve_fn = mal_value_new_undefined();
        job->as.thenable.reject_fn = mal_value_new_undefined();
    }

    // The deleted root edges are shaded and cleared; stop publishing the node
    // before it can be freed by the bounded-pool overflow path.
    vm->active_job = nullptr;

    if (vm->job_pool_count >= MAL_PROMISE_JOB_POOL_LIMIT) {
        free(job);
        return;
    }
    job->next = vm->job_pool;
    vm->job_pool = job;
    vm->job_pool_count++;
}

void mal_vm_free_job_pool(MalVm *vm) {
    MalJob *job = vm->job_pool;
    while (job != nullptr) {
        MalJob *next = job->next;
        free(job);
        job = next;
    }
    vm->job_pool = nullptr;
    vm->job_pool_count = 0;
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
    MalJob *job = mal_job_new(vm, MAL_JOB_PROMISE_REACTION);
    job->as.reaction.handler = handler;
    job->is_reject = is_reject;
    job->as.reaction.cap_resolve = cap_resolve;
    job->as.reaction.cap_reject = cap_reject;
    job->as.reaction.argument = argument;
    mal_vm_enqueue(vm, job);
}

void mal_vm_enqueue_await_job(
    MalVm *vm,
    MalValue state,
    bool is_reject,
    MalValue argument
) {
    MalJob *job = mal_job_new(vm, MAL_JOB_ASYNC_AWAIT);
    job->as.reaction.handler = state;
    job->is_reject = is_reject;
    job->as.reaction.cap_resolve = mal_value_new_undefined();
    job->as.reaction.cap_reject = mal_value_new_undefined();
    job->as.reaction.argument = argument;
    MAL_PERF_COUNT(promise_await_typed_jobs);
    mal_vm_enqueue(vm, job);
}

void mal_vm_enqueue_thenable_job(
    MalVm *vm,
    MalValue then,
    MalValue thenable,
    MalValue resolve_fn,
    MalValue reject_fn
) {
    MalJob *job = mal_job_new(vm, MAL_JOB_PROMISE_RESOLVE_THENABLE);
    job->as.thenable.then = then;
    job->as.thenable.thenable = thenable;
    job->as.thenable.resolve_fn = resolve_fn;
    job->as.thenable.reject_fn = reject_fn;
    mal_vm_enqueue(vm, job);
}

bool mal_vm_has_pending_jobs(const MalVm *vm) {
    return vm->job_head != nullptr;
}

/**
 * Invoke a capability's resolve/reject function with one argument, clearing any
 * pending throw first so the call is not poisoned by the just-finished handler.
 */
static void mal_vm_call_capability_function(MalVm *vm, MalValue cap_fn, MalValue argument) {
    if (!mal_value_is_callable(cap_fn)) {
        return;
    }
    vm->completion = mal_completion_normal();
    mal_vm_call_value(vm, cap_fn, mal_value_new_undefined(), &argument, 1);
}

static void mal_vm_settle_reaction_capability(
    MalVm *vm,
    MalValue cap_resolve,
    MalValue cap_reject,
    bool is_reject,
    MalValue argument
) {
    // Exact-intrinsic Promise.prototype.then stores its target Promise where a
    // callable resolve would otherwise live. The second field is the exact
    // constructor and therefore also restores the omitted function's realm.
    if (mal_value_is_promise_object(cap_resolve)) {
        vm->completion = mal_completion_normal();
        mal_promise_settle_direct(
            vm, cap_resolve, cap_reject, is_reject, argument);
        return;
    }

    mal_vm_call_capability_function(
        vm, is_reject ? cap_reject : cap_resolve, argument);
}

/** PromiseReactionJob: run the handler (or default), then settle the dependent. */
static void mal_vm_run_reaction_job(MalVm *vm, MalJob *job) {
    MalCompletion result;
    if (mal_value_is_callable(job->as.reaction.handler)) {
        vm->completion = mal_completion_normal();
        result = mal_vm_call_value(
            vm,
            job->as.reaction.handler,
            mal_value_new_undefined(),
            &job->as.reaction.argument,
            1
        );
    } else if (job->is_reject) {
        // Default reject handler rethrows the reason.
        result = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = job->as.reaction.argument};
    } else {
        // Default fulfill handler passes the value through.
        result = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = job->as.reaction.argument};
    }

    if (result.kind == MAL_COMPLETION_THROW) {
        mal_vm_settle_reaction_capability(
            vm,
            job->as.reaction.cap_resolve,
            job->as.reaction.cap_reject,
            true,
            result.value);
    } else {
        mal_vm_settle_reaction_capability(
            vm,
            job->as.reaction.cap_resolve,
            job->as.reaction.cap_reject,
            false,
            result.value);
    }
}

/** Async await fulfillment/rejection reaction without materialized callbacks. */
static void mal_vm_run_await_job(MalVm *vm, MalJob *job) {
    vm->completion = mal_completion_normal();
    mal_vm_resume_generator(
        vm,
        (MalGeneratorObject *) mal_value_to_heap(job->as.reaction.handler),
        job->as.reaction.argument,
        job->is_reject ? MAL_GENERATOR_RESUME_THROW : MAL_GENERATOR_RESUME_NEXT);
}

/** PromiseResolveThenableJob: call then(thenable, resolve, reject), routing a throw to reject. */
static void mal_vm_run_thenable_job(MalVm *vm, MalJob *job) {
    MalValue args[2] = {job->as.thenable.resolve_fn, job->as.thenable.reject_fn};
    vm->completion = mal_completion_normal();
    MalCompletion result = mal_vm_call_value(
        vm, job->as.thenable.then, job->as.thenable.thenable, args, 2);
    if (result.kind == MAL_COMPLETION_THROW) {
        mal_vm_call_capability_function(vm, job->as.thenable.reject_fn, result.value);
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
        switch (job->kind) {
            case MAL_JOB_PROMISE_REACTION:
                mal_vm_run_reaction_job(vm, job);
                break;
            case MAL_JOB_PROMISE_RESOLVE_THENABLE:
                mal_vm_run_thenable_job(vm, job);
                break;
            case MAL_JOB_ASYNC_AWAIT:
                mal_vm_run_await_job(vm, job);
                break;
        }
        mal_job_recycle(vm, job);

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
