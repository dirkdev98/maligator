#include "values.h"
#include <stdlib.h>
#include <pthread.h>
#include <stdatomic.h>
#include <assert.h>
#include <sched.h>
#include <time.h>
#include <string.h>

Immutable immutable_fixed = {77, {78, 79}, {80, 81}, {82}, {{83, 84}, {85, 86}}};
Immutable a_make(int seed) {
    Immutable value = {seed, {seed + 1, seed + 2}, {seed + 3, seed + 4}, {seed + 5}, {{seed + 6, seed + 7}, {seed + 8, seed + 9}}};
    return value;
}
static _Atomic int taken;
int immutable_taken(void) { return taken; }
int a_take_before(Before value) { taken++; return value.value; }
int z_take(Immutable value) {
    taken++;
    return value.code + value.nested.value + value.nested.writable + value.samples[0] + value.samples[1] + value.promoted + value.points[0].value + value.points[0].writable + value.points[1].value + value.points[1].writable;
}
int immutable_array(const Immutable *values, size_t count) {
    if (count > 0 && (uintptr_t)values % _Alignof(Immutable) != 0) abort();
    int sum = 0;
    for (size_t index = 0; index < count; index++) sum += z_take(values[index]);
    return sum;
}
int immutable_bits_take(ImmutableBits value) { taken++; return (int)value.code + value.payload; }
ImmutableChoice immutable_choice_int(int value) { return (ImmutableChoice){.integer = value}; }
int immutable_choice_take_int(ImmutableChoice value) { return value.integer; }
ImmutableChoice immutable_choice_record(int seed) { return (ImmutableChoice){.record = a_make(seed)}; }
int immutable_choice_take_record(ImmutableChoice value) { return z_take(value.record); }
ImmutableChoice immutable_choice_array(int seed) { return (ImmutableChoice){.samples = {seed, seed + 1}}; }
int immutable_choice_take_array(ImmutableChoice value) { return value.samples[0] + value.samples[1]; }
void immutable_choice_out(int seed, ImmutableChoice *value) {
    if ((uintptr_t)value % _Alignof(ImmutableChoice) != 0) abort();
    ImmutableChoice native = immutable_choice_record(seed);
    memcpy(value, &native, sizeof(native));
}
void immutable_choice_inout(ImmutableChoice *value) {
    if ((uintptr_t)value % _Alignof(ImmutableChoice) != 0) abort();
    value->record.nested.writable += 100;
}
int immutable_choice_sum(const ImmutableChoice *values, size_t count) {
    if (count > 0 && (uintptr_t)values % _Alignof(ImmutableChoice) != 0) abort();
    int sum = 0;
    for (size_t index = 0; index < count; index++) sum += values[index].integer;
    return sum;
}
int immutable_envelope_take(ImmutableEnvelope value) { return value.id + value.payload.integer; }
void immutable_out(Immutable *value) {
    if ((uintptr_t)value % _Alignof(Immutable) != 0) abort();
    Immutable native = a_make(21);
    memcpy(value, &native, sizeof(native));
    taken++;
}
void immutable_inout(Immutable *value) {
    if ((uintptr_t)value % _Alignof(Immutable) != 0) abort();
    value->nested.writable += 100;
    taken++;
}
void immutable_array_out(Immutable (*value)[2]) {
    if ((uintptr_t)value % _Alignof(ImmutablePair) != 0) abort();
    Immutable native[2] = { a_make(31), a_make(41) };
    memcpy(value, native, sizeof(native));
}
void immutable_pair_out(ImmutablePair *value) { immutable_array_out(value); }
void immutable_pair_inout(ImmutablePair *value) {
    if ((uintptr_t)value % _Alignof(ImmutablePair) != 0) abort();
    (*value)[0].nested.writable += 100;
    (*value)[1].nested.writable += 200;
    taken++;
}
void immutable_numbers_out(ImmutableNumbers *value) {
    const int native[2] = {17, 23};
    memcpy(value, native, sizeof(native));
}
void immutable_grid_out(ImmutableGrid *value) {
    const int native[2][2] = {{2, 3}, {5, 7}};
    memcpy(value, native, sizeof(native));
}
void immutable_grid_inout(ImmutableGrid *value) {
    if ((*value)[0][0] != 11 || (*value)[0][1] != 13 || (*value)[1][0] != 17 || (*value)[1][1] != 19) abort();
    taken++;
}
Before z_make_before(int seed) { return (Before){seed + 10}; }
static int token_destroyed;
static int token_destroy_sum;
ImmutableToken immutable_token_make(int seed) { return (ImmutableToken){seed, seed + 1}; }
ImmutableToken immutable_token_borrow(void) { return (ImmutableToken){99, 100}; }
void immutable_token_destroy(ImmutableToken value) { token_destroyed++; token_destroy_sum += value.token; }
int immutable_token_destroyed(void) { return token_destroyed; }
int immutable_token_destroy_sum(void) { return token_destroy_sum; }
uintptr_t immutable_token_address(const ImmutableToken *value) { return (uintptr_t)value; }
int immutable_token_consume(ImmutableToken value) { return value.token + value.detail; }
int immutable_token_array(const ImmutableToken *values, size_t count) {
    if (count > 0 && (uintptr_t)values % _Alignof(ImmutableToken) != 0) abort();
    int sum = 0;
    for (size_t index = 0; index < count; index++) sum += immutable_token_consume(values[index]);
    return sum;
}
int immutable_token_with_callback(ImmutableToken value, void (*callback)(void *), void *data) { callback(data); return value.token + value.detail; }
void immutable_token_set(ImmutableToken *value, int detail) { value->detail = detail; }
void immutable_token_visit(int seed, void (*callback)(ImmutableToken, void *), void *data) { callback(immutable_token_make(seed), data); }
void immutable_token_out(int seed, ImmutableToken *value) {
    if ((uintptr_t)value % _Alignof(ImmutableToken) != 0) abort();
    ImmutableToken native = immutable_token_make(seed);
    memcpy(value, &native, sizeof(native));
}
void immutable_token_out_visit(int seed, ImmutableToken *value, void (*callback)(void *), void *data) { immutable_token_out(seed, value); callback(data); }
int immutable_visit(int seed, int (*callback)(Immutable, void *), void *data) {
    return callback(a_make(seed), data) + seed;
}
void immutable_notify(int seed, void (*callback)(Immutable, void *), void *data,
    void (*release)(void *)) {
    callback(a_make(seed), data);
    release(data);
}

Immutable immutable_callback_result(Immutable (*callback)(void)) { return callback(); }
ImmutableChoice immutable_choice_callback(ImmutableChoice (*callback)(void)) { return callback(); }
static _Atomic int callback_zeroes;
int immutable_callback_zeroes(void) { return atomic_load(&callback_zeroes); }
int immutable_callback_check(Immutable (*callback)(int, void *), void *data) {
    int sum = 0;
    for (int i = 0; i < 2; i++) {
        Immutable result = callback(i, data);
        int value = z_take(result);
        if (value == 0) atomic_fetch_add(&callback_zeroes, 1);
        sum += value;
    }
    return sum;
}
typedef struct { Immutable (*callback)(int, void *); void *data; int index; int sum; } ImmutableCallbackJob;
static void *immutable_callback_job(void *data) {
    ImmutableCallbackJob *job = data;
    Immutable result = job->callback(job->index, job->data);
    job->sum = z_take(result);
    return NULL;
}
int immutable_callback_parallel(Immutable (*callback)(int, void *), void *data, void (*release)(void *)) {
    ImmutableCallbackJob jobs[2] = {{callback, data, 0, 0}, {callback, data, 1, 0}};
    pthread_t threads[2];
    for (int i = 0; i < 2; i++) if (pthread_create(&threads[i], NULL, immutable_callback_job, &jobs[i]) != 0) abort();
    for (int i = 0; i < 2; i++) if (pthread_join(threads[i], NULL) != 0) abort();
    release(data);
    return jobs[0].sum + jobs[1].sum;
}

static _Atomic int callback_started;
static _Atomic int callback_released;
static int callback_shutdown_checked;
static void immutable_verify_shutdown(void) { assert(callback_shutdown_checked); }
static void *immutable_release_later(void *unused) {
    (void)unused;
    struct timespec delay = {.tv_nsec = 50000000};
    nanosleep(&delay, NULL);
    atomic_store(&callback_released, 1);
    return NULL;
}
void immutable_callback_shutdown(Immutable (*callback)(int, void *), void *data) {
    Immutable result = callback(0, data);
    assert(z_take(result) == 175);
    if (atexit(immutable_verify_shutdown) != 0) abort();
    pthread_t thread;
    if (pthread_create(&thread, NULL, immutable_release_later, NULL) != 0) abort();
    while (!atomic_load(&callback_released)) sched_yield();
    assert(z_take(result) == 175);
    callback_shutdown_checked = 1;
    if (pthread_join(thread, NULL) != 0) abort();
}
void immutable_callback_cancel(Immutable (*callback)(int, void *), void *data) {
    Immutable first = callback(0, data);
    assert(z_take(first) == 175);
    if (atexit(immutable_verify_shutdown) != 0) abort();
    atomic_store(&callback_started, 1);
    Immutable canceled = callback(1, data);
    assert(z_take(canceled) == 0 && z_take(first) == 175);
    callback_shutdown_checked = 1;
}
void immutable_callback_wait_started(void) { while (!atomic_load(&callback_started)) sched_yield(); }

static _Atomic(Immutable (*)(int)) immutable_replacement;
void immutable_callback_replace(Immutable (*callback)(int)) { atomic_store(&immutable_replacement, callback); }
Immutable immutable_callback_replaced(int index) {
    Immutable (*callback)(int) = atomic_load(&immutable_replacement);
    return callback == NULL ? (Immutable){} : callback(index);
}

void immutable_pair_many(ImmutablePair *value, size_t count) { for (size_t i = 0; i < count; i++) for (int j = 0; j < 2; j++) value[i][j].nested.writable += 100; }
