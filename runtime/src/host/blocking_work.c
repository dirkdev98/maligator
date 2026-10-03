#include "blocking_work.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>

#include "executor.h"
#include "host.h"
#include "profile.h"

typedef struct MalBlockingWorkState MalBlockingWorkState;
typedef struct MalBlockingWorkJob {
    struct MalBlockingWorkJob *next;
    MalBlockingWorkState *state;
    MalHostHandle operation;
    MalBlockingWorkRun run;
    MalHostTaskDestroy destroy;
    void *data;
    MalBlockingWorkReservation reservation;
} MalBlockingWorkJob;

// Executor queue accounting ends at dequeue; retained caps include reservations and posted completions.
#define MAL_BLOCKING_WORK_RETAINED_LIMIT ((usize) 512 * 1024 * 1024)
#define MAL_BLOCKING_WORK_RETAINED_JOB_LIMIT ((usize) 1024)
static _Atomic usize g_blocking_work_retained_bytes;
static _Atomic usize g_blocking_work_retained_jobs;

struct MalBlockingWorkState {
    MalHost *host;
    pthread_mutex_t mutex;
    MalExecutorClient executor;
    MalBlockingWorkJob *failed;
    bool stopping;
};

bool mal_blocking_work_reserve(
    MalHost *host, usize bytes, MalBlockingWorkReservation *reservation) {
    if (host == nullptr || reservation == nullptr || reservation->active ||
        !mal_host_posted_accepting(&host->posted_tasks) ||
        bytes > MAL_BLOCKING_WORK_RETAINED_LIMIT) return false;
    usize jobs = atomic_load_explicit(&g_blocking_work_retained_jobs, memory_order_relaxed);
    do {
        if (jobs >= MAL_BLOCKING_WORK_RETAINED_JOB_LIMIT) return false;
    } while (!atomic_compare_exchange_weak_explicit(
        &g_blocking_work_retained_jobs, &jobs, jobs + 1,
        memory_order_relaxed, memory_order_relaxed));
    usize current = atomic_load_explicit(&g_blocking_work_retained_bytes, memory_order_relaxed);
    do {
        if (current > MAL_BLOCKING_WORK_RETAINED_LIMIT - bytes) {
            atomic_fetch_sub_explicit(&g_blocking_work_retained_jobs, 1, memory_order_relaxed);
            return false;
        }
    } while (!atomic_compare_exchange_weak_explicit(
        &g_blocking_work_retained_bytes, &current, current + bytes,
        memory_order_relaxed, memory_order_relaxed));
    *reservation = (MalBlockingWorkReservation) {.bytes = bytes, .active = true};
    return true;
}

void mal_blocking_work_reservation_release(MalBlockingWorkReservation *reservation) {
    if (reservation == nullptr || !reservation->active) return;
    usize bytes = reservation->bytes;
    *reservation = (MalBlockingWorkReservation) {0};
    if (bytes != 0) {
        usize previous = atomic_fetch_sub_explicit(
            &g_blocking_work_retained_bytes, bytes, memory_order_relaxed);
        if (previous < bytes) abort();
    }
    usize previous = atomic_fetch_sub_explicit(
        &g_blocking_work_retained_jobs, 1, memory_order_relaxed);
    if (previous == 0) abort();
}

usize mal_blocking_work_retained_bytes(void) {
    return atomic_load_explicit(&g_blocking_work_retained_bytes, memory_order_relaxed);
}

usize mal_blocking_work_retained_jobs(void) {
    return atomic_load_explicit(&g_blocking_work_retained_jobs, memory_order_relaxed);
}

static void mal_blocking_work_job_destroy(void *data) {
    MalBlockingWorkJob *job = data;
    job->destroy(job->data);
    mal_blocking_work_reservation_release(&job->reservation);
    free(job);
}

void *mal_blocking_work_result_data(void *result) {
    return result == nullptr ? nullptr : ((MalBlockingWorkJob *) result)->data;
}

static void mal_blocking_work_run(void *data) {
    MalBlockingWorkJob *job = data;
    MalBlockingWorkState *state = job->state;
    // Admission holds this lock until the owner has activated the reserved operation.
    pthread_mutex_lock(&state->mutex);
    pthread_mutex_unlock(&state->mutex);
    job->run(job->data);
    if (!mal_host_post_complete(state->host, job->operation,
            MAL_HOST_TERMINAL_OK, job, mal_blocking_work_job_destroy)) {
        pthread_mutex_lock(&state->mutex);
        job->next = state->failed;
        state->failed = job;
        pthread_mutex_unlock(&state->mutex);
    }
    (void) mal_reactor_release_work(&state->host->reactor);
}

static void mal_blocking_work_discard(void *data) {
    MalBlockingWorkJob *job = data;
    MalHost *host = job->state->host;
    (void) mal_host_operation_cancel(&host->tasks, job->operation);
    mal_blocking_work_job_destroy(job);
    (void) mal_reactor_release_work(&host->reactor);
}

static bool mal_blocking_work_init(MalHost *host) {
    MalBlockingWorkState *state = calloc(1, sizeof(*state));
    if (state == nullptr) return false;
    state->host = host;
    if (pthread_mutex_init(&state->mutex, nullptr) != 0) {
        free(state);
        return false;
    }
    if (!mal_executor_client_init(&state->executor, MAL_EXECUTOR_IO, 4, 64)) {
        pthread_mutex_destroy(&state->mutex);
        free(state);
        return false;
    }
    mal_profile_mark_worker_cpu_possible();
    host->blocking_work.state = state;
    return true;
}

bool mal_blocking_work_start(
    MalHost *host, MalBlockingWorkRun run, void *data,
    MalHostTaskDestroy destroy, MalBlockingWorkReservation *reservation,
    MalHostHandle *operation) {
    if (operation != nullptr) *operation = 0;
    if (host == nullptr || run == nullptr || destroy == nullptr || operation == nullptr ||
        reservation == nullptr || !reservation->active ||
        !mal_host_posted_accepting(&host->posted_tasks)) return false;
    if (host->blocking_work.state == nullptr && !mal_blocking_work_init(host)) return false;
    MalBlockingWorkState *state = host->blocking_work.state;
    MalBlockingWorkJob *job = malloc(sizeof(*job));
    if (job == nullptr) return false;
    pthread_mutex_lock(&state->mutex);
    if (state->stopping || !mal_host_operation_start(&host->tasks, operation)) {
        pthread_mutex_unlock(&state->mutex);
        free(job);
        return false;
    }
    if (!mal_reactor_retain_work(&host->reactor)) {
        mal_host_operation_abort_start(&host->tasks, *operation);
        *operation = 0;
        pthread_mutex_unlock(&state->mutex);
        free(job);
        return false;
    }
    *job = (MalBlockingWorkJob) {
        .state = state, .operation = *operation, .run = run, .data = data, .destroy = destroy,
        .reservation = *reservation,
    };
    if (!mal_executor_submit(&state->executor, mal_blocking_work_run,
            mal_blocking_work_discard, job, sizeof(*job), 0)) {
        (void) mal_reactor_release_work(&host->reactor);
        mal_host_operation_abort_start(&host->tasks, *operation);
        *operation = 0;
        pthread_mutex_unlock(&state->mutex);
        free(job);
        return false;
    }
    if (!mal_host_operation_activate(&host->tasks, *operation)) abort();
    *reservation = (MalBlockingWorkReservation) {0};
    pthread_mutex_unlock(&state->mutex);
    return true;
}

void mal_blocking_work_reap(MalBlockingWork *work) {
    MalBlockingWorkState *state = work->state;
    if (state == nullptr) return;
    pthread_mutex_lock(&state->mutex);
    MalBlockingWorkJob *failed = state->failed;
    state->failed = nullptr;
    pthread_mutex_unlock(&state->mutex);
    while (failed != nullptr) {
        MalBlockingWorkJob *next = failed->next;
        (void) mal_host_operation_cancel(&state->host->tasks, failed->operation);
        mal_blocking_work_job_destroy(failed);
        failed = next;
    }
}

void mal_blocking_work_shutdown(MalBlockingWork *work) {
    MalBlockingWorkState *state = work->state;
    if (state == nullptr) return;
    pthread_mutex_lock(&state->mutex);
    state->stopping = true;
    pthread_mutex_unlock(&state->mutex);
    mal_executor_client_shutdown(&state->executor);
    mal_blocking_work_reap(work);
}

void mal_blocking_work_free(MalBlockingWork *work) {
    if (work->state == nullptr) return;
    mal_blocking_work_shutdown(work);
    mal_executor_client_free(&work->state->executor);
    pthread_mutex_destroy(&work->state->mutex);
    free(work->state);
    work->state = nullptr;
}
