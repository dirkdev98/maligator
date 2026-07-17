#pragma once

#include "./defaults.h"

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
 * Single-threaded / single-isolate for now (Phase 4 adds MPSC cross-isolate wake
 * via EVFILT_USER/eventfd — the backend `wake` seam is reserved for it).
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
} MalOp;

/* A pending timer. One-shot: fires its waker once CLOCK_MONOTONIC passes the
 * deadline. Storage is caller-owned; `heap_index` is the reactor's, -1 when not
 * queued. */
typedef struct MalTimer {
    i64 deadline_ns;
    MalWaker waker;
    i32 heap_index;
} MalTimer;

struct MalReactor {
    int backend_fd; /* kqueue / epoll descriptor */

    /* Binary min-heap of pending timers, ordered by deadline. */
    MalTimer **timers;
    i32 timer_count;
    i32 timer_cap;

    /* Count of registered fd ops (so the scheduler knows when work remains). */
    i32 pending_ops;

    /* Reactor-owned readiness registrations and deferred backend event tokens. */
    MalReactorFd *fds;
    MalReactorToken *retired_tokens;
    u64 next_generation;
};

void mal_reactor_init(MalReactor *r);
void mal_reactor_free(MalReactor *r);

/* True while the reactor holds anything that could still fire a waker. */
bool mal_reactor_has_pending(const MalReactor *r);

/* Register / cancel one-shot fd readiness interest. Each op represents exactly
 * one direction. Returns false if the request is invalid or the backend rejects
 * the registration change; a failed add leaves the op inactive. Cancellation is
 * idempotent for an inactive op and always detaches an active op, with false
 * reporting that backend cleanup failed. */
bool mal_reactor_add_op(MalReactor *r, MalOp *op);
bool mal_reactor_cancel_op(MalReactor *r, MalOp *op);

/* Register / cancel a one-shot timer. */
void mal_reactor_add_timer(MalReactor *r, MalTimer *t);
void mal_reactor_cancel_timer(MalReactor *r, MalTimer *t);

/* Block until the nearest timer deadline or an fd event (or return immediately if
 * nothing is pending), firing wakers for everything that became ready. */
void mal_reactor_wait(MalReactor *r);

/* CLOCK_MONOTONIC in nanoseconds. */
i64 mal_reactor_now_ns(void);
