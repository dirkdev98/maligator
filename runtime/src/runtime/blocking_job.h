#pragma once

#include "blocking_work.h"
#include "vm.h"

/*
 * Blocking jobs run a payload on the blocking-work pool, then settle it on the mutator
 * from the event loop, in the realm and async context that started the job. Every
 * filesystem API shares one pending list, GC root source and macrotask drain.
 */

#define MAL_BLOCKING_JOB_VALUES 3

/*
 * Settle a finished job. `data` is the payload, or null when teardown cancelled the work;
 * the pool frees it after settle returns, so settle takes over a buffer by clearing the
 * payload's pointer. `values` are the job's values, rooted for the call. `tag` is the
 * caller's own discriminator, such as the operation kind.
 */
typedef void (*MalBlockingJobSettle)(
    MalVm *vm, void *data, bool cancelled, u32 tag, MalValue values[MAL_BLOCKING_JOB_VALUES]);

typedef struct MalBlockingJob {
    MalBlockingWorkRun run;
    MalHostTaskDestroy destroy;
    MalBlockingJobSettle settle;
    void *data;
    /* Bytes the payload retains, reserved against the pool's budget unless the
     * reservation passed to start is already active. */
    usize footprint;
    u32 tag;
    /* Values the settle call needs, such as the promise or callback to complete. */
    MalValue values[MAL_BLOCKING_JOB_VALUES];
} MalBlockingJob;

typedef enum MalBlockingJobStart : u8 {
    MAL_BLOCKING_JOB_STARTED,
    /* The pool is stopping or holds its limit of retained work. */
    MAL_BLOCKING_JOB_BUSY,
    MAL_BLOCKING_JOB_NO_MEMORY,
} MalBlockingJobStart;

/* Register the drain, the root source and this VM's teardown. Installers call it once
 * per VM before starting jobs; false means the teardown could not be registered. */
bool mal_blocking_jobs_install(MalVm *vm);

/* Start a job. On success the payload and the reservation belong to the pool. On any
 * failure nothing is thrown and the caller still owns both. */
MalBlockingJobStart mal_blocking_job_start(
    MalVm *vm, const MalBlockingJob *job, MalBlockingWorkReservation *reservation);
