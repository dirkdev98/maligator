#pragma once

#include "./defaults.h"
#include "value.h"

typedef struct MalVm MalVm;

/**
 * The two kinds of spec PromiseJob we enqueue onto the microtask queue.
 */
typedef enum MalJobKind {
    MAL_JOB_PROMISE_REACTION,
    MAL_JOB_PROMISE_RESOLVE_THENABLE,
} MalJobKind;

/**
 * A queued microtask. Jobs are drained FIFO at a baseline frame count by
 * mal_vm_drain_microtasks; running one may enqueue further jobs (the queue
 * grows during the drain and the loop continues until it empties).
 */
typedef struct MalJob {
    struct MalJob *next;
    MalJobKind kind;

    /**
     * PROMISE_REACTION (NewPromiseReactionJob): run `handler` on `argument`
     * (or, when `handler` is undefined, pass the argument through on fulfill /
     * rethrow it on reject per `is_reject`), then settle the dependent
     * capability via `cap_resolve` / `cap_reject`.
     */
    MalValue handler;
    bool is_reject;
    MalValue cap_resolve;
    MalValue cap_reject;
    MalValue argument;

    /**
     * PROMISE_RESOLVE_THENABLE (NewPromiseResolveThenableJob): call `then` with
     * `thenable` as the receiver and the resolving functions of the promise
     * being resolved (`resolve_fn`, `reject_fn`) as arguments.
     */
    MalValue then;
    MalValue thenable;
    MalValue resolve_fn;
    MalValue reject_fn;
} MalJob;

/** Append a promise-reaction job to the microtask queue. */
void mal_vm_enqueue_reaction_job(
    MalVm *vm,
    MalValue handler,
    bool is_reject,
    MalValue cap_resolve,
    MalValue cap_reject,
    MalValue argument
);

/** Append a resolve-thenable job to the microtask queue. */
void mal_vm_enqueue_thenable_job(
    MalVm *vm,
    MalValue then,
    MalValue thenable,
    MalValue resolve_fn,
    MalValue reject_fn
);

/** True when at least one microtask is queued. */
bool mal_vm_has_pending_jobs(const MalVm *vm);

/**
 * Run queued microtasks until the queue is empty. Must be called only at a
 * baseline frame count (the top-level frame has returned), never re-entrantly
 * from inside a running job — reaction handlers re-enter the interpreter via
 * mal_vm_call_value, and draining at a baseline keeps that nesting flat.
 */
void mal_vm_drain_microtasks(MalVm *vm);
