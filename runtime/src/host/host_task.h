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
typedef bool (*MalHostPostWake)(void *data);

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
    usize queued_count;
    usize live_operations;
    u32 free_operation;
} MalHostTasks;

/* Cross-thread producers own only plain host data. Posted payloads must not hold
 * runtime/VM values; the main reactor thread translates them into neutral tasks. */
typedef struct MalHostPostedTasks {
    struct MalHostPostedState *state;
} MalHostPostedTasks;

void mal_host_tasks_init(MalHostTasks *tasks);
void mal_host_tasks_free(MalHostTasks *tasks);

/* A successful start owns a reserved terminal task until that task is released. */
bool mal_host_operation_start(MalHostTasks *tasks, MalHostHandle *operation);
/* Discard a STARTING reservation without publishing a terminal task. */
bool mal_host_operation_abort_start(MalHostTasks *tasks, MalHostHandle operation);
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
/* Inspect the next task without dequeuing or transferring any ownership. */
bool mal_host_peek_task(const MalHostTasks *tasks, MalHostTask *task);
/* Transfer payload ownership out of a dequeued task; its destroy callback is disarmed. */
void *mal_host_task_take_data(MalHostTasks *tasks, MalHostTask *task);
void mal_host_task_release(MalHostTasks *tasks, MalHostTask *task);

usize mal_host_tasks_pending(const MalHostTasks *tasks);
usize mal_host_operations_pending(const MalHostTasks *tasks);

bool mal_host_posted_tasks_init(
    MalHostPostedTasks *posted, MalHostPostWake wake, void *wake_data);
/* Successful posts take ownership of data. Rejected posts leave it with caller. */
bool mal_host_posted_progress(
    MalHostPostedTasks *posted,
    MalHostHandle operation,
    void *data,
    MalHostTaskDestroy destroy);
bool mal_host_posted_complete(
    MalHostPostedTasks *posted,
    MalHostHandle operation,
    MalHostTerminalResult result,
    void *data,
    MalHostTaskDestroy destroy);
/* Main-reactor-only. A drain transfers the current FIFO batch, never dispatches it. */
usize mal_host_posted_drain(MalHostPostedTasks *posted, MalHostTasks *tasks);
/* Reject future posts and transfer every post accepted before shutdown. */
usize mal_host_posted_shutdown(MalHostPostedTasks *posted, MalHostTasks *tasks);
/* Destroy only after all producer threads have stopped calling the posted API. */
void mal_host_posted_tasks_free(MalHostPostedTasks *posted);
usize mal_host_posted_pending(MalHostPostedTasks *posted);
bool mal_host_posted_accepting(MalHostPostedTasks *posted);
