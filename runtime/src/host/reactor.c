#include "reactor.h"

#include <stdlib.h>
#include <time.h>
#include <unistd.h>

#if defined(__APPLE__) || defined(__FreeBSD__)
#define MAL_REACTOR_KQUEUE 1
#include <sys/event.h>
#include <sys/types.h>
#elif defined(__linux__)
#define MAL_REACTOR_EPOLL 1
#include <sys/epoll.h>
#else
#error "mal_reactor: no backend for this platform (need kqueue or epoll)"
#endif

#define MAL_REACTOR_MAX_EVENTS 64

i64 mal_reactor_now_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (i64) ts.tv_sec * 1000000000 + (i64) ts.tv_nsec;
}

/* ---------------------------------------------------------------------------
 * Timer min-heap (ordered by deadline). heap_index is kept current on every move
 * so a timer can be cancelled in O(log n) by pointer.
 * --------------------------------------------------------------------------- */

static void mal_timer_swap(MalReactor *r, i32 a, i32 b) {
    MalTimer *ta = r->timers[a];
    MalTimer *tb = r->timers[b];
    r->timers[a] = tb;
    r->timers[b] = ta;
    tb->heap_index = a;
    ta->heap_index = b;
}

static void mal_timer_sift_up(MalReactor *r, i32 i) {
    while (i > 0) {
        i32 parent = (i - 1) / 2;
        if (r->timers[parent]->deadline_ns <= r->timers[i]->deadline_ns) {
            break;
        }
        mal_timer_swap(r, i, parent);
        i = parent;
    }
}

static void mal_timer_sift_down(MalReactor *r, i32 i) {
    for (;;) {
        i32 left = 2 * i + 1;
        i32 right = 2 * i + 2;
        i32 smallest = i;
        if (left < r->timer_count &&
            r->timers[left]->deadline_ns < r->timers[smallest]->deadline_ns) {
            smallest = left;
        }
        if (right < r->timer_count &&
            r->timers[right]->deadline_ns < r->timers[smallest]->deadline_ns) {
            smallest = right;
        }
        if (smallest == i) {
            break;
        }
        mal_timer_swap(r, i, smallest);
        i = smallest;
    }
}

void mal_reactor_add_timer(MalReactor *r, MalTimer *t) {
    if (r->timer_count == r->timer_cap) {
        r->timer_cap = r->timer_cap == 0 ? 8 : r->timer_cap * 2;
        r->timers = realloc(r->timers, sizeof(MalTimer *) * (usize) r->timer_cap);
    }
    i32 i = r->timer_count++;
    r->timers[i] = t;
    t->heap_index = i;
    mal_timer_sift_up(r, i);
}

/* Remove the timer at heap slot `i`, restoring the heap invariant. */
static MalTimer *mal_timer_remove_at(MalReactor *r, i32 i) {
    MalTimer *removed = r->timers[i];
    i32 last = --r->timer_count;
    removed->heap_index = -1;
    if (i != last) {
        r->timers[i] = r->timers[last];
        r->timers[i]->heap_index = i;
        // The moved element may need to go either direction.
        mal_timer_sift_down(r, i);
        mal_timer_sift_up(r, i);
    }
    return removed;
}

void mal_reactor_cancel_timer(MalReactor *r, MalTimer *t) {
    if (t->heap_index >= 0 && t->heap_index < r->timer_count &&
        r->timers[t->heap_index] == t) {
        mal_timer_remove_at(r, t->heap_index);
    }
}

/* ---------------------------------------------------------------------------
 * Backend: readiness → completion. One-shot registration; the op fires once.
 * --------------------------------------------------------------------------- */

static int mal_backend_create(void) {
#if MAL_REACTOR_KQUEUE
    return kqueue();
#else
    return epoll_create1(EPOLL_CLOEXEC);
#endif
}

static void mal_backend_add(int backend_fd, MalOp *op) {
#if MAL_REACTOR_KQUEUE
    struct kevent kev;
    i16 filter = (op->interest & MAL_IO_WRITE) ? EVFILT_WRITE : EVFILT_READ;
    EV_SET(&kev, (uintptr_t) op->fd, filter, EV_ADD | EV_ONESHOT, 0, 0, op);
    kevent(backend_fd, &kev, 1, nullptr, 0, nullptr);
#else
    struct epoll_event ev = {0};
    ev.events = EPOLLONESHOT | ((op->interest & MAL_IO_READ) ? EPOLLIN : 0u) |
        ((op->interest & MAL_IO_WRITE) ? EPOLLOUT : 0u);
    ev.data.ptr = op;
    epoll_ctl(backend_fd, EPOLL_CTL_ADD, op->fd, &ev);
#endif
}

static void mal_backend_del(int backend_fd, MalOp *op) {
#if MAL_REACTOR_KQUEUE
    struct kevent kev;
    i16 filter = (op->interest & MAL_IO_WRITE) ? EVFILT_WRITE : EVFILT_READ;
    EV_SET(&kev, (uintptr_t) op->fd, filter, EV_DELETE, 0, 0, nullptr);
    kevent(backend_fd, &kev, 1, nullptr, 0, nullptr); // best-effort (may be gone)
#else
    epoll_ctl(backend_fd, EPOLL_CTL_DEL, op->fd, nullptr);
#endif
}

/* Block up to timeout_ns (< 0 = forever), firing the waker of each ready op. */
static void mal_backend_wait(MalReactor *r, i64 timeout_ns) {
#if MAL_REACTOR_KQUEUE
    struct kevent evs[MAL_REACTOR_MAX_EVENTS];
    struct timespec ts;
    struct timespec *tsp = nullptr;
    if (timeout_ns >= 0) {
        ts.tv_sec = (time_t) (timeout_ns / 1000000000);
        ts.tv_nsec = (long) (timeout_ns % 1000000000);
        tsp = &ts;
    }
    int n = kevent(r->backend_fd, nullptr, 0, evs, MAL_REACTOR_MAX_EVENTS, tsp);
    for (int i = 0; i < n; i++) {
        MalOp *op = (MalOp *) evs[i].udata;
        if (op == nullptr || !op->active) {
            continue;
        }
        op->active = false; // EV_ONESHOT already disarmed it
        r->pending_ops--;
        op->waker.fn(op->waker.data);
    }
#else
    struct epoll_event evs[MAL_REACTOR_MAX_EVENTS];
    int timeout_ms = timeout_ns < 0 ? -1 : (int) ((timeout_ns + 999999) / 1000000);
    int n = epoll_wait(r->backend_fd, evs, MAL_REACTOR_MAX_EVENTS, timeout_ms);
    for (int i = 0; i < n; i++) {
        MalOp *op = (MalOp *) evs[i].data.ptr;
        if (op == nullptr || !op->active) {
            continue;
        }
        op->active = false;
        r->pending_ops--;
        epoll_ctl(r->backend_fd, EPOLL_CTL_DEL, op->fd, nullptr); // one-shot cleanup
        op->waker.fn(op->waker.data);
    }
#endif
}

/* ---------------------------------------------------------------------------
 * Public reactor API.
 * --------------------------------------------------------------------------- */

void mal_reactor_init(MalReactor *r) {
    r->backend_fd = mal_backend_create();
    r->timers = nullptr;
    r->timer_count = 0;
    r->timer_cap = 0;
    r->pending_ops = 0;
}

void mal_reactor_free(MalReactor *r) {
    if (r->backend_fd >= 0) {
        close(r->backend_fd);
        r->backend_fd = -1;
    }
    free(r->timers);
    r->timers = nullptr;
    r->timer_count = 0;
    r->timer_cap = 0;
    r->pending_ops = 0;
}

bool mal_reactor_has_pending(const MalReactor *r) {
    return r->timer_count > 0 || r->pending_ops > 0;
}

void mal_reactor_add_op(MalReactor *r, MalOp *op) {
    op->active = true;
    r->pending_ops++;
    mal_backend_add(r->backend_fd, op);
}

void mal_reactor_cancel_op(MalReactor *r, MalOp *op) {
    if (op->active) {
        op->active = false;
        r->pending_ops--;
        mal_backend_del(r->backend_fd, op);
    }
}

void mal_reactor_wait(MalReactor *r) {
    i64 timeout;
    if (r->timer_count > 0) {
        i64 now = mal_reactor_now_ns();
        i64 deadline = r->timers[0]->deadline_ns;
        timeout = deadline > now ? deadline - now : 0;
    } else if (r->pending_ops > 0) {
        timeout = -1; // block until an fd event
    } else {
        return; // nothing pending
    }

    mal_backend_wait(r, timeout);

    // Fire every timer whose deadline has now passed.
    i64 now = mal_reactor_now_ns();
    while (r->timer_count > 0 && r->timers[0]->deadline_ns <= now) {
        MalTimer *t = mal_timer_remove_at(r, 0);
        t->waker.fn(t->waker.data);
    }
}
