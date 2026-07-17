#include "host_task.h"

#include <pthread.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

typedef struct MalHostTaskNode {
    struct MalHostTaskNode *queue_next;
    struct MalHostTaskNode *owned_next;
    struct MalHostTaskNode *owned_previous;
    MalHostTasks *owner;
    MalHostTask task;
    MalHostTaskDestroy destroy;
    u32 operation_index;
} MalHostTaskNode;

typedef struct MalHostOperationSlot {
    MalHostTaskNode *terminal;
    MalHostOperationState state;
    u64 generation;
    u32 next_free;
    bool occupied;
} MalHostOperationSlot;

typedef struct MalHostPostedNode {
    struct MalHostPostedNode *next;
    MalHostTaskKind kind;
    MalHostHandle operation;
    MalHostTerminalResult result;
    void *data;
    MalHostTaskDestroy destroy;
} MalHostPostedNode;

typedef struct MalHostPostedState {
    pthread_mutex_t mutex;
    MalHostPostedNode *head;
    MalHostPostedNode *tail;
    MalHostPostWake wake;
    void *wake_data;
    usize pending;
    bool accepting;
} MalHostPostedState;

static _Atomic(u64) mal_host_next_operation_generation = 1;

#define MAL_HOST_HANDLE_INDEX_BITS 20
#define MAL_HOST_HANDLE_INDEX_MASK ((1u << MAL_HOST_HANDLE_INDEX_BITS) - 1)
#define MAL_HOST_HANDLE_GENERATION_MASK ((UINT64_C(1) << 44) - 1)

static u64 mal_host_operation_generation(void) {
    u64 generation;
    do {
        generation = atomic_fetch_add(&mal_host_next_operation_generation, 1) &
            MAL_HOST_HANDLE_GENERATION_MASK;
    } while (generation == 0);
    return generation;
}

static MalHostHandle mal_host_operation_handle(
    usize index, u64 generation) {
    return (generation << MAL_HOST_HANDLE_INDEX_BITS) | (u64) (index + 1);
}

static MalHostOperationSlot *mal_host_operation_slot(
    const MalHostTasks *tasks, MalHostHandle operation, usize *index_out) {
    u32 encoded_index = (u32) operation & MAL_HOST_HANDLE_INDEX_MASK;
    if (encoded_index == 0) {
        return nullptr;
    }
    usize index = (usize) encoded_index - 1;
    if (index >= tasks->operation_capacity) {
        return nullptr;
    }
    MalHostOperationSlot *slot = &tasks->operations[index];
    if (!slot->occupied || mal_host_operation_handle(index, slot->generation) != operation) {
        return nullptr;
    }
    if (index_out != nullptr) {
        *index_out = index;
    }
    return slot;
}

static void mal_host_task_own(MalHostTasks *tasks, MalHostTaskNode *node) {
    node->owner = tasks;
    node->owned_previous = nullptr;
    node->owned_next = tasks->owned;
    if (tasks->owned != nullptr) {
        tasks->owned->owned_previous = node;
    }
    tasks->owned = node;
}

static void mal_host_task_disown(MalHostTasks *tasks, MalHostTaskNode *node) {
    if (node->owned_previous == nullptr) {
        tasks->owned = node->owned_next;
    } else {
        node->owned_previous->owned_next = node->owned_next;
    }
    if (node->owned_next != nullptr) {
        node->owned_next->owned_previous = node->owned_previous;
    }
}

static void mal_host_task_destroy(MalHostTasks *tasks, MalHostTaskNode *node) {
    mal_host_task_disown(tasks, node);
    if (node->destroy != nullptr) {
        node->destroy(node->task.data);
    }
    free(node);
}

static void mal_host_task_enqueue(MalHostTasks *tasks, MalHostTaskNode *node) {
    node->queue_next = nullptr;
    if (tasks->tail == nullptr) {
        tasks->head = node;
    } else {
        tasks->tail->queue_next = node;
    }
    tasks->tail = node;
    tasks->queued_count++;
}

static bool mal_host_operations_grow(MalHostTasks *tasks) {
    usize old_capacity = tasks->operation_capacity;
    usize capacity = old_capacity == 0 ? 8 : old_capacity * 2;
    if (capacity < old_capacity || capacity > MAL_HOST_HANDLE_INDEX_MASK) {
        return false;
    }
    MalHostOperationSlot *operations =
        realloc(tasks->operations, sizeof(MalHostOperationSlot) * capacity);
    if (operations == nullptr) {
        return false;
    }
    tasks->operations = operations;
    tasks->operation_capacity = capacity;
    for (usize i = capacity; i > old_capacity; i--) {
        MalHostOperationSlot *slot = &operations[i - 1];
        memset(slot, 0, sizeof(*slot));
        slot->next_free = tasks->free_operation;
        tasks->free_operation = (u32) i;
    }
    return true;
}

static void mal_host_operation_retire(
    MalHostTasks *tasks, MalHostOperationSlot *slot, usize index) {
    slot->state = MAL_HOST_OPERATION_RELEASED;
    slot->occupied = false;
    slot->next_free = tasks->free_operation;
    tasks->free_operation = (u32) index + 1;
    tasks->live_operations--;
}

static void mal_host_operation_terminal(
    MalHostTasks *tasks,
    MalHostOperationSlot *slot,
    usize index,
    MalHostTerminalResult result,
    void *data,
    MalHostTaskDestroy destroy) {
    MalHostTaskNode *node = slot->terminal;
    node->task = (MalHostTask) {
        .kind = MAL_HOST_TASK_TERMINAL,
        .operation = mal_host_operation_handle(index, slot->generation),
        .result = result,
        .data = data,
        ._node = node,
    };
    node->destroy = destroy;
    slot->state = MAL_HOST_OPERATION_TERMINAL_QUEUED;
    mal_host_task_enqueue(tasks, node);
}

void mal_host_tasks_init(MalHostTasks *tasks) {
    memset(tasks, 0, sizeof(*tasks));
}

void mal_host_tasks_free(MalHostTasks *tasks) {
    MalHostTaskNode *node = tasks->owned;
    while (node != nullptr) {
        MalHostTaskNode *next = node->owned_next;
        if (node->destroy != nullptr) {
            node->destroy(node->task.data);
        }
        free(node);
        node = next;
    }
    free(tasks->operations);
    memset(tasks, 0, sizeof(*tasks));
}

bool mal_host_operation_start(MalHostTasks *tasks, MalHostHandle *operation) {
    if (operation == nullptr) {
        return false;
    }
    if (tasks->free_operation == 0 && !mal_host_operations_grow(tasks)) {
        return false;
    }
    MalHostTaskNode *terminal = calloc(1, sizeof(MalHostTaskNode));
    if (terminal == nullptr) {
        return false;
    }
    usize index = (usize) tasks->free_operation - 1;
    MalHostOperationSlot *slot = &tasks->operations[index];
    tasks->free_operation = slot->next_free;
    slot->next_free = 0;
    slot->terminal = terminal;
    slot->state = MAL_HOST_OPERATION_STARTING;
    slot->generation = mal_host_operation_generation();
    slot->occupied = true;
    terminal->operation_index = (u32) index;
    mal_host_task_own(tasks, terminal);
    tasks->live_operations++;
    *operation = mal_host_operation_handle(index, slot->generation);
    return true;
}

bool mal_host_operation_activate(MalHostTasks *tasks, MalHostHandle operation) {
    MalHostOperationSlot *slot = mal_host_operation_slot(tasks, operation, nullptr);
    if (slot == nullptr || slot->state != MAL_HOST_OPERATION_STARTING) {
        return false;
    }
    slot->state = MAL_HOST_OPERATION_ACTIVE;
    return true;
}

MalHostOperationState mal_host_operation_state(
    const MalHostTasks *tasks, MalHostHandle operation) {
    MalHostOperationSlot *slot = mal_host_operation_slot(tasks, operation, nullptr);
    return slot == nullptr ? MAL_HOST_OPERATION_INVALID : slot->state;
}

bool mal_host_operation_progress(
    MalHostTasks *tasks,
    MalHostHandle operation,
    void *data,
    MalHostTaskDestroy destroy) {
    usize index;
    MalHostOperationSlot *slot = mal_host_operation_slot(tasks, operation, &index);
    if (slot == nullptr || slot->state != MAL_HOST_OPERATION_ACTIVE) {
        return false;
    }
    MalHostTaskNode *node = calloc(1, sizeof(MalHostTaskNode));
    if (node == nullptr) {
        return false;
    }
    node->task = (MalHostTask) {
        .kind = MAL_HOST_TASK_PROGRESS,
        .operation = operation,
        .result = MAL_HOST_TERMINAL_NONE,
        .data = data,
        ._node = node,
    };
    node->destroy = destroy;
    node->operation_index = (u32) index;
    mal_host_task_own(tasks, node);
    mal_host_task_enqueue(tasks, node);
    return true;
}

bool mal_host_operation_complete(
    MalHostTasks *tasks,
    MalHostHandle operation,
    MalHostTerminalResult result,
    void *data,
    MalHostTaskDestroy destroy) {
    if (result != MAL_HOST_TERMINAL_OK && result != MAL_HOST_TERMINAL_ERROR) {
        return false;
    }
    usize index;
    MalHostOperationSlot *slot = mal_host_operation_slot(tasks, operation, &index);
    if (slot == nullptr || slot->state != MAL_HOST_OPERATION_ACTIVE) {
        return false;
    }
    mal_host_operation_terminal(tasks, slot, index, result, data, destroy);
    return true;
}

bool mal_host_operation_cancel(MalHostTasks *tasks, MalHostHandle operation) {
    usize index;
    MalHostOperationSlot *slot = mal_host_operation_slot(tasks, operation, &index);
    if (slot == nullptr) {
        return false;
    }
    if (slot->state == MAL_HOST_OPERATION_TERMINAL_QUEUED) {
        return true;
    }
    if (slot->state != MAL_HOST_OPERATION_STARTING &&
        slot->state != MAL_HOST_OPERATION_ACTIVE) {
        return false;
    }
    slot->state = MAL_HOST_OPERATION_CANCELLING;

    MalHostTaskNode *previous = nullptr;
    MalHostTaskNode *node = tasks->head;
    while (node != nullptr) {
        MalHostTaskNode *next = node->queue_next;
        if (node->task.kind == MAL_HOST_TASK_PROGRESS &&
            node->operation_index == (u32) index) {
            if (previous == nullptr) {
                tasks->head = next;
            } else {
                previous->queue_next = next;
            }
            if (tasks->tail == node) {
                tasks->tail = previous;
            }
            tasks->queued_count--;
            mal_host_task_destroy(tasks, node);
        } else {
            previous = node;
        }
        node = next;
    }

    mal_host_operation_terminal(
        tasks, slot, index, MAL_HOST_TERMINAL_CANCELLED, nullptr, nullptr);
    return true;
}

bool mal_host_next_task(MalHostTasks *tasks, MalHostTask *task) {
    if (task == nullptr || tasks->head == nullptr) {
        return false;
    }
    MalHostTaskNode *node = tasks->head;
    tasks->head = node->queue_next;
    if (tasks->head == nullptr) {
        tasks->tail = nullptr;
    }
    node->queue_next = nullptr;
    tasks->queued_count--;
    *task = node->task;
    return true;
}

void mal_host_task_release(MalHostTasks *tasks, MalHostTask *task) {
    if (task == nullptr || task->_node == nullptr) {
        return;
    }
    MalHostTaskNode *node = task->_node;
    if (node->owner != tasks) {
        return;
    }
    bool terminal = node->task.kind == MAL_HOST_TASK_TERMINAL;
    u32 operation_index = node->operation_index;
    task->_node = nullptr;
    mal_host_task_destroy(tasks, node);

    if (terminal && operation_index < tasks->operation_capacity) {
        MalHostOperationSlot *slot = &tasks->operations[operation_index];
        slot->terminal = nullptr;
        mal_host_operation_retire(tasks, slot, operation_index);
    }
}

usize mal_host_tasks_pending(const MalHostTasks *tasks) {
    return tasks->queued_count;
}

usize mal_host_operations_pending(const MalHostTasks *tasks) {
    return tasks->live_operations;
}

bool mal_host_posted_tasks_init(
    MalHostPostedTasks *posted, MalHostPostWake wake, void *wake_data) {
    if (posted == nullptr || wake == nullptr) {
        return false;
    }
    posted->state = nullptr;
    MalHostPostedState *state = calloc(1, sizeof(MalHostPostedState));
    if (state == nullptr) {
        return false;
    }
    if (pthread_mutex_init(&state->mutex, nullptr) != 0) {
        free(state);
        return false;
    }
    state->wake = wake;
    state->wake_data = wake_data;
    state->accepting = true;
    posted->state = state;
    return true;
}

static bool mal_host_posted_push(
    MalHostPostedTasks *posted,
    MalHostTaskKind kind,
    MalHostHandle operation,
    MalHostTerminalResult result,
    void *data,
    MalHostTaskDestroy destroy) {
    if (posted == nullptr || posted->state == nullptr || operation == 0) {
        return false;
    }
    MalHostPostedNode *node = malloc(sizeof(MalHostPostedNode));
    if (node == nullptr) {
        return false;
    }
    *node = (MalHostPostedNode) {
        .kind = kind,
        .operation = operation,
        .result = result,
        .data = data,
        .destroy = destroy,
    };

    MalHostPostedState *state = posted->state;
    pthread_mutex_lock(&state->mutex);
    if (!state->accepting) {
        pthread_mutex_unlock(&state->mutex);
        free(node);
        return false;
    }
    MalHostPostedNode *previous_tail = state->tail;
    if (previous_tail == nullptr) {
        state->head = node;
    } else {
        previous_tail->next = node;
    }
    state->tail = node;
    state->pending++;

    /* Signal while serialized with draining. On a hard wake failure the enqueue
     * can still be rolled back without racing the main reactor consumer. */
    if (!state->wake(state->wake_data)) {
        if (previous_tail == nullptr) {
            state->head = nullptr;
        } else {
            previous_tail->next = nullptr;
        }
        state->tail = previous_tail;
        state->pending--;
        pthread_mutex_unlock(&state->mutex);
        free(node);
        return false;
    }
    pthread_mutex_unlock(&state->mutex);
    return true;
}

bool mal_host_posted_progress(
    MalHostPostedTasks *posted,
    MalHostHandle operation,
    void *data,
    MalHostTaskDestroy destroy) {
    return mal_host_posted_push(
        posted,
        MAL_HOST_TASK_PROGRESS,
        operation,
        MAL_HOST_TERMINAL_NONE,
        data,
        destroy);
}

bool mal_host_posted_complete(
    MalHostPostedTasks *posted,
    MalHostHandle operation,
    MalHostTerminalResult result,
    void *data,
    MalHostTaskDestroy destroy) {
    if (result != MAL_HOST_TERMINAL_OK && result != MAL_HOST_TERMINAL_ERROR) {
        return false;
    }
    return mal_host_posted_push(
        posted, MAL_HOST_TASK_TERMINAL, operation, result, data, destroy);
}

static usize mal_host_posted_transfer(
    MalHostPostedTasks *posted, MalHostTasks *tasks, bool shutdown) {
    if (posted == nullptr || posted->state == nullptr || tasks == nullptr) {
        return 0;
    }
    MalHostPostedState *state = posted->state;
    pthread_mutex_lock(&state->mutex);
    if (shutdown) {
        state->accepting = false;
    }
    MalHostPostedNode *node = state->head;
    usize count = state->pending;
    state->head = nullptr;
    state->tail = nullptr;
    state->pending = 0;
    pthread_mutex_unlock(&state->mutex);

    while (node != nullptr) {
        MalHostPostedNode *next = node->next;
        bool transferred = node->kind == MAL_HOST_TASK_PROGRESS
            ? mal_host_operation_progress(
                  tasks, node->operation, node->data, node->destroy)
            : mal_host_operation_complete(
                  tasks, node->operation, node->result, node->data, node->destroy);
        if (!transferred && node->destroy != nullptr) {
            node->destroy(node->data);
        }
        free(node);
        node = next;
    }
    return count;
}

usize mal_host_posted_drain(MalHostPostedTasks *posted, MalHostTasks *tasks) {
    return mal_host_posted_transfer(posted, tasks, false);
}

usize mal_host_posted_shutdown(MalHostPostedTasks *posted, MalHostTasks *tasks) {
    return mal_host_posted_transfer(posted, tasks, true);
}

void mal_host_posted_tasks_free(MalHostPostedTasks *posted) {
    if (posted == nullptr || posted->state == nullptr) {
        return;
    }
    MalHostPostedState *state = posted->state;
    pthread_mutex_lock(&state->mutex);
    state->accepting = false;
    MalHostPostedNode *node = state->head;
    state->head = nullptr;
    state->tail = nullptr;
    state->pending = 0;
    pthread_mutex_unlock(&state->mutex);
    while (node != nullptr) {
        MalHostPostedNode *next = node->next;
        if (node->destroy != nullptr) {
            node->destroy(node->data);
        }
        free(node);
        node = next;
    }
    pthread_mutex_destroy(&state->mutex);
    free(state);
    posted->state = nullptr;
}

usize mal_host_posted_pending(MalHostPostedTasks *posted) {
    if (posted == nullptr || posted->state == nullptr) {
        return 0;
    }
    MalHostPostedState *state = posted->state;
    pthread_mutex_lock(&state->mutex);
    usize pending = state->pending;
    pthread_mutex_unlock(&state->mutex);
    return pending;
}

bool mal_host_posted_accepting(MalHostPostedTasks *posted) {
    if (posted == nullptr || posted->state == nullptr) {
        return false;
    }
    MalHostPostedState *state = posted->state;
    pthread_mutex_lock(&state->mutex);
    bool accepting = state->accepting;
    pthread_mutex_unlock(&state->mutex);
    return accepting;
}
