#include "close.h"
#include <assert.h>
#include <pthread.h>
#include <stdlib.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <sched.h>

static CloseBase *pending;
static void (*completion)(CloseBase *);

void close_now(CloseBase *handle, void (*done)(CloseBase *)) { done(handle); }
void close_later(CloseBase *handle, void (*done)(CloseBase *)) {
    assert(pending == NULL);
    pending = handle;
    completion = done;
}
void close_flush(void) {
    CloseBase *handle = pending;
    void (*done)(CloseBase *) = completion;
    pending = NULL;
    completion = NULL;
    if (done != NULL) done(handle);
}
static void *complete_foreign(void *unused) {
    (void) unused;
    close_flush();
    return NULL;
}
void close_foreign(CloseBase *handle, void (*done)(CloseBase *)) {
    close_later(handle, done);
    pthread_t thread;
    if (pthread_create(&thread, NULL, complete_foreign, NULL) != 0) abort();
    if (pthread_join(thread, NULL) != 0) abort();
}
extern size_t mal_gc_process_bytes(void);
static void after_vm(void) {
    CloseState *state = (CloseState *) pending;
    for (size_t index = 0; index < state->length; index++) assert(state->bytes[index] == 71);
    assert(mal_gc_process_bytes() >= state->length);
    pthread_t thread;
    if (pthread_create(&thread, NULL, complete_foreign, NULL) != 0) abort();
    if (pthread_join(thread, NULL) != 0) abort();
    assert(mal_gc_process_bytes() == 0);
}
void close_after_vm(CloseBase *handle, void (*done)(CloseBase *)) {
    close_later(handle, done);
    if (atexit(after_vm) != 0) abort();
}
void close_data(CloseBase *handle, void (*done)(void *, int), void *data) {
    (void) handle;
    done(data, 17);
}
int close_read(CloseBase *handle) { return handle->tag; }
void close_visit(CloseBase *handle, void (*visit)(CloseBase *, void *), void *data) {
    visit(handle, data);
}
void close_lend(void (*visit)(CloseBase *, void *), void *data) {
    static CloseBase handle = {41};
    visit(&handle, data);
}
int close_status(CloseBase *handle, void (*done)(CloseBase *)) { done(handle); return 0; }
void close_wrong(CloseBase *handle, void (*done)(CloseOther *)) { (void) handle; (void) done; }
void close_missing(CloseBase *handle, void (*done)(int)) { (void) handle; (void) done; }
static CloseBase reused;
static void (*reused_callback)(CloseBase *);
CloseBase *close_reused_open(void) { return &reused; }
void close_reused_set(CloseBase *handle, void (*callback)(CloseBase *)) {
    assert(handle == &reused);
    reused_callback = callback;
}
void close_reused_emit(void) { reused_callback(&reused); }
static _Atomic bool keyed_started;
static void *detached_keyed_calls(void *unused) {
    (void) unused;
    atomic_store(&keyed_started, true);
    for (int index = 0; index < 4096; index++) reused_callback(&reused);
    return NULL;
}
static void after_vm_keyed(void) {
    pthread_t thread;
    if (pthread_create(&thread, NULL, detached_keyed_calls, NULL) != 0) abort();
    while (!atomic_load(&keyed_started)) sched_yield();
    close_flush();
    if (pthread_join(thread, NULL) != 0) abort();
}
void close_reused_after_vm(CloseBase *handle, void (*done)(CloseBase *)) {
    close_later(handle, done);
    if (atexit(after_vm_keyed) != 0) abort();
}
void close_with_error(CloseBase *handle, void (*before)(void *), void *data, void (*done)(CloseBase *)) {
    before(data);
    done(handle);
}
