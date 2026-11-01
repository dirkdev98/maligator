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
extern size_t mal_gc_process_bytes(void);

struct ResultResource { int value; };
struct ResultManual { int value; };
static int manuals_freed;
ResultManual *result_manual_new(void) {
    ResultManual *manual = malloc(sizeof(*manual));
    if (manual == NULL) abort();
    manual->value = 91;
    return manual;
}
void result_manual_free(ResultManual *manual) { manuals_freed++; free(manual); }
ResultStateBase *result_state_base(ResultState *state) { return &state->base; }
int result_state_tag(ResultStateBase *state) { return state->tag; }
static _Atomic int resources_freed;
ResultResource *result_resource_new(int value) {
    ResultResource *resource = malloc(sizeof(*resource));
    if (resource == NULL) abort();
    resource->value = value;
    return resource;
}
void result_resource_free(ResultResource *resource) {
    atomic_fetch_add(&resources_freed, 1);
    free(resource);
}
ResultResource *result_resource_borrow(int value) { return result_resource_new(value); }
ResultResource *result_resource_own(ResultResource *resource) { return resource; }
int result_resource_value(ResultResource *resource) { return resource->value; }
int result_resource_freed(void) { return atomic_load(&resources_freed); }
ResultResource *result_handle(ResultResource *(*callback)(int, void *), void *data) {
    ResultResource *first = callback(0, data);
    if (first == NULL) return NULL;
    ResultResource *second = callback(1, data);
    if (second == NULL) return NULL;
    assert(first->value == 77 && second->value == 88);
    return first;
}
ResultState *result_state(ResultState *(*callback)(int, void *), void *data) {
    ResultState *first = callback(0, data);
    if (first == NULL) return NULL;
    ResultState *second = callback(1, data);
    if (second == NULL) return NULL;
    assert(first->length == 3 && first->bytes[0] == 5 && first->bytes[1] == 0 && first->bytes[2] == 7);
    assert(first->text_length == 5 && memcmp(first->text, "Gr\xc3\xbc\0", 5) == 0);
    return first;
}
void result_lend_handle(ResultResource *(*callback)(ResultResource *, void *), void *data) {
    ResultResource resource = {.value = 77};
    assert(callback(&resource, data) == NULL);
}

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
static void verify_handle_shutdown(void) {
    assert(shutdown_checked && atomic_load(&resources_freed) == 1);
    assert(mal_gc_process_bytes() == 0);
}
void result_handles_shutdown(ResultResource *(*resource)(void *), void *resource_data,
    ResultState *(*state)(void *), void *state_data) {
    ResultResource *kept_resource = resource(resource_data);
    ResultState *kept_state = state(state_data);
    assert(kept_resource != NULL && kept_state != NULL);
    if (atexit(verify_handle_shutdown) != 0) abort();
    pthread_t thread;
    if (pthread_create(&thread, NULL, release_later, NULL) != 0) abort();
    while (!atomic_load(&released)) sched_yield();
    assert(atomic_load(&resources_freed) == 0 && kept_resource->value == 77);
    assert(kept_state->length == 3 && kept_state->bytes[0] == 5 && kept_state->bytes[2] == 7);
    assert(kept_state->text_length == 5 && memcmp(kept_state->text, "Gr\xc3\xbc\0", 5) == 0);
    shutdown_checked = true;
    if (pthread_join(thread, NULL) != 0) abort();
}
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

static const char *(*retained_callback)(int, void *);
static void *retained_data;
static void (*retained_release)(void *);
static const char *retained_text[2];
void result_retain(const char *(*callback)(int, void *), void *data, void (*release)(void *)) {
    assert(retained_callback == NULL);
    retained_callback = callback;
    retained_data = data;
    retained_release = release;
}
const char *result_retained_call(int index) {
    assert(index >= 0 && index < 2 && retained_callback != NULL);
    const char *result = retained_callback(index, retained_data);
    retained_text[index] = result;
    return result;
}
int result_retained_matches(const char *first, const char *second) {
    return retained_text[0] != NULL && retained_text[1] != NULL
        && strcmp(retained_text[0], first) == 0 && strcmp(retained_text[1], second) == 0;
}
void result_retained_clear(void) {
    void *data = retained_data;
    void (*release)(void *) = retained_release;
    retained_callback = NULL;
    retained_data = NULL;
    retained_release = NULL;
    retained_text[0] = retained_text[1] = NULL;
    if (release != NULL) release(data);
}
static const char *(*replacement_callback)(int);
void result_replace(const char *(*callback)(int)) { replacement_callback = callback; }
const char *result_replaced_call(int index) {
    return replacement_callback == NULL ? NULL : replacement_callback(index);
}

static const unsigned char *(*retained_bytes_callback)(unsigned char *, int, void *);
static void *retained_bytes_data;
static void (*retained_bytes_release)(void *);
static const unsigned char *retained_bytes[2];
static unsigned char retained_lengths[2];
void result_retain_bytes(const unsigned char *(*callback)(unsigned char *, int, void *), void *data, void (*release)(void *)) {
    assert(retained_bytes_callback == NULL);
    retained_bytes_callback = callback;
    retained_bytes_data = data;
    retained_bytes_release = release;
}
void result_retained_bytes_call(int index) {
    assert(index >= 0 && index < 2 && retained_bytes_callback != NULL);
    unsigned char length = 91;
    const unsigned char *result = retained_bytes_callback(&length, index, retained_bytes_data);
    if (result == NULL) assert(length == 0);
    retained_bytes[index] = result;
    retained_lengths[index] = length;
}
int result_retained_bytes_sum(int index) {
    assert(index >= 0 && index < 2);
    int sum = 0;
    for (int offset = 0; offset < retained_lengths[index]; offset++) sum += retained_bytes[index][offset];
    return sum;
}
void result_retained_bytes_clear(void) {
    void *data = retained_bytes_data;
    void (*release)(void *) = retained_bytes_release;
    retained_bytes_callback = NULL;
    retained_bytes_data = NULL;
    retained_bytes_release = NULL;
    retained_bytes[0] = retained_bytes[1] = NULL;
    retained_lengths[0] = retained_lengths[1] = 0;
    if (release != NULL) release(data);
}
static void retained_after_vm(void) {
    assert(result_retained_matches("late-first", "late-second"));
    assert(result_retained_bytes_sum(0) == 12 && result_retained_bytes_sum(1) == 9);
    assert(mal_gc_process_bytes() == 0);
    assert(retained_callback(0, retained_data) == NULL);
    unsigned char length = 91;
    assert(retained_bytes_callback(&length, 0, retained_bytes_data) == NULL && length == 0);
    result_retained_clear();
    result_retained_bytes_clear();
}
void result_retained_after_vm(void) { if (atexit(retained_after_vm) != 0) abort(); }

static ResultResource *(*kept_resource_callback)(int, void *);
static void *kept_resource_data;
static void (*kept_resource_release)(void *);
static ResultResource *kept_resource;
void result_keep_resource(ResultResource *(*callback)(int, void *), void *data, void (*release)(void *)) {
    assert(kept_resource_callback == NULL);
    kept_resource_callback = callback;
    kept_resource_data = data;
    kept_resource_release = release;
}
ResultResource *result_kept_resource_call(int index) {
    kept_resource = kept_resource_callback(index, kept_resource_data);
    return kept_resource;
}
void result_kept_resource_clear(void) {
    void *data = kept_resource_data;
    void (*release)(void *) = kept_resource_release;
    kept_resource = NULL;
    kept_resource_callback = NULL;
    kept_resource_data = NULL;
    kept_resource_release = NULL;
    if (release != NULL) release(data);
}
static ResultState *(*kept_state_callback)(int, void *);
static void *kept_state_data;
static void (*kept_state_release)(void *);
static ResultState *kept_state;
void result_keep_state(ResultState *(*callback)(int, void *), void *data, void (*release)(void *)) {
    assert(kept_state_callback == NULL);
    kept_state_callback = callback;
    kept_state_data = data;
    kept_state_release = release;
}
ResultState *result_kept_state_call(int index) {
    kept_state = kept_state_callback(index, kept_state_data);
    return kept_state;
}
void result_kept_state_clear(void) {
    void *data = kept_state_data;
    void (*release)(void *) = kept_state_release;
    kept_state = NULL;
    kept_state_callback = NULL;
    kept_state_data = NULL;
    kept_state_release = NULL;
    if (release != NULL) release(data);
}
static ResultResource *(*replacement_resource_callback)(int);
void result_replace_resource(ResultResource *(*callback)(int)) { replacement_resource_callback = callback; }
ResultResource *result_replaced_resource_call(int index) {
    return replacement_resource_callback(index);
}
static void *release_kept_handles(void *unused) {
    (void) unused;
    result_kept_resource_clear();
    result_kept_state_clear();
    return NULL;
}
static ResultManual *(*kept_manual_callback)(void *);
static void *kept_manual_data;
static void (*kept_manual_release)(void *);
static ResultManual *kept_manual;
void result_keep_manual(ResultManual *(*callback)(void *), void *data, void (*release)(void *)) {
    kept_manual_callback = callback;
    kept_manual_data = data;
    kept_manual_release = release;
}
void result_kept_manual_call(void) { kept_manual = kept_manual_callback(kept_manual_data); }
static void kept_handles_after_vm(void) {
    assert(atomic_load(&resources_freed) == 0 && kept_resource->value == 77);
    assert(kept_state->length == 3 && kept_state->bytes[0] == 5 && kept_state->bytes[2] == 7);
    assert(kept_state->text_length == 5 && memcmp(kept_state->text, "Gr\xc3\xbc\0", 5) == 0);
    assert(mal_gc_process_bytes() >= 8);
    assert(kept_resource_callback(0, kept_resource_data) == NULL);
    assert(kept_state_callback(0, kept_state_data) == NULL);
    pthread_t thread;
    if (pthread_create(&thread, NULL, release_kept_handles, NULL) != 0) abort();
    if (pthread_join(thread, NULL) != 0) abort();
    assert(atomic_load(&resources_freed) == 1 && mal_gc_process_bytes() == 0);
    assert(manuals_freed == 0 && kept_manual->value == 91);
    kept_manual_release(kept_manual_data);
    assert(manuals_freed == 0 && kept_manual->value == 91);
    result_manual_free(kept_manual);
    assert(manuals_freed == 1);
}
void result_kept_handles_after_vm(void) { if (atexit(kept_handles_after_vm) != 0) abort(); }
static ResultResource *owned_key;
static ResultResource *(*owned_callback)(ResultResource *, void *);
static void *owned_data;
void result_replace_owned(ResultResource *owner, ResultResource *(*callback)(ResultResource *, void *), void *data) {
    owned_key = owner;
    owned_callback = callback;
    owned_data = data;
}
ResultResource *result_replaced_owned_call(void) { return owned_callback(owned_key, owned_data); }
