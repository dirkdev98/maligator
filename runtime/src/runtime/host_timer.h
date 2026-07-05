#pragma once

#include "./defaults.h"
#include "reactor.h"
#include "value.h"

typedef struct MalVm MalVm;
typedef struct MalObject MalObject;

/*
 * Host timers (isolate_todo.md Phase 1 — the JS-visible surface of the reactor).
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
 * collector roots (mal_host_timers_gc_scan) so they survive until the task runs.
 */

typedef struct MalHostTimer {
    i64 id;
    MalTimer timer; /* reactor timer; removed from the heap when it fires */
    MalValue callback;
    MalValue *args; /* heap copy of setTimeout extra args (nullptr if none) */
    i32 arg_count;
    i64 repeat_ms;  /* setInterval period; 0 for a one-shot setTimeout */
    bool ready;     /* timer fired; callback awaits the macrotask phase */
    bool cancelled; /* clearTimeout'd before it fired/ran */
    MalVm *vm;      /* back-ref for the reactor waker */
    struct MalHostTimer *next;
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

/* (GC roots the pending callbacks + args by walking vm->host_timers directly in
 * mal_gc_scan_roots — no separate hook needed.) */

/* Free all remaining timer tasks (teardown). */
void mal_host_timers_free(MalVm *vm);

/* Install setTimeout / clearTimeout as own methods of `global_this`. */
void mal_host_timers_install(MalVm *vm, MalObject *global_this);
