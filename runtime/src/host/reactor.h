#pragma once

#include "./defaults.h"

#include <stdatomic.h>

/*
 * The I/O reactor (see docs/decisions/03-wave-0-host-architecture.md). Completion-oriented core: a caller
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
    MalReactor *_reactor;
    struct MalOp *_ready_next;
    bool active; /* true while registered; cleared when it fires or is cancelled */
    bool _queued_ready;
} MalOp;

static_assert(sizeof(MalOp) <= 48, "MalOp outgrew its 48-byte layout");

/* A pending timer. One-shot: fires its waker once CLOCK_MONOTONIC passes the
 * deadline. Storage is caller-owned; `heap_index` is the reactor's, -1 when not
 * queued. */
typedef struct MalTimer {
    /* The heap key: the deadline the timer surfaces at. */
    i64 deadline_ns;
    /* A re-armed deadline later than the key, applied when the key surfaces. */
    i64 postponed_ns;
    MalWaker waker;
    i32 heap_index;
    u64 sequence;
} MalTimer;

#define MAL_REACTOR_CHANGE_CAPACITY 32

/* A kqueue registration awaiting submission with the next backend wait. */
typedef struct MalReactorChange {
    int fd;
    i16 filter;
    void *token;
} MalReactorChange;

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
    /* Registered ops their owners marked as not keeping the event loop alive. */
    i32 unreferenced_ops;

    /* Ops queued to run before the next backend wait. */
    MalOp *ready_ops;
    MalOp *ready_ops_tail;
    i32 ready_op_count;

    /* Reactor-owned readiness registrations and deferred backend event tokens. */
    MalReactorFd *fds;
    MalReactorFd *retired_fds;
    MalReactorFd *free_fds;
    i32 free_fd_count;
    /* Sparse two-level fd -> state index (256 descriptor slots per leaf). */
    MalReactorFd ***fd_pages;
    usize fd_page_count;
    MalReactorToken *retired_tokens;
    MalReactorToken *free_tokens;
    u64 next_generation;

    MalReactorChange changes[MAL_REACTOR_CHANGE_CAPACITY];
    i32 change_count;

    /* The clock as of the start of the current pump or the last backend wait. */
    i64 loop_now_ns;
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

/* Move a timer's deadline, queueing it if needed. A queued timer that only moves
 * later keeps its heap slot and is re-keyed when that slot comes due, so an
 * inactivity timeout re-armed on every exchange costs no heap work. Equal
 * deadlines then fire in re-key order, which suits only such timeouts. */
void mal_reactor_rearm_timer(MalReactor *r, MalTimer *t, i64 deadline_ns);

/* Block until the nearest timer deadline or an fd event (or return immediately if
 * nothing is pending), firing wakers for everything that became ready. */
void mal_reactor_wait(MalReactor *r);

// Service a bounded ready-op snapshot, fd readiness and due timers without blocking.
void mal_reactor_poll(MalReactor *r);

/* CLOCK_MONOTONIC in nanoseconds. */
i64 mal_reactor_now_ns(void);

/* The clock as last sampled by the reactor loop, libuv's uv_now. It lags the real
 * clock by the callbacks run since, so it suits only deadlines that tolerate firing
 * that much early, such as connection inactivity timeouts. */
i64 mal_reactor_loop_now_ns(const MalReactor *r);
