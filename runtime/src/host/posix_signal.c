#include "posix_signal.h"

#include <errno.h>
#include <signal.h>
#include <stdatomic.h>
#include <string.h>

/* The handler stores through these from an arbitrary interruption point, so the
 * flags must be lock-free; a spin-lock fallback inside a signal handler would
 * deadlock against the thread it interrupted. */
static_assert(ATOMIC_CHAR_LOCK_FREE == 2, "signal flags must be lock-free");
static_assert(ATOMIC_POINTER_LOCK_FREE == 2, "signal reactor slot must be lock-free");

static _Atomic(unsigned char) mal_host_signal_pending[MAL_HOST_SIGNAL_COUNT];
static _Atomic(MalReactor *) mal_host_signal_reactor;
static bool mal_host_signal_installed[MAL_HOST_SIGNAL_COUNT];
static struct sigaction mal_host_signal_previous[MAL_HOST_SIGNAL_COUNT];

static int mal_host_signal_number(MalHostSignal signal) {
    switch (signal) {
        case MAL_HOST_SIGNAL_INT:
            return SIGINT;
        case MAL_HOST_SIGNAL_TERM:
            return SIGTERM;
        default:
            return 0;
    }
}

const char *mal_host_signal_name(MalHostSignal signal) {
    switch (signal) {
        case MAL_HOST_SIGNAL_INT:
            return "SIGINT";
        case MAL_HOST_SIGNAL_TERM:
            return "SIGTERM";
        default:
            return "";
    }
}

bool mal_host_signal_lookup(const char *name, MalHostSignal *out) {
    for (int i = 0; i < MAL_HOST_SIGNAL_COUNT; i++) {
        if (strcmp(name, mal_host_signal_name((MalHostSignal) i)) == 0) {
            *out = (MalHostSignal) i;
            return true;
        }
    }
    return false;
}

/* Async-signal-safe. Flag first, then wake: the event loop rechecks the flags
 * after every reactor wait, and mal_reactor_wake's coalescing flag also keeps
 * mal_reactor_has_pending true, so a delivery that races the loop's idle check
 * still gets one more pass instead of exiting underneath it. */
static void mal_host_signal_handler(int signo) {
    int saved_errno = errno;
    for (int i = 0; i < MAL_HOST_SIGNAL_COUNT; i++) {
        if (mal_host_signal_number((MalHostSignal) i) == signo) {
            atomic_store_explicit(
                &mal_host_signal_pending[i], 1, memory_order_release);
            break;
        }
    }
    MalReactor *reactor =
        atomic_load_explicit(&mal_host_signal_reactor, memory_order_acquire);
    if (reactor != nullptr) {
        (void) mal_reactor_wake(reactor);
    }
    errno = saved_errno;
}

bool mal_host_signal_listen(MalReactor *reactor, MalHostSignal signal) {
    if (reactor == nullptr || signal < 0 || signal >= MAL_HOST_SIGNAL_COUNT) {
        return false;
    }
    atomic_store_explicit(&mal_host_signal_reactor, reactor, memory_order_release);
    if (mal_host_signal_installed[signal]) {
        return true;
    }
    struct sigaction action;
    memset(&action, 0, sizeof action);
    action.sa_handler = mal_host_signal_handler;
    sigemptyset(&action.sa_mask);
    // SA_RESTART keeps an interrupted read/write in the runtime's I/O paths from
    // surfacing EINTR just because a listener is registered; the reactor wait
    // tolerates either outcome.
    action.sa_flags = SA_RESTART;
    if (sigaction(mal_host_signal_number(signal), &action,
                  &mal_host_signal_previous[signal])
        != 0) {
        return false;
    }
    mal_host_signal_installed[signal] = true;
    return true;
}

void mal_host_signal_unlisten(MalHostSignal signal) {
    if (signal < 0 || signal >= MAL_HOST_SIGNAL_COUNT
        || !mal_host_signal_installed[signal]) {
        return;
    }
    sigaction(mal_host_signal_number(signal), &mal_host_signal_previous[signal],
              nullptr);
    mal_host_signal_installed[signal] = false;
    atomic_store_explicit(&mal_host_signal_pending[signal], 0, memory_order_release);
}

bool mal_host_signal_take(MalHostSignal signal) {
    if (signal < 0 || signal >= MAL_HOST_SIGNAL_COUNT) {
        return false;
    }
    // A single RMW, so a delivery racing the read cannot be dropped the way a
    // load-then-store pair would drop it.
    return atomic_exchange_explicit(
               &mal_host_signal_pending[signal], 0, memory_order_acq_rel)
        != 0;
}

void mal_host_signal_reset(void) {
    for (int i = 0; i < MAL_HOST_SIGNAL_COUNT; i++) {
        mal_host_signal_unlisten((MalHostSignal) i);
    }
    atomic_store_explicit(&mal_host_signal_reactor, nullptr, memory_order_release);
}
