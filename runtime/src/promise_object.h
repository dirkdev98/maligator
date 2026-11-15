#pragma once

#include "./defaults.h"
#include "object.h"
#include "value.h"

typedef struct MalVm MalVm;
typedef struct MalGeneratorObject MalGeneratorObject;
typedef struct MalAsyncContext MalAsyncContext;

/**
 * [[PromiseState]]. A promise is settled at most once: the state transitions
 * pending -> fulfilled or pending -> rejected and then never changes.
 */
typedef enum MalPromiseState {
    MAL_PROMISE_PENDING,
    MAL_PROMISE_FULFILLED,
    MAL_PROMISE_REJECTED,
} MalPromiseState;

typedef struct MalJob MalJob;

typedef struct MalPromiseObject {
    MalObject object;
    MalObjectStorage object_storage;
    MalPromiseState state;

    /**
     * Whether a handler has been attached (then/catch/await). Drives unhandled-
     * rejection tracking: a promise that rejects while unhandled is reported.
     */
    bool is_handled;

    /** Fulfillment value or rejection reason; undefined while pending. */
    MalValue result;

    /** Pending jobs become runnable in registration order at settlement. */
    MalJob *reactions_head;
    MalJob *reactions_tail;

    /**
     * A resumable async body links its hidden activation here so an await can
     * record an ancestor for stack captures. Completion clears the link before
     * that activation can be recycled.
     */
    MalGeneratorObject *async_owner;
} MalPromiseObject;

/** Reference fields stay immutable after publication; jobs update only scalar state. */
typedef struct MalPromiseAllState {
    MalHeapHeader header;
    MalValue promise;
    MalValue values;
    u32 remaining;
    bool settled;
} MalPromiseAllState;

static_assert(sizeof(MalPromiseAllState) == 32,
              "Promise.all aggregation must remain one 32-byte cell");

MalPromiseAllState *mal_promise_all_state_new(
    MalVm *vm, MalValue promise, MalValue values, u32 count);

/** Register one index of a guarded intrinsic Promise.all traversal. */
void mal_promise_append_all_reaction(
    MalVm *vm, MalPromiseObject *promise, MalValue state, u32 index);

/** Allocate a pending promise with the given [[Prototype]]. */
MalPromiseObject *mal_promise_object_new(MalHeap *heap, MalObject *prototype);

/**
 * Append one paired reaction. The promise must be pending; settled promises
 * schedule a job directly instead.
 */
void mal_promise_append_reaction(
    MalVm *vm,
    MalPromiseObject *promise,
    MalValue on_fulfilled,
    MalValue on_rejected,
    MalValue cap_resolve,
    MalValue cap_reject
);

/** Append a typed async-function continuation without allocating JS callbacks. */
void mal_promise_append_await_reaction(
    MalVm *vm,
    MalPromiseObject *promise,
    MalValue state
);

/** Append a typed AsyncGeneratorAwaitReturn continuation. */
void mal_promise_append_async_generator_return_reaction(
    MalVm *vm,
    MalPromiseObject *promise,
    MalValue generator,
    MalValue realm_anchor
);

/** Append a typed AsyncFromSyncIterator continuation. */
void mal_promise_append_async_from_sync_reaction(
    MalVm *vm,
    MalPromiseObject *promise,
    MalValue sync_iterator,
    MalValue result_promise,
    MalValue realm_anchor,
    bool done,
    bool close_on_rejection
);

/** Append a typed DisposeResources continuation. */
void mal_promise_append_dispose_resources_reaction(
    MalVm *vm,
    MalPromiseObject *promise,
    MalValue stack,
    MalValue result_promise,
    MalValue realm_anchor
);

/**
 * FulfillPromise: settle to fulfilled with `value` and enqueue reaction jobs
 * for the fulfill list. A no-op when already settled.
 */
void mal_promise_fulfill(MalVm *vm, MalPromiseObject *promise, MalValue value);

/**
 * RejectPromise: settle to rejected with `reason` and enqueue reaction jobs for
 * the reject list. A no-op when already settled.
 */
void mal_promise_reject(MalVm *vm, MalPromiseObject *promise, MalValue reason);
