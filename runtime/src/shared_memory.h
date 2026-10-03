#pragma once

#include "./defaults.h"

/*
 * SharedArrayBuffer backing stores and the Atomics wait/notify table.
 *
 * A MalSharedMemory lives outside every language heap. Each isolate that can see
 * it holds one retain per wrapper (MalArrayBufferObject.shared_memory) and per
 * in-flight snapshot or waiter, so publication and waiting never depend on a
 * wrapper surviving GC. The byte range is reserved at max_byte_length on
 * creation and never moves; growth only publishes a larger length.
 *
 * Every function here is thread-safe unless noted.
 */

typedef struct MalSharedMemory MalSharedMemory;

/* Null when the allocation fails or would exceed the process shared-memory cap. */
MalSharedMemory *mal_shared_memory_new(u32 byte_length, u32 max_byte_length, bool growable);
void mal_shared_memory_retain(MalSharedMemory *memory);
/* The last release frees the bytes and returns them to the process accounting. */
void mal_shared_memory_release(MalSharedMemory *memory);

byte *mal_shared_memory_data(const MalSharedMemory *memory);
/* Sequentially consistent read of the published length. */
u32 mal_shared_memory_byte_length(const MalSharedMemory *memory);
u32 mal_shared_memory_max_byte_length(const MalSharedMemory *memory);
bool mal_shared_memory_growable(const MalSharedMemory *memory);
/*
 * Publish new_length if it is >= the current length and <= max. Concurrent
 * growers race through CAS; the bytes were zeroed at reservation, so no
 * zero-fill happens after publication. False when shrinking or over max.
 */
bool mal_shared_memory_grow(MalSharedMemory *memory, u32 new_length);

/*
 * Process-wide cap on live shared bytes, MAL_SHARED_MEMORY_DEFAULT_MAX_BYTES
 * unless the MAL_SHARED_MEMORY_MAX_BYTES environment variable holds a decimal
 * u64 (read once, on first use; malformed values keep the default). 0 means
 * unlimited, though the total never exceeds SIZE_MAX. Live bytes count each
 * backing's full reservation (max_byte_length for growable ones) from creation
 * until its last release, so grow never fails on the cap. set_limit replaces the
 * environment value and applies to subsequent allocations; existing backings
 * are never revoked.
 */
#define MAL_SHARED_MEMORY_DEFAULT_MAX_BYTES ((u64) 1 << 30)
void mal_shared_memory_set_limit(u64 limit_bytes);
u64 mal_shared_memory_limit(void);
u64 mal_shared_memory_live_bytes(void);

/* Tear-free, sequentially consistent element access. `offset` must be aligned
 * to `width` (1, 2, 4 or 8) and inside the published length. */
u64 mal_shared_atomic_load(byte *address, u32 width);
void mal_shared_atomic_store(byte *address, u32 width, u64 value);

/*
 * Forward byte-order copy where either side may be shared memory, as the spec's
 * CopyDataBlockBytes (overlapping ranges included). Every unit is a relaxed
 * atomic, so each byte a racing agent observes is stale or new. Disjoint ranges
 * with equal alignment coalesce bytes into 8-byte units; a racing access of a
 * different width is then a mixed-size atomic pair outside the C11 model.
 */
void mal_shared_bytes_copy(byte *dst, const byte *src, u32 length);

/* memmove semantics (direction chosen for overlap) with relaxed byte units. */
void mal_shared_bytes_move(byte *dst, const byte *src, usize length);
void mal_shared_bytes_fill(byte *dst, byte value, usize length);
/* Shared -> private and private -> shared byte copies. */
void mal_shared_bytes_read(byte *dst, const byte *src, usize length);
void mal_shared_bytes_write(byte *dst, const byte *src, usize length);

/*
 * Ordinary (Unordered) element access to shared memory: relaxed atomic, so an
 * aligned integer/float element never tears and races are not C UB. `address`
 * must be aligned to `width`.
 */
u64 mal_shared_unordered_load(const byte *address, u32 width);
void mal_shared_unordered_store(byte *address, u32 width, u64 value);

typedef enum {
    MAL_SHARED_RMW_ADD,
    MAL_SHARED_RMW_SUB,
    MAL_SHARED_RMW_AND,
    MAL_SHARED_RMW_OR,
    MAL_SHARED_RMW_XOR,
    MAL_SHARED_RMW_EXCHANGE,
} MalSharedRmw;

/* Returns the previous raw element bits. */
u64 mal_shared_atomic_rmw(byte *address, u32 width, MalSharedRmw op, u64 operand);
u64 mal_shared_atomic_compare_exchange(byte *address, u32 width, u64 expected, u64 replacement);

typedef enum {
    MAL_SHARED_WAIT_OK,
    MAL_SHARED_WAIT_NOT_EQUAL,
    MAL_SHARED_WAIT_TIMED_OUT,
    // Termination hook fired; the caller must unwind without a JS result.
    MAL_SHARED_WAIT_INTERRUPTED,
} MalSharedWaitResult;

/*
 * Per-isolate interruption point for a blocking Atomics.wait. The owner embeds
 * one, initializes it before running JS, and any thread may signal it (worker
 * terminate, process exit). The signal is sticky until reset by the owner.
 * Threadless WASI keeps only the sticky flag.
 */
typedef struct MalSharedWaitInterrupt MalSharedWaitInterrupt;
MalSharedWaitInterrupt *mal_shared_wait_interrupt_new(void);
void mal_shared_wait_interrupt_free(MalSharedWaitInterrupt *interrupt);
void mal_shared_wait_interrupt_signal(MalSharedWaitInterrupt *interrupt);
void mal_shared_wait_interrupt_reset(MalSharedWaitInterrupt *interrupt);
bool mal_shared_wait_interrupt_pending(const MalSharedWaitInterrupt *interrupt);

/*
 * Atomics.wait critical section: compare the element at `offset` with
 * `expected` under the waiter-list lock, then block until notify, timeout
 * (milliseconds; +Infinity waits forever) or interrupt. `interrupt` may be null.
 * Threadless WASI has no agent that could notify and never blocks: a matching
 * value reports INTERRUPTED if signaled, else TIMED_OUT immediately.
 */
MalSharedWaitResult mal_shared_memory_wait_sync(
    MalSharedMemory *memory, u32 offset, u32 width, u64 expected,
    f64 timeout_ms, MalSharedWaitInterrupt *interrupt);

/* Wake up to `count` waiters (sync and async, FIFO) on (memory, offset). Always
 * 0 on threadless WASI, where nothing can be waiting. */
u32 mal_shared_memory_notify(MalSharedMemory *memory, u32 offset, u32 count);

#if !defined(__wasi__)
/*
 * Atomics.waitAsync waiter. Holds no thread: notify removes it from the list
 * and hands it to its owner's sink. `post` runs on the notifying thread with no
 * shared-memory lock held; it must be non-blocking and must eventually make the
 * owner call mal_shared_async_waiter_release. Native only: threadless WASI has
 * no host event loop to own a waiter.
 */
typedef struct MalSharedAsyncWaiter MalSharedAsyncWaiter;
typedef void (*MalSharedAsyncPost)(void *owner, MalSharedAsyncWaiter *waiter);

/*
 * Compare and enqueue atomically. Returns null with *out_result set to
 * NOT_EQUAL when the value differs; otherwise the waiter is enqueued and the
 * caller holds the owner reference. `cookie` is an owner-private id.
 */
MalSharedAsyncWaiter *mal_shared_memory_wait_async(
    MalSharedMemory *memory, u32 offset, u32 width, u64 expected,
    MalSharedAsyncPost post, void *owner, u64 cookie,
    MalSharedWaitResult *out_result);

/*
 * Owner-thread timeout or teardown: remove the waiter if it is still enqueued.
 * True means this call settled it as `result`; false means a notify already won
 * and its post is (or will be) delivered.
 */
bool mal_shared_async_waiter_cancel(MalSharedAsyncWaiter *waiter, MalSharedWaitResult result);
MalSharedWaitResult mal_shared_async_waiter_result(const MalSharedAsyncWaiter *waiter);
u64 mal_shared_async_waiter_cookie(const MalSharedAsyncWaiter *waiter);
/* Drop one reference (owner's, or the posted delivery's). */
void mal_shared_async_waiter_release(MalSharedAsyncWaiter *waiter);
#endif
