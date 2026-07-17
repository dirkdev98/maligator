#include "reactor.h"

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
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

struct MalReactorFd {
    int fd;
    MalOp *read_op;
    MalOp *write_op;
    u64 read_generation;
    u64 write_generation;
    MalReactorToken *read_token;
    MalReactorToken *write_token;
    MalReactorToken *poll_token;
    bool backend_present;
    MalReactorFd *next;
};

struct MalReactorToken {
    MalReactorFd *fd_state;
    u64 read_generation;
    u64 write_generation;
    MalReactorToken *next;
};

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

static bool mal_fd_set_flags(int fd) {
    int status = fcntl(fd, F_GETFL, 0);
    if (status < 0 || fcntl(fd, F_SETFL, status | O_NONBLOCK) < 0) {
        return false;
    }
    int descriptor = fcntl(fd, F_GETFD, 0);
    return descriptor >= 0 && fcntl(fd, F_SETFD, descriptor | FD_CLOEXEC) == 0;
}

static bool mal_backend_add_wake(MalReactor *r) {
    int fds[2] = {-1, -1};
    if (r->backend_fd < 0 || pipe(fds) < 0) {
        return false;
    }
    if (!mal_fd_set_flags(fds[0]) || !mal_fd_set_flags(fds[1])) {
        close(fds[0]);
        close(fds[1]);
        return false;
    }

#if MAL_REACTOR_KQUEUE
    struct kevent kev;
    EV_SET(&kev, (uintptr_t) fds[0], EVFILT_READ, EV_ADD, 0, 0, r);
    bool added = kevent(r->backend_fd, &kev, 1, nullptr, 0, nullptr) == 0;
#else
    struct epoll_event ev = {0};
    ev.events = EPOLLIN;
    ev.data.ptr = r;
    bool added = epoll_ctl(r->backend_fd, EPOLL_CTL_ADD, fds[0], &ev) == 0;
#endif
    if (!added) {
        close(fds[0]);
        close(fds[1]);
        return false;
    }
    r->wake_read_fd = fds[0];
    r->wake_write_fd = fds[1];
    return true;
}

static void mal_reactor_dispatch_wake(MalReactor *r) {
    unsigned char bytes[64];
    for (;;) {
        ssize_t count = read(r->wake_read_fd, bytes, sizeof(bytes));
        if (count > 0) {
            continue;
        }
        if (count < 0 && errno == EINTR) {
            continue;
        }
        break;
    }

    /* Clear before invoking the consumer. A producer racing the batch drain then
     * writes a fresh byte; one racing earlier is included in this callback. */
    atomic_store_explicit(&r->wake_pending, false, memory_order_release);
    MalWaker waker = r->wake_waker;
    if (waker.fn != nullptr) {
        waker.fn(waker.data);
    }
}

static MalReactorFd *mal_reactor_find_fd(MalReactor *r, int fd) {
    for (MalReactorFd *state = r->fds; state != nullptr; state = state->next) {
        if (state->fd == fd) {
            return state;
        }
    }
    return nullptr;
}

static MalReactorFd *mal_reactor_get_fd(MalReactor *r, int fd) {
    MalReactorFd *state = mal_reactor_find_fd(r, fd);
    if (state != nullptr) {
        return state;
    }
    state = calloc(1, sizeof(MalReactorFd));
    if (state == nullptr) {
        return nullptr;
    }
    state->fd = fd;
    state->next = r->fds;
    r->fds = state;
    return state;
}

static MalReactorToken *mal_reactor_token(MalReactorFd *state) {
    MalReactorToken *token = malloc(sizeof(MalReactorToken));
    if (token == nullptr) {
        return nullptr;
    }
    token->fd_state = state;
    token->read_generation = state->read_generation;
    token->write_generation = state->write_generation;
    token->next = nullptr;
    return token;
}

static void mal_reactor_retire_token(MalReactor *r, MalReactorToken *token) {
    if (token == nullptr) {
        return;
    }
    token->next = r->retired_tokens;
    r->retired_tokens = token;
}

static void mal_reactor_free_retired_tokens(MalReactor *r) {
    while (r->retired_tokens != nullptr) {
        MalReactorToken *token = r->retired_tokens;
        r->retired_tokens = token->next;
        free(token);
    }
}

#if MAL_REACTOR_KQUEUE
static bool mal_backend_add_interest(MalReactor *r, MalReactorFd *state, MalIoInterest interest) {
    MalReactorToken *token = mal_reactor_token(state);
    if (token == nullptr) {
        return false;
    }
    struct kevent kev;
    i16 filter = interest == MAL_IO_WRITE ? EVFILT_WRITE : EVFILT_READ;
    EV_SET(&kev, (uintptr_t) state->fd, filter, EV_ADD | EV_ONESHOT, 0, 0, token);
    if (kevent(r->backend_fd, &kev, 1, nullptr, 0, nullptr) < 0) {
        free(token);
        return false;
    }
    MalReactorToken **slot =
        interest == MAL_IO_READ ? &state->read_token : &state->write_token;
    mal_reactor_retire_token(r, *slot);
    *slot = token;
    return true;
}

static bool mal_backend_del_interest(MalReactor *r, MalReactorFd *state, MalIoInterest interest) {
    struct kevent kev;
    i16 filter = interest == MAL_IO_WRITE ? EVFILT_WRITE : EVFILT_READ;
    EV_SET(&kev, (uintptr_t) state->fd, filter, EV_DELETE, 0, 0, nullptr);
    if (kevent(r->backend_fd, &kev, 1, nullptr, 0, nullptr) < 0 && errno != ENOENT &&
        errno != EBADF) {
        return false;
    }
    MalReactorToken **slot =
        interest == MAL_IO_READ ? &state->read_token : &state->write_token;
    mal_reactor_retire_token(r, *slot);
    *slot = nullptr;
    return true;
}
#else
static bool mal_backend_sync(MalReactor *r, MalReactorFd *state) {
    bool wanted = state->read_op != nullptr || state->write_op != nullptr;
    if (!wanted) {
        if (!state->backend_present) {
            return true;
        }
        if (epoll_ctl(r->backend_fd, EPOLL_CTL_DEL, state->fd, nullptr) < 0 &&
            errno != ENOENT && errno != EBADF) {
            return false;
        }
        state->backend_present = false;
        mal_reactor_retire_token(r, state->poll_token);
        state->poll_token = nullptr;
        return true;
    }

    MalReactorToken *token = mal_reactor_token(state);
    if (token == nullptr) {
        return false;
    }
    struct epoll_event ev = {0};
    ev.events = EPOLLONESHOT | EPOLLRDHUP | (state->read_op != nullptr ? EPOLLIN : 0u) |
        (state->write_op != nullptr ? EPOLLOUT : 0u);
    ev.data.ptr = token;
    int operation = state->backend_present ? EPOLL_CTL_MOD : EPOLL_CTL_ADD;
    if (epoll_ctl(r->backend_fd, operation, state->fd, &ev) < 0) {
        if (operation != EPOLL_CTL_MOD || errno != ENOENT ||
            epoll_ctl(r->backend_fd, EPOLL_CTL_ADD, state->fd, &ev) < 0) {
            free(token);
            return false;
        }
    }
    state->backend_present = true;
    mal_reactor_retire_token(r, state->poll_token);
    state->poll_token = token;
    return true;
}
#endif

static MalOp **mal_fd_op_slot(MalReactorFd *state, MalIoInterest interest) {
    return interest == MAL_IO_READ ? &state->read_op : &state->write_op;
}

static u64 *mal_fd_generation_slot(MalReactorFd *state, MalIoInterest interest) {
    return interest == MAL_IO_READ ? &state->read_generation : &state->write_generation;
}

static bool mal_reactor_dispatch_op(
    MalReactor *r, MalReactorFd *state, MalIoInterest interest, u64 generation) {
    MalOp **slot = mal_fd_op_slot(state, interest);
    if (*slot == nullptr || *mal_fd_generation_slot(state, interest) != generation) {
        return true;
    }

    MalOp *op = *slot;
    MalWaker waker = op->waker;
    *slot = nullptr;
    op->active = false;
    op->_reactor = nullptr;
    r->pending_ops--;

#if MAL_REACTOR_KQUEUE
    bool synced = true;
#else
    bool synced = mal_backend_sync(r, state);
#endif
    waker.fn(waker.data);
    return synced;
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
        if (evs[i].udata == r) {
            mal_reactor_dispatch_wake(r);
            continue;
        }
        MalReactorToken *token = (MalReactorToken *) evs[i].udata;
        if (token == nullptr) {
            continue;
        }
        MalReactorFd *state = token->fd_state;
        if (evs[i].filter == EVFILT_READ && state->read_token == token) {
            state->read_token = nullptr;
            mal_reactor_retire_token(r, token);
            mal_reactor_dispatch_op(r, state, MAL_IO_READ, token->read_generation);
        } else if (evs[i].filter == EVFILT_WRITE && state->write_token == token) {
            state->write_token = nullptr;
            mal_reactor_retire_token(r, token);
            mal_reactor_dispatch_op(r, state, MAL_IO_WRITE, token->write_generation);
        }
    }
#else
    struct epoll_event evs[MAL_REACTOR_MAX_EVENTS];
    int timeout_ms = timeout_ns < 0 ? -1 : (int) ((timeout_ns + 999999) / 1000000);
    int n = epoll_wait(r->backend_fd, evs, MAL_REACTOR_MAX_EVENTS, timeout_ms);
    for (int i = 0; i < n; i++) {
        if (evs[i].data.ptr == r) {
            mal_reactor_dispatch_wake(r);
            continue;
        }
        MalReactorToken *token = (MalReactorToken *) evs[i].data.ptr;
        if (token == nullptr) {
            continue;
        }
        MalReactorFd *state = token->fd_state;
        if (state->poll_token != token) {
            continue;
        }
        state->poll_token = nullptr;
        mal_reactor_retire_token(r, token);

        u32 events = evs[i].events;
        bool read_ready =
            (events & (EPOLLIN | EPOLLRDHUP | EPOLLHUP | EPOLLERR)) != 0;
        bool write_ready = (events & (EPOLLOUT | EPOLLHUP | EPOLLERR)) != 0;
        bool synced = true;
        if (read_ready) {
            synced = mal_reactor_dispatch_op(
                r, state, MAL_IO_READ, token->read_generation);
        }
        if (write_ready) {
            synced = mal_reactor_dispatch_op(
                         r, state, MAL_IO_WRITE, token->write_generation) &&
                synced;
        }
        /* EPOLLONESHOT disables both directions. If rearming the direction that
         * did not fire failed, wake it rather than leaving an unreachable op. */
        if (!synced) {
            if (!read_ready) {
                mal_reactor_dispatch_op(r, state, MAL_IO_READ, token->read_generation);
            }
            if (!write_ready) {
                mal_reactor_dispatch_op(r, state, MAL_IO_WRITE, token->write_generation);
            }
        }
    }
#endif
    mal_reactor_free_retired_tokens(r);
}

/* ---------------------------------------------------------------------------
 * Public reactor API.
 * --------------------------------------------------------------------------- */

void mal_reactor_init(MalReactor *r) {
    r->backend_fd = mal_backend_create();
    r->wake_read_fd = -1;
    r->wake_write_fd = -1;
    atomic_init(&r->wake_pending, false);
    atomic_init(&r->retained_work, 0);
    r->wake_waker = (MalWaker) {0};
    r->timers = nullptr;
    r->timer_count = 0;
    r->timer_cap = 0;
    r->pending_ops = 0;
    r->fds = nullptr;
    r->retired_tokens = nullptr;
    r->next_generation = 0;
    (void) mal_backend_add_wake(r);
}

void mal_reactor_free(MalReactor *r) {
    if (r->wake_read_fd >= 0) {
        close(r->wake_read_fd);
        r->wake_read_fd = -1;
    }
    if (r->wake_write_fd >= 0) {
        close(r->wake_write_fd);
        r->wake_write_fd = -1;
    }
    if (r->backend_fd >= 0) {
        close(r->backend_fd);
        r->backend_fd = -1;
    }
    free(r->timers);
    r->timers = nullptr;
    r->timer_count = 0;
    r->timer_cap = 0;
    mal_reactor_free_retired_tokens(r);
    while (r->fds != nullptr) {
        MalReactorFd *state = r->fds;
        r->fds = state->next;
        if (state->read_op != nullptr) {
            state->read_op->active = false;
            state->read_op->_reactor = nullptr;
        }
        if (state->write_op != nullptr) {
            state->write_op->active = false;
            state->write_op->_reactor = nullptr;
        }
        free(state->read_token);
        free(state->write_token);
        free(state->poll_token);
        free(state);
    }
    r->pending_ops = 0;
    atomic_store_explicit(&r->wake_pending, false, memory_order_relaxed);
    atomic_store_explicit(&r->retained_work, 0, memory_order_relaxed);
    r->wake_waker = (MalWaker) {0};
}

bool mal_reactor_has_pending(const MalReactor *r) {
    return r->timer_count > 0 || r->pending_ops > 0 ||
        atomic_load_explicit(&r->retained_work, memory_order_acquire) > 0 ||
        atomic_load_explicit(&r->wake_pending, memory_order_acquire);
}

bool mal_reactor_retain_work(MalReactor *r) {
    if (r->wake_write_fd < 0) {
        return false;
    }
    usize retained = atomic_load_explicit(&r->retained_work, memory_order_relaxed);
    for (;;) {
        if (retained == SIZE_MAX) {
            return false;
        }
        if (atomic_compare_exchange_weak_explicit(
                &r->retained_work,
                &retained,
                retained + 1,
                memory_order_release,
                memory_order_relaxed)) {
            return true;
        }
    }
}

bool mal_reactor_release_work(MalReactor *r) {
    usize retained = atomic_load_explicit(&r->retained_work, memory_order_relaxed);
    for (;;) {
        if (retained == 0) {
            return false;
        }
        if (atomic_compare_exchange_weak_explicit(
                &r->retained_work,
                &retained,
                retained - 1,
                memory_order_acq_rel,
                memory_order_relaxed)) {
            return mal_reactor_wake(r);
        }
    }
}

void mal_reactor_set_waker(MalReactor *r, MalWaker waker) {
    r->wake_waker = waker;
}

bool mal_reactor_wake(MalReactor *r) {
    if (r->wake_write_fd < 0) {
        return false;
    }
    if (atomic_exchange_explicit(&r->wake_pending, true, memory_order_acq_rel)) {
        return true;
    }
    unsigned char byte = 1;
    for (;;) {
        if (write(r->wake_write_fd, &byte, 1) == 1) {
            return true;
        }
        if (errno == EINTR) {
            continue;
        }
        if (errno == EAGAIN || errno == EWOULDBLOCK) {
            return true;
        }
        atomic_store_explicit(&r->wake_pending, false, memory_order_release);
        return false;
    }
}

bool mal_reactor_add_op(MalReactor *r, MalOp *op) {
    if (r->backend_fd < 0 || op->fd < 0 || op->waker.fn == nullptr || op->active ||
        op->_reactor != nullptr ||
        (op->interest != MAL_IO_READ && op->interest != MAL_IO_WRITE)) {
        return false;
    }
    MalReactorFd *state = mal_reactor_get_fd(r, op->fd);
    if (state == nullptr) {
        return false;
    }
    MalOp **slot = mal_fd_op_slot(state, op->interest);
    if (*slot != nullptr) {
        return false;
    }

    u64 *generation = mal_fd_generation_slot(state, op->interest);
    r->next_generation++;
    if (r->next_generation == 0) {
        r->next_generation++;
    }
    *generation = r->next_generation;
    *slot = op;
    op->active = true;
    op->_reactor = r;
    r->pending_ops++;
#if MAL_REACTOR_KQUEUE
    bool added = mal_backend_add_interest(r, state, op->interest);
#else
    bool added = mal_backend_sync(r, state);
#endif
    if (!added) {
        *slot = nullptr;
        op->active = false;
        op->_reactor = nullptr;
        r->pending_ops--;
        return false;
    }
    return true;
}

bool mal_reactor_cancel_op(MalReactor *r, MalOp *op) {
    if (!op->active) {
        return op->_reactor == nullptr;
    }
    if (op->_reactor != r) {
        return false;
    }
    MalReactorFd *state = mal_reactor_find_fd(r, op->fd);
    if (state == nullptr) {
        return false;
    }
    MalOp **slot = mal_fd_op_slot(state, op->interest);
    if (*slot != op) {
        return false;
    }

#if MAL_REACTOR_KQUEUE
    bool cancelled = mal_backend_del_interest(r, state, op->interest);
    *slot = nullptr;
#else
    *slot = nullptr;
    bool cancelled = mal_backend_sync(r, state);
#endif
    op->active = false;
    op->_reactor = nullptr;
    r->pending_ops--;
    return cancelled;
}

void mal_reactor_wait(MalReactor *r) {
    i64 timeout;
    if (r->timer_count > 0) {
        i64 now = mal_reactor_now_ns();
        i64 deadline = r->timers[0]->deadline_ns;
        timeout = deadline > now ? deadline - now : 0;
    } else if (r->pending_ops > 0 ||
        atomic_load_explicit(&r->retained_work, memory_order_acquire) > 0 ||
        atomic_load_explicit(&r->wake_pending, memory_order_acquire)) {
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
