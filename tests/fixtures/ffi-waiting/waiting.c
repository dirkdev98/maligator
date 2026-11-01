#include "waiting.h"
#include <assert.h>
#include <pthread.h>
#include <sched.h>
#include <stdatomic.h>
#include <stdlib.h>

static pthread_mutex_t registration_lock = PTHREAD_MUTEX_INITIALIZER;
static WaitingInteger integer_callback;
static WaitingRecord record_callback;
static WaitingVoid void_callback;
static WaitingKeyed keyed_callback;
static void *callback_data;
static void (*callback_release)(void *);
static pthread_t producers[4];
static int producer_count;
static int iterations;
static int record_mode;
static _Atomic int total;
static _Atomic int entered;
static _Atomic int completed;
static int expected_zero;
static int exit_registered;
static int canceled_count;

void waiting_clear(void) {
    pthread_mutex_lock(&registration_lock);
    void *data = callback_data;
    void (*release)(void *) = callback_release;
    integer_callback = NULL;
    record_callback = NULL;
    void_callback = NULL;
    callback_data = NULL;
    callback_release = NULL;
    pthread_mutex_unlock(&registration_lock);
    if (release != NULL) release(data);
}

void waiting_set_integer(WaitingInteger callback, void *data, void (*release)(void *)) {
    waiting_clear();
    pthread_mutex_lock(&registration_lock);
    integer_callback = callback;
    callback_data = data;
    callback_release = release;
    pthread_mutex_unlock(&registration_lock);
}

void waiting_set_record(WaitingRecord callback, void *data, void (*release)(void *)) {
    waiting_clear();
    pthread_mutex_lock(&registration_lock);
    record_callback = callback;
    callback_data = data;
    callback_release = release;
    pthread_mutex_unlock(&registration_lock);
}

void waiting_set_keyed(WaitingKeyed callback) {
    pthread_mutex_lock(&registration_lock);
    keyed_callback = callback;
    pthread_mutex_unlock(&registration_lock);
}

void waiting_set_void(WaitingVoid callback, void *data, void (*release)(void *)) {
    waiting_clear();
    pthread_mutex_lock(&registration_lock);
    void_callback = callback;
    callback_data = data;
    callback_release = release;
    pthread_mutex_unlock(&registration_lock);
}

int waiting_call_integer(int value) {
    pthread_mutex_lock(&registration_lock);
    WaitingInteger callback = integer_callback;
    void *data = callback_data;
    pthread_mutex_unlock(&registration_lock);
    return callback == NULL ? 0 : callback(value, data);
}

int waiting_call_keyed(int value) {
    pthread_mutex_lock(&registration_lock);
    WaitingKeyed callback = keyed_callback;
    pthread_mutex_unlock(&registration_lock);
    return callback == NULL ? 0 : callback(value);
}

static void *produce(void *index) {
    int base = (int) (size_t) index * 100;
    for (int item = 0; item < iterations; item++) {
        atomic_fetch_add(&entered, 1);
        int result;
        if (record_mode == 1) {
            WaitingPair pair = record_callback(base + item, callback_data);
            if (expected_zero) assert(pair.x == 0 && pair.y == 0);
            result = pair.x + pair.y;
        } else if (record_mode == 3) {
            void_callback(base + item, callback_data);
            result = 0;
        } else {
            result = record_mode == 2 ? waiting_call_keyed(base + item) : waiting_call_integer(base + item);
            if (expected_zero) assert(result == 0);
        }
        atomic_fetch_add(&total, result);
        atomic_fetch_add(&completed, 1);
    }
    return NULL;
}

int waiting_join(void) {
    for (int index = 0; index < producer_count; index++) {
        void *result;
        assert(pthread_join(producers[index], &result) == 0);
        if (result == PTHREAD_CANCELED) canceled_count++;
    }
    producer_count = 0;
    waiting_clear();
    return atomic_load(&total);
}

static void finish(void) {
    waiting_join();
    if (expected_zero) assert(atomic_load(&completed) > 0 && atomic_load(&total) == 0);
}

void waiting_start(int count, int threads, int record) {
    assert(producer_count == 0 && threads > 0 && threads <= 4);
    if (!exit_registered) { assert(atexit(finish) == 0); exit_registered = 1; }
    iterations = count;
    canceled_count = 0;
    record_mode = record;
    atomic_store(&total, 0);
    atomic_store(&entered, 0);
    atomic_store(&completed, 0);
    producer_count = threads;
    for (int index = 0; index < threads; index++)
        assert(pthread_create(&producers[index], NULL, produce, (void *) (size_t) index) == 0);
}

void waiting_expect_zero(void) { expected_zero = 1; }
void waiting_cancel(void) {
    assert(producer_count == 1);
    assert(pthread_cancel(producers[0]) == 0);
}
int waiting_canceled(void) { return canceled_count; }
void waiting_arm_shutdown(void) {
    waiting_expect_zero();
    waiting_start(1, 4, 0);
    while (atomic_load(&entered) != 4) sched_yield();
}
void waiting_arm_child(void) {
    waiting_expect_zero();
    assert(atexit(finish) == 0);
    atomic_store(&entered, 0);
    atomic_store(&completed, 0);
}
int waiting_child_call(void) {
    atomic_store(&entered, 1);
    int result = waiting_call_integer(7);
    assert(result == 0);
    atomic_store(&completed, 1);
    return result;
}
void waiting_wait_child(void) {
    while (atomic_load(&entered) == 0) sched_yield();
}
