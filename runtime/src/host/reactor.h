#pragma once

#include "./defaults.h"

#include <stdatomic.h>

/*
 * The I/O reactor (see docs/roadmaps/isolate-reactor.md). Completion-oriented core: a caller
 * registers interest (an fd becoming ready, or a deadline passing) together with a
 * *waker* — "make my task runnable again" — and when the event occurs the reactor
 * fires the waker. The scheduler's run loop drains runnable fibers, then blocks in
 * mal_reactor_wait when idle-but-pending, so a fiber that is waiting on I/O or a
 * timer costs nothing until its event lands.
 *
 * The completion interface is the contract; the kqueue/epoll backends implement it
 * by *readiness emulation* (watch the fd, fire the waker when ready — the caller
 * then does the syscall). io_uring / IOCP (true completion with kernel-filled
 * buffers) slot in behind the same waker interface later; the non-moving GC makes
 * handing a GC-owned buffer straight to the kernel a Phase-2 concern, not a
 * representation change here.
 *
 * Registrations and dispatch remain reactor-thread-only. The retained-work and
 * wake entries are thread-safe so bounded worker threads can post completions.
 */

/* "Make this task runnable again." Fired by the reactor when an op/timer resolves.
 * For a fiber, `fn` re-enqueues it on the scheduler and `data` is the MalFiber. */
typedef struct MalWaker {
    void (*fn)(void *data);
    void *data;
} MalWaker;

typedef enum MalIoInterest {
    MAL_IO_READ = 1,
    MAL_IO_WRITE = 2,
} MalIoInterest;

typedef struct MalReactor MalReactor;
typedef struct MalReactorFd MalReactorFd;
typedef struct MalReactorToken MalReactorToken;

/* A pending readiness op. One-shot: fires its waker once the fd is ready, then is
 * removed. Storage is caller-owned (typically a stack local on the waiting fiber,
 * kept valid because a suspended fiber's C stack is preserved). */
typedef struct MalOp {
    int fd;
    MalIoInterest interest;
    MalWaker waker;
    bool active; /* true while registered; cleared when it fires or is cancelled */
    MalReactor *_reactor;
    struct MalOp *_ready_next;
    bool _queued_ready;
} MalOp;

/* A pending timer. One-shot: fires its waker once CLOCK_MONOTONIC passes the
 * deadline. Storage is caller-owned; `heap_index` is the reactor's, -1 when not
 * queued. */
typedef struct MalTimer {
    i64 deadline_ns;
    MalWaker waker;
    i32 heap_index;
    u64 sequence;
} MalTimer;

struct MalReactor {
    int backend_fd; /* kqueue / epoll descriptor */
    int wake_read_fd;
    int wake_write_fd;
    _Atomic(bool) wake_pending;
    _Atomic(usize) retained_work;
    MalWaker wake_waker;

    /* Binary min-heap of pending timers, ordered by deadline. */
    MalTimer **timers;
    i32 timer_count;
    i32 timer_cap;
    u64 next_timer_sequence;

    /* Count of registered fd ops (so the scheduler knows when work remains). */
    i32 pending_ops;

    /* Ops queued to run before the next backend wait. */
    MalOp *ready_ops;
    MalOp *ready_ops_tail;
    i32 ready_op_count;

    /* Reactor-owned readiness registrations and deferred backend event tokens. */
    MalReactorFd *fds;
    MalReactorToken *retired_tokens;
    u64 next_generation;
};

void mal_reactor_init(MalReactor *r);
void mal_reactor_free(MalReactor *r);

/* True while the reactor holds anything that could still fire a waker. */
bool mal_reactor_has_pending(const MalReactor *r);

/* Account for work that can complete only on another thread. Retain before the
 * worker becomes visible; release wakes a blocked reactor so it can recheck idle. */
bool mal_reactor_retain_work(MalReactor *r);
bool mal_reactor_release_work(MalReactor *r);

/* Install the reactor-thread callback and signal it from any producer thread.
 * Signals coalesce; a successful call guarantees a pollable wake remains. */
void mal_reactor_set_waker(MalReactor *r, MalWaker waker);
/* The reactor must outlive every thread that can call wake/release_work. */
bool mal_reactor_wake(MalReactor *r);

/* Register / cancel one-shot fd readiness interest. Each op represents exactly
 * one direction. Returns false if the request is invalid or the backend rejects
 * the registration change; a failed add leaves the op inactive. Cancellation is
 * idempotent for an inactive op and always detaches an active op, with false
 * reporting that backend cleanup failed. */
bool mal_reactor_add_op(MalReactor *r, MalOp *op);
/* Queue an op's waker without waiting for fd readiness. This preserves the
 * reactor callback boundary for optimistic I/O; a callback that encounters
 * EAGAIN can re-register the op through mal_reactor_add_op. */
bool mal_reactor_defer_op(MalReactor *r, MalOp *op);
bool mal_reactor_cancel_op(MalReactor *r, MalOp *op);

/* Register / cancel a one-shot timer. */
void mal_reactor_add_timer(MalReactor *r, MalTimer *t);
void mal_reactor_cancel_timer(MalReactor *r, MalTimer *t);

/* Block until the nearest timer deadline or an fd event (or return immediately if
 * nothing is pending), firing wakers for everything that became ready. */
void mal_reactor_wait(MalReactor *r);

/* CLOCK_MONOTONIC in nanoseconds. */
i64 mal_reactor_now_ns(void);
