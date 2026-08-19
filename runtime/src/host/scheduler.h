#pragma once

#include "./defaults.h"
#include "fiber.h"
#include "reactor.h"
#include "vm.h"

/*
 * Minimal cooperative + preemptive round-robin scheduler for one isolate
 * (see docs/decisions/03-wave-0-host-architecture.md). It runs on the main fiber: mal_sched_run drains a
 * FIFO of runnable fibers, switching into each until it yields, blocks, or
 * finishes, then round-robins the runnable ones. Preemption is via the GC
 * safepoint hook: each fiber gets a reduction budget, and a safepoint (a
 * mal_gc_poll site the compiler already emits at loop back-edges / call returns)
 * yields the fiber once its budget is spent — so a tight CPU loop can't starve
 * its peers ("lots, preemptively-fair, CPU-bound-friendly").
 *
 * This is deliberately single-threaded and single-isolate. SMP (N schedulers on
 * OS threads, MPSC injector, cross-isolate wake) is Phase 4; the run-queue link
 * and wake entry are shaped so that grows without a rewrite.
 */

typedef struct MalScheduler {
    MalVm *vm; /* the isolate */

    /* The scheduler runs on this fiber (the isolate's main fiber). A worker yields
     * back to it; it never sits in the run queue. */
    MalFiber *main_fiber;

    /* The fiber currently executing (a worker, or main_fiber while scheduling). */
    MalFiber *current;

    /* Run queue: intrusive singly-linked FIFO via MalFiber.rq_next. */
    MalFiber *run_head;
    MalFiber *run_tail;

    /* Reductions granted to a fiber each time it is scheduled in. */
    i32 default_budget;
} MalScheduler;

/* The active scheduler (isolate-local). Read by the preempt hook and yield.
 * SMP requires _Thread_local storage per scheduler thread. */
extern MalScheduler *mal_current_scheduler;

/* Initialize `s` over an already-initialized isolate `vm` (whose main fiber
 * exists), install the preemption + fiber-exit hooks, and make it current. */
void mal_sched_init(MalScheduler *s, MalVm *vm);

/* Uninstall the hooks and clear the current scheduler. Call before the scheduler
 * (and any borrowed stack storage) goes away, so a later safepoint can't call a
 * dangling hook. */
void mal_sched_shutdown(void);

/* Create a fiber running `entry(arg)` and enqueue it as runnable. */
MalFiber *mal_sched_spawn(MalScheduler *s, void (*entry)(void *), void *arg);

/* Run until the run queue drains (all fibers finished or blocked). Returns on the
 * main fiber. */
void mal_sched_run(MalScheduler *s);

/* Called from within a running fiber to voluntarily give up the core; it stays
 * runnable and is re-enqueued. Returns when scheduled again. */
void mal_sched_yield(void);

/* Called from within a running fiber to suspend it pending an external event; it
 * is NOT re-enqueued. A later mal_sched_wake makes it runnable again. */
void mal_sched_block(void);

/* Mark a BLOCKED fiber runnable and enqueue it (the future waker entry). Safe to
 * call from the scheduler/main fiber. */
void mal_sched_wake(MalScheduler *s, MalFiber *fiber);

/* --- Fiber I/O (blocking-looking, actually reactor-driven) --------------------
 * Called from within a running fiber; each suspends the fiber on the reactor and
 * returns when its event lands, so the fiber's peers keep running meanwhile. */

/* Suspend the running fiber for at least `ns` nanoseconds. */
void mal_sched_sleep_ns(MalScheduler *s, i64 ns);

/* Suspend the running fiber until `fd` is ready for the given interest. */
void mal_sched_wait_fd(MalScheduler *s, int fd, MalIoInterest interest);
