#include "vm.h"

#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <unistd.h>

#include "host.h"
#include "host_task.h"
#include "reactor.h"
#include "scheduler.h"

/*
 * Reactor-core acceptance test. Drives the I/O reactor through the
 * scheduler and asserts:
 *
 *   1. Timers wake sleeping fibers, in deadline order, and the fibers sleep
 *      *concurrently* (the run loop blocks in the reactor while all are asleep).
 *   2. fd readiness wakes a fiber blocked on a pipe read — i.e. one fiber can be
 *      parked on I/O while another makes progress and eventually satisfies it.
 *   3. The turn loop idle-exits once nothing is runnable and nothing is pending
 *      (if it didn't, mal_sched_run would hang and the runner would time out).
 *
 * Uses a real isolate (mal_vm_definition) only to stand up heap + intrinsics.
 */

extern const MalVmDefinition mal_vm_definition;

#define SLEEPER_COUNT 4
#define SLEEP_STEP_MS 3

static int g_wake_order[SLEEPER_COUNT];
static int g_wake_len = 0;
static int g_sleepers_done = 0;

/* Pipe test state. */
static int g_pipe[2] = {-1, -1};
static unsigned char g_byte_written = 0xA7;
static int g_byte_read = -1;
static bool g_reader_done = false;
static bool g_writer_done = false;

static int g_payload_releases = 0;
static int g_payload_sum = 0;

static void count_wake(void *data) {
    int *count = data;
    (*count)++;
}

static bool reactor_concurrent_interests(void) {
    MalReactor reactor;
    int sockets[2] = {-1, -1};
    int read_wakes = 0;
    int write_wakes = 0;
    mal_reactor_init(&reactor);
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) < 0) {
        mal_reactor_free(&reactor);
        return false;
    }

    MalOp read_op = {
        .fd = sockets[0],
        .interest = MAL_IO_READ,
        .waker = {.fn = count_wake, .data = &read_wakes},
    };
    MalOp write_op = {
        .fd = sockets[0],
        .interest = MAL_IO_WRITE,
        .waker = {.fn = count_wake, .data = &write_wakes},
    };
    unsigned char byte = 1;
    bool ok = mal_reactor_add_op(&reactor, &read_op) &&
        mal_reactor_add_op(&reactor, &write_op) && write(sockets[1], &byte, 1) == 1;
    if (ok) {
        mal_reactor_wait(&reactor);
        ok = read_wakes == 1 && write_wakes == 1 && !mal_reactor_has_pending(&reactor);
    }

    (void) mal_reactor_cancel_op(&reactor, &read_op);
    (void) mal_reactor_cancel_op(&reactor, &write_op);
    mal_reactor_free(&reactor);
    close(sockets[0]);
    close(sockets[1]);
    return ok;
}

static bool reactor_cancellation(void) {
    MalReactor reactor;
    int fds[2] = {-1, -1};
    int wakes = 0;
    mal_reactor_init(&reactor);
    if (pipe(fds) < 0) {
        mal_reactor_free(&reactor);
        return false;
    }

    MalOp op = {
        .fd = fds[0],
        .interest = MAL_IO_READ,
        .waker = {.fn = count_wake, .data = &wakes},
    };
    unsigned char byte = 1;
    bool ok = mal_reactor_add_op(&reactor, &op) &&
        mal_reactor_cancel_op(&reactor, &op) &&
        mal_reactor_cancel_op(&reactor, &op) && write(fds[1], &byte, 1) == 1;
    mal_reactor_wait(&reactor);
    ok = ok && wakes == 0 && !op.active && !mal_reactor_has_pending(&reactor);

    mal_reactor_free(&reactor);
    close(fds[0]);
    close(fds[1]);
    return ok;
}

typedef struct RearmContext {
    MalReactor *reactor;
    MalOp op;
    int wakes;
    bool ok;
} RearmContext;

static void rearm_wake(void *data) {
    RearmContext *context = data;
    unsigned char byte;
    context->ok = context->ok && read(context->op.fd, &byte, 1) == 1;
    context->wakes++;
    if (context->wakes == 1) {
        context->ok = context->ok && mal_reactor_add_op(context->reactor, &context->op);
    }
}

static bool reactor_rearm_is_one_shot(void) {
    MalReactor reactor;
    int fds[2] = {-1, -1};
    mal_reactor_init(&reactor);
    if (pipe(fds) < 0) {
        mal_reactor_free(&reactor);
        return false;
    }

    RearmContext context = {
        .reactor = &reactor,
        .op = {
            .fd = fds[0],
            .interest = MAL_IO_READ,
            .waker = {.fn = rearm_wake},
        },
        .ok = true,
    };
    context.op.waker.data = &context;
    unsigned char bytes[2] = {1, 2};
    bool ok = write(fds[1], bytes, sizeof(bytes)) == (ssize_t) sizeof(bytes) &&
        mal_reactor_add_op(&reactor, &context.op);
    if (ok) {
        mal_reactor_wait(&reactor);
        ok = context.ok && context.wakes == 1 && context.op.active;
    }
    if (ok) {
        mal_reactor_wait(&reactor);
        ok = context.ok && context.wakes == 2 && !context.op.active &&
            !mal_reactor_has_pending(&reactor);
    }
    mal_reactor_wait(&reactor);
    ok = ok && context.wakes == 2;

    (void) mal_reactor_cancel_op(&reactor, &context.op);
    mal_reactor_free(&reactor);
    close(fds[0]);
    close(fds[1]);
    return ok;
}

static bool reactor_registration_failure(void) {
    MalReactor reactor;
    int fds[2] = {-1, -1};
    int wakes = 0;
    mal_reactor_init(&reactor);
    if (pipe(fds) < 0) {
        mal_reactor_free(&reactor);
        return false;
    }
    close(fds[0]);

    MalOp op = {
        .fd = fds[0],
        .interest = MAL_IO_READ,
        .waker = {.fn = count_wake, .data = &wakes},
    };
    bool ok = !mal_reactor_add_op(&reactor, &op) && !op.active &&
        !mal_reactor_has_pending(&reactor) && wakes == 0;

    mal_reactor_free(&reactor);
    close(fds[1]);
    return ok;
}

typedef struct FreeingContext {
    MalReactor *reactor;
    MalOp read_op;
    MalOp write_op;
    int *wakes;
    bool *cancelled;
} FreeingContext;

static void cancel_and_free_wake(void *data) {
    FreeingContext *context = data;
    (*context->wakes)++;
    bool read_cancelled = mal_reactor_cancel_op(context->reactor, &context->read_op);
    bool write_cancelled = mal_reactor_cancel_op(context->reactor, &context->write_op);
    *context->cancelled = read_cancelled && write_cancelled;
    free(context);
}

static bool reactor_callback_can_free_owner(void) {
    MalReactor reactor;
    int sockets[2] = {-1, -1};
    int wakes = 0;
    bool cancelled = false;
    mal_reactor_init(&reactor);
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, sockets) < 0) {
        mal_reactor_free(&reactor);
        return false;
    }

    FreeingContext *context = calloc(1, sizeof(FreeingContext));
    if (context == nullptr) {
        mal_reactor_free(&reactor);
        close(sockets[0]);
        close(sockets[1]);
        return false;
    }
    context->reactor = &reactor;
    context->wakes = &wakes;
    context->cancelled = &cancelled;
    context->read_op = (MalOp) {
        .fd = sockets[0],
        .interest = MAL_IO_READ,
        .waker = {.fn = cancel_and_free_wake, .data = context},
    };
    context->write_op = (MalOp) {
        .fd = sockets[0],
        .interest = MAL_IO_WRITE,
        .waker = {.fn = cancel_and_free_wake, .data = context},
    };
    unsigned char byte = 1;
    bool ok = mal_reactor_add_op(&reactor, &context->read_op) &&
        mal_reactor_add_op(&reactor, &context->write_op) &&
        write(sockets[1], &byte, 1) == 1;
    if (ok) {
        mal_reactor_wait(&reactor);
        mal_reactor_wait(&reactor);
        ok = cancelled && wakes == 1 && !mal_reactor_has_pending(&reactor);
    } else {
        (void) mal_reactor_cancel_op(&reactor, &context->read_op);
        (void) mal_reactor_cancel_op(&reactor, &context->write_op);
        free(context);
    }

    mal_reactor_free(&reactor);
    close(sockets[0]);
    close(sockets[1]);
    return ok;
}

static int *task_payload(int value) {
    int *payload = malloc(sizeof(int));
    if (payload != nullptr) {
        *payload = value;
    }
    return payload;
}

static void task_payload_release(void *data) {
    int *payload = data;
    g_payload_releases++;
    g_payload_sum += *payload;
    free(payload);
}

static bool host_tasks_fifo(void) {
    MalHostTasks tasks;
    MalHostHandle operation = 0;
    MalHostTask task;
    mal_host_tasks_init(&tasks);
    g_payload_releases = 0;
    g_payload_sum = 0;

    bool ok = mal_host_operation_start(&tasks, &operation) &&
        mal_host_operation_state(&tasks, operation) == MAL_HOST_OPERATION_STARTING &&
        mal_host_operation_activate(&tasks, operation) &&
        mal_host_operation_state(&tasks, operation) == MAL_HOST_OPERATION_ACTIVE;
    for (int i = 1; ok && i <= 3; i++) {
        int *payload = task_payload(i);
        ok = payload != nullptr && mal_host_operation_progress(
            &tasks, operation, payload, task_payload_release);
        if (!ok && payload != nullptr) {
            free(payload);
        }
    }
    for (int expected = 1; ok && expected <= 3; expected++) {
        ok = mal_host_next_task(&tasks, &task) &&
            task.kind == MAL_HOST_TASK_PROGRESS && task.operation == operation &&
            task.result == MAL_HOST_TERMINAL_NONE && *(int *) task.data == expected;
        if (ok) {
            mal_host_task_release(&tasks, &task);
            ok = task._node == nullptr &&
                mal_host_operation_state(&tasks, operation) == MAL_HOST_OPERATION_ACTIVE;
        }
    }
    int *terminal_payload = task_payload(4);
    ok = ok && terminal_payload != nullptr && mal_host_operation_complete(
        &tasks,
        operation,
        MAL_HOST_TERMINAL_OK,
        terminal_payload,
        task_payload_release);
    if (!ok && terminal_payload != nullptr &&
        mal_host_operation_state(&tasks, operation) == MAL_HOST_OPERATION_ACTIVE) {
        free(terminal_payload);
    }
    ok = ok &&
        mal_host_operation_state(&tasks, operation) == MAL_HOST_OPERATION_TERMINAL_QUEUED &&
        mal_host_next_task(&tasks, &task) && task.kind == MAL_HOST_TASK_TERMINAL &&
        task.result == MAL_HOST_TERMINAL_OK && *(int *) task.data == 4;
    if (ok) {
        mal_host_task_release(&tasks, &task);
        ok = mal_host_operation_state(&tasks, operation) == MAL_HOST_OPERATION_INVALID &&
            g_payload_releases == 4 && g_payload_sum == 10 &&
            !mal_host_next_task(&tasks, &task);
    }
    mal_host_tasks_free(&tasks);
    return ok;
}

static bool host_tasks_stale_handles(void) {
    MalHostTasks first;
    MalHostTasks second;
    MalHostHandle stale = 0;
    MalHostHandle reused = 0;
    MalHostTask task;
    mal_host_tasks_init(&first);
    mal_host_tasks_init(&second);

    bool ok = mal_host_operation_start(&first, &stale) &&
        mal_host_operation_state(&second, stale) == MAL_HOST_OPERATION_INVALID &&
        !mal_host_operation_cancel(&second, stale) &&
        mal_host_operation_activate(&first, stale) &&
        mal_host_operation_complete(
            &first, stale, MAL_HOST_TERMINAL_OK, nullptr, nullptr) &&
        mal_host_next_task(&first, &task);
    if (ok) {
        mal_host_task_release(&first, &task);
    }
    ok = ok && mal_host_operation_start(&first, &reused) && reused != stale &&
        mal_host_operation_state(&first, stale) == MAL_HOST_OPERATION_INVALID &&
        !mal_host_operation_activate(&first, stale) &&
        !mal_host_operation_cancel(&first, stale) &&
        mal_host_operation_cancel(&first, reused) &&
        mal_host_next_task(&first, &task) && task.result == MAL_HOST_TERMINAL_CANCELLED;
    if (ok) {
        mal_host_task_release(&first, &task);
    }
    mal_host_tasks_free(&second);
    mal_host_tasks_free(&first);
    return ok;
}

static bool host_tasks_completion_wins(void) {
    MalHostTasks tasks;
    MalHostHandle operation = 0;
    MalHostTask task;
    mal_host_tasks_init(&tasks);

    bool ok = mal_host_operation_start(&tasks, &operation) &&
        mal_host_operation_activate(&tasks, operation) &&
        mal_host_operation_progress(&tasks, operation, nullptr, nullptr) &&
        mal_host_operation_complete(
            &tasks, operation, MAL_HOST_TERMINAL_ERROR, nullptr, nullptr) &&
        mal_host_operation_cancel(&tasks, operation) &&
        mal_host_operation_cancel(&tasks, operation) &&
        !mal_host_operation_complete(
            &tasks, operation, MAL_HOST_TERMINAL_OK, nullptr, nullptr);
    int count = 0;
    while (ok && mal_host_next_task(&tasks, &task)) {
        count++;
        ok = (count == 1 && task.kind == MAL_HOST_TASK_PROGRESS) ||
            (count == 2 && task.kind == MAL_HOST_TASK_TERMINAL &&
                task.result == MAL_HOST_TERMINAL_ERROR);
        mal_host_task_release(&tasks, &task);
    }
    ok = ok && count == 2 &&
        mal_host_operation_state(&tasks, operation) == MAL_HOST_OPERATION_INVALID;
    mal_host_tasks_free(&tasks);
    return ok;
}

static bool host_tasks_cancellation_wins(void) {
    MalHostTasks tasks;
    MalHostHandle operation = 0;
    MalHostHandle starting = 0;
    MalHostTask task;
    mal_host_tasks_init(&tasks);
    g_payload_releases = 0;
    g_payload_sum = 0;

    bool ok = mal_host_operation_start(&tasks, &operation) &&
        mal_host_operation_activate(&tasks, operation);
    for (int value = 5; ok && value <= 6; value++) {
        int *payload = task_payload(value);
        ok = payload != nullptr && mal_host_operation_progress(
            &tasks, operation, payload, task_payload_release);
        if (!ok && payload != nullptr) {
            free(payload);
        }
    }
    ok = ok && mal_host_operation_cancel(&tasks, operation) &&
        g_payload_releases == 2 && g_payload_sum == 11 &&
        mal_host_operation_cancel(&tasks, operation) &&
        !mal_host_operation_complete(
            &tasks, operation, MAL_HOST_TERMINAL_OK, nullptr, nullptr) &&
        mal_host_next_task(&tasks, &task) && task.kind == MAL_HOST_TASK_TERMINAL &&
        task.result == MAL_HOST_TERMINAL_CANCELLED;
    if (ok) {
        mal_host_task_release(&tasks, &task);
    }
    ok = ok && !mal_host_next_task(&tasks, &task) &&
        !mal_host_operation_cancel(&tasks, operation) &&
        mal_host_operation_start(&tasks, &starting) &&
        mal_host_operation_cancel(&tasks, starting) &&
        mal_host_next_task(&tasks, &task) && task.result == MAL_HOST_TERMINAL_CANCELLED;
    if (ok) {
        mal_host_task_release(&tasks, &task);
    }
    ok = ok && !mal_host_next_task(&tasks, &task);
    mal_host_tasks_free(&tasks);
    return ok;
}

/* Sleeper i sleeps (SLEEPER_COUNT - i) steps, so completion order is i =
 * N-1, N-2, ..., 0 (shortest sleep finishes first). */
static void sleeper(void *arg) {
    intptr_t id = (intptr_t) arg;
    MalScheduler *s = mal_current_scheduler;
    i64 ms = (i64) (SLEEPER_COUNT - id) * SLEEP_STEP_MS;
    mal_sched_sleep_ns(s, ms * 1000000);
    if (g_wake_len < SLEEPER_COUNT) {
        g_wake_order[g_wake_len++] = (int) id;
    }
    g_sleepers_done++;
}

static void pipe_reader(void *arg) {
    (void) arg;
    MalScheduler *s = mal_current_scheduler;
    mal_sched_wait_fd(s, g_pipe[0], MAL_IO_READ);
    unsigned char b = 0;
    ssize_t n = read(g_pipe[0], &b, 1);
    if (n == 1) {
        g_byte_read = (int) b;
    }
    g_reader_done = true;
}

static void pipe_writer(void *arg) {
    (void) arg;
    MalScheduler *s = mal_current_scheduler;
    /* Sleep first, so the reader is definitely parked on the reactor before the
     * byte is written — proving the wake comes from fd readiness, not ordering. */
    mal_sched_sleep_ns(s, 5 * 1000000);
    ssize_t n = write(g_pipe[1], &g_byte_written, 1);
    (void) n;
    g_writer_done = true;
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_vm_definition);
    mal_host_attach(&vm); // reactor + timers (the platform the scheduler drives)

    MalScheduler sched;
    mal_sched_init(&sched, &vm);

    if (pipe(g_pipe) == 0) {
        fcntl(g_pipe[0], F_SETFL, O_NONBLOCK);
        fcntl(g_pipe[1], F_SETFL, O_NONBLOCK);
    }

    for (intptr_t i = 0; i < SLEEPER_COUNT; i++) {
        mal_sched_spawn(&sched, sleeper, (void *) i);
    }
    mal_sched_spawn(&sched, pipe_reader, nullptr);
    mal_sched_spawn(&sched, pipe_writer, nullptr);

    mal_sched_run(&sched);
    mal_sched_shutdown();

    // Check 2a: sleepers all finished.
    bool all_slept = g_sleepers_done == SLEEPER_COUNT && g_wake_len == SLEEPER_COUNT;

    // Check 2b: they woke in deadline order (id N-1, N-2, ..., 0).
    bool order_ok = all_slept;
    for (int i = 0; i < g_wake_len; i++) {
        if (g_wake_order[i] != SLEEPER_COUNT - 1 - i) {
            order_ok = false;
        }
    }

    // Check: pipe reader was woken by fd readiness and read the exact byte.
    bool pipe_ok = g_reader_done && g_writer_done && g_byte_read == (int) g_byte_written;

    if (g_pipe[0] >= 0) {
        close(g_pipe[0]);
    }
    if (g_pipe[1] >= 0) {
        close(g_pipe[1]);
    }

    struct {
        const char *name;
        bool ok;
    } checks[] = {
        {"all sleepers woke", all_slept},
        {"sleepers woke in deadline order", order_ok},
        {"pipe reader woken by fd readiness, got byte", pipe_ok},
        {"same fd supports independent read and write ops", reactor_concurrent_interests()},
        {"cancelled readiness does not wake", reactor_cancellation()},
        {"one-shot readiness rearms without duplicate wake", reactor_rearm_is_one_shot()},
        {"backend registration failure leaves op inactive", reactor_registration_failure()},
        {"callback cancellation permits owner free", reactor_callback_can_free_owner()},
        {"host tasks preserve FIFO ownership", host_tasks_fifo()},
        {"host operation handles reject stale and cross-host reuse", host_tasks_stale_handles()},
        {"first terminal completion wins exactly once", host_tasks_completion_wins()},
        {"cancellation suppresses progress and wins exactly once", host_tasks_cancellation_wins()},
    };
    int total = (int) (sizeof(checks) / sizeof(checks[0]));
    int passed = 0;
    for (int i = 0; i < total; i++) {
        if (checks[i].ok) {
            passed++;
        } else {
            printf("reactortest CHECK FAIL: %s\n", checks[i].name);
        }
    }
    printf(
        "reactortest: sleepers=%d/%d order=[%d %d %d %d] byte r=%d w=%d\n",
        g_sleepers_done,
        SLEEPER_COUNT,
        g_wake_len > 0 ? g_wake_order[0] : -1,
        g_wake_len > 1 ? g_wake_order[1] : -1,
        g_wake_len > 2 ? g_wake_order[2] : -1,
        g_wake_len > 3 ? g_wake_order[3] : -1,
        g_byte_read,
        (int) g_byte_written);
    printf("reactortest PASS %d/%d\n", passed, total);

    mal_gc_collect(&vm);
    mal_host_detach(&vm);
    mal_vm_free(&vm);
    return passed == total ? 0 : 1;
}
