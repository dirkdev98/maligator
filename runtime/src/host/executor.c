#include "executor.h"

#include <pthread.h>
#include <signal.h>
#include <stdlib.h>

#define MAL_EXECUTOR_MAX_THREADS 4
#define MAL_EXECUTOR_MAX_QUEUED 1024
#define MAL_EXECUTOR_QUEUE_BYTES ((usize) 64 * 1024 * 1024)
#define MAL_EXECUTOR_WORKING_BYTES ((usize) 512 * 1024 * 1024)

typedef struct MalExecutorJob {
    struct MalExecutorJob *next;
    MalExecutorRun run;
    MalExecutorDiscard discard;
    void *data;
    usize queued_bytes;
    usize working_bytes;
} MalExecutorJob;

typedef struct MalExecutorPool MalExecutorPool;
typedef struct MalExecutorClientState {
    MalExecutorPool *pool;
    struct MalExecutorClientState *ready_next;
    MalExecutorJob *head;
    MalExecutorJob *tail;
    usize concurrency;
    usize queue_capacity;
    usize queued;
    usize running;
    bool ready;
    bool accepting;
} MalExecutorClientState;

struct MalExecutorPool {
    pthread_mutex_t mutex;
    pthread_cond_t changed;
    pthread_t threads[MAL_EXECUTOR_MAX_THREADS];
    usize thread_count;
    usize clients;
    usize queued;
    usize queued_bytes;
    usize working_bytes;
    MalExecutorClientState *ready_head;
    MalExecutorClientState *ready_tail;
    bool stopping;
};

static pthread_mutex_t mal_executor_registry_mutex = PTHREAD_MUTEX_INITIALIZER;
static MalExecutorPool *mal_executor_pools[MAL_EXECUTOR_CLASS_COUNT];

static void mal_executor_ready_remove(MalExecutorPool *pool, MalExecutorClientState *client) {
    MalExecutorClientState *previous = nullptr;
    for (MalExecutorClientState *item = pool->ready_head; item != nullptr;
            previous = item, item = item->ready_next) {
        if (item != client) continue;
        if (previous == nullptr) pool->ready_head = item->ready_next;
        else previous->ready_next = item->ready_next;
        if (pool->ready_tail == item) pool->ready_tail = previous;
        item->ready_next = nullptr;
        item->ready = false;
        return;
    }
}

static void mal_executor_ready_add(MalExecutorPool *pool, MalExecutorClientState *client) {
    if (client->ready || client->head == nullptr || !client->accepting) return;
    client->ready = true;
    client->ready_next = nullptr;
    if (pool->ready_tail == nullptr) pool->ready_head = client;
    else pool->ready_tail->ready_next = client;
    pool->ready_tail = client;
}

static void *mal_executor_worker(void *data) {
    MalExecutorPool *pool = data;
    pthread_mutex_lock(&pool->mutex);
    for (;;) {
        MalExecutorClientState *client = pool->ready_head;
        while (client != nullptr && (client->running >= client->concurrency ||
                client->head->working_bytes > MAL_EXECUTOR_WORKING_BYTES - pool->working_bytes)) {
            client = client->ready_next;
        }
        if (client == nullptr) {
            if (pool->stopping) break;
            pthread_cond_wait(&pool->changed, &pool->mutex);
            continue;
        }
        mal_executor_ready_remove(pool, client);
        MalExecutorJob *job = client->head;
        client->head = job->next;
        if (client->head == nullptr) client->tail = nullptr;
        client->queued--;
        client->running++;
        pool->queued--;
        pool->queued_bytes -= job->queued_bytes;
        pool->working_bytes += job->working_bytes;
        mal_executor_ready_add(pool, client);
        pthread_mutex_unlock(&pool->mutex);
        job->run(job->data);
        pthread_mutex_lock(&pool->mutex);
        pool->working_bytes -= job->working_bytes;
        client->running--;
        free(job);
        pthread_cond_broadcast(&pool->changed);
    }
    pthread_mutex_unlock(&pool->mutex);
    return nullptr;
}

static MalExecutorPool *mal_executor_pool_new(MalExecutorClass kind) {
    MalExecutorPool *pool = calloc(1, sizeof(*pool));
    if (pool == nullptr) return nullptr;
    if (pthread_mutex_init(&pool->mutex, nullptr) != 0) {
        free(pool);
        return nullptr;
    }
    if (pthread_cond_init(&pool->changed, nullptr) != 0) {
        pthread_mutex_destroy(&pool->mutex);
        free(pool);
        return nullptr;
    }
    // Native helpers must not inherit a mutator's sampling signal delivery.
    sigset_t blocked, previous;
    sigemptyset(&blocked);
    sigaddset(&blocked, SIGPROF);
    if (pthread_sigmask(SIG_BLOCK, &blocked, &previous) != 0) {
        pthread_cond_destroy(&pool->changed);
        pthread_mutex_destroy(&pool->mutex);
        free(pool);
        return nullptr;
    }
    usize capacity = kind == MAL_EXECUTOR_IO ? 4 : 2;
    for (; pool->thread_count < capacity; pool->thread_count++) {
        if (pthread_create(&pool->threads[pool->thread_count], nullptr,
                mal_executor_worker, pool) != 0) break;
    }
    (void) pthread_sigmask(SIG_SETMASK, &previous, nullptr);
    if (pool->thread_count == 0) {
        pthread_cond_destroy(&pool->changed);
        pthread_mutex_destroy(&pool->mutex);
        free(pool);
        return nullptr;
    }
    return pool;
}

bool mal_executor_client_init(MalExecutorClient *client, MalExecutorClass kind,
        usize concurrency, usize queue_capacity) {
    if (client == nullptr || client->state != nullptr ||
            (usize) kind >= MAL_EXECUTOR_CLASS_COUNT || concurrency == 0 || queue_capacity == 0) {
        return false;
    }
    MalExecutorClientState *state = calloc(1, sizeof(*state));
    if (state == nullptr) return false;
    pthread_mutex_lock(&mal_executor_registry_mutex);
    MalExecutorPool *pool = mal_executor_pools[kind];
    if (pool == nullptr) {
        pool = mal_executor_pool_new(kind);
        mal_executor_pools[kind] = pool;
    }
    if (pool != nullptr) pool->clients++;
    pthread_mutex_unlock(&mal_executor_registry_mutex);
    if (pool == nullptr) {
        free(state);
        return false;
    }
    *state = (MalExecutorClientState) {
        .pool = pool, .concurrency = concurrency,
        .queue_capacity = queue_capacity, .accepting = true,
    };
    client->state = state;
    return true;
}

bool mal_executor_submit(MalExecutorClient *client, MalExecutorRun run,
        MalExecutorDiscard discard, void *data, usize queued_bytes, usize working_bytes) {
    if (client == nullptr || client->state == nullptr || run == nullptr || discard == nullptr ||
            working_bytes > MAL_EXECUTOR_WORKING_BYTES) return false;
    MalExecutorJob *job = malloc(sizeof(*job));
    if (job == nullptr) return false;
    *job = (MalExecutorJob) {
        .run = run, .discard = discard, .data = data,
        .queued_bytes = queued_bytes, .working_bytes = working_bytes,
    };
    MalExecutorClientState *state = client->state;
    MalExecutorPool *pool = state->pool;
    pthread_mutex_lock(&pool->mutex);
    if (!state->accepting || state->queued >= state->queue_capacity ||
            pool->queued >= MAL_EXECUTOR_MAX_QUEUED ||
            queued_bytes > MAL_EXECUTOR_QUEUE_BYTES - pool->queued_bytes) {
        pthread_mutex_unlock(&pool->mutex);
        free(job);
        return false;
    }
    if (state->tail == nullptr) state->head = job;
    else state->tail->next = job;
    state->tail = job;
    state->queued++;
    pool->queued++;
    pool->queued_bytes += queued_bytes;
    mal_executor_ready_add(pool, state);
    pthread_cond_broadcast(&pool->changed);
    pthread_mutex_unlock(&pool->mutex);
    return true;
}

bool mal_executor_cancel(MalExecutorClient *client, void *data) {
    if (client == nullptr || client->state == nullptr) return false;
    MalExecutorClientState *state = client->state;
    MalExecutorPool *pool = state->pool;
    pthread_mutex_lock(&pool->mutex);
    MalExecutorJob *previous = nullptr;
    for (MalExecutorJob *job = state->head; job != nullptr; previous = job, job = job->next) {
        if (job->data != data) continue;
        if (previous == nullptr) state->head = job->next;
        else previous->next = job->next;
        if (state->tail == job) state->tail = previous;
        state->queued--;
        pool->queued--;
        pool->queued_bytes -= job->queued_bytes;
        if (state->head == nullptr) mal_executor_ready_remove(pool, state);
        free(job);
        pthread_mutex_unlock(&pool->mutex);
        return true;
    }
    pthread_mutex_unlock(&pool->mutex);
    return false;
}

void mal_executor_client_shutdown(MalExecutorClient *client) {
    if (client == nullptr || client->state == nullptr) return;
    MalExecutorClientState *state = client->state;
    MalExecutorPool *pool = state->pool;
    pthread_mutex_lock(&pool->mutex);
    state->accepting = false;
    mal_executor_ready_remove(pool, state);
    MalExecutorJob *queued = state->head;
    state->head = state->tail = nullptr;
    state->queued = 0;
    for (MalExecutorJob *job = queued; job != nullptr; job = job->next) {
        pool->queued--;
        pool->queued_bytes -= job->queued_bytes;
    }
    pthread_cond_broadcast(&pool->changed);
    pthread_mutex_unlock(&pool->mutex);
    while (queued != nullptr) {
        MalExecutorJob *next = queued->next;
        queued->discard(queued->data);
        free(queued);
        queued = next;
    }
    pthread_mutex_lock(&pool->mutex);
    while (state->running != 0) pthread_cond_wait(&pool->changed, &pool->mutex);
    pthread_mutex_unlock(&pool->mutex);
}

void mal_executor_client_free(MalExecutorClient *client) {
    if (client == nullptr || client->state == nullptr) return;
    mal_executor_client_shutdown(client);
    MalExecutorPool *pool = client->state->pool;
    free(client->state);
    client->state = nullptr;
    pthread_mutex_lock(&mal_executor_registry_mutex);
    if (--pool->clients == 0) {
        for (usize i = 0; i < MAL_EXECUTOR_CLASS_COUNT; i++) {
            if (mal_executor_pools[i] == pool) mal_executor_pools[i] = nullptr;
        }
        pthread_mutex_lock(&pool->mutex);
        pool->stopping = true;
        pthread_cond_broadcast(&pool->changed);
        pthread_mutex_unlock(&pool->mutex);
        for (usize i = 0; i < pool->thread_count; i++) pthread_join(pool->threads[i], nullptr);
        pthread_cond_destroy(&pool->changed);
        pthread_mutex_destroy(&pool->mutex);
        free(pool);
    }
    pthread_mutex_unlock(&mal_executor_registry_mutex);
}

usize mal_executor_client_workers(MalExecutorClient *client) {
    if (client == nullptr || client->state == nullptr) return 0;
    MalExecutorClientState *state = client->state;
    return state->concurrency < state->pool->thread_count
        ? state->concurrency : state->pool->thread_count;
}

usize mal_executor_client_queued(MalExecutorClient *client) {
    if (client == nullptr || client->state == nullptr) return 0;
    MalExecutorPool *pool = client->state->pool;
    pthread_mutex_lock(&pool->mutex);
    usize queued = client->state->queued;
    pthread_mutex_unlock(&pool->mutex);
    return queued;
}
