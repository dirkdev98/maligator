#include "microtask.h"

#include <stdint.h>
#include <stdlib.h>

#include "async_context.h"
#include "builtin_async_generator.h"
#include "builtin_promise.h"
#include "gc.h"
#include "generator_object.h"
#include "perf_stats.h"
#include "vm.h"

static u64 g_job_allocations = 0;
static u64 g_reaction_allocations = 0;
static u64 g_job_reuses = 0;
static u64 g_reaction_reuses = 0;

// Six blocks hold 4,092 jobs, matching the old 4,096-node pool's 192 KiB budget.
#define MAL_PROMISE_JOB_BLOCK_SIZE 32768
#define MAL_PROMISE_JOB_RETAINED_BLOCK_LIMIT 6

typedef struct MalJobBlock MalJobBlock;

struct MalJobBlock {
    MalJobBlock *next;
    MalJob *free_list;
    u32 next_unused;
    u32 live_count;
    MalJob jobs[];
};

static_assert(
    (MAL_PROMISE_JOB_BLOCK_SIZE & (MAL_PROMISE_JOB_BLOCK_SIZE - 1)) == 0,
    "Promise job block size must be a power of two");

#define MAL_PROMISE_JOBS_PER_BLOCK \
    ((u32) ((MAL_PROMISE_JOB_BLOCK_SIZE - sizeof(MalJobBlock)) / sizeof(MalJob)))

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

static bool mal_job_block_has_capacity(const MalJobBlock *block) {
    return block->free_list != nullptr || block->next_unused < MAL_PROMISE_JOBS_PER_BLOCK;
}

static MalJobBlock *mal_job_find_block(MalVm *vm) {
    MalJobBlock *block = vm->job_active_block;
    if (block != nullptr && mal_job_block_has_capacity(block)) {
        return block;
    }
    for (block = vm->job_blocks; block != nullptr; block = block->next) {
        if (mal_job_block_has_capacity(block)) {
            vm->job_active_block = block;
            return block;
        }
    }

    block = aligned_alloc(MAL_PROMISE_JOB_BLOCK_SIZE, MAL_PROMISE_JOB_BLOCK_SIZE);
    block->next = vm->job_blocks;
    block->free_list = nullptr;
    block->next_unused = 0;
    block->live_count = 0;
    vm->job_blocks = block;
    vm->job_active_block = block;
    MAL_PERF_COUNT(promise_job_slab_block_allocations);
    return block;
}

static MalJob *mal_job_new(MalVm *vm, MalJobKind kind) {
    MalJobBlock *block = mal_job_find_block(vm);
    if (block->live_count == 0 && block->next_unused != 0) {
        vm->job_idle_block_count--;
    }

    MalJob *job;
    if (block->free_list == nullptr) {
        job = &block->jobs[block->next_unused++];
        g_job_allocations++;
        MAL_PERF_COUNT(promise_job_slab_fresh_slots);
    } else {
        job = block->free_list;
        block->free_list = job->next;
        g_job_reuses++;
        MAL_PERF_COUNT(promise_job_slab_hits);
    }
    block->live_count++;
    job->next = nullptr;
    job->kind = kind;
    job->is_reject = false;
#if MAL_NODE
    job->async_context = mal_async_context_capture(vm);
#endif
    return job;
}

static void mal_job_release(MalVm *vm, MalJob *job) {
    MalJobBlock *block = (MalJobBlock *) (
        (uintptr_t) job & ~((uintptr_t) MAL_PROMISE_JOB_BLOCK_SIZE - 1));
    job->next = block->free_list;
    block->free_list = job;
    block->live_count--;
    vm->job_active_block = block;
    if (block->live_count != 0) {
        return;
    }

    if (vm->job_idle_block_count < MAL_PROMISE_JOB_RETAINED_BLOCK_LIMIT) {
        vm->job_idle_block_count++;
        u64 retained_bytes =
            (u64) vm->job_idle_block_count * MAL_PROMISE_JOB_BLOCK_SIZE;
        if (mal_perf_stats_enabled &&
            retained_bytes > mal_perf_stats.promise_job_slab_peak_retained_bytes) {
            mal_perf_stats.promise_job_slab_peak_retained_bytes = retained_bytes;
        }
        return;
    }

    MalJobBlock **link = &vm->job_blocks;
    while (*link != block) {
        link = &(*link)->next;
    }
    *link = block->next;
    vm->job_active_block = nullptr;
    free(block);
    MAL_PERF_COUNT(promise_job_slab_block_frees);
}

static void mal_job_recycle(MalVm *vm, MalJob *job) {
    if (job->kind == MAL_JOB_PROMISE_REACTION ||
        job->kind == MAL_JOB_ASYNC_AWAIT ||
        job->kind == MAL_JOB_ASYNC_GENERATOR_RETURN) {
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
#if MAL_NODE
    mal_gc_write_barrier(
        mal_async_internal_value((MalHeapHeader *) job->async_context));
    job->async_context = nullptr;
#endif

    // The deleted root edges are shaded and cleared; stop publishing the node
    // before it can be freed by the bounded-pool overflow path.
    vm->active_job = nullptr;

    mal_job_release(vm, job);
}

void mal_vm_free_job_pool(MalVm *vm) {
    MalJobBlock *block = vm->job_blocks;
    while (block != nullptr) {
        MalJobBlock *next = block->next;
        free(block);
        MAL_PERF_COUNT(promise_job_slab_block_frees);
        block = next;
    }
    vm->job_blocks = nullptr;
    vm->job_active_block = nullptr;
    vm->job_idle_block_count = 0;
}

static void mal_vm_enqueue(MalVm *vm, MalJob *job) {
    if (vm->job_tail == nullptr) {
        vm->job_head = job;
    } else {
        vm->job_tail->next = job;
    }
    vm->job_tail = job;
}

static void mal_vm_enqueue_reaction_job_with_context(
    MalVm *vm,
    MalValue handler,
    bool is_reject,
    MalValue cap_resolve,
    MalValue cap_reject,
    MalValue argument
#if MAL_NODE
    , MalAsyncContext *context
#endif
) {
    MalJob *job = mal_job_new(vm, MAL_JOB_PROMISE_REACTION);
#if MAL_NODE
    job->async_context = context;
#endif
    job->as.reaction.handler = handler;
    job->is_reject = is_reject;
    job->as.reaction.cap_resolve = cap_resolve;
    job->as.reaction.cap_reject = cap_reject;
    job->as.reaction.argument = argument;
    mal_vm_enqueue(vm, job);
}

void mal_vm_enqueue_reaction_job(
    MalVm *vm,
    MalValue handler,
    bool is_reject,
    MalValue cap_resolve,
    MalValue cap_reject,
    MalValue argument
) {
    mal_vm_enqueue_reaction_job_with_context(
        vm, handler, is_reject, cap_resolve, cap_reject, argument
#if MAL_NODE
        , mal_async_context_capture(vm)
#endif
    );
}

#if MAL_NODE
void mal_vm_enqueue_reaction_job_in_context(
    MalVm *vm,
    MalValue handler,
    bool is_reject,
    MalValue cap_resolve,
    MalValue cap_reject,
    MalValue argument,
    MalAsyncContext *context
) {
    mal_vm_enqueue_reaction_job_with_context(
        vm, handler, is_reject, cap_resolve, cap_reject, argument, context);
}
#endif

static void mal_vm_enqueue_await_job_with_context(
    MalVm *vm,
    MalValue state,
    bool is_reject,
    MalValue argument
#if MAL_NODE
    , MalAsyncContext *context
#endif
) {
    MalJob *job = mal_job_new(vm, MAL_JOB_ASYNC_AWAIT);
#if MAL_NODE
    job->async_context = context;
#endif
    job->as.reaction.handler = state;
    job->is_reject = is_reject;
    job->as.reaction.cap_resolve = mal_value_new_undefined();
    job->as.reaction.cap_reject = mal_value_new_undefined();
    job->as.reaction.argument = argument;
    MAL_PERF_COUNT(promise_await_typed_jobs);
    mal_vm_enqueue(vm, job);
}

void mal_vm_enqueue_await_job(
    MalVm *vm,
    MalValue state,
    bool is_reject,
    MalValue argument
) {
    mal_vm_enqueue_await_job_with_context(
        vm, state, is_reject, argument
#if MAL_NODE
        , mal_async_context_capture(vm)
#endif
    );
}

#if MAL_NODE
void mal_vm_enqueue_await_job_in_context(
    MalVm *vm,
    MalValue state,
    bool is_reject,
    MalValue argument,
    MalAsyncContext *context
) {
    mal_vm_enqueue_await_job_with_context(vm, state, is_reject, argument, context);
}
#endif

static void mal_vm_enqueue_async_generator_return_job_with_context(
    MalVm *vm,
    MalValue generator,
    MalValue realm_anchor,
    bool is_reject,
    MalValue argument
#if MAL_NODE
    , MalAsyncContext *context
#endif
) {
    MalJob *job = mal_job_new(vm, MAL_JOB_ASYNC_GENERATOR_RETURN);
#if MAL_NODE
    job->async_context = context;
#endif
    job->as.reaction.handler = generator;
    job->is_reject = is_reject;
    job->as.reaction.cap_resolve = realm_anchor;
    job->as.reaction.cap_reject = mal_value_new_undefined();
    job->as.reaction.argument = argument;
    mal_vm_enqueue(vm, job);
}

void mal_vm_enqueue_async_generator_return_job(
    MalVm *vm,
    MalValue generator,
    MalValue realm_anchor,
    bool is_reject,
    MalValue argument
) {
    mal_vm_enqueue_async_generator_return_job_with_context(
        vm, generator, realm_anchor, is_reject, argument
#if MAL_NODE
        , mal_async_context_capture(vm)
#endif
    );
}

#if MAL_NODE
void mal_vm_enqueue_async_generator_return_job_in_context(
    MalVm *vm,
    MalValue generator,
    MalValue realm_anchor,
    bool is_reject,
    MalValue argument,
    MalAsyncContext *context
) {
    mal_vm_enqueue_async_generator_return_job_with_context(
        vm, generator, realm_anchor, is_reject, argument, context);
}
#endif

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

void mal_vm_enqueue_promise_adoption_job(
    MalVm *vm,
    MalValue captured_then,
    MalValue source,
    MalValue target,
    MalValue target_constructor
) {
    MalJob *job = mal_job_new(vm, MAL_JOB_PROMISE_RESOLVE_THENABLE);
    job->as.thenable.then = captured_then;
    job->as.thenable.thenable = source;
    job->as.thenable.resolve_fn = target;
    job->as.thenable.reject_fn = target_constructor;
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

/** AsyncGeneratorAwaitReturn's realm-capturing fulfillment/rejection closure. */
static void mal_vm_run_async_generator_return_job(MalVm *vm, MalJob *job) {
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_vm_realm_switch_to(
        vm, mal_vm_callee_realm(vm, job->as.reaction.cap_resolve));
#endif
    vm->completion = mal_completion_normal();
    mal_async_generator_await_return_complete(
        vm,
        (MalGeneratorObject *) mal_value_to_heap(job->as.reaction.handler),
        job->is_reject,
        job->as.reaction.argument);
#if MAL_REALMS
    mal_vm_realm_switch_to(vm, saved_realm);
#endif
}

/** PromiseResolveThenableJob: call then(thenable, resolve, reject), routing a throw to reject. */
static void mal_vm_run_thenable_job(MalVm *vm, MalJob *job) {
    // Exact native adoption uses the otherwise-impossible non-callable resolve
    // field to retain the direct target capability without materialized callbacks.
    if (mal_value_is_promise_object(job->as.thenable.resolve_fn)) {
        if (mal_promise_try_perform_native_adoption(
                vm,
                job->as.thenable.then,
                job->as.thenable.thenable,
                job->as.thenable.resolve_fn,
                job->as.thenable.reject_fn)) {
            return;
        }

        // Promise Resolve Functions captured `then` before this job was queued,
        // but constructor/species mutations before execution remain observable.
        MAL_PERF_COUNT(promise_native_adoption_guard_fallbacks);
        MalValue resolve_fn;
        MalValue reject_fn;
#if MAL_REALMS
        MalRealm *saved_realm = vm->current_realm;
        mal_vm_realm_switch_to(
            vm, mal_vm_callee_realm(vm, job->as.thenable.reject_fn));
#endif
        mal_promise_create_resolving(
            vm, job->as.thenable.resolve_fn, &resolve_fn, &reject_fn);
#if MAL_REALMS
        mal_vm_realm_switch_to(vm, saved_realm);
#endif
        MalValue args[2] = {resolve_fn, reject_fn};
        MalRootSpan span;
        mal_gc_root(&span, args, 2);
        vm->completion = mal_completion_normal();
        MalCompletion result = mal_vm_call_value(
            vm, job->as.thenable.then, job->as.thenable.thenable, args, 2);
        if (result.kind == MAL_COMPLETION_THROW) {
            mal_vm_call_capability_function(vm, reject_fn, result.value);
        }
        mal_gc_unroot(&span);
        return;
    }

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
#if MAL_NODE
        MalAsyncContextScope async_scope;
        mal_async_context_scope_enter(vm, &async_scope, job->async_context);
#endif
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
            case MAL_JOB_ASYNC_GENERATOR_RETURN:
                mal_vm_run_async_generator_return_job(vm, job);
                break;
        }
#if MAL_NODE
        mal_async_context_scope_exit(vm, &async_scope);
#endif
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
