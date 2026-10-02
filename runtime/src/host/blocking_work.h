#pragma once

#include "host_task.h"

typedef struct MalHost MalHost;
typedef struct MalBlockingWork {
    struct MalBlockingWorkState *state;
} MalBlockingWork;

typedef void (*MalBlockingWorkRun)(void *data);

// Start and teardown run on the reactor thread; success transfers ownership of VM-free payloads.
bool mal_blocking_work_start(
    MalHost *host, MalBlockingWorkRun run, void *data,
    MalHostTaskDestroy destroy, MalHostHandle *operation);
void mal_blocking_work_reap(MalBlockingWork *work);
void mal_blocking_work_shutdown(MalBlockingWork *work);
void mal_blocking_work_free(MalBlockingWork *work);
