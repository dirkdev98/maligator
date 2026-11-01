#define _POSIX_C_SOURCE 200809L
#include "results.h"
#include <assert.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <sched.h>

const char *result_text(const char *(*callback)(int, void *), void *data) {
    const char *first = callback(0, data);
    if (first == NULL) return NULL;
    const char *second = callback(1, data);
    if (second == NULL) return NULL;
    assert(first != second);
    assert(strlen(second) != 0);
    return first;
}
const char *result_required(const char *(*callback)(int, void *), void *data) {
    return result_text(callback, data);
}
const char *result_scoped(const char *(*callback)(int)) {
    const char *first = callback(0);
    const char *second = callback(1);
    if (first == NULL || second == NULL) return NULL;
    assert(first != second);
    return first;
}
const char *result_counted(const char *(*callback)(int *, int, void *), void *data, size_t *length) {
    int first_length = -1, second_length = -1;
    const char *first = callback(&first_length, 0, data);
    *length = 0;
    if (first == NULL) { assert(first_length == 0); return NULL; }
    const char *second = callback(&second_length, 1, data);
    if (second == NULL) { assert(second_length == 0); return NULL; }
    assert(first != second && second_length != 0);
    *length = (size_t) first_length;
    return first;
}
const unsigned char *result_bytes(const unsigned char *(*callback)(unsigned char *, int, void *), void *data, size_t *length) {
    unsigned char first_length = 91, second_length = 91;
    const unsigned char *first = callback(&first_length, 0, data);
    *length = 0;
    if (first == NULL) { assert(first_length == 0); return NULL; }
    const unsigned char *second = callback(&second_length, 1, data);
    if (second == NULL) { assert(second_length == 0); return NULL; }
    assert(first != second && second_length != 0);
    *length = first_length;
    return first;
}
typedef struct ResultJob {
    const char *(*callback)(int, void *);
    void *data;
    int index;
    const char *result;
} ResultJob;
static void *run_result(void *data) {
    ResultJob *job = data;
    job->result = job->callback(job->index, job->data);
    return NULL;
}
const char *result_parallel(const char *(*callback)(int, void *), void *data) {
    ResultJob jobs[] = {{callback, data, 0, NULL}, {callback, data, 1, NULL}};
    pthread_t threads[2];
    for (int index = 0; index < 2; index++)
        if (pthread_create(&threads[index], NULL, run_result, &jobs[index]) != 0) abort();
    for (int index = 0; index < 2; index++)
        if (pthread_join(threads[index], NULL) != 0) abort();
    return jobs[0].result == NULL || jobs[1].result == NULL ? NULL : jobs[0].result;
}
static _Atomic bool released;
static bool shutdown_checked;
static void *release_later(void *unused) {
    (void) unused;
    struct timespec delay = {.tv_nsec = 50000000};
    nanosleep(&delay, NULL);
    atomic_store(&released, true);
    return NULL;
}
static void verify_shutdown(void) { assert(shutdown_checked); }
void result_shutdown(const char *(*callback)(int, void *), void *data) {
    const char *text = callback(0, data);
    assert(text != NULL);
    if (atexit(verify_shutdown) != 0) abort();
    pthread_t thread;
    if (pthread_create(&thread, NULL, release_later, NULL) != 0) abort();
    while (!atomic_load(&released)) sched_yield();
    assert(strcmp(text, "native-kept") == 0);
    shutdown_checked = true;
    if (pthread_join(thread, NULL) != 0) abort();
}
void result_bad_count(const char *(*callback)(int *, int, void *), void *data) {
    assert(callback(NULL, 0, data) == NULL);
}
int result_scalar(int (*callback)(void)) { return callback(); }
static _Atomic bool cancel_started;
static bool cancel_checked;
static void verify_cancel(void) { assert(cancel_checked); }
void result_cancel(const char *(*callback)(int *, int, void *), void *data) {
    int first_length = -1, second_length = 91;
    const char *first = callback(&first_length, 0, data);
    assert(first != NULL && first_length == 4);
    if (atexit(verify_cancel) != 0) abort();
    atomic_store(&cancel_started, true);
    const char *second = callback(&second_length, 1, data);
    assert(second == NULL && second_length == 0);
    assert(memcmp(first, "kept", 4) == 0);
    cancel_checked = true;
}
void result_cancel_wait_started(void) { while (!atomic_load(&cancel_started)) sched_yield(); }
