#include "blocking_work.h"

#include <pthread.h>
#include <stdlib.h>

#include "host.h"
#include "profile.h"

#define MAL_BLOCKING_WORK_THREADS 4

typedef struct MalBlockingWorkJob {
    struct MalBlockingWorkJob *next;
    MalHostHandle operation;
    MalBlockingWorkRun run;
    MalHostTaskDestroy destroy;
    void *data;
} MalBlockingWorkJob;

typedef struct MalBlockingWorkState {
    MalHost *host;
    pthread_mutex_t mutex;
    pthread_cond_t ready;
    pthread_t threads[MAL_BLOCKING_WORK_THREADS];
    usize thread_count;
    MalBlockingWorkJob *head;
    MalBlockingWorkJob *tail;
    MalBlockingWorkJob *failed;
    bool stopping;
} MalBlockingWorkState;

static void *mal_blocking_work_worker(void *data) {
    MalBlockingWorkState *state = data;
    for (;;) {
        pthread_mutex_lock(&state->mutex);
        while (state->head == nullptr && !state->stopping) {
            pthread_cond_wait(&state->ready, &state->mutex);
        }
        if (state->stopping) {
            pthread_mutex_unlock(&state->mutex);
            return nullptr;
        }
        MalBlockingWorkJob *job = state->head;
        state->head = job->next;
        if (state->head == nullptr) state->tail = nullptr;
        pthread_mutex_unlock(&state->mutex);

        job->run(job->data);
        if (!mal_host_post_complete(state->host, job->operation,
                MAL_HOST_TERMINAL_OK, job->data, job->destroy)) {
            // Retire the operation on the reactor thread even if posting could not allocate.
            pthread_mutex_lock(&state->mutex);
            job->next = state->failed;
            state->failed = job;
            pthread_mutex_unlock(&state->mutex);
        } else {
            free(job);
        }
        (void) mal_reactor_release_work(&state->host->reactor);
    }
}

static bool mal_blocking_work_init(MalHost *host) {
    MalBlockingWorkState *state = calloc(1, sizeof(*state));
    if (state == nullptr) return false;
    state->host = host;
    if (pthread_mutex_init(&state->mutex, nullptr) != 0) {
        free(state);
        return false;
    }
    if (pthread_cond_init(&state->ready, nullptr) != 0) {
        pthread_mutex_destroy(&state->mutex);
        free(state);
        return false;
    }
    for (; state->thread_count < MAL_BLOCKING_WORK_THREADS; state->thread_count++) {
        if (pthread_create(&state->threads[state->thread_count], nullptr,
                mal_blocking_work_worker, state) != 0) break;
    }
    if (state->thread_count == 0) {
        pthread_cond_destroy(&state->ready);
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
    MalHostTaskDestroy destroy, MalHostHandle *operation) {
    if (host == nullptr || run == nullptr || destroy == nullptr || operation == nullptr ||
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
        pthread_mutex_unlock(&state->mutex);
        free(job);
        return false;
    }
    if (!mal_host_operation_activate(&host->tasks, *operation)) {
        (void) mal_reactor_release_work(&host->reactor);
        mal_host_operation_abort_start(&host->tasks, *operation);
        pthread_mutex_unlock(&state->mutex);
        free(job);
        return false;
    }
    *job = (MalBlockingWorkJob) {
        .operation = *operation, .run = run, .data = data, .destroy = destroy,
    };
    if (state->tail == nullptr) state->head = job;
    else state->tail->next = job;
    state->tail = job;
    pthread_cond_signal(&state->ready);
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
        failed->destroy(failed->data);
        free(failed);
        failed = next;
    }
}

void mal_blocking_work_shutdown(MalBlockingWork *work) {
    MalBlockingWorkState *state = work->state;
    if (state == nullptr) return;
    pthread_mutex_lock(&state->mutex);
    if (state->stopping) {
        pthread_mutex_unlock(&state->mutex);
        return;
    }
    state->stopping = true;
    MalBlockingWorkJob *queued = state->head;
    state->head = state->tail = nullptr;
    pthread_cond_broadcast(&state->ready);
    pthread_mutex_unlock(&state->mutex);
    while (queued != nullptr) {
        MalBlockingWorkJob *next = queued->next;
        (void) mal_host_operation_cancel(&state->host->tasks, queued->operation);
        queued->destroy(queued->data);
        (void) mal_reactor_release_work(&state->host->reactor);
        free(queued);
        queued = next;
    }
    // The posted queue and reactor must outlive every producer thread.
    for (usize i = 0; i < state->thread_count; i++) {
        pthread_join(state->threads[i], nullptr);
    }
    mal_blocking_work_reap(work);
}

void mal_blocking_work_free(MalBlockingWork *work) {
    if (work->state == nullptr) return;
    mal_blocking_work_shutdown(work);
    pthread_cond_destroy(&work->state->ready);
    pthread_mutex_destroy(&work->state->mutex);
    free(work->state);
    work->state = nullptr;
}
