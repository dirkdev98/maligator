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

#define MAL_PROMISE_JOB_POOL_LIMIT 4096

/**
 * A queued microtask. Jobs are drained FIFO at a baseline frame count by
 * mal_vm_drain_microtasks; running one may enqueue further jobs (the queue
 * grows during the drain and the loop continues until it empties).
 */
typedef struct MalJob {
    struct MalJob *next;
    MalJobKind kind;
    bool is_reject;
    union {
        /** NewPromiseReactionJob payload. */
        struct {
            MalValue handler;
            MalValue cap_resolve;
            MalValue cap_reject;
            MalValue argument;
        } reaction;
        /** NewPromiseResolveThenableJob payload. */
        struct {
            MalValue then;
            MalValue thenable;
            MalValue resolve_fn;
            MalValue reject_fn;
        } thenable;
    } as;
} MalJob;

/** Process-wide native allocation counters used by the benchmark tracker. */
u64 mal_promise_job_allocation_count(void);
u64 mal_promise_reaction_allocation_count(void);
u64 mal_promise_job_reuse_count(void);
u64 mal_promise_reaction_reuse_count(void);
void mal_promise_note_reaction_allocation(void);
void mal_promise_note_reaction_reuse(void);

/** Free the VM's cleared, untraced job freelist at teardown. */
void mal_vm_free_job_pool(MalVm *vm);

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
