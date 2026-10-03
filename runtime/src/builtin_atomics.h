#pragma once

#include "shared_memory.h"
#include "vm.h"

/**
 * The `Atomics` namespace object. Element operations are sequentially
 * consistent native atomics on the backing bytes; wait/notify use the
 * process-wide waiter table in shared_memory.h keyed by backing + byte offset.
 */
void mal_builtin_atomics_install(MalVm *vm);

/**
 * Configure the calling isolate's agent: [[CanBlock]] for Atomics.wait and the
 * interruption point a blocked wait observes. Call on the isolate's mutator
 * thread before it runs JS. Threadless WASI ignores `can_block` (always false).
 */
void mal_atomics_set_agent(bool can_block, MalSharedWaitInterrupt *interrupt);

/**
 * Event-loop seam for Atomics.waitAsync with a nonzero timeout. Must compare and
 * enqueue atomically (mal_shared_memory_wait_async), store NOT_EQUAL or OK in
 * *out_result, and on OK return the pending promise it will settle with "ok" or
 * "timed-out". Returns false with a pending exception on failure. Without a hook
 * (threadless WASI included) a matching wait throws a TypeError rather than
 * return a promise nothing could settle. The hook is isolate-local:
 * set it on the isolate's mutator thread and clear it (null) at its teardown.
 */
typedef bool (*MalAtomicsWaitAsyncHook)(
    MalVm *vm, MalSharedMemory *memory, u32 offset, u32 width, u64 expected,
    f64 timeout_ms, MalSharedWaitResult *out_result, MalValue *out_promise);
void mal_atomics_set_wait_async_hook(MalAtomicsWaitAsyncHook hook);
