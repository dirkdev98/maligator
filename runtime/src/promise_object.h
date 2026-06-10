#pragma once

#include "./defaults.h"
#include "object.h"
#include "value.h"

typedef struct MalVm MalVm;

/**
 * [[PromiseState]]. A promise is settled at most once: the state transitions
 * pending -> fulfilled or pending -> rejected and then never changes.
 */
typedef enum MalPromiseState {
    MAL_PROMISE_PENDING,
    MAL_PROMISE_FULFILLED,
    MAL_PROMISE_REJECTED,
} MalPromiseState;

/**
 * A pending PromiseReaction: the dependent promise's capability plus an
 * optional handler. Fulfill and reject reactions live in separate lists on the
 * promise; which list a reaction is in encodes its [[Type]], so no type field
 * is needed. Nodes are malloc'd and freed when the promise settles.
 */
typedef struct MalPromiseReaction {
    struct MalPromiseReaction *next;
    MalValue cap_resolve;
    MalValue cap_reject;
    MalValue handler;
} MalPromiseReaction;

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

    /** Reactions awaiting settlement; both are consumed and freed on settle. */
    MalPromiseReaction *fulfill_reactions;
    MalPromiseReaction *reject_reactions;
} MalPromiseObject;

/** Allocate a pending promise with the given [[Prototype]]. */
MalPromiseObject *mal_promise_object_new(MalHeap *heap, MalObject *prototype);

/**
 * Append a reaction to the fulfill (on_reject=false) or reject list. The
 * promise must be pending; settled promises schedule a job directly instead.
 */
void mal_promise_append_reaction(
    MalPromiseObject *promise,
    bool on_reject,
    MalValue handler,
    MalValue cap_resolve,
    MalValue cap_reject
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
