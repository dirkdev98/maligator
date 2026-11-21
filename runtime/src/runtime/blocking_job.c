#include "blocking_job.h"

#include <stdlib.h>

#include "async_context.h"
#include "gc.h"
#include "host.h"
#include "web_host_timer.h"

typedef struct BlockingJobPending {
    struct BlockingJobPending *next;
    MalVm *vm;
    MalHostHandle operation;
    MalBlockingJobSettle settle;
    u32 tag;
    MalValue values[MAL_BLOCKING_JOB_VALUES];
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
} BlockingJobPending;

// Pending jobs and their root registration belong to this mutator's isolate.
static MAL_ISOLATE_LOCAL BlockingJobPending *blocking_job_pending;
static MAL_ISOLATE_LOCAL bool blocking_job_installed;

static void blocking_job_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (BlockingJobPending *state = blocking_job_pending; state != nullptr; state = state->next) {
        if (state->vm != vm) continue;
        for (usize i = 0; i < MAL_BLOCKING_JOB_VALUES; i++) mal_gc_mark_value(state->values[i]);
        mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) state->async_context));
    }
}

static void blocking_job_free(MalVm *vm) {
    BlockingJobPending **link = &blocking_job_pending;
    while (*link != nullptr) {
        BlockingJobPending *state = *link;
        if (state->vm != vm) {
            link = &state->next;
            continue;
        }
        *link = state->next;
        free(state);
    }
}

static bool blocking_job_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    MalHostTask task;
    if (host == nullptr || !mal_host_peek_task(&host->tasks, &task)) return false;
    BlockingJobPending **link = &blocking_job_pending;
    while (*link != nullptr && ((*link)->vm != vm || (*link)->operation != task.operation)) {
        link = &(*link)->next;
    }
    BlockingJobPending *state = *link;
    if (state == nullptr || !mal_host_next_task(&host->tasks, &task)) return false;
    *link = state->next;
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, state->realm);
#endif
    MalValue values[MAL_BLOCKING_JOB_VALUES];
    for (usize i = 0; i < MAL_BLOCKING_JOB_VALUES; i++) values[i] = state->values[i];
    MalRootSpan root;
    mal_gc_root(&root, values, MAL_BLOCKING_JOB_VALUES);
    MalAsyncContextScope async_scope;
    mal_async_context_scope_enter(vm, &async_scope, state->async_context);
    MalBlockingJobSettle settle = state->settle;
    u32 tag = state->tag;
    free(state);
    settle(vm, mal_blocking_work_result_data(task.data),
        task.result == MAL_HOST_TERMINAL_CANCELLED, tag, values);
    mal_async_context_scope_exit(vm, &async_scope);
    mal_gc_unroot(&root);
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif
    mal_host_task_release(&host->tasks, &task);
    return true;
}

bool mal_blocking_jobs_install(MalVm *vm) {
    if (!blocking_job_installed) {
        mal_gc_register_root_source(blocking_job_scan_roots, nullptr);
        mal_host_register_macrotask_drain(blocking_job_drain, false);
        blocking_job_installed = true;
    }
    return mal_vm_register_runtime_cleanup(vm, blocking_job_free);
}

MalBlockingJobStart mal_blocking_job_start(
    MalVm *vm, const MalBlockingJob *job, MalBlockingWorkReservation *reservation) {
    BlockingJobPending *state = calloc(1, sizeof(*state));
    if (state == nullptr) return MAL_BLOCKING_JOB_NO_MEMORY;
    *state = (BlockingJobPending) {
        .vm = vm,
        .settle = job->settle,
        .tag = job->tag,
        .async_context = mal_async_context_capture(vm),
#if MAL_REALMS
        .realm = vm->current_realm,
#endif
    };
    for (usize i = 0; i < MAL_BLOCKING_JOB_VALUES; i++) state->values[i] = job->values[i];
    bool reserved = reservation->active
        || mal_blocking_work_reserve(mal_host(vm), job->footprint, reservation);
    if (!reserved || !mal_blocking_work_start(mal_host(vm), job->run, job->data,
            job->destroy, reservation, &state->operation, false)) {
        free(state);
        return MAL_BLOCKING_JOB_BUSY;
    }
    state->next = blocking_job_pending;
    blocking_job_pending = state;
    return MAL_BLOCKING_JOB_STARTED;
}
