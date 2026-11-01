#include "async.h"
#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

struct AsyncResource { int value; };
static _Atomic int live;
static _Atomic int shutdown_entered;
static _Atomic int shutdown_finished;

int async_apply(int count, AsyncCallback callback, void *data) {
    int sum = 0;
    for (int index = 0; index < count; index++) sum += callback(index, data);
    return sum;
}

typedef struct Job {
    int count;
    int base;
    int result;
    AsyncCallback callback;
    void *data;
} Job;

static void *apply(void *raw) {
    Job *job = raw;
    for (int index = 0; index < job->count; index++)
        job->result += job->callback(job->base + index, job->data);
    return NULL;
}

int async_parallel(int count, AsyncCallback callback, void *data) {
    pthread_t threads[4];
    Job jobs[4];
    for (int index = 0; index < 4; index++) {
        jobs[index] = (Job) {count, index * 100, 0, callback, data};
        assert(pthread_create(&threads[index], NULL, apply, &jobs[index]) == 0);
    }
    int result = 0;
    for (int index = 0; index < 4; index++) {
        assert(pthread_join(threads[index], NULL) == 0);
        result += jobs[index].result;
    }
    return result;
}

int async_plain(int count, AsyncPlainCallback callback) {
    int sum = 0;
    for (int index = 0; index < count; index++) sum += callback(index);
    return sum;
}

void async_void(int count, void (*callback)(int, void *), void *data) {
    for (int index = 0; index < count; index++) callback(index, data);
}

AsyncPair async_record(int value, AsyncPair (*callback)(int, void *), void *data) {
    return callback(value, data);
}

static char *owned(void) {
    char *text = malloc(6);
    assert(text != NULL);
    memcpy(text, "owned", 6);
    atomic_fetch_add(&live, 1);
    return text;
}

char *async_owned(AsyncCallback callback, void *data) {
    callback(1, data);
    return owned();
}
void async_free(void *value) { if (value != NULL) { atomic_fetch_sub(&live, 1); free(value); } }
AsyncResource *async_resource(AsyncCallback callback, void *data) {
    callback(1, data);
    AsyncResource *value = calloc(1, sizeof(*value));
    assert(value != NULL);
    atomic_fetch_add(&live, 1);
    return value;
}
void async_resource_destroy(AsyncResource *value) { async_free(value); }
void async_outputs(AsyncCallback callback, void *data, char **text) {
    callback(1, data);
    *text = owned();
}
int async_live(void) { return atomic_load(&live); }
int async_touch(unsigned char *bytes, size_t length, AsyncCallback callback, void *data) {
    assert(length >= 2);
    bytes[0] = 42;
    bytes[1] = (unsigned char) callback(1, data);
    return (int) length;
}

static void shutdown_check(void) {
    assert(atomic_load(&shutdown_finished) == 1);
    assert(async_live() == 0);
}
void async_shutdown(AsyncCallback callback, void *data) {
    assert(atexit(shutdown_check) == 0);
    atomic_store(&shutdown_entered, 1);
    assert(async_parallel(16, callback, data) == 0);
    atomic_store(&shutdown_finished, 1);
}
void async_wait_entered(void) {
    while (atomic_load(&shutdown_entered) == 0) sched_yield();
}
char *async_shutdown_owned(AsyncCallback callback, void *data) {
    async_shutdown(callback, data);
    return owned();
}
AsyncResource *async_shutdown_resource(AsyncCallback callback, void *data) {
    async_shutdown(callback, data);
    return async_resource(callback, data);
}
void async_shutdown_outputs(AsyncCallback callback, void *data, char **text) {
    async_shutdown(callback, data);
    *text = owned();
}
void async_bytes_count(long long count, void (*callback)(const unsigned char *, long long, void *), void *data) {
    const unsigned char byte = 42;
    callback(&byte, count, data);
}
