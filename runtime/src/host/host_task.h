#pragma once

#include "./defaults.h"

typedef u64 MalHostHandle;

typedef enum MalHostOperationState {
    MAL_HOST_OPERATION_INVALID = 0,
    MAL_HOST_OPERATION_STARTING,
    MAL_HOST_OPERATION_ACTIVE,
    MAL_HOST_OPERATION_CANCELLING,
    MAL_HOST_OPERATION_TERMINAL_QUEUED,
    MAL_HOST_OPERATION_RELEASED,
} MalHostOperationState;

typedef enum MalHostTaskKind {
    MAL_HOST_TASK_PROGRESS = 1,
    MAL_HOST_TASK_TERMINAL,
} MalHostTaskKind;

typedef enum MalHostTerminalResult {
    MAL_HOST_TERMINAL_NONE = 0,
    MAL_HOST_TERMINAL_OK,
    MAL_HOST_TERMINAL_ERROR,
    MAL_HOST_TERMINAL_CANCELLED,
} MalHostTerminalResult;

typedef void (*MalHostTaskDestroy)(void *data);

typedef struct MalHostTask {
    MalHostTaskKind kind;
    MalHostHandle operation;
    MalHostTerminalResult result;
    void *data;
    struct MalHostTaskNode *_node;
} MalHostTask;

typedef struct MalHostTasks {
    struct MalHostTaskNode *head;
    struct MalHostTaskNode *tail;
    struct MalHostTaskNode *owned;
    struct MalHostOperationSlot *operations;
    usize operation_capacity;
    u32 free_operation;
} MalHostTasks;

void mal_host_tasks_init(MalHostTasks *tasks);
void mal_host_tasks_free(MalHostTasks *tasks);

/* A successful start owns a reserved terminal task until that task is released. */
bool mal_host_operation_start(MalHostTasks *tasks, MalHostHandle *operation);
bool mal_host_operation_activate(MalHostTasks *tasks, MalHostHandle operation);
MalHostOperationState mal_host_operation_state(
    const MalHostTasks *tasks, MalHostHandle operation);

/* Ownership of data transfers only when the enqueue/complete call succeeds. */
bool mal_host_operation_progress(
    MalHostTasks *tasks,
    MalHostHandle operation,
    void *data,
    MalHostTaskDestroy destroy);
bool mal_host_operation_complete(
    MalHostTasks *tasks,
    MalHostHandle operation,
    MalHostTerminalResult result,
    void *data,
    MalHostTaskDestroy destroy);

/* Valid live handles accept repeated cancellation; retired handles are invalid. */
bool mal_host_operation_cancel(MalHostTasks *tasks, MalHostHandle operation);

bool mal_host_next_task(MalHostTasks *tasks, MalHostTask *task);
void mal_host_task_release(MalHostTasks *tasks, MalHostTask *task);
