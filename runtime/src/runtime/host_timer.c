#include "host_timer.h"

#include <stdlib.h>

#include "gc.h"
#include "host.h"
#include "intrinsics.h"
#include "microtask.h"
#include "value_ops.h"
#include "vm.h"

/* Reactor waker: the timer's deadline passed. It is already off the reactor heap;
 * mark the task ready so the event loop's macrotask phase runs its callback. */
static void mal_host_timer_waker(void *data) {
    ((MalHostTimer *) data)->ready = true;
}

i64 mal_host_set_timeout(
    MalVm *vm, MalValue callback, i64 delay_ms, MalValue *args, i32 arg_count) {
    MalHostTimer *t = calloc(1, sizeof(MalHostTimer));
    t->id = mal_host(vm)->timer_next_id++;
    t->callback = callback;
    t->args = args;
    t->arg_count = arg_count;
    t->ready = false;
    t->cancelled = false;
    t->vm = vm;
    t->timer.deadline_ns =
        mal_reactor_now_ns() + (delay_ms < 0 ? 0 : delay_ms) * 1000000;
    t->timer.waker = (MalWaker) {.fn = mal_host_timer_waker, .data = t};
    t->timer.heap_index = -1;

    t->next = mal_host(vm)->timers;
    mal_host(vm)->timers = t;
    mal_reactor_add_timer(&mal_host(vm)->reactor, &t->timer);
    return t->id;
}

void mal_host_clear_timeout(MalVm *vm, i64 id) {
    MalHostTimer **pp = &mal_host(vm)->timers;
    while (*pp != nullptr) {
        MalHostTimer *t = *pp;
        if (t->id == id) {
            mal_reactor_cancel_timer(&mal_host(vm)->reactor, &t->timer);
            *pp = t->next;
            free(t->args);
            free(t);
            return;
        }
        pp = &t->next;
    }
}

/* Run one fired-but-not-run timer callback (a macrotask). Returns false when none
 * are ready. Runs at most one per call so the caller drains microtasks between
 * macrotasks (HTML event-loop ordering). */
static bool mal_host_run_one_ready(MalVm *vm) {
    MalHostTimer **pp = &mal_host(vm)->timers;
    while (*pp != nullptr) {
        MalHostTimer *t = *pp;
        if (t->cancelled) {
            *pp = t->next;
            free(t->args);
            free(t);
            continue;
        }
        if (t->ready) {
            *pp = t->next; // unlink before running: the callback may mutate the list
            MalValue cb = t->callback;
            MalValue *cargs = t->args;
            i32 cargc = t->arg_count;
            free(t); // the task struct is done; cb/cargs kept alive below

            // Root the callback + args across the call: they left the scanned
            // host-timer list, and invoking the callback can trigger a GC.
            MalRootSpan rs_cb;
            mal_gc_root(&rs_cb, &cb, 1);
            MalRootSpan rs_args;
            if (cargc > 0) {
                mal_gc_root(&rs_args, cargs, cargc);
            }
            mal_vm_call_value(vm, cb, mal_value_new_undefined(), cargs, cargc);
            if (cargc > 0) {
                mal_gc_unroot(&rs_args);
            }
            mal_gc_unroot(&rs_cb);

            free(cargs);
            return true;
        }
        pp = &t->next;
    }
    return false;
}

void mal_host_run_event_loop(MalVm *vm) {
    for (;;) {
        // Microtasks first (promise jobs), then one macrotask, then repeat.
        mal_vm_drain_microtasks(vm);
        if (mal_host_run_one_ready(vm)) {
            continue;
        }
        // No callback is ready. If the reactor still holds timers/fd ops, block
        // until the next fires; otherwise the isolate is idle -> done.
        if (!mal_reactor_has_pending(&mal_host(vm)->reactor)) {
            break;
        }
        mal_reactor_wait(&mal_host(vm)->reactor);
    }
}

void mal_host_timers_free(MalVm *vm) {
    MalHostTimer *t = mal_host(vm)->timers;
    while (t != nullptr) {
        MalHostTimer *next = t->next;
        free(t->args);
        free(t);
        t = next;
    }
    mal_host(vm)->timers = nullptr;
}

/* --- native globals ------------------------------------------------------- */

static MalValue mal_host_set_timeout_native(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    if (arg_count < 1 || !mal_value_is_callable(args[0])) {
        return mal_value_from_f64(0); // TODO(spec): throw TypeError on non-callable
    }
    i64 delay = 0;
    if (arg_count >= 2) {
        f64 d = mal_ops_to_number(args[1]);
        if (d == d && d > 0) { // d==d rejects NaN
            delay = (i64) d;
        }
    }
    i32 extra = arg_count > 2 ? arg_count - 2 : 0;
    MalValue *extra_args = nullptr;
    if (extra > 0) {
        extra_args = malloc(sizeof(MalValue) * (usize) extra);
        for (i32 i = 0; i < extra; i++) {
            extra_args[i] = args[i + 2];
        }
    }
    i64 id = mal_host_set_timeout(vm, args[0], delay, extra_args, extra);
    return mal_value_from_f64((f64) id);
}

static MalValue mal_host_clear_timeout_native(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    if (arg_count >= 1) {
        f64 d = mal_ops_to_number(args[0]);
        if (d == d) {
            mal_host_clear_timeout(vm, (i64) d);
        }
    }
    return mal_value_new_undefined();
}

/* Root source: pending timer callbacks + their args must survive until they run.
 * Registered with the engine so the collector roots them without knowing the type. */
static void mal_host_timers_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (MalHostTimer *t = mal_host(vm)->timers; t != nullptr; t = t->next) {
        mal_gc_mark_value(t->callback);
        mal_gc_mark_values(t->args, t->arg_count);
    }
}

void mal_host_timers_install(MalVm *vm, MalObject *global_this) {
    mal_gc_register_root_source(mal_host_timers_scan_roots, nullptr);
    mal_intrinsic_define_method_n(vm, global_this, "setTimeout", 2, mal_host_set_timeout_native);
    mal_intrinsic_define_method_n(
        vm, global_this, "clearTimeout", 1, mal_host_clear_timeout_native);
}
