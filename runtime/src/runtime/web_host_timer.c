#include "web_host_timer.h"

#include <stdlib.h>

#include "async_context.h"
#include "gc.h"
#include "host.h"
#include "intrinsics.h"
#include "microtask.h"
#include "value_ops.h"
#include "vm.h"

#define MAL_HOST_MAX_MACROTASK_DRAINS 8
static MalHostMacrotaskDrain mal_host_macrotask_drains[MAL_HOST_MAX_MACROTASK_DRAINS];
static i32 mal_host_macrotask_drain_count;

void mal_host_register_macrotask_drain(MalHostMacrotaskDrain drain) {
    for (i32 i = 0; i < mal_host_macrotask_drain_count; i++) {
        if (mal_host_macrotask_drains[i] == drain) return;
    }
    if (mal_host_macrotask_drain_count < MAL_HOST_MAX_MACROTASK_DRAINS) {
        mal_host_macrotask_drains[mal_host_macrotask_drain_count++] = drain;
    }
}

static bool mal_host_run_runtime_macrotask(MalVm *vm) {
    for (i32 i = 0; i < mal_host_macrotask_drain_count; i++) {
        if (mal_host_macrotask_drains[i](vm)) return true;
    }
    return false;
}

/* Reactor waker: the timer's deadline passed. It is already off the reactor heap;
 * mark the task ready so the event loop's macrotask phase runs its callback. */
static void mal_host_timer_waker(void *data) {
    MalHostTimer *t = data;
    MalHost *host = mal_host(t->vm);
    t->ready = true;
    t->ready_next = nullptr;
    if (host->ready_timers_tail == nullptr) {
        host->ready_timers = t;
    } else {
        host->ready_timers_tail->ready_next = t;
    }
    host->ready_timers_tail = t;
}

static void mal_host_unlink_timer(MalHost *host, MalHostTimer *t) {
    if (t->previous == nullptr) {
        host->timers = t->next;
    } else {
        t->previous->next = t->next;
    }
    if (t->next == nullptr) {
        host->timers_tail = t->previous;
    } else {
        t->next->previous = t->previous;
    }
}

static i64 mal_host_add_timer(
    MalVm *vm, MalValue callback, i64 delay_ms, MalValue *args, i32 arg_count,
    i64 repeat_ms, bool repeating) {
    MalHostTimer *t = calloc(1, sizeof(MalHostTimer));
    t->id = mal_host(vm)->timer_next_id++;
    t->callback = callback;
    t->args = args;
    t->arg_count = arg_count;
#if MAL_NODE
    t->async_context = mal_async_context_capture(vm);
#endif
    t->repeat_ms = repeat_ms;
    t->repeating = repeating;
    t->ready = false;
    t->cancelled = false;
    t->vm = vm;
    t->timer.deadline_ns =
        mal_reactor_now_ns() + (delay_ms < 0 ? 0 : delay_ms) * 1000000;
    t->timer.waker = (MalWaker) {.fn = mal_host_timer_waker, .data = t};
    t->timer.heap_index = -1;

    t->previous = mal_host(vm)->timers_tail;
    t->next = nullptr;
    if (mal_host(vm)->timers_tail == nullptr) {
        mal_host(vm)->timers = t;
    } else {
        mal_host(vm)->timers_tail->next = t;
    }
    mal_host(vm)->timers_tail = t;
    mal_reactor_add_timer(&mal_host(vm)->reactor, &t->timer);
    return t->id;
}

i64 mal_host_set_timeout(
    MalVm *vm, MalValue callback, i64 delay_ms, MalValue *args, i32 arg_count) {
    return mal_host_add_timer(vm, callback, delay_ms, args, arg_count, 0, false);
}

i64 mal_host_set_interval(
    MalVm *vm, MalValue callback, i64 period_ms, MalValue *args, i32 arg_count) {
    if (period_ms < 0) {
        period_ms = 0;
    }
    return mal_host_add_timer(vm, callback, period_ms, args, arg_count, period_ms, true);
}

void mal_host_clear_timeout(MalVm *vm, i64 id) {
    MalHost *host = mal_host(vm);
    for (MalHostTimer *t = host->timers; t != nullptr; t = t->next) {
        if (t->id == id) {
            if (t->ready) {
                t->cancelled = true;
            } else {
                mal_reactor_cancel_timer(&host->reactor, &t->timer);
                mal_host_unlink_timer(host, t);
                free(t->args);
                free(t);
            }
            return;
        }
    }
}

/* Run one fired-but-not-run timer callback (a macrotask). Returns false when none
 * are ready. Runs at most one per call so the caller drains microtasks between
 * macrotasks (HTML event-loop ordering). */
static bool mal_host_run_one_ready(MalVm *vm) {
    MalHost *host = mal_host(vm);
    while (host->ready_timers != nullptr) {
        MalHostTimer *t = host->ready_timers;
        host->ready_timers = t->ready_next;
        if (host->ready_timers == nullptr) {
            host->ready_timers_tail = nullptr;
        }
        if (t->cancelled) {
            mal_host_unlink_timer(host, t);
            free(t->args);
            free(t);
            continue;
        }
        if (t->repeating) {
            MalValue cb = t->callback;
            MalValue *cargs = t->args;
            i32 cargc = t->arg_count;
            MalRootSpan rs_cb;
            mal_gc_root(&rs_cb, &cb, 1);
#if MAL_NODE
            MalAsyncContextScope async_scope;
            mal_async_context_scope_enter(vm, &async_scope, t->async_context);
#endif
            mal_vm_call_value(vm, cb, mal_value_new_undefined(), cargs, cargc);
#if MAL_NODE
            mal_async_context_scope_exit(vm, &async_scope);
#endif
            mal_gc_unroot(&rs_cb);
            if (t->cancelled) {
                mal_host_unlink_timer(host, t);
                free(t->args);
                free(t);
            } else {
                // Rearm after the handler so timers it creates at the same delay run first.
                t->ready = false;
                t->timer.deadline_ns = mal_reactor_now_ns() + t->repeat_ms * 1000000;
                t->timer.heap_index = -1;
                mal_reactor_add_timer(&host->reactor, &t->timer);
            }
            return true;
        }

        mal_host_unlink_timer(host, t); // callback may mutate the pending list
        MalValue cb = t->callback;
        MalValue *cargs = t->args;
        i32 cargc = t->arg_count;
#if MAL_NODE
        MalAsyncContext *async_context = t->async_context;
#endif
        free(t); // the task struct is done; cb/cargs kept alive below

        MalRootSpan rs_cb;
        mal_gc_root(&rs_cb, &cb, 1);
        MalRootSpan rs_args;
        if (cargc > 0) {
            mal_gc_root(&rs_args, cargs, cargc);
        }
#if MAL_NODE
        MalAsyncContextScope async_scope;
        mal_async_context_scope_enter(vm, &async_scope, async_context);
#endif
        mal_vm_call_value(vm, cb, mal_value_new_undefined(), cargs, cargc);
#if MAL_NODE
        mal_async_context_scope_exit(vm, &async_scope);
#endif
        if (cargc > 0) {
            mal_gc_unroot(&rs_args);
        }
        mal_gc_unroot(&rs_cb);

        free(cargs);
        return true;
    }
    return false;
}

void mal_host_run_event_loop(MalVm *vm) {
    for (;;) {
        // Microtasks first (promise jobs), then one macrotask, then repeat.
        mal_vm_drain_microtasks(vm);
        if (mal_host_run_runtime_macrotask(vm)) {
            if (mal_gc_poll) mal_gc_safepoint(vm);
            continue;
        }
        if (mal_host_run_one_ready(vm)) {
            if (mal_gc_poll) mal_gc_safepoint(vm);
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
    mal_host(vm)->timers_tail = nullptr;
    mal_host(vm)->ready_timers = nullptr;
    mal_host(vm)->ready_timers_tail = nullptr;
}

/* --- native globals ------------------------------------------------------- */

/* Shared setTimeout/setInterval body: (callback, delay, ...args). Returns the id,
 * or 0 for a non-callable first argument. Copies the extra args to a heap buffer
 * the timer takes ownership of. */
static i64 mal_host_schedule_native(MalVm *vm, const MalValue *args, i32 arg_count, bool repeat) {
    if (arg_count < 1 || !mal_value_is_callable(args[0])) {
        return 0; // Required TypeError for a non-callable callback remains unsupported.
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
    return repeat ? mal_host_set_interval(vm, args[0], delay, extra_args, extra)
                  : mal_host_set_timeout(vm, args[0], delay, extra_args, extra);
}

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
    return mal_value_from_f64((f64) mal_host_schedule_native(vm, args, arg_count, false));
}

static MalValue mal_host_set_interval_native(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_value_from_f64((f64) mal_host_schedule_native(vm, args, arg_count, true));
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
#if MAL_NODE
        mal_gc_mark_value(
            mal_async_internal_value((MalHeapHeader *) t->async_context));
#endif
    }
}

void mal_host_timers_install(MalVm *vm, MalObject *global_this) {
    mal_gc_register_root_source(mal_host_timers_scan_roots, nullptr);
    mal_intrinsic_define_method_n(vm, global_this, "setTimeout", 2, mal_host_set_timeout_native);
    mal_intrinsic_define_method_n(
        vm, global_this, "clearTimeout", 1, mal_host_clear_timeout_native);
    mal_intrinsic_define_method_n(vm, global_this, "setInterval", 2, mal_host_set_interval_native);
    // clearInterval shares clearTimeout's id space / cancellation path.
    mal_intrinsic_define_method_n(
        vm, global_this, "clearInterval", 1, mal_host_clear_timeout_native);
}
