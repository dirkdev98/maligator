#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "gc_process.h"
#include "shared_memory.h"

#define CHECK(condition)                                                          \
    do {                                                                          \
        if (!(condition)) {                                                       \
            fprintf(stderr, "check failed at %d: %s\n", __LINE__, #condition);    \
            abort();                                                              \
        }                                                                         \
    } while (0)

#define PINGPONG_ROUNDS 2000
#define ADDERS 4
#define ADDS_PER_THREAD 20000

static MalSharedMemory *g_memory;

static i32 *slot(u32 index) {
    return (i32 *) (mal_shared_memory_data(g_memory) + index * 4);
}

// Strict alternation through wait/notify: a lost wakeup hangs the run, which
// the driver's timeout reports.
static void *pingpong_peer(void *arg) {
    (void) arg;
    for (i32 round = 0; round < PINGPONG_ROUNDS; round++) {
        while (mal_shared_atomic_load((byte *) slot(0), 4) != 1) {
            mal_shared_memory_wait_sync(g_memory, 0, 4, 0, INFINITY, nullptr);
        }
        mal_shared_atomic_store((byte *) slot(0), 4, 0);
        mal_shared_memory_notify(g_memory, 0, 1);
    }
    return nullptr;
}

static void *adder(void *arg) {
    (void) arg;
    for (i32 i = 0; i < ADDS_PER_THREAD; i++) {
        mal_shared_atomic_rmw((byte *) slot(1), 4, MAL_SHARED_RMW_ADD, 1);
    }
    return nullptr;
}

static MalSharedWaitInterrupt *g_interrupt;
static _Atomic(i32) g_interrupted_result = -1;

static void *interrupted_waiter(void *arg) {
    (void) arg;
    MalSharedWaitResult result = mal_shared_memory_wait_sync(g_memory, 8, 4, 0, INFINITY, g_interrupt);
    atomic_store(&g_interrupted_result, (i32) result);
    return nullptr;
}

static _Atomic(i32) g_posts;

#define TEAR_ROUNDS 200000
#define TEAR_PATTERN_A 0x0123456789abcdefull
#define TEAR_PATTERN_B 0xfedcba9876543210ull
static _Atomic(bool) g_tear_stop;

// Ordinary (Unordered) element stores racing loads must never tear an aligned
// element: every observed value is one of the two whole patterns.
static void *tear_writer(void *arg) {
    byte *element = arg;
    for (i32 i = 0; i < TEAR_ROUNDS; i++) {
        mal_shared_unordered_store(element, 8, (i & 1) ? TEAR_PATTERN_A : TEAR_PATTERN_B);
        mal_shared_unordered_store(element + 8, 4, (i & 1) ? 0x89abcdefu : 0x76543210u);
    }
    atomic_store(&g_tear_stop, true);
    return nullptr;
}

#define GROWERS 4
static MalSharedMemory *g_growable;
static _Atomic(bool) g_grow_regressed;

static void *grower(void *arg) {
    u32 step = (u32) (uintptr_t) arg;
    for (u32 length = 8 + step; length <= 4096; length += GROWERS) {
        (void) mal_shared_memory_grow(g_growable, length);
        // Another agent never observes the published length moving backwards.
        u32 seen = mal_shared_memory_byte_length(g_growable);
        u32 again = mal_shared_memory_byte_length(g_growable);
        if (again < seen) {
            atomic_store(&g_grow_regressed, true);
        }
    }
    return nullptr;
}

#define ADMITTERS 8
static _Atomic(i32) g_admitted;
static MalSharedMemory *g_admitted_memory[ADMITTERS];

static void *admitter(void *arg) {
    uintptr_t index = (uintptr_t) arg;
    g_admitted_memory[index] = mal_shared_memory_new(1024, 1024, false);
    if (g_admitted_memory[index] != nullptr) {
        atomic_fetch_add(&g_admitted, 1);
    }
    return nullptr;
}

static void count_post(void *owner, MalSharedAsyncWaiter *waiter) {
    (void) owner;
    CHECK(mal_shared_async_waiter_result(waiter) == MAL_SHARED_WAIT_OK);
    atomic_fetch_add(&g_posts, 1);
    mal_shared_async_waiter_release(waiter);
}

// Prints the cap MAL_SHARED_MEMORY_MAX_BYTES configured; the driver checks it.
static int report_limit(void) {
    printf("limit %llu\n", (unsigned long long) mal_shared_memory_limit());
    return 0;
}

// An explicit limit set before the first allocation replaces the environment.
static int override_limit(void) {
    mal_shared_memory_set_limit(4096);
    CHECK(mal_shared_memory_limit() == 4096);
    CHECK(mal_shared_memory_new(4097, 4097, false) == nullptr);
    CHECK(mal_shared_memory_new(1, 8192, true) == nullptr);
    MalSharedMemory *fits = mal_shared_memory_new(1, 4096, true);
    CHECK(fits != nullptr);
    CHECK(mal_shared_memory_new(1, 1, false) == nullptr);
    mal_shared_memory_release(fits);
    CHECK(mal_shared_memory_live_bytes() == 0);
    printf("override PASS\n");
    return 0;
}

int main(int argc, char **argv) {
    if (argc > 1 && strcmp(argv[1], "limit") == 0) {
        return report_limit();
    }
    if (argc > 1 && strcmp(argv[1], "override") == 0) {
        return override_limit();
    }
    // One process charge per backing for its whole reservation, released by
    // the last reference rather than by each wrapper's release.
    usize process_bytes = mal_gc_process_bytes();
    g_memory = mal_shared_memory_new(16, 64, true);
    CHECK(g_memory != nullptr);
    CHECK(mal_gc_process_bytes() == process_bytes + 64);
    mal_shared_memory_retain(g_memory);
    mal_shared_memory_release(g_memory);
    CHECK(mal_gc_process_bytes() == process_bytes + 64);
    MalSharedMemory *transient = mal_shared_memory_new(8, 8, false);
    CHECK(transient != nullptr);
    CHECK(mal_gc_process_bytes() == process_bytes + 72);
    mal_shared_memory_release(transient);
    CHECK(mal_gc_process_bytes() == process_bytes + 64);
    CHECK(mal_shared_memory_byte_length(g_memory) == 16);
    CHECK(mal_shared_memory_grow(g_memory, 32));
    CHECK(!mal_shared_memory_grow(g_memory, 24));
    CHECK(!mal_shared_memory_grow(g_memory, 65));
    CHECK(mal_shared_memory_byte_length(g_memory) == 32);

    pthread_t peer;
    pthread_create(&peer, nullptr, pingpong_peer, nullptr);
    for (i32 round = 0; round < PINGPONG_ROUNDS; round++) {
        mal_shared_atomic_store((byte *) slot(0), 4, 1);
        mal_shared_memory_notify(g_memory, 0, 1);
        while (mal_shared_atomic_load((byte *) slot(0), 4) != 0) {
            mal_shared_memory_wait_sync(g_memory, 0, 4, 1, INFINITY, nullptr);
        }
    }
    pthread_join(peer, nullptr);

    pthread_t adders[ADDERS];
    for (i32 i = 0; i < ADDERS; i++) {
        pthread_create(&adders[i], nullptr, adder, nullptr);
    }
    for (i32 i = 0; i < ADDERS; i++) {
        pthread_join(adders[i], nullptr);
    }
    CHECK(mal_shared_atomic_load((byte *) slot(1), 4) == (u64) ADDERS * ADDS_PER_THREAD);

    CHECK(mal_shared_memory_wait_sync(g_memory, 4, 4, 7, 0, nullptr) == MAL_SHARED_WAIT_NOT_EQUAL);
    CHECK(mal_shared_memory_wait_sync(g_memory, 4, 4, 0, 5, nullptr) == MAL_SHARED_WAIT_TIMED_OUT);

    g_interrupt = mal_shared_wait_interrupt_new();
    pthread_t interrupted;
    pthread_create(&interrupted, nullptr, interrupted_waiter, nullptr);
    struct timespec pause = {.tv_sec = 0, .tv_nsec = 20 * 1000 * 1000};
    nanosleep(&pause, nullptr);
    mal_shared_wait_interrupt_signal(g_interrupt);
    pthread_join(interrupted, nullptr);
    CHECK(atomic_load(&g_interrupted_result) == MAL_SHARED_WAIT_INTERRUPTED);
    mal_shared_wait_interrupt_free(g_interrupt);

    // Async waiters: one notified, one cancelled; neither holds a thread.
    MalSharedWaitResult result;
    MalSharedAsyncWaiter *notified =
        mal_shared_memory_wait_async(g_memory, 12, 4, 0, count_post, nullptr, 1, &result);
    MalSharedAsyncWaiter *cancelled =
        mal_shared_memory_wait_async(g_memory, 12, 4, 0, count_post, nullptr, 2, &result);
    CHECK(notified != nullptr && cancelled != nullptr);
    CHECK(mal_shared_memory_wait_async(g_memory, 12, 4, 9, count_post, nullptr, 3, &result) == nullptr);
    CHECK(result == MAL_SHARED_WAIT_NOT_EQUAL);
    CHECK(mal_shared_memory_notify(g_memory, 12, 1) == 1);
    CHECK(atomic_load(&g_posts) == 1);
    CHECK(!mal_shared_async_waiter_cancel(notified, MAL_SHARED_WAIT_TIMED_OUT));
    CHECK(mal_shared_async_waiter_cancel(cancelled, MAL_SHARED_WAIT_TIMED_OUT));
    CHECK(mal_shared_async_waiter_result(cancelled) == MAL_SHARED_WAIT_TIMED_OUT);
    CHECK(mal_shared_memory_notify(g_memory, 12, 1) == 0);
    mal_shared_async_waiter_release(notified);
    mal_shared_async_waiter_release(cancelled);

    u64 live = mal_shared_memory_live_bytes();
    CHECK(live >= 64);
    mal_shared_memory_retain(g_memory);
    mal_shared_memory_release(g_memory);
    CHECK(mal_shared_memory_live_bytes() == live);
    mal_shared_memory_release(g_memory);
    CHECK(mal_shared_memory_live_bytes() == live - 64);
    CHECK(mal_gc_process_bytes() == process_bytes);

    mal_shared_memory_set_limit(mal_shared_memory_live_bytes() + 8);
    CHECK(mal_shared_memory_limit() == mal_shared_memory_live_bytes() + 8);
    CHECK(mal_shared_memory_new(16, 16, false) == nullptr);
    CHECK(mal_gc_process_bytes() == process_bytes);
    MalSharedMemory *empty = mal_shared_memory_new(0, 0, false);
    CHECK(empty != nullptr);
    mal_shared_memory_release(empty);
    mal_shared_memory_set_limit(0);
    CHECK(mal_shared_memory_limit() == 0);

    // A growable backing is charged its full reservation up front.
    u64 before_growable = mal_shared_memory_live_bytes();
    MalSharedMemory *reserved = mal_shared_memory_new(8, 4096, true);
    CHECK(reserved != nullptr);
    CHECK(mal_shared_memory_live_bytes() == before_growable + 4096);
    mal_shared_memory_release(reserved);
    CHECK(mal_shared_memory_live_bytes() == before_growable);

    // Concurrent admissions never overshoot the cap: exactly 3 of 8 KiB fit.
    u64 base = mal_shared_memory_live_bytes();
    mal_shared_memory_set_limit(base + 3 * 1024 + 512);
    pthread_t admitters[ADMITTERS];
    for (uintptr_t i = 0; i < ADMITTERS; i++) {
        pthread_create(&admitters[i], nullptr, admitter, (void *) i);
    }
    for (i32 i = 0; i < ADMITTERS; i++) {
        pthread_join(admitters[i], nullptr);
    }
    CHECK(atomic_load(&g_admitted) == 3);
    CHECK(mal_shared_memory_live_bytes() == base + 3 * 1024);
    for (i32 i = 0; i < ADMITTERS; i++) {
        mal_shared_memory_release(g_admitted_memory[i]);
    }
    CHECK(mal_shared_memory_live_bytes() == base);
    mal_shared_memory_set_limit(0);

    // Racing growers: monotonic publication, final length is the largest request.
    g_growable = mal_shared_memory_new(8, 4096, true);
    CHECK(g_growable != nullptr);
    pthread_t growers[GROWERS];
    for (uintptr_t i = 0; i < GROWERS; i++) {
        pthread_create(&growers[i], nullptr, grower, (void *) i);
    }
    for (i32 i = 0; i < GROWERS; i++) {
        pthread_join(growers[i], nullptr);
    }
    CHECK(!atomic_load(&g_grow_regressed));
    CHECK(mal_shared_memory_byte_length(g_growable) == 4096);
    // Bytes exposed by growth read as zero.
    CHECK(mal_shared_unordered_load(mal_shared_memory_data(g_growable) + 4088, 8) == 0);
    mal_shared_memory_release(g_growable);

    // Tear-freedom of ordinary 8- and 4-byte element accesses under a racing writer.
    MalSharedMemory *tear = mal_shared_memory_new(16, 16, false);
    CHECK(tear != nullptr);
    byte *element = mal_shared_memory_data(tear);
    mal_shared_unordered_store(element, 8, TEAR_PATTERN_A);
    mal_shared_unordered_store(element + 8, 4, 0x89abcdefu);
    pthread_t writer;
    pthread_create(&writer, nullptr, tear_writer, element);
    while (!atomic_load(&g_tear_stop)) {
        u64 wide = mal_shared_unordered_load(element, 8);
        u64 narrow = mal_shared_unordered_load(element + 8, 4);
        CHECK(wide == TEAR_PATTERN_A || wide == TEAR_PATTERN_B);
        CHECK(narrow == 0x89abcdefu || narrow == 0x76543210u);
    }
    pthread_join(writer, nullptr);
    mal_shared_memory_release(tear);

    // Overlapping shared moves keep memmove results in both directions.
    MalSharedMemory *moves = mal_shared_memory_new(16, 16, false);
    byte *bytes = mal_shared_memory_data(moves);
    for (u32 i = 0; i < 16; i++) {
        mal_shared_unordered_store(bytes + i, 1, i);
    }
    mal_shared_bytes_move(bytes + 2, bytes, 8);
    for (u32 i = 0; i < 8; i++) {
        CHECK(mal_shared_unordered_load(bytes + 2 + i, 1) == i);
    }
    mal_shared_bytes_move(bytes, bytes + 2, 8);
    for (u32 i = 0; i < 8; i++) {
        CHECK(mal_shared_unordered_load(bytes + i, 1) == i);
    }
    mal_shared_bytes_fill(bytes + 4, 0xAA, 4);
    CHECK(mal_shared_unordered_load(bytes + 4, 4) == 0xAAAAAAAAu);
    CHECK(mal_shared_unordered_load(bytes + 8, 1) == 8);
    byte snapshot[4];
    mal_shared_bytes_read(snapshot, bytes, 4);
    CHECK(snapshot[0] == 0 && snapshot[3] == 3);
    const byte replacement[2] = {0x55, 0x66};
    mal_shared_bytes_write(bytes + 14, replacement, 2);
    CHECK(mal_shared_unordered_load(bytes + 14, 1) == 0x55);
    CHECK(mal_shared_unordered_load(bytes + 15, 1) == 0x66);
    mal_shared_memory_release(moves);

    printf("shared-memory-atomics PASS\n");
    return 0;
}
