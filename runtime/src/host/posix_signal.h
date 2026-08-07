#pragma once

#include "./defaults.h"
#include "reactor.h"

/*
 * POSIX signal bridge (host layer). Turns an asynchronously delivered signal
 * into an ordinary reactor wake-up so the runtime can dispatch it on the main VM
 * thread.
 *
 * The POSIX handler installed here does the only three things that are
 * async-signal-safe in this codebase: set a lock-free atomic flag, write one
 * byte to the reactor's self-pipe (mal_reactor_wake), and restore errno. It
 * never touches the VM, the GC heap, malloc, or stdio — a handler can interrupt
 * the collector mid-mark or the allocator mid-splice, so anything else is a
 * latent crash rather than a rare one.
 *
 * Dispositions are process-wide, so the state below is file-static rather than
 * per-isolate; the single-isolate host entry is the only user. The reactor
 * pointer must be cleared before the reactor is destroyed (mal_host_free calls
 * mal_host_signal_reset), otherwise a signal arriving during teardown would wake
 * freed memory.
 */

typedef enum MalHostSignal {
    MAL_HOST_SIGNAL_INT,
    MAL_HOST_SIGNAL_TERM,
    MAL_HOST_SIGNAL_COUNT,
} MalHostSignal;

/** The Node-visible name of a bridged signal ("SIGINT" / "SIGTERM"). */
const char *mal_host_signal_name(MalHostSignal signal);

/** Map a Node signal name to its slot; false for a signal this host cannot bridge. */
bool mal_host_signal_lookup(const char *name, MalHostSignal *out);

/**
 * Install the bridging handler for `signal`, waking `reactor` on delivery.
 * Idempotent: re-listening only refreshes the reactor. Returns false when the
 * disposition could not be installed, leaving the previous one in place.
 */
bool mal_host_signal_listen(MalReactor *reactor, MalHostSignal signal);

/**
 * Restore the disposition that was in effect before mal_host_signal_listen —
 * normally SIG_DFL, so the signal's default action (terminating the process)
 * resumes once the last listener is gone. Idempotent.
 */
void mal_host_signal_unlisten(MalHostSignal signal);

/** Consume a pending delivery. Main-thread only; coalesces repeats. */
bool mal_host_signal_take(MalHostSignal signal);

/** Restore every bridged disposition and drop the reactor reference (teardown). */
void mal_host_signal_reset(void);
