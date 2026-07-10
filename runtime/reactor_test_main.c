#include "vm.h"

#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#include "host.h"
#include "reactor.h"
#include "scheduler.h"

/*
 * Phase 1 acceptance test (isolate_todo.md). Drives the I/O reactor through the
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
