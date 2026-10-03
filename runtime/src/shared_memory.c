#include "shared_memory.h"

#include <ctype.h>
#include <errno.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#if !defined(__wasi__)
#include <math.h>
#include <pthread.h>
#include <time.h>
#endif

#include "gc_process.h"

struct MalSharedMemory {
    _Atomic(u64) refcount;
    byte *data;
    _Atomic(u32) byte_length;
    u32 max_byte_length;
    u32 capacity;
    bool growable;
};

enum {
    SHARED_LIMIT_UNSET,
    SHARED_LIMIT_CONFIGURING,
    SHARED_LIMIT_READY,
};

static _Atomic(u64) g_live_bytes;
static _Atomic(u64) g_limit_bytes;
static _Atomic(u32) g_limit_state;

static u64 shared_memory_env_limit(void) {
    u64 limit = MAL_SHARED_MEMORY_DEFAULT_MAX_BYTES;
    const char *option = getenv("MAL_SHARED_MEMORY_MAX_BYTES");
    // strtoull alone accepts whitespace, a sign and "-1" wrapping to UINT64_MAX.
    if (option != nullptr && isdigit((unsigned char) option[0])) {
        char *end;
        errno = 0;
        unsigned long long value = strtoull(option, &end, 10);
        if (*end == '\0' && errno != ERANGE) {
            limit = (u64) value;
        }
    }
    return limit;
}

// The environment is read exactly once; the configuring thread finishes before
// any other caller reads the limit, so a later set_limit is never overwritten.
static void shared_memory_configure_limit(void) {
    if (atomic_load_explicit(&g_limit_state, memory_order_acquire) == SHARED_LIMIT_READY) {
        return;
    }
    u32 expected = SHARED_LIMIT_UNSET;
    if (atomic_compare_exchange_strong(&g_limit_state, &expected, SHARED_LIMIT_CONFIGURING)) {
        atomic_store_explicit(&g_limit_bytes, shared_memory_env_limit(), memory_order_relaxed);
        atomic_store_explicit(&g_limit_state, SHARED_LIMIT_READY, memory_order_release);
        return;
    }
    while (atomic_load_explicit(&g_limit_state, memory_order_acquire) != SHARED_LIMIT_READY) {
    }
}

void mal_shared_memory_set_limit(u64 limit_bytes) {
    shared_memory_configure_limit();
    atomic_store(&g_limit_bytes, limit_bytes);
}

u64 mal_shared_memory_live_bytes(void) {
    return atomic_load(&g_live_bytes);
}

u64 mal_shared_memory_limit(void) {
    shared_memory_configure_limit();
    return atomic_load(&g_limit_bytes);
}

// Reserve against the cap before allocating so two isolates cannot both pass a
// check-then-add window and overshoot it. SIZE_MAX bounds even an unlimited
// cap, so the u64 sum cannot wrap and the total stays addressable.
static bool shared_memory_admit(u64 bytes) {
    u64 limit = mal_shared_memory_limit();
    if (limit == 0 || limit > SIZE_MAX) {
        limit = SIZE_MAX;
    }
    u64 live = atomic_load(&g_live_bytes);
    do {
        if (bytes > limit || live > limit - bytes) {
            return false;
        }
    } while (!atomic_compare_exchange_weak(&g_live_bytes, &live, live + bytes));
    return true;
}

MalSharedMemory *mal_shared_memory_new(u32 byte_length, u32 max_byte_length, bool growable) {
    u32 capacity = growable ? max_byte_length : byte_length;
    if (byte_length > capacity) {
        return nullptr;
    }
    if (!shared_memory_admit(capacity)) {
        return nullptr;
    }
    MalSharedMemory *memory = malloc(sizeof(MalSharedMemory));
    // calloc keeps hidden growable capacity zero without touching its pages, so
    // grow publishes a length and never writes bytes another agent may read.
    byte *data = capacity > 0 ? calloc(capacity, 1) : nullptr;
    if (memory == nullptr || (capacity > 0 && data == nullptr)) {
        free(memory);
        free(data);
        atomic_fetch_sub(&g_live_bytes, capacity);
        return nullptr;
    }
    // Separate from the hard shared cap above: the process budget only drives
    // GC pressure, charged once per backing however many wrappers share it.
    mal_gc_process_charge(capacity);
    atomic_init(&memory->refcount, 1);
    memory->data = data;
    atomic_init(&memory->byte_length, byte_length);
    memory->max_byte_length = growable ? max_byte_length : byte_length;
    memory->capacity = capacity;
    memory->growable = growable;
    return memory;
}

void mal_shared_memory_retain(MalSharedMemory *memory) {
    atomic_fetch_add_explicit(&memory->refcount, 1, memory_order_relaxed);
}

void mal_shared_memory_release(MalSharedMemory *memory) {
    if (memory == nullptr) {
        return;
    }
    if (atomic_fetch_sub_explicit(&memory->refcount, 1, memory_order_acq_rel) != 1) {
        return;
    }
    atomic_fetch_sub(&g_live_bytes, memory->capacity);
    free(memory->data);
    mal_gc_process_release(memory->capacity);
    free(memory);
}

byte *mal_shared_memory_data(const MalSharedMemory *memory) {
    return memory->data;
}

u32 mal_shared_memory_byte_length(const MalSharedMemory *memory) {
    return atomic_load(&((MalSharedMemory *) memory)->byte_length);
}

u32 mal_shared_memory_max_byte_length(const MalSharedMemory *memory) {
    return memory->max_byte_length;
}

bool mal_shared_memory_growable(const MalSharedMemory *memory) {
    return memory->growable;
}

bool mal_shared_memory_grow(MalSharedMemory *memory, u32 new_length) {
    if (!memory->growable || new_length > memory->max_byte_length) {
        return false;
    }
    u32 current = atomic_load(&memory->byte_length);
    while (current <= new_length) {
        if (current == new_length ||
            atomic_compare_exchange_weak(&memory->byte_length, &current, new_length)) {
            return true;
        }
    }
    return false;
}

// Element accesses go through the GCC/Clang __atomic builtins on the raw byte
// address: the store is not declared _Atomic, and the builtins are the defined
// way to give a plain object seq-cst atomic access without a data race.
u64 mal_shared_atomic_load(byte *address, u32 width) {
    switch (width) {
    case 1:
        return __atomic_load_n((u8 *) address, __ATOMIC_SEQ_CST);
    case 2:
        return __atomic_load_n((u16 *) address, __ATOMIC_SEQ_CST);
    case 4:
        return __atomic_load_n((u32 *) address, __ATOMIC_SEQ_CST);
    default:
        return __atomic_load_n((u64 *) address, __ATOMIC_SEQ_CST);
    }
}

void mal_shared_atomic_store(byte *address, u32 width, u64 value) {
    switch (width) {
    case 1:
        __atomic_store_n((u8 *) address, (u8) value, __ATOMIC_SEQ_CST);
        break;
    case 2:
        __atomic_store_n((u16 *) address, (u16) value, __ATOMIC_SEQ_CST);
        break;
    case 4:
        __atomic_store_n((u32 *) address, (u32) value, __ATOMIC_SEQ_CST);
        break;
    default:
        __atomic_store_n((u64 *) address, value, __ATOMIC_SEQ_CST);
        break;
    }
}

// Integer addresses: relational comparison of pointers into unrelated
// allocations is undefined in C.
static bool shared_ranges_disjoint(const byte *a, const byte *b, usize length) {
    uintptr_t x = (uintptr_t) a;
    uintptr_t y = (uintptr_t) b;
    return x >= y ? x - y >= length : y - x >= length;
}

void mal_shared_bytes_copy(byte *dst, const byte *src, u32 length) {
    u32 i = 0;
    // Disjoint, equally aligned ranges coalesce into 8-byte relaxed units, which
    // the spec permits for Unordered byte events. A concurrent access of another
    // width to those bytes is a mixed-size atomic pair that C11 leaves undefined
    // and TSan may flag; hardware keeps each byte stale-or-new. Overlap stays
    // byte-by-byte so the forward copy is exact.
    if (((uintptr_t) dst & 7) == ((uintptr_t) src & 7) &&
        shared_ranges_disjoint(dst, src, length)) {
        while (i < length && ((uintptr_t) (dst + i) & 7) != 0) {
            __atomic_store_n(dst + i, __atomic_load_n(src + i, __ATOMIC_RELAXED), __ATOMIC_RELAXED);
            i++;
        }
        for (; i + 8 <= length; i += 8) {
            u64 word = __atomic_load_n((const u64 *) (src + i), __ATOMIC_RELAXED);
            __atomic_store_n((u64 *) (dst + i), word, __ATOMIC_RELAXED);
        }
    }
    for (; i < length; i++) {
        __atomic_store_n(dst + i, __atomic_load_n(src + i, __ATOMIC_RELAXED), __ATOMIC_RELAXED);
    }
}

void mal_shared_bytes_move(byte *dst, const byte *src, usize length) {
    if ((uintptr_t) dst <= (uintptr_t) src || shared_ranges_disjoint(dst, src, length)) {
        for (usize i = 0; i < length; i++) {
            __atomic_store_n(dst + i, __atomic_load_n(src + i, __ATOMIC_RELAXED), __ATOMIC_RELAXED);
        }
        return;
    }
    for (usize i = length; i > 0; i--) {
        __atomic_store_n(dst + i - 1, __atomic_load_n(src + i - 1, __ATOMIC_RELAXED), __ATOMIC_RELAXED);
    }
}

void mal_shared_bytes_fill(byte *dst, byte value, usize length) {
    for (usize i = 0; i < length; i++) {
        __atomic_store_n(dst + i, value, __ATOMIC_RELAXED);
    }
}

void mal_shared_bytes_read(byte *dst, const byte *src, usize length) {
    for (usize i = 0; i < length; i++) {
        dst[i] = __atomic_load_n(src + i, __ATOMIC_RELAXED);
    }
}

void mal_shared_bytes_write(byte *dst, const byte *src, usize length) {
    for (usize i = 0; i < length; i++) {
        __atomic_store_n(dst + i, src[i], __ATOMIC_RELAXED);
    }
}

// Relaxed is exactly the spec's Unordered access for an aligned element:
// single-copy atomic (tear-free) with no ordering against other locations.
u64 mal_shared_unordered_load(const byte *address, u32 width) {
    switch (width) {
    case 1:
        return __atomic_load_n((const u8 *) address, __ATOMIC_RELAXED);
    case 2:
        return __atomic_load_n((const u16 *) address, __ATOMIC_RELAXED);
    case 4:
        return __atomic_load_n((const u32 *) address, __ATOMIC_RELAXED);
    default:
        return __atomic_load_n((const u64 *) address, __ATOMIC_RELAXED);
    }
}

void mal_shared_unordered_store(byte *address, u32 width, u64 value) {
    switch (width) {
    case 1:
        __atomic_store_n((u8 *) address, (u8) value, __ATOMIC_RELAXED);
        break;
    case 2:
        __atomic_store_n((u16 *) address, (u16) value, __ATOMIC_RELAXED);
        break;
    case 4:
        __atomic_store_n((u32 *) address, (u32) value, __ATOMIC_RELAXED);
        break;
    default:
        __atomic_store_n((u64 *) address, value, __ATOMIC_RELAXED);
        break;
    }
}

// Unsigned element types make wrap-around defined; callers reinterpret.
#define SHARED_RMW_WIDTH(NAME, T)                                                 \
    static u64 NAME(T *p, MalSharedRmw op, T v) {                                 \
        switch (op) {                                                             \
        case MAL_SHARED_RMW_ADD:                                                  \
            return __atomic_fetch_add(p, v, __ATOMIC_SEQ_CST);                    \
        case MAL_SHARED_RMW_SUB:                                                  \
            return __atomic_fetch_sub(p, v, __ATOMIC_SEQ_CST);                    \
        case MAL_SHARED_RMW_AND:                                                  \
            return __atomic_fetch_and(p, v, __ATOMIC_SEQ_CST);                    \
        case MAL_SHARED_RMW_OR:                                                   \
            return __atomic_fetch_or(p, v, __ATOMIC_SEQ_CST);                     \
        case MAL_SHARED_RMW_XOR:                                                  \
            return __atomic_fetch_xor(p, v, __ATOMIC_SEQ_CST);                    \
        case MAL_SHARED_RMW_EXCHANGE:                                             \
            return __atomic_exchange_n(p, v, __ATOMIC_SEQ_CST);                   \
        }                                                                         \
        return 0;                                                                 \
    }

SHARED_RMW_WIDTH(shared_rmw_u8, u8)
SHARED_RMW_WIDTH(shared_rmw_u16, u16)
SHARED_RMW_WIDTH(shared_rmw_u32, u32)
SHARED_RMW_WIDTH(shared_rmw_u64, u64)

#undef SHARED_RMW_WIDTH

u64 mal_shared_atomic_rmw(byte *address, u32 width, MalSharedRmw op, u64 operand) {
    switch (width) {
    case 1:
        return shared_rmw_u8((u8 *) address, op, (u8) operand);
    case 2:
        return shared_rmw_u16((u16 *) address, op, (u16) operand);
    case 4:
        return shared_rmw_u32((u32 *) address, op, (u32) operand);
    default:
        return shared_rmw_u64((u64 *) address, op, operand);
    }
}

u64 mal_shared_atomic_compare_exchange(byte *address, u32 width, u64 expected, u64 replacement) {
    switch (width) {
    case 1: {
        u8 e = (u8) expected;
        __atomic_compare_exchange_n((u8 *) address, &e, (u8) replacement, false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
        return e;
    }
    case 2: {
        u16 e = (u16) expected;
        __atomic_compare_exchange_n((u16 *) address, &e, (u16) replacement, false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
        return e;
    }
    case 4: {
        u32 e = (u32) expected;
        __atomic_compare_exchange_n((u32 *) address, &e, (u32) replacement, false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
        return e;
    }
    default: {
        u64 e = expected;
        __atomic_compare_exchange_n((u64 *) address, &e, replacement, false, __ATOMIC_SEQ_CST, __ATOMIC_SEQ_CST);
        return e;
    }
    }
}

static u64 shared_width_mask(u32 width) {
    return width >= 8 ? ~0ull : ((1ull << (width * 8)) - 1);
}

#if !defined(__wasi__)

typedef struct SharedWaiter SharedWaiter;

struct SharedWaiter {
    SharedWaiter *prev;
    SharedWaiter *next;
    MalSharedMemory *memory; // retained while the waiter exists
    u32 offset;
    bool enqueued;
    bool is_async;
    MalSharedWaitResult result;
    // Sync waiter only; stack-owned by the blocked thread.
    pthread_cond_t *cond;
};

struct MalSharedAsyncWaiter {
    SharedWaiter base;
    _Atomic(u32) refcount;
    MalSharedAsyncPost post;
    void *owner;
    u64 cookie;
};

struct MalSharedWaitInterrupt {
    pthread_mutex_t lock;
    _Atomic(bool) signaled;
    // The blocked waiter, guarded by `lock`.
    SharedWaiter *current;
};

// Striped list heads keyed by (backing identity, offset). The backing pointer
// is stable while any waiter retains it, so it cannot be recycled under a key.
#define SHARED_WAIT_BUCKETS 64

typedef struct {
    pthread_mutex_t lock;
    SharedWaiter *head;
    SharedWaiter *tail;
} SharedWaitBucket;

static SharedWaitBucket g_buckets[SHARED_WAIT_BUCKETS];
static pthread_once_t g_buckets_once = PTHREAD_ONCE_INIT;

static void shared_wait_buckets_init(void) {
    for (u32 i = 0; i < SHARED_WAIT_BUCKETS; i++) {
        pthread_mutex_init(&g_buckets[i].lock, nullptr);
        g_buckets[i].head = nullptr;
        g_buckets[i].tail = nullptr;
    }
}

static SharedWaitBucket *shared_wait_bucket(const MalSharedMemory *memory, u32 offset) {
    pthread_once(&g_buckets_once, shared_wait_buckets_init);
    uintptr_t key = (uintptr_t) memory ^ ((uintptr_t) offset * 0x9E3779B97F4A7C15ull);
    key ^= key >> 29;
    return &g_buckets[key % SHARED_WAIT_BUCKETS];
}

static void bucket_append(SharedWaitBucket *bucket, SharedWaiter *waiter) {
    waiter->next = nullptr;
    waiter->prev = bucket->tail;
    if (bucket->tail != nullptr) {
        bucket->tail->next = waiter;
    } else {
        bucket->head = waiter;
    }
    bucket->tail = waiter;
    waiter->enqueued = true;
}

static void bucket_remove(SharedWaitBucket *bucket, SharedWaiter *waiter) {
    if (waiter->prev != nullptr) {
        waiter->prev->next = waiter->next;
    } else {
        bucket->head = waiter->next;
    }
    if (waiter->next != nullptr) {
        waiter->next->prev = waiter->prev;
    } else {
        bucket->tail = waiter->prev;
    }
    waiter->prev = nullptr;
    waiter->next = nullptr;
    waiter->enqueued = false;
}

MalSharedWaitInterrupt *mal_shared_wait_interrupt_new(void) {
    MalSharedWaitInterrupt *interrupt = calloc(1, sizeof(MalSharedWaitInterrupt));
    if (interrupt == nullptr) {
        return nullptr;
    }
    pthread_mutex_init(&interrupt->lock, nullptr);
    atomic_init(&interrupt->signaled, false);
    return interrupt;
}

void mal_shared_wait_interrupt_free(MalSharedWaitInterrupt *interrupt) {
    if (interrupt == nullptr) {
        return;
    }
    pthread_mutex_destroy(&interrupt->lock);
    free(interrupt);
}

void mal_shared_wait_interrupt_signal(MalSharedWaitInterrupt *interrupt) {
    if (interrupt == nullptr) {
        return;
    }
    // Lock order: interrupt, then bucket. The waiter re-checks `signaled` under
    // its bucket lock before every cond wait, so setting it first and
    // broadcasting under that lock cannot lose the wakeup.
    pthread_mutex_lock(&interrupt->lock);
    atomic_store(&interrupt->signaled, true);
    SharedWaiter *waiter = interrupt->current;
    if (waiter != nullptr) {
        SharedWaitBucket *bucket = shared_wait_bucket(waiter->memory, waiter->offset);
        pthread_mutex_lock(&bucket->lock);
        pthread_cond_broadcast(waiter->cond);
        pthread_mutex_unlock(&bucket->lock);
    }
    pthread_mutex_unlock(&interrupt->lock);
}

void mal_shared_wait_interrupt_reset(MalSharedWaitInterrupt *interrupt) {
    atomic_store(&interrupt->signaled, false);
}

bool mal_shared_wait_interrupt_pending(const MalSharedWaitInterrupt *interrupt) {
    return atomic_load(&((MalSharedWaitInterrupt *) interrupt)->signaled);
}

static i64 shared_monotonic_ns(void) {
    struct timespec now;
    clock_gettime(CLOCK_MONOTONIC, &now);
    return (i64) now.tv_sec * 1000000000ll + now.tv_nsec;
}

// Blocks on `cond` until `deadline_ns` (negative = forever); spurious wakeups
// are handled by the caller's loop.
static void shared_cond_wait(pthread_cond_t *cond, pthread_mutex_t *lock, i64 deadline_ns) {
    if (deadline_ns < 0) {
        pthread_cond_wait(cond, lock);
        return;
    }
    i64 remaining = deadline_ns - shared_monotonic_ns();
    if (remaining <= 0) {
        return;
    }
#if defined(__APPLE__)
    struct timespec relative = {
        .tv_sec = remaining / 1000000000ll,
        .tv_nsec = remaining % 1000000000ll,
    };
    pthread_cond_timedwait_relative_np(cond, lock, &relative);
#else
    struct timespec absolute = {
        .tv_sec = deadline_ns / 1000000000ll,
        .tv_nsec = deadline_ns % 1000000000ll,
    };
    pthread_cond_timedwait(cond, lock, &absolute);
#endif
}

static void shared_cond_init(pthread_cond_t *cond) {
#if defined(__APPLE__)
    pthread_cond_init(cond, nullptr);
#else
    pthread_condattr_t attr;
    pthread_condattr_init(&attr);
    pthread_condattr_setclock(&attr, CLOCK_MONOTONIC);
    pthread_cond_init(cond, &attr);
    pthread_condattr_destroy(&attr);
#endif
}

MalSharedWaitResult mal_shared_memory_wait_sync(
    MalSharedMemory *memory, u32 offset, u32 width, u64 expected,
    f64 timeout_ms, MalSharedWaitInterrupt *interrupt) {
    i64 deadline_ns = -1;
    if (!isinf(timeout_ms) || timeout_ms < 0) {
        f64 ms = isnan(timeout_ms) || timeout_ms < 0 ? 0 : timeout_ms;
        // Saturate rather than overflow i64 for finite but huge timeouts.
        f64 ns = ms * 1e6;
        deadline_ns = ns >= 9.0e18 ? -1 : shared_monotonic_ns() + (i64) ns;
    }

    pthread_cond_t cond;
    shared_cond_init(&cond);
    SharedWaiter waiter = {
        .memory = memory,
        .offset = offset,
        .cond = &cond,
        .result = MAL_SHARED_WAIT_TIMED_OUT,
    };
    if (interrupt != nullptr) {
        pthread_mutex_lock(&interrupt->lock);
        interrupt->current = &waiter;
        pthread_mutex_unlock(&interrupt->lock);
    }

    SharedWaitBucket *bucket = shared_wait_bucket(memory, offset);
    pthread_mutex_lock(&bucket->lock);
    MalSharedWaitResult result;
    u64 current = mal_shared_atomic_load(memory->data + offset, width) & shared_width_mask(width);
    if (current != (expected & shared_width_mask(width))) {
        result = MAL_SHARED_WAIT_NOT_EQUAL;
    } else {
        bucket_append(bucket, &waiter);
        for (;;) {
            if (!waiter.enqueued) {
                result = waiter.result;
                break;
            }
            if (interrupt != nullptr && atomic_load(&interrupt->signaled)) {
                bucket_remove(bucket, &waiter);
                result = MAL_SHARED_WAIT_INTERRUPTED;
                break;
            }
            if (deadline_ns >= 0 && shared_monotonic_ns() >= deadline_ns) {
                bucket_remove(bucket, &waiter);
                result = MAL_SHARED_WAIT_TIMED_OUT;
                break;
            }
            shared_cond_wait(&cond, &bucket->lock, deadline_ns);
        }
    }
    pthread_mutex_unlock(&bucket->lock);

    if (interrupt != nullptr) {
        pthread_mutex_lock(&interrupt->lock);
        interrupt->current = nullptr;
        pthread_mutex_unlock(&interrupt->lock);
    }
    pthread_cond_destroy(&cond);
    return result;
}

MalSharedAsyncWaiter *mal_shared_memory_wait_async(
    MalSharedMemory *memory, u32 offset, u32 width, u64 expected,
    MalSharedAsyncPost post, void *owner, u64 cookie,
    MalSharedWaitResult *out_result) {
    MalSharedAsyncWaiter *waiter = calloc(1, sizeof(MalSharedAsyncWaiter));
    if (waiter == nullptr) {
        *out_result = MAL_SHARED_WAIT_INTERRUPTED;
        return nullptr;
    }
    mal_shared_memory_retain(memory);
    waiter->base.memory = memory;
    waiter->base.offset = offset;
    waiter->base.is_async = true;
    waiter->base.result = MAL_SHARED_WAIT_TIMED_OUT;
    // One reference for the owner, one for the list/post path.
    atomic_init(&waiter->refcount, 2);
    waiter->post = post;
    waiter->owner = owner;
    waiter->cookie = cookie;

    SharedWaitBucket *bucket = shared_wait_bucket(memory, offset);
    pthread_mutex_lock(&bucket->lock);
    u64 current = mal_shared_atomic_load(memory->data + offset, width) & shared_width_mask(width);
    bool equal = current == (expected & shared_width_mask(width));
    if (equal) {
        bucket_append(bucket, &waiter->base);
    }
    pthread_mutex_unlock(&bucket->lock);
    if (!equal) {
        mal_shared_memory_release(memory);
        free(waiter);
        *out_result = MAL_SHARED_WAIT_NOT_EQUAL;
        return nullptr;
    }
    *out_result = MAL_SHARED_WAIT_OK;
    return waiter;
}

bool mal_shared_async_waiter_cancel(MalSharedAsyncWaiter *waiter, MalSharedWaitResult result) {
    SharedWaitBucket *bucket = shared_wait_bucket(waiter->base.memory, waiter->base.offset);
    pthread_mutex_lock(&bucket->lock);
    bool removed = waiter->base.enqueued;
    if (removed) {
        bucket_remove(bucket, &waiter->base);
        waiter->base.result = result;
    }
    pthread_mutex_unlock(&bucket->lock);
    if (removed) {
        // The list reference is dropped here because no post will happen.
        mal_shared_async_waiter_release(waiter);
    }
    return removed;
}

MalSharedWaitResult mal_shared_async_waiter_result(const MalSharedAsyncWaiter *waiter) {
    return waiter->base.result;
}

u64 mal_shared_async_waiter_cookie(const MalSharedAsyncWaiter *waiter) {
    return waiter->cookie;
}

void mal_shared_async_waiter_release(MalSharedAsyncWaiter *waiter) {
    if (atomic_fetch_sub_explicit(&waiter->refcount, 1, memory_order_acq_rel) != 1) {
        return;
    }
    mal_shared_memory_release(waiter->base.memory);
    free(waiter);
}

u32 mal_shared_memory_notify(MalSharedMemory *memory, u32 offset, u32 count) {
    SharedWaitBucket *bucket = shared_wait_bucket(memory, offset);
    // Async posts happen after the lock drops, so a sink may take its own locks.
    MalSharedAsyncWaiter *posted = nullptr;
    MalSharedAsyncWaiter *posted_tail = nullptr;
    u32 woken = 0;
    pthread_mutex_lock(&bucket->lock);
    SharedWaiter *waiter = bucket->head;
    while (waiter != nullptr && woken < count) {
        SharedWaiter *next = waiter->next;
        if (waiter->memory == memory && waiter->offset == offset) {
            bucket_remove(bucket, waiter);
            waiter->result = MAL_SHARED_WAIT_OK;
            if (waiter->is_async) {
                // Reuse the now-unlinked `next` field as a FIFO post chain.
                if (posted_tail != nullptr) {
                    posted_tail->base.next = waiter;
                } else {
                    posted = (MalSharedAsyncWaiter *) waiter;
                }
                posted_tail = (MalSharedAsyncWaiter *) waiter;
            } else {
                pthread_cond_signal(waiter->cond);
            }
            woken++;
        }
        waiter = next;
    }
    pthread_mutex_unlock(&bucket->lock);
    while (posted != nullptr) {
        MalSharedAsyncWaiter *next = (MalSharedAsyncWaiter *) posted->base.next;
        posted->base.next = nullptr;
        posted->post(posted->owner, posted);
        posted = next;
    }
    return woken;
}

#else

// wasm32-wasip1 runs one agent with no threads, so no waiter can ever be
// enqueued for another agent to wake.
struct MalSharedWaitInterrupt {
    bool signaled;
};

MalSharedWaitInterrupt *mal_shared_wait_interrupt_new(void) {
    return calloc(1, sizeof(MalSharedWaitInterrupt));
}

void mal_shared_wait_interrupt_free(MalSharedWaitInterrupt *interrupt) {
    free(interrupt);
}

void mal_shared_wait_interrupt_signal(MalSharedWaitInterrupt *interrupt) {
    if (interrupt != nullptr) {
        interrupt->signaled = true;
    }
}

void mal_shared_wait_interrupt_reset(MalSharedWaitInterrupt *interrupt) {
    interrupt->signaled = false;
}

bool mal_shared_wait_interrupt_pending(const MalSharedWaitInterrupt *interrupt) {
    return interrupt->signaled;
}

MalSharedWaitResult mal_shared_memory_wait_sync(
    MalSharedMemory *memory, u32 offset, u32 width, u64 expected,
    f64 timeout_ms, MalSharedWaitInterrupt *interrupt) {
    (void) timeout_ms;
    u64 current = mal_shared_atomic_load(memory->data + offset, width) & shared_width_mask(width);
    if (current != (expected & shared_width_mask(width))) {
        return MAL_SHARED_WAIT_NOT_EQUAL;
    }
    if (interrupt != nullptr && interrupt->signaled) {
        return MAL_SHARED_WAIT_INTERRUPTED;
    }
    return MAL_SHARED_WAIT_TIMED_OUT;
}

u32 mal_shared_memory_notify(MalSharedMemory *memory, u32 offset, u32 count) {
    (void) memory;
    (void) offset;
    (void) count;
    return 0;
}

#endif
