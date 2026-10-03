#include "gc.h"
#include "gc_process.h"
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static pthread_mutex_t mutex = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t condition = PTHREAD_COND_INITIALIZER;
static usize ready;
static bool started;
static usize iterations;
static const char *mode;

static double now_ms(void) {
    struct timespec time;
    clock_gettime(CLOCK_MONOTONIC, &time);
    return (double) time.tv_sec * 1000.0 + (double) time.tv_nsec / 1000000.0;
}

static void *run(void *data) {
    (void) data;
    MalGcProcessParticipant *participant = mal_gc_process_register(mal_gc_current_poll_target());
    pthread_mutex_lock(&mutex);
    ready++;
    pthread_cond_broadcast(&condition);
    while (!started) pthread_cond_wait(&condition, &mutex);
    pthread_mutex_unlock(&mutex);
    if (strcmp(mode, "poll") == 0) {
        for (usize i = 0; i < iterations; i++) {
            if (mal_gc_process_take_pressure(participant)) abort();
        }
    } else if (strcmp(mode, "charge") == 0) {
        for (usize i = 0; i < iterations; i++) mal_gc_process_charge(64);
        mal_gc_process_release(iterations * 64);
    } else if (strcmp(mode, "balanced") == 0) {
        for (usize i = 0; i < iterations; i++) {
            mal_gc_process_charge(64);
            mal_gc_process_release(64);
        }
    } else {
        abort();
    }
    if (mal_gc_process_take_pressure(participant)) abort();
    mal_gc_process_unregister(participant);
    return nullptr;
}

int main(int argc, char **argv) {
    mode = argc > 1 ? argv[1] : "balanced";
    usize count = argc > 2 ? strtoull(argv[2], nullptr, 10) : 4;
    iterations = argc > 3 ? strtoull(argv[3], nullptr, 10) : 200000;
    if (count < 1 || count > 16 || iterations < 1 || iterations > 1000000 ||
        count * iterations * 64 >= mal_gc_process_budget()) return 2;
    pthread_t threads[16];
    for (usize i = 0; i < count; i++) {
        if (pthread_create(&threads[i], nullptr, run, nullptr) != 0) abort();
    }
    pthread_mutex_lock(&mutex);
    while (ready != count) pthread_cond_wait(&condition, &mutex);
    double before = now_ms();
    started = true;
    pthread_cond_broadcast(&condition);
    pthread_mutex_unlock(&mutex);
    for (usize i = 0; i < count; i++) pthread_join(threads[i], nullptr);
    double elapsed = now_ms() - before;
    if (mal_gc_process_bytes() != 0) abort();
    printf("{\"mode\":\"%s\",\"threads\":%zu,\"operations\":%zu,\"checksum\":0,\"elapsedMs\":%.6f}\n",
        mode, count, count * iterations, elapsed);
    return 0;
}
