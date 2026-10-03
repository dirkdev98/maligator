#pragma once

#include "host_task.h"

typedef struct MalHost MalHost;
typedef struct MalBlockingWork {
    struct MalBlockingWorkState *state;
} MalBlockingWork;

typedef struct MalBlockingWorkReservation {
    usize bytes;
    bool active;
} MalBlockingWorkReservation;

typedef void (*MalBlockingWorkRun)(void *data);

// Single-owner token: zero-initialize, reserve before copying, and release on pre-start failure.
bool mal_blocking_work_reserve(
    MalHost *host, usize bytes, MalBlockingWorkReservation *reservation);
void mal_blocking_work_reservation_release(MalBlockingWorkReservation *reservation);
usize mal_blocking_work_retained_bytes(void);
usize mal_blocking_work_retained_jobs(void);
// Start and teardown run on the reactor thread; success moves the reservation and payload.
bool mal_blocking_work_start(
    MalHost *host, MalBlockingWorkRun run, void *data,
    MalHostTaskDestroy destroy, MalBlockingWorkReservation *reservation,
    MalHostHandle *operation);
// Borrow the payload until task release; taking the host-owned wrapper would strand its reservation.
void *mal_blocking_work_result_data(void *result);
void mal_blocking_work_reap(MalBlockingWork *work);
void mal_blocking_work_shutdown(MalBlockingWork *work);
void mal_blocking_work_free(MalBlockingWork *work);
