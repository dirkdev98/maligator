#include "async.h"
#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

struct AsyncResource { int value; void *callback_data; };
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

static pthread_mutex_t registered_lock = PTHREAD_MUTEX_INITIALIZER;
static AsyncCallback registered_callback;
static AsyncResourceCallback registered_lookup;
static void *registered_data;
static void (*registered_release)(void *);

void async_registered_clear(void) {
    pthread_mutex_lock(&registered_lock);
    void *data = registered_data;
    void (*release)(void *) = registered_release;
    registered_callback = NULL;
    registered_lookup = NULL;
    registered_data = NULL;
    registered_release = NULL;
    pthread_mutex_unlock(&registered_lock);
    if (release != NULL) release(data);
}

int async_register(int mode, AsyncCallback callback, void *data, void (*release)(void *)) {
    async_registered_clear();
    pthread_mutex_lock(&registered_lock);
    registered_callback = callback;
    registered_data = data;
    registered_release = release;
    pthread_mutex_unlock(&registered_lock);
    int result = mode > 0 && callback != NULL ? callback(11, data) : 0;
    if (mode == 2) async_registered_clear();
    return result;
}

int async_registered_call(int value) {
    pthread_mutex_lock(&registered_lock);
    AsyncCallback callback = registered_callback;
    AsyncResourceCallback lookup = registered_lookup;
    void *data = registered_data;
    pthread_mutex_unlock(&registered_lock);
    if (callback != NULL) return callback(value, data);
    AsyncResource resource = {value, data};
    return lookup == NULL ? 0 : lookup(&resource);
}

int async_registered_count(void) {
    pthread_mutex_lock(&registered_lock);
    int count = registered_callback != NULL || registered_lookup != NULL;
    pthread_mutex_unlock(&registered_lock);
    return count;
}

int async_register_lookup(int mode, AsyncResourceCallback callback, void *data, void (*release)(void *)) {
    async_registered_clear();
    pthread_mutex_lock(&registered_lock);
    registered_lookup = callback;
    registered_data = data;
    registered_release = release;
    pthread_mutex_unlock(&registered_lock);
    int result = mode > 0 ? async_registered_call(11) : 0;
    if (mode == 2) async_registered_clear();
    return result;
}

void *async_resource_data(AsyncResource *resource) { return resource->callback_data; }
int async_resource_value(AsyncResource *resource) { return resource->value; }

void async_notify(void (*callback)(int, void *), void *data, void (*release)(void *)) {
    callback(17, data);
    release(data);
}

static _Atomic int retained_started;
static _Atomic int retained_finished;

int async_release_after(int value, AsyncCallback callback, void *data, void (*release)(void *)) {
    atomic_fetch_add(&retained_started, 1);
    int result = callback(value, data);
    release(data);
    atomic_fetch_add(&retained_finished, 1);
    return result;
}

int async_release_buffer(AsyncCallback callback, void *data, void (*release)(void *), const unsigned char *bytes, size_t length) {
    assert(length > 0);
    return async_release_after(bytes[0], callback, data, release);
}

static void retained_shutdown_check(void) {
    assert(atomic_load(&retained_started) > 0);
    assert(atomic_load(&retained_started) == atomic_load(&retained_finished));
}

void async_retained_arm_shutdown(void) {
    assert(atexit(retained_shutdown_check) == 0);
}

void async_retained_wait(void) {
    while (atomic_load(&retained_started) == 0) sched_yield();
}
