#include "worker.h"
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

struct WorkerResource {
    int value;
    void (*callback)(int, void *);
    void *data;
    void (*release)(void *);
    bool emit;
};
struct RetryResource { int attempts; };
struct ReusedResource { int value; void (*callback)(ReusedResource *); };
static struct ReusedResource reused;
static bool reused_live;
static _Atomic int live;
static _Atomic int started;
static _Atomic int finished;
static _Atomic bool held;

static void pause_ms(long milliseconds) {
    struct timespec delay = {0, milliseconds * 1000000};
    nanosleep(&delay, NULL);
}

WorkerResource *worker_open(int value) {
    WorkerResource *resource = calloc(1, sizeof(*resource));
    if (resource != NULL) { resource->value = value; live++; }
    return resource;
}
int worker_value(WorkerResource *resource) { return resource->value; }
int worker_close(WorkerResource *resource) {
    started++;
    while (held) pause_ms(1);
    if (resource->emit && resource->callback != NULL) resource->callback(resource->value, resource->data);
    if (resource->release != NULL) resource->release(resource->data);
    free(resource);
    live--;
    finished++;
    return 7;
}
void worker_watch(WorkerResource *resource, void (*callback)(int, void *), void *data, void (*release)(void *)) {
    resource->callback = callback; resource->data = data; resource->release = release; resource->emit = true;
}
void worker_watch_direct(WorkerResource *resource, void (*callback)(int, void *), void *data, void (*release)(void *)) {
    worker_watch(resource, callback, data, release); resource->emit = false;
}
ReusedResource *worker_reused_open(int value) {
    if (reused_live) abort();
    reused_live = true; reused.value = value; reused.callback = NULL; live++;
    return &reused;
}
ReusedResource *worker_reused_alias(void) { return &reused; }
int worker_reused_value(ReusedResource *resource) { return resource->value; }
void worker_reused_close(ReusedResource *resource) {
    (void) resource;
    reused_live = false; live--;
    // Completion remains pending after the address becomes available to a new resource.
    started++;
    while (held) pause_ms(1);
    finished++;
}
void worker_reused_listen(ReusedResource *resource, void (*callback)(ReusedResource *)) { resource->callback = callback; }
void worker_reused_emit(ReusedResource *resource) { if (resource->callback != NULL) resource->callback(resource); }
RetryResource *worker_retry_open(int attempts) {
    RetryResource *resource = malloc(sizeof(*resource));
    if (resource != NULL) { resource->attempts = attempts; live++; }
    return resource;
}
int worker_retry_left(RetryResource *resource) { return resource->attempts; }
bool worker_retry_close(RetryResource *resource) {
    if (resource->attempts > 0) { resource->attempts--; return false; }
    free(resource);
    live--;
    return true;
}
int worker_live(void) { return live; }
void worker_hold(void) { started = 0; finished = 0; held = true; }
static void *unblock(void *data) {
    (void) data;
    pause_ms(30);
    held = false;
    return NULL;
}
void worker_unblock_later(void) {
    pthread_t thread;
    if (pthread_create(&thread, NULL, unblock, NULL) != 0) abort();
    if (pthread_detach(thread) != 0) abort();
}
void worker_wait_started(void) { while (started == 0) pause_ms(1); }
void worker_wait_finished(void) { while (finished == 0) pause_ms(1); }
static void check_shutdown(void) {
    if (live != 0) abort();
    fputs("worker cleanup complete\n", stderr);
}
void worker_expect_clean_shutdown(void) { if (atexit(check_shutdown) != 0) abort(); }
