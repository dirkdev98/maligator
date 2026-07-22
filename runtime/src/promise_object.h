#pragma once

#include "./defaults.h"
#include "object.h"
#include "value.h"

typedef struct MalVm MalVm;
typedef struct MalGeneratorObject MalGeneratorObject;

/**
 * [[PromiseState]]. A promise is settled at most once: the state transitions
 * pending -> fulfilled or pending -> rejected and then never changes.
 */
typedef enum MalPromiseState {
    MAL_PROMISE_PENDING,
    MAL_PROMISE_FULFILLED,
    MAL_PROMISE_REJECTED,
} MalPromiseState;

typedef struct MalPromiseReactionBlock MalPromiseReactionBlock;

/**
 * A paired pending PromiseReaction: one registration's two optional handlers and
 * shared dependent capability. The promise owns a FIFO list of these nodes.
 */
typedef struct MalPromiseReaction {
    struct MalPromiseReaction *next;
    /* Capability encoding: two callables, two undefined values (no result
     * capability), {direct target Promise, exact intrinsic constructor}, or
     * {internal await tag, generator state}. The int32 tag cannot collide with
     * any valid user-created PromiseCapability resolve function. */
    MalValue cap_resolve;
    MalValue cap_reject;
    MalValue on_fulfilled;
    MalValue on_rejected;
} MalPromiseReaction;

static_assert(sizeof(MalPromiseReaction) == 40,
              "MalPromiseReaction must remain a 40-byte slab node");

typedef struct MalPromiseObject {
    MalObject object;
    MalPromiseState state;

    /**
     * Whether a handler has been attached (then/catch/await). Drives unhandled-
     * rejection tracking: a promise that rejects while unhandled is reported.
     */
    bool is_handled;

    /** Fulfillment value or rejection reason; undefined while pending. */
    MalValue result;

    /** Paired reactions awaiting settlement, kept in registration order. */
    MalPromiseReaction *reactions_head;
    MalPromiseReaction *reactions_tail;

    /**
     * Async stack stitching: the async function state whose result this promise
     * is (set at ASYNC_START), or null for an ordinary promise. mal_async_function_await
     * uses it to record an `awaited_by` back-link so a capture can reconstruct the
     * await chain.
     */
    MalGeneratorObject *async_owner;
} MalPromiseObject;

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

/**
 * Free a pending reaction list directly. The GC finalizer uses this for a promise
 * collected while still pending.
 */
void mal_promise_free_reactions(MalVm *vm, MalPromiseReaction *list);

/** Free the VM's cleared, untraced reaction freelist at teardown. */
void mal_promise_free_reaction_pool(MalVm *vm);
