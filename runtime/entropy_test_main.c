#include "vm.h"

#include <pthread.h>
#include <stdio.h>
#include <string.h>

#include "entropy.h"

/*
 * Direct CSPRNG-boundary acceptance test.
 *
 * Statistical checks on the JavaScript side cannot catch the failure this
 * driver exists for: a chunked platform adapter that silently returns without
 * filling the tail of a large request. So every assertion here is about the
 * *contract* — how many bytes are written, and where — rather than about the
 * distribution of the bytes.
 */

extern const MalRuntimeImage mal_runtime_image;

#define CANARY 0x5a
#define GUARD 64

/* Fill a guarded buffer and confirm the request wrote exactly its own window. */
static bool entropy_fills_exactly(usize length) {
    usize total = length + 2 * GUARD;
    byte *buffer = malloc(total);
    if (buffer == nullptr) return false;
    memset(buffer, CANARY, total);
    byte *target = buffer + GUARD;
    bool ok = mal_host_entropy(target, length) == 0;
    for (usize i = 0; ok && i < GUARD; i++) {
        ok = buffer[i] == (byte) CANARY && buffer[GUARD + length + i] == (byte) CANARY;
    }
    // A request that returned without filling the tail leaves the canary there.
    // With 256 trailing bytes still untouched the odds of a false pass are 2^-2048.
    usize untouched = 0;
    for (usize i = 0; i < length; i++) {
        if (target[i] == (byte) CANARY) untouched++;
    }
    usize tolerated = length / 128 + 8;
    ok = ok && untouched <= tolerated;
    free(buffer);
    return ok;
}

static bool entropy_zero_length_touches_nothing(void) {
    byte buffer[8];
    memset(buffer, CANARY, sizeof(buffer));
    if (mal_host_entropy(buffer, 0) != 0) return false;
    for (usize i = 0; i < sizeof(buffer); i++) {
        if (buffer[i] != (byte) CANARY) return false;
    }
    return true;
}

/* getentropy(2) refuses more than 256 bytes, so a chunked implementation that
 * miscounts truncates exactly here. */
static bool entropy_spans_the_chunk_boundary(void) {
    const usize sizes[] = {1, 255, 256, 257, 511, 512, 513, 1024};
    for (usize i = 0; i < countof(sizes); i++) {
        if (!entropy_fills_exactly(sizes[i])) return false;
    }
    return true;
}

static bool entropy_fills_a_large_request(void) {
    return entropy_fills_exactly(1024 * 1024);
}

static bool entropy_draws_differ(void) {
    byte first[64];
    byte second[64];
    return mal_host_entropy(first, sizeof(first)) == 0
        && mal_host_entropy(second, sizeof(second)) == 0
        && memcmp(first, second, sizeof(first)) != 0;
}

static bool entropy_rejects_a_null_target(void) {
    return mal_host_entropy(nullptr, 16) != 0 && mal_host_entropy_uuid(nullptr, false) != 0;
}

static bool entropy_uuid_sets_version_and_variant(void) {
    for (int i = 0; i < 256; i++) {
        u8 uuid[16];
        if (mal_host_entropy_uuid(uuid, i % 2 == 0) != 0) return false;
        if ((uuid[6] & 0xf0) != 0x40) return false;
        if ((uuid[8] & 0xc0) != 0x80) return false;
    }
    return true;
}

/* The cache must serve distinct values, and `fresh` must bypass it entirely
 * rather than consume from it. */
static bool entropy_uuid_cache_serves_distinct_values(void) {
    mal_host_entropy_cache_reset();
    u8 cached[128][16];
    for (usize i = 0; i < countof(cached); i++) {
        if (mal_host_entropy_uuid(cached[i], false) != 0) return false;
    }
    for (usize i = 0; i < countof(cached); i++) {
        for (usize j = i + 1; j < countof(cached); j++) {
            if (memcmp(cached[i], cached[j], 16) == 0) return false;
        }
    }
    // Draining the whole batch and asking for one more must refill rather than
    // repeat, and a fresh draw must not collide with the batch either.
    u8 refilled[16];
    u8 uncached[16];
    if (mal_host_entropy_uuid(refilled, false) != 0) return false;
    if (mal_host_entropy_uuid(uncached, true) != 0) return false;
    for (usize i = 0; i < countof(cached); i++) {
        if (memcmp(cached[i], refilled, 16) == 0) return false;
        if (memcmp(cached[i], uncached, 16) == 0) return false;
    }
    return memcmp(refilled, uncached, 16) != 0;
}

static bool entropy_cache_reset_forces_a_refill(void) {
    u8 before[16];
    if (mal_host_entropy_uuid(before, false) != 0) return false;
    mal_host_entropy_cache_reset();
    u8 after[16];
    if (mal_host_entropy_uuid(after, false) != 0) return false;
    return memcmp(before, after, 16) != 0;
}

/*
 * The UUID cache and the fallback descriptor are process-global, and this
 * boundary promises no reactor-thread affinity, so the locking has to be real.
 * Each worker interleaves cached draws, `fresh` draws, cache resets, and plain
 * entropy requests; an unsynchronized cache hands the same slot to two threads,
 * which shows up here as a duplicate.
 */
#define ENTROPY_THREADS 8
#define ENTROPY_DRAWS_PER_THREAD 96

typedef struct {
    u8 uuids[ENTROPY_DRAWS_PER_THREAD][16];
    bool bits_ok;
    bool draws_ok;
} EntropyWorker;

static void *entropy_worker(void *data) {
    EntropyWorker *worker = data;
    worker->bits_ok = true;
    worker->draws_ok = true;
    for (usize i = 0; i < ENTROPY_DRAWS_PER_THREAD; i++) {
        if (mal_host_entropy_uuid(worker->uuids[i], i % 8 == 0) != 0) {
            worker->bits_ok = false;
            continue;
        }
        if ((worker->uuids[i][6] & 0xf0) != 0x40 || (worker->uuids[i][8] & 0xc0) != 0x80) {
            worker->bits_ok = false;
        }
        byte scratch[64];
        if (mal_host_entropy(scratch, sizeof(scratch)) != 0) worker->draws_ok = false;
        // Resetting mid-flight is the case that would tear a naive cursor.
        if (i % 32 == 31) mal_host_entropy_cache_reset();
    }
    return nullptr;
}

static bool entropy_is_safe_under_concurrency(void) {
    static EntropyWorker workers[ENTROPY_THREADS];
    pthread_t threads[ENTROPY_THREADS];
    usize started = 0;
    for (usize i = 0; i < ENTROPY_THREADS; i++) {
        if (pthread_create(&threads[i], nullptr, entropy_worker, &workers[i]) != 0) break;
        started++;
    }
    for (usize i = 0; i < started; i++) {
        (void) pthread_join(threads[i], nullptr);
    }
    if (started != ENTROPY_THREADS) return false;
    for (usize i = 0; i < ENTROPY_THREADS; i++) {
        if (!workers[i].bits_ok || !workers[i].draws_ok) return false;
    }
    // Every UUID drawn by every thread must be distinct.
    for (usize a = 0; a < ENTROPY_THREADS; a++) {
        for (usize i = 0; i < ENTROPY_DRAWS_PER_THREAD; i++) {
            for (usize b = a; b < ENTROPY_THREADS; b++) {
                for (usize j = (b == a ? i + 1 : 0); j < ENTROPY_DRAWS_PER_THREAD; j++) {
                    if (memcmp(workers[a].uuids[i], workers[b].uuids[j], 16) == 0) {
                        return false;
                    }
                }
            }
        }
    }
    return true;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);

    struct {
        const char *name;
        bool ok;
    } checks[] = {
        {"a zero-length request succeeds and touches nothing",
            entropy_zero_length_touches_nothing()},
        {"requests spanning the 256-byte chunk boundary are filled completely",
            entropy_spans_the_chunk_boundary()},
        {"a 1 MiB request is filled without overrunning its buffer",
            entropy_fills_a_large_request()},
        {"consecutive draws differ", entropy_draws_differ()},
        {"a null target is refused rather than dereferenced",
            entropy_rejects_a_null_target()},
        {"UUID bytes carry the version 4 and RFC 4122 variant bits",
            entropy_uuid_sets_version_and_variant()},
        {"the UUID cache serves distinct values and `fresh` bypasses it",
            entropy_uuid_cache_serves_distinct_values()},
        {"resetting the cache forces a fresh platform draw",
            entropy_cache_reset_forces_a_refill()},
        {"concurrent draws, resets, and UUID batches never repeat a value",
            entropy_is_safe_under_concurrency()},
    };
    int total = (int) countof(checks);
    int passed = 0;
    for (int i = 0; i < total; i++) {
        if (checks[i].ok) {
            passed++;
        } else {
            printf("entropytest CHECK FAIL: %s\n", checks[i].name);
        }
    }
    printf("entropytest PASS %d/%d\n", passed, total);

    mal_vm_free(&vm);
    return passed == total ? 0 : 1;
}
