#pragma once

#include "./defaults.h"
#include "reactor.h"
#include "value.h"

typedef struct MalVm MalVm;
typedef struct MalObject MalObject;
typedef struct MalAsyncContext MalAsyncContext;
typedef bool (*MalHostMacrotaskDrain)(MalVm *vm);
typedef bool (*MalHostIdleNotify)(MalVm *vm);

/*
 * Host timers (the JS-visible surface of the reactor).
 *
 * `setTimeout(cb, ms, ...args)` registers a one-shot reactor timer; when it fires,
 * the callback becomes a runnable macrotask. The host event loop
 * (mal_host_run_event_loop) drives the standard shape: run a macrotask, drain the
 * microtask queue, block in the reactor for the next timer/fd, repeat — until no
 * timers, fd ops, or microtasks remain.
 *
 * Callbacks run on the main execution context (not a worker fiber), matching the
 * single-threaded event-loop semantics of the web platform; actors/fibers are a
 * separate concern. Each pending task holds its callback + extra args, which the
 * collector roots (mal_host_timers_scan_roots) so they survive until the task runs.
 */

typedef struct MalHostTimer {
    i64 id;
    MalTimer timer; /* reactor timer; removed from the heap when it fires */
    MalValue callback;
    MalValue *args; /* heap copy of setTimeout extra args (nullptr if none) */
    i32 arg_count;
#if MAL_NODE
    MalAsyncContext *async_context;
#endif
    i64 repeat_ms;  /* normalized setInterval period, including zero */
    bool repeating; /* distinguishes zero-delay intervals from one-shot timers */
    bool ready;     /* timer fired; callback awaits the macrotask phase */
    bool cancelled; /* clearTimeout'd before it fired/ran */
    MalVm *vm;      /* back-ref for the reactor waker */
    struct MalHostTimer *previous;
    struct MalHostTimer *next;
    struct MalHostTimer *ready_next;
} MalHostTimer;

/* Register a setTimeout; returns its id. Takes ownership of `args` (freed with the
 * task). `delay_ms` is clamped to >= 0. */
i64 mal_host_set_timeout(MalVm *vm, MalValue callback, i64 delay_ms, MalValue *args, i32 arg_count);

/* Register a repeating setInterval (re-armed each period until cleared). */
i64 mal_host_set_interval(MalVm *vm, MalValue callback, i64 period_ms, MalValue *args, i32 arg_count);

/* Cancel a pending timer by id (no-op if unknown / already run). Backs both
 * clearTimeout and clearInterval (shared id space). */
void mal_host_clear_timeout(MalVm *vm, i64 id);

/* Drive the event loop until the isolate is idle (no timers, fd ops, or
 * microtasks). Runs after the top-level program's synchronous phase. */
void mal_host_run_event_loop(MalVm *vm);

/* Register an optional runtime macrotask source without making the host loop
 * reference that runtime directly. Duplicate function pointers are ignored.
 * A `priority` source is polled before the ordinary ones, so a host interrupt
 * (a delivered POSIX signal) cannot be starved by a setImmediate chain. */
void mal_host_register_macrotask_drain(MalHostMacrotaskDrain drain, bool priority);

/* Register the runtime's "the loop just went idle" notification (node:process's
 * `beforeExit`). It runs only when nothing else can make progress, and returns
 * true when it actually notified someone; the loop then gives the notified code
 * one more chance to schedule work before exiting. Same indirection rationale as
 * the macrotask drains: the host loop must not name a runtime module. */
void mal_host_register_idle_notify(MalHostIdleNotify notify);

/* Free all remaining timer tasks (teardown). */
void mal_host_timers_free(MalVm *vm);

/* Install setTimeout / clearTimeout as own methods of `global_this`. */
void mal_host_timers_install(MalVm *vm, MalObject *global_this);
