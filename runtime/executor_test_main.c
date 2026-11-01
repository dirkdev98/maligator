#include "executor.h"

#include <assert.h>
#include <pthread.h>
#include <stdio.h>
#include <time.h>

typedef struct Gate {
    pthread_mutex_t mutex;
    pthread_cond_t changed;
    usize started;
    usize completed;
    usize discarded;
    bool open;
} Gate;

static void gated_work(void *data) {
    Gate *gate = data;
    pthread_mutex_lock(&gate->mutex);
    gate->started++;
    pthread_cond_broadcast(&gate->changed);
    while (!gate->open) pthread_cond_wait(&gate->changed, &gate->mutex);
    gate->completed++;
    pthread_mutex_unlock(&gate->mutex);
}

static void discarded_work(void *data) {
    Gate *gate = data;
    pthread_mutex_lock(&gate->mutex);
    gate->discarded++;
    pthread_cond_broadcast(&gate->changed);
    pthread_mutex_unlock(&gate->mutex);
}

static void wait_for_count(Gate *gate, const usize *count, usize expected) {
    struct timespec deadline;
    assert(clock_gettime(CLOCK_REALTIME, &deadline) == 0);
    deadline.tv_sec += 10;
    pthread_mutex_lock(&gate->mutex);
    while (*count < expected) {
        assert(pthread_cond_timedwait(&gate->changed, &gate->mutex, &deadline) == 0);
    }
    pthread_mutex_unlock(&gate->mutex);
}

static void open_gate(Gate *gate) {
    pthread_mutex_lock(&gate->mutex);
    gate->open = true;
    pthread_cond_broadcast(&gate->changed);
    pthread_mutex_unlock(&gate->mutex);
}

static void *shutdown_client(void *data) {
    mal_executor_client_shutdown(data);
    return nullptr;
}

typedef struct CleanupJob { Gate *gate; pthread_t owner; } CleanupJob;
static void cleanup_work(void *data) {
    CleanupJob *job = data;
    assert(!pthread_equal(job->owner, pthread_self()));
    gated_work(job->gate);
}
static void cleanup_discard(void *data) { discarded_work(((CleanupJob *) data)->gate); }
typedef struct ShutdownGate { Gate *discarded; Gate *blocked; } ShutdownGate;
static void *release_for_shutdown(void *data) {
    ShutdownGate *gate = data;
    wait_for_count(gate->discarded, &gate->discarded->discarded, 1);
    open_gate(gate->blocked);
    return nullptr;
}

int main(void) {
    Gate blocked = {.mutex = PTHREAD_MUTEX_INITIALIZER, .changed = PTHREAD_COND_INITIALIZER};
    Gate other = {.mutex = PTHREAD_MUTEX_INITIALIZER, .changed = PTHREAD_COND_INITIALIZER};
    Gate queued = {.mutex = PTHREAD_MUTEX_INITIALIZER, .changed = PTHREAD_COND_INITIALIZER};
    MalExecutorClient first = {0}, second = {0};
    assert(mal_executor_client_init(&first, MAL_EXECUTOR_IO, 1, 2));
    assert(mal_executor_client_init(&second, MAL_EXECUTOR_IO, 1, 2));
    assert(mal_executor_submit(&first, gated_work, discarded_work, &blocked, 1, 0, false));
    wait_for_count(&blocked, &blocked.started, 1);
    assert(mal_executor_submit(&first, gated_work, discarded_work, &queued, 1, 0, false));
    assert(mal_executor_submit(&first, gated_work, discarded_work, &queued, 1, 0, false));
    assert(!mal_executor_submit(&first, gated_work, discarded_work, &queued, 1, 0, false));
    assert(!mal_executor_cancel(&first, &blocked));
    assert(mal_executor_cancel(&first, &queued));
    assert(mal_executor_client_queued(&first) == 1);
    assert(mal_executor_submit(&second, gated_work, discarded_work, &other, 1, 0, false));
    wait_for_count(&other, &other.started, 1);
    pthread_t shutdown;
    assert(pthread_create(&shutdown, nullptr, shutdown_client, &first) == 0);
    wait_for_count(&queued, &queued.discarded, 1);
    open_gate(&blocked);
    pthread_join(shutdown, nullptr);
    assert(blocked.completed == 1 && queued.discarded == 1 && queued.started == 0);
    assert(!mal_executor_submit(&first, gated_work, discarded_work, &queued, 0, 0, false));
    mal_executor_client_free(&first);
    open_gate(&other);
    mal_executor_client_shutdown(&second);
    assert(other.completed == 1);
    assert(!mal_executor_submit(&second, gated_work, discarded_work, &queued, 0, 0, false));
    mal_executor_client_free(&second);
    Gate held = {.mutex = PTHREAD_MUTEX_INITIALIZER, .changed = PTHREAD_COND_INITIALIZER};
    Gate cleanup = {.mutex = PTHREAD_MUTEX_INITIALIZER, .changed = PTHREAD_COND_INITIALIZER, .open = true};
    Gate discarded = {.mutex = PTHREAD_MUTEX_INITIALIZER, .changed = PTHREAD_COND_INITIALIZER};
    MalExecutorClient draining = {0};
    CleanupJob required = {&cleanup, pthread_self()};
    ShutdownGate release = {&discarded, &held};
    assert(mal_executor_client_init(&draining, MAL_EXECUTOR_IO, 1, 2));
    assert(mal_executor_submit(&draining, gated_work, discarded_work, &held, 0, 0, false));
    wait_for_count(&held, &held.started, 1);
    assert(mal_executor_submit(&draining, cleanup_work, cleanup_discard, &required, 0, 0, true));
    assert(mal_executor_submit(&draining, gated_work, discarded_work, &discarded, 0, 0, false));
    assert(pthread_create(&shutdown, nullptr, release_for_shutdown, &release) == 0);
    mal_executor_client_shutdown(&draining);
    pthread_join(shutdown, nullptr);
    assert(cleanup.completed == 1 && cleanup.discarded == 0 && discarded.started == 0);
    mal_executor_client_free(&draining);
    pthread_cond_destroy(&held.changed);
    pthread_mutex_destroy(&held.mutex);
    pthread_cond_destroy(&cleanup.changed);
    pthread_mutex_destroy(&cleanup.mutex);
    pthread_cond_destroy(&discarded.changed);
    pthread_mutex_destroy(&discarded.mutex);
    Gate global = {.mutex = PTHREAD_MUTEX_INITIALIZER, .changed = PTHREAD_COND_INITIALIZER};
    MalExecutorClient clients[8] = {0};
    for (usize i = 0; i < countof(clients); i++) {
        assert(mal_executor_client_init(&clients[i], MAL_EXECUTOR_IO, 1, 1));
        assert(mal_executor_submit(&clients[i], gated_work, discarded_work, &global, 0, 0, false));
    }
    wait_for_count(&global, &global.started, 4);
    pthread_mutex_lock(&global.mutex);
    assert(global.started == 4);
    pthread_mutex_unlock(&global.mutex);
    open_gate(&global);
    for (usize i = 0; i < countof(clients); i++) mal_executor_client_shutdown(&clients[i]);
    assert(global.completed + global.discarded == 8);
    for (usize i = 0; i < countof(clients); i++) mal_executor_client_free(&clients[i]);
    pthread_cond_destroy(&blocked.changed);
    pthread_mutex_destroy(&blocked.mutex);
    pthread_cond_destroy(&other.changed);
    pthread_mutex_destroy(&other.mutex);
    pthread_cond_destroy(&queued.changed);
    pthread_mutex_destroy(&queued.mutex);
    pthread_cond_destroy(&global.changed);
    pthread_mutex_destroy(&global.mutex);
    puts("executor PASS");
    return 0;
}
