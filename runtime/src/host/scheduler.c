#include "scheduler.h"

#include "gc.h"
#include "host.h"

MalScheduler *mal_current_scheduler = nullptr;

#define MAL_SCHED_DEFAULT_BUDGET 1000

/* ---------------------------------------------------------------------------
 * Run queue (intrusive FIFO).
 * --------------------------------------------------------------------------- */

static void mal_sched_enqueue(MalScheduler *s, MalFiber *f) {
    f->rq_next = nullptr;
    if (s->run_tail != nullptr) {
        s->run_tail->rq_next = f;
    } else {
        s->run_head = f;
    }
    s->run_tail = f;
}

static MalFiber *mal_sched_dequeue(MalScheduler *s) {
    MalFiber *f = s->run_head;
    if (f == nullptr) {
        return nullptr;
    }
    s->run_head = f->rq_next;
    if (s->run_head == nullptr) {
        s->run_tail = nullptr;
    }
    f->rq_next = nullptr;
    return f;
}

/* ---------------------------------------------------------------------------
 * Context switch: swap the per-fiber exec slice around the raw stack switch, so
 * the live MalVm always reflects the fiber that is running.
 * --------------------------------------------------------------------------- */

static void mal_sched_switch(MalScheduler *s, MalFiber *from, MalFiber *to) {
    mal_fiber_save_exec(from, s->vm);
    mal_fiber_load_exec(to, s->vm); /* sets vm->current_fiber + mal_current_fiber */
    s->current = to;
    mal_fiber_switch(&from->ctx_sp, &to->ctx_sp);
    /* Resumed later: whoever switched back into `from` already loaded its slice, so
     * the live MalVm + s->current reflect `from` again. Nothing to restore here. */
}

/* ---------------------------------------------------------------------------
 * Hooks (installed into the fiber/GC layers).
 * --------------------------------------------------------------------------- */

/* A fiber's entry returned: switch back to the scheduler; never comes back. */
static void mal_sched_fiber_exit(MalFiber *finished) {
    MalScheduler *s = mal_current_scheduler;
    mal_sched_switch(s, finished, s->main_fiber);
    __builtin_trap(); /* unreachable: we never switch into a FINISHED fiber */
}

/* Called at every safepoint. Charges one reduction to the running worker and
 * yields it when the budget is spent. The scheduler (main) fiber is never
 * preempted. */
static void mal_sched_preempt(MalVm *vm) {
    (void) vm;
    MalScheduler *s = mal_current_scheduler;
    if (s == nullptr) {
        return;
    }
    MalFiber *self = s->current;
    if (self == nullptr || self == s->main_fiber) {
        return;
    }
    if (self->reductions_left > 0) {
        self->reductions_left--;
        return;
    }
    mal_sched_yield();
}

/* ---------------------------------------------------------------------------
 * Public API.
 * --------------------------------------------------------------------------- */

void mal_sched_init(MalScheduler *s, MalVm *vm) {
    s->vm = vm;
    s->main_fiber = vm->current_fiber; /* created by mal_fiber_init_main */
    s->current = vm->current_fiber;
    s->run_head = nullptr;
    s->run_tail = nullptr;
    s->default_budget = MAL_SCHED_DEFAULT_BUDGET;
    // The reactor is owned by the isolate (vm), initialized in mal_vm_init.

    mal_current_scheduler = s;
    mal_fiber_exit_hook = mal_sched_fiber_exit;
    mal_gc_preempt_hook = mal_sched_preempt;
}

void mal_sched_shutdown(void) {
    // The reactor is owned by the isolate (freed in mal_vm_free), not here.
    mal_gc_preempt_hook = nullptr;
    mal_fiber_exit_hook = nullptr;
    mal_current_scheduler = nullptr;
}

MalFiber *mal_sched_spawn(MalScheduler *s, void (*entry)(void *), void *arg) {
    MalFiber *f = mal_fiber_create(s->vm, entry, arg, 0, 0);
    if (f == nullptr) {
        return nullptr;
    }
    f->state = MAL_FIBER_RUNNABLE;
    mal_sched_enqueue(s, f);
    return f;
}

void mal_sched_run(MalScheduler *s) {
    for (;;) {
        MalFiber *f = mal_sched_dequeue(s);
        if (f == nullptr) {
            // Run queue drained. If the reactor still holds timers/ops, block until
            // one fires (which wakes — re-enqueues — a fiber), then loop. Otherwise
            // there is no way to make progress: the isolate is idle, so exit.
            if (mal_reactor_has_pending(&mal_host(s->vm)->reactor)) {
                mal_reactor_wait(&mal_host(s->vm)->reactor);
                continue;
            }
            break;
        }
        if (f->state == MAL_FIBER_FINISHED) {
            mal_fiber_destroy(s->vm, f);
            continue;
        }
        f->reductions_left = s->default_budget;
        f->state = MAL_FIBER_RUNNING;

        mal_sched_switch(s, s->main_fiber, f);
        /* Back on the main fiber: `f` yielded, blocked, or finished. */

        switch (f->state) {
            case MAL_FIBER_FINISHED:
                mal_fiber_destroy(s->vm, f);
                break;
            case MAL_FIBER_RUNNABLE:
                mal_sched_enqueue(s, f); /* round-robin */
                break;
            case MAL_FIBER_BLOCKED:
                break; /* left out; a wake re-enqueues it */
            default:
                break;
        }
    }
}

void mal_sched_yield(void) {
    MalScheduler *s = mal_current_scheduler;
    MalFiber *self = s->current;
    self->state = MAL_FIBER_RUNNABLE;
    mal_sched_switch(s, self, s->main_fiber);
}

void mal_sched_block(void) {
    MalScheduler *s = mal_current_scheduler;
    MalFiber *self = s->current;
    self->state = MAL_FIBER_BLOCKED;
    mal_sched_switch(s, self, s->main_fiber);
}

void mal_sched_wake(MalScheduler *s, MalFiber *fiber) {
    if (fiber->state == MAL_FIBER_BLOCKED) {
        fiber->state = MAL_FIBER_RUNNABLE;
        mal_sched_enqueue(s, fiber);
    }
}

/* --- Fiber I/O ------------------------------------------------------------- */

/* Reactor waker that re-runs a fiber. Runs on the main fiber inside
 * mal_reactor_wait, so mal_current_scheduler is valid. */
static void mal_sched_wake_fiber_cb(void *data) {
    mal_sched_wake(mal_current_scheduler, (MalFiber *) data);
}

static MalWaker mal_sched_fiber_waker(MalFiber *f) {
    return (MalWaker) {.fn = mal_sched_wake_fiber_cb, .data = f};
}

void mal_sched_sleep_ns(MalScheduler *s, i64 ns) {
    MalFiber *self = s->current;
    MalTimer timer = {
        .deadline_ns = mal_reactor_now_ns() + (ns < 0 ? 0 : ns),
        .waker = mal_sched_fiber_waker(self),
        .heap_index = -1,
    };
    mal_reactor_add_timer(&mal_host(s->vm)->reactor, &timer);
    mal_sched_block(); // suspend; the reactor fires the timer -> wakes us
    // Resumed. If we were woken for some other reason, drop the stale timer.
    mal_reactor_cancel_timer(&mal_host(s->vm)->reactor, &timer);
}

void mal_sched_wait_fd(MalScheduler *s, int fd, MalIoInterest interest) {
    MalFiber *self = s->current;
    MalOp op = {
        .fd = fd,
        .interest = interest,
        .waker = mal_sched_fiber_waker(self),
        .active = false,
    };
    mal_reactor_add_op(&mal_host(s->vm)->reactor, &op);
    mal_sched_block();
    // Resumed. If we were woken for some other reason, deregister the stale op.
    mal_reactor_cancel_op(&mal_host(s->vm)->reactor, &op);
}
