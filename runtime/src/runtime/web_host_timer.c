#include "web_host_timer.h"

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdatomic.h>

#include "async_context.h"
#include "gc.h"
#include "function_object.h"
#include "heap_symbol.h"
#include "shape.h"
#include "host.h"
#include "intrinsics.h"
#include "microtask.h"
#include "object.h"
#include "object_ops.h"
#include "property_store.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// A fixed set of runtime subsystems registers drains; overflow is a runtime bug.
#define MAL_HOST_MAX_MACROTASK_DRAINS 16
#define MAL_HOST_REACTOR_POLL_INTERVAL 32
// Checkpoint hooks belong to the isolate whose mutator registered them.
static MAL_ISOLATE_LOCAL MalHostMacrotaskDrain
    mal_host_macrotask_drains[MAL_HOST_MAX_MACROTASK_DRAINS];
static MAL_ISOLATE_LOCAL i32 mal_host_macrotask_drain_count;
static MAL_ISOLATE_LOCAL i32 mal_host_priority_drain_count;
static MAL_ISOLATE_LOCAL i32 mal_host_macrotask_cursor;
static MAL_ISOLATE_LOCAL MalHostIdleNotify mal_host_idle_notify;
static MAL_ISOLATE_LOCAL MalHostExitNotify mal_host_exit_notify;
static MAL_ISOLATE_LOCAL MalHostTerminationCheck mal_host_termination_check;

void mal_host_set_termination_check(MalHostTerminationCheck check) {
    mal_host_termination_check = check;
}

void mal_host_register_macrotask_drain(MalHostMacrotaskDrain drain, bool priority) {
    for (i32 i = 0; i < mal_host_macrotask_drain_count; i++) {
        if (mal_host_macrotask_drains[i] == drain) return;
    }
    if (mal_host_macrotask_drain_count >= MAL_HOST_MAX_MACROTASK_DRAINS) {
        fprintf(stderr, "maligator: too many host macrotask drains (max %d)\n", MAL_HOST_MAX_MACROTASK_DRAINS);
        abort();
    }
    if (priority) {
        for (i32 i = mal_host_macrotask_drain_count; i > 0; i--) {
            mal_host_macrotask_drains[i] = mal_host_macrotask_drains[i - 1];
        }
        mal_host_macrotask_drains[0] = drain;
        mal_host_macrotask_drain_count++;
        mal_host_priority_drain_count++;
        return;
    }
    mal_host_macrotask_drains[mal_host_macrotask_drain_count++] = drain;
}

void mal_host_register_idle_notify(MalHostIdleNotify notify) {
    mal_host_idle_notify = notify;
}

void mal_host_register_exit_notify(MalHostExitNotify notify) {
    mal_host_exit_notify = notify;
}

int mal_host_finish_process(MalVm *vm, int default_code) {
    mal_gc_set_mutator_busy(vm, true);
    int code = mal_host_exit_notify != nullptr
        ? mal_host_exit_notify(vm, default_code) : default_code;
    mal_gc_set_mutator_busy(vm, false);
    return code;
}

static bool mal_host_run_priority_macrotask(MalVm *vm) {
    for (i32 i = 0; i < mal_host_priority_drain_count; i++) {
        if (mal_host_macrotask_drains[i](vm)) return true;
    }
    return false;
}

static bool mal_host_run_runtime_macrotask(MalVm *vm) {
    i32 count = mal_host_macrotask_drain_count - mal_host_priority_drain_count;
    if (count == 0) return false;
    i32 start = mal_host_macrotask_cursor % count;
    for (i32 offset = 0; offset < count; offset++) {
        i32 index = (start + offset) % count;
        if (mal_host_macrotask_drains[mal_host_priority_drain_count + index](vm)) {
            mal_host_macrotask_cursor = (index + 1) % count;
            return true;
        }
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

static MalHostTimer *mal_host_add_timer(
    MalVm *vm, MalValue callback, i64 delay_ms, MalValue *args, i32 arg_count,
    i64 repeat_ms, bool repeating) {
    MalHostTimer *t = calloc(1, sizeof(MalHostTimer));
    if (t == nullptr) {
        free(args);
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    t->id = mal_host(vm)->timer_next_id++;
    t->callback = callback;
    t->handle = mal_value_new_undefined();
    t->referenced = true;
    t->args = args;
    t->arg_count = arg_count;
    t->async_context = mal_async_context_capture(vm);
    t->delay_ms = delay_ms < 0 ? 0 : delay_ms;
    t->repeat_ms = repeat_ms;
    t->repeating = repeating;
    t->ready = false;
    t->cancelled = false;
    t->vm = vm;
    t->timer.deadline_ns = mal_reactor_now_ns() + t->delay_ms * 1000000;
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
    return t;
}

static MalHostTimer *mal_host_add_timeout_or_interval(
    MalVm *vm, MalValue callback, i64 delay_ms, MalValue *args, i32 arg_count, bool repeat) {
    if (!repeat) return mal_host_add_timer(vm, callback, delay_ms, args, arg_count, 0, false);
    i64 period_ms = delay_ms < 0 ? 0 : delay_ms;
    return mal_host_add_timer(vm, callback, period_ms, args, arg_count, period_ms, true);
}

i64 mal_host_set_timeout(
    MalVm *vm, MalValue callback, i64 delay_ms, MalValue *args, i32 arg_count) {
    MalHostTimer *t = mal_host_add_timeout_or_interval(vm, callback, delay_ms, args, arg_count, false);
    return t == nullptr ? 0 : t->id;
}

i64 mal_host_set_interval(
    MalVm *vm, MalValue callback, i64 period_ms, MalValue *args, i32 arg_count) {
    MalHostTimer *t = mal_host_add_timeout_or_interval(vm, callback, period_ms, args, arg_count, true);
    return t == nullptr ? 0 : t->id;
}

static MalHostTimer *mal_host_find_timer(MalVm *vm, i64 id) {
    for (MalHostTimer *t = mal_host(vm)->timers; t != nullptr; t = t->next) {
        if (t->id == id) return t;
    }
    return nullptr;
}

void mal_host_clear_timeout(MalVm *vm, i64 id) {
    MalHost *host = mal_host(vm);
    MalHostTimer *t = mal_host_find_timer(vm, id);
    if (t == nullptr) return;
    if (t->ready) {
        t->cancelled = true;
    } else {
        mal_reactor_cancel_timer(&host->reactor, &t->timer);
        mal_host_unlink_timer(host, t);
        free(t->args);
        free(t);
    }
}

void mal_host_timer_set_referenced(MalVm *vm, i64 id, bool referenced) {
    MalHostTimer *timer = mal_host_find_timer(vm, id);
    if (timer != nullptr && !timer->cancelled) timer->referenced = referenced;
}

bool mal_host_timers_are_node(MalVm *vm) {
    MalHost *host = mal_host(vm);
    return host != nullptr && host->node_timers;
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
            MalAsyncContextScope async_scope;
            mal_async_context_scope_enter(vm, &async_scope, t->async_context);
            mal_vm_call_value(vm, cb, t->handle, cargs, cargc);
            mal_async_context_scope_exit(vm, &async_scope);
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

        // The timer stays listed, and so rooted, while its callback runs: clearing it
        // there only marks it, and Timeout.refresh() can still re-arm it.
        t->running = true;
        MalAsyncContextScope async_scope;
        mal_async_context_scope_enter(vm, &async_scope, t->async_context);
        mal_vm_call_value(vm, t->callback, t->handle, t->args, t->arg_count);
        mal_async_context_scope_exit(vm, &async_scope);
        t->running = false;
        if (t->refreshed && !t->cancelled) {
            t->refreshed = false;
            t->ready = false;
            t->timer.deadline_ns = mal_reactor_now_ns() + t->delay_ms * 1000000;
            t->timer.heap_index = -1;
            mal_reactor_add_timer(&host->reactor, &t->timer);
        } else {
            mal_host_unlink_timer(host, t);
            free(t->args);
            free(t);
        }
        return true;
    }
    return false;
}

static bool mal_host_has_referenced_work(MalVm *vm) {
    MalHost *host = mal_host(vm);
    i32 unreferenced = 0;
    for (MalHostTimer *timer = host->timers; timer != nullptr; timer = timer->next) {
        if (timer->cancelled) continue;
        if (timer->referenced) return true;
        if (timer->timer.heap_index >= 0) unreferenced++;
    }
    return host->reactor.timer_count > unreferenced
        || host->reactor.pending_ops > host->reactor.unreferenced_ops
        || atomic_load_explicit(&host->reactor.retained_work, memory_order_acquire) > 0
        || atomic_load_explicit(&host->reactor.wake_pending, memory_order_acquire);
}

/* A macrotask's throw goes to the uncaught handler once; true when the loop may continue. */
static bool mal_host_recover_uncaught(MalVm *vm) {
    if (vm->uncaught_reported || vm->errors_forwarded) return false;
    return mal_vm_report_uncaught(vm);
}

void mal_host_run_event_loop_until(MalVm *vm, bool (*stop)(MalVm *, void *), void *data) {
    mal_gc_set_mutator_busy(vm, true);
    // Tracks whether the loop did anything since the last idle notification, so a
    // `beforeExit` listener that schedules new work is notified again next time
    // the loop drains, while one that schedules nothing does not spin forever.
    // Seeded true so the first drain always notifies.
    bool progressed = true;
    bool prefer_reactor = false;
    i32 macrotasks_since_poll = MAL_HOST_REACTOR_POLL_INTERVAL;
    MalHost *host = mal_host(vm);
    for (;;) {
        if (mal_gc_native_stack_clear_due(vm)) mal_gc_clear_unused_native_stack();
        // A prior macrotask's uncaught throw must survive the next microtask checkpoint.
        if (vm->completion.kind == MAL_COMPLETION_THROW && !mal_host_recover_uncaught(vm)) break;
        if (mal_gc_terminating()) break;
        if (mal_host_termination_check != nullptr && mal_host_termination_check(vm)) break;
        mal_vm_drain_microtasks(vm);
        if (stop != nullptr && stop(vm, data)) break;
        if (!mal_vm_check_entry_evaluation(vm)) break;
        if (vm->completion.kind == MAL_COMPLETION_THROW && !mal_host_recover_uncaught(vm)) break;
        if (mal_host_termination_check != nullptr && mal_host_termination_check(vm)) break;
        if (mal_host_run_priority_macrotask(vm)) {
            progressed = true;
            macrotasks_since_poll++;
            if (mal_gc_poll) mal_gc_safepoint(vm);
            continue;
        }
        bool timer_due = host->reactor.timer_count > 0 &&
            host->reactor.timers[0]->deadline_ns <= mal_reactor_now_ns();
        if (macrotasks_since_poll >= MAL_HOST_REACTOR_POLL_INTERVAL || timer_due) {
            mal_reactor_poll(&host->reactor);
            macrotasks_since_poll = 0;
            // Server wakers can enter JS, so their jobs precede the next macrotask.
            continue;
        }
        if (prefer_reactor && mal_host_has_referenced_work(vm) && mal_host_run_one_ready(vm)) {
            progressed = true;
            prefer_reactor = false;
            macrotasks_since_poll++;
            if (mal_gc_poll) mal_gc_safepoint(vm);
            continue;
        }
        if (mal_host_run_runtime_macrotask(vm)) {
            progressed = true;
            prefer_reactor = true;
            macrotasks_since_poll++;
            if (mal_gc_poll) mal_gc_safepoint(vm);
            continue;
        }
        if (mal_host_has_referenced_work(vm) && mal_host_run_one_ready(vm)) {
            progressed = true;
            prefer_reactor = false;
            macrotasks_since_poll++;
            if (mal_gc_poll) mal_gc_safepoint(vm);
            continue;
        }
        if (mal_gc_finish_pending_cycle(vm)) {
            continue;
        }
        // No callback is ready. If the reactor still holds timers/fd ops, block
        // until the next fires; otherwise the isolate is idle.
		if (mal_host_has_referenced_work(vm)) {
			progressed = true;
            mal_gc_set_mutator_busy(vm, false);
			mal_reactor_wait(&mal_host(vm)->reactor);
            macrotasks_since_poll = 0;
            mal_gc_set_mutator_busy(vm, true);
			if (mal_gc_poll) mal_gc_safepoint(vm);
			continue;
        }
        if (stop != nullptr || !progressed || mal_host_idle_notify == nullptr) {
            break;
        }
        progressed = false;
        if (!mal_host_idle_notify(vm)) {
            break;
        }
        if (mal_gc_poll) mal_gc_safepoint(vm);
    }
    mal_gc_set_mutator_busy(vm, false);
}

void mal_host_run_event_loop(MalVm *vm) {
    mal_host_run_event_loop_until(vm, nullptr, nullptr);
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
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Timer callback must be a function");
        return 0;
    }
    i64 delay = 0;
    if (arg_count >= 2) {
        f64 d;
        if (!mal_vm_to_number(vm, args[1], &d)) return 0;
        if (isfinite(d) && d > 0 && d <= INT32_MAX) {
            delay = (i64) d;
        }
    }
    i32 extra = arg_count > 2 ? arg_count - 2 : 0;
    MalValue *extra_args = nullptr;
    if (extra > 0) {
        extra_args = malloc(sizeof(MalValue) * (usize) extra);
        if (extra_args == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return 0;
        }
        for (i32 i = 0; i < extra; i++) {
            extra_args[i] = args[i + 2];
        }
    }
    MalHostTimer *t = mal_host_add_timeout_or_interval(vm, args[0], delay, extra_args, extra, repeat);
    return t == nullptr ? 0 : t->id;
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
        f64 d;
        if (mal_vm_to_number(vm, args[0], &d) && isfinite(d)
            && d >= 0 && d <= 9007199254740991.0) {
            mal_host_clear_timeout(vm, (i64) d);
        }
    }
    return mal_value_new_undefined();
}

/*
 * Node's Timeout objects. One prototype per VM carries the methods, and each object
 * records its timer id under a private symbol, which reflection can neither see nor
 * forge. The prototype and symbol live as long as the VM that created them.
 */
static MAL_ISOLATE_LOCAL MalVm *timeout_vm;
static MAL_ISOLATE_LOCAL MalValue timeout_prototype;
static MAL_ISOLATE_LOCAL MalValue timeout_id_symbol;
// The heap's transition tree interns this shape and retains its key.
static MAL_ISOLATE_LOCAL MalShape *timeout_shape;

/* Root source: pending timer callbacks + their args must survive until they run.
 * Registered with the engine so the collector roots them without knowing the type. */
static void mal_host_timers_scan_roots(MalVm *vm, void *data) {
    (void) data;
    if (vm == timeout_vm) {
        mal_gc_mark_value(timeout_prototype);
        mal_gc_mark_value(timeout_id_symbol);
    }
    MalHost *host = mal_host(vm);
    if (host == nullptr) return;
    for (MalHostTimer *t = host->timers; t != nullptr; t = t->next) {
        mal_gc_mark_value(t->callback);
        mal_gc_mark_value(t->handle);
        mal_gc_mark_values(t->args, t->arg_count);
        mal_gc_mark_value(
            mal_async_internal_value((MalHeapHeader *) t->async_context));
    }
}

static MalKey timeout_id_key(void) {
    return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = timeout_id_symbol};
}

/* The timer id a Timeout object records, or 0 when `value` is not one. */
static i64 timeout_id(MalVm *vm, MalValue value) {
    if (vm != timeout_vm || !mal_value_is_object(value)) return 0;
    MalObject *object = mal_value_to_object(value);
    // A Timeout nobody extended still has its allocation shape, whose only slot is the id.
    if (object->shape == timeout_shape)
        return (i64) mal_ops_number_as_f64(mal_object_field_load_shaped(object, 0));
    MalPropertyLookup id = mal_object_get_own(object, timeout_id_key());
    return id.present ? (i64) mal_ops_number_as_f64(id.desc.value) : 0;
}

/* The pending timer behind a Timeout receiver, or nullptr once it ran or was cleared. */
static MalHostTimer *timeout_timer(MalVm *vm, MalValue self) {
    i64 id = timeout_id(vm, self);
    MalHostTimer *timer = id == 0 ? nullptr : mal_host_find_timer(vm, id);
    return timer != nullptr && !timer->cancelled ? timer : nullptr;
}

static MalValue timeout_ref(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalHostTimer *timer = timeout_timer(vm, self);
    if (timer != nullptr) timer->referenced = true;
    return self;
}

static MalValue timeout_unref(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalHostTimer *timer = timeout_timer(vm, self);
    if (timer != nullptr) timer->referenced = false;
    return self;
}

/* A timeout that ran or was cleared keeps nothing alive, so it reports false. */
static MalValue timeout_has_ref(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalHostTimer *timer = timeout_timer(vm, self);
    return mal_value_new_boolean(timer != nullptr && timer->referenced);
}

/*
 * Restart a pending timer's delay from now; a one-shot timer whose callback is running
 * re-arms once it returns. A timer already queued to run keeps its turn.
 */
static MalValue timeout_refresh(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalHostTimer *timer = timeout_timer(vm, self);
    if (timer != nullptr && timer->running) {
        timer->refreshed = true;
    } else if (timer != nullptr && !timer->ready) {
        MalReactor *reactor = &mal_host(vm)->reactor;
        mal_reactor_cancel_timer(reactor, &timer->timer);
        timer->timer.deadline_ns = mal_reactor_now_ns() + timer->delay_ms * 1000000;
        timer->timer.heap_index = -1;
        mal_reactor_add_timer(reactor, &timer->timer);
    }
    return self;
}

static MalValue timeout_close(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    i64 id = timeout_id(vm, self);
    if (id != 0) mal_host_clear_timeout(vm, id);
    return self;
}

/* The numeric id keeps arithmetic on handles and clearTimeout(Number(handle)) working. */
static MalValue timeout_to_primitive(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt; (void) callee;
    i64 id = timeout_id(vm, self);
    if (id == 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not a Timeout");
        return mal_value_new_undefined();
    }
    return mal_value_from_f64((f64) id);
}

static void timeout_runtime_cleanup(MalVm *vm) {
    if (timeout_vm != vm) return;
    timeout_vm = nullptr;
    timeout_prototype = mal_value_new_undefined();
    timeout_id_symbol = mal_value_new_undefined();
    timeout_shape = nullptr;
}

static void timeout_prototype_install(MalVm *vm) {
    if (timeout_vm == vm) return;
    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_from_symbol(mal_symbol_new_private(&vm->heap)),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *prototype = mal_value_to_object(roots[0]);
    mal_intrinsic_define_method_n(vm, prototype, "ref", 0, timeout_ref);
    mal_intrinsic_define_method_n(vm, prototype, "unref", 0, timeout_unref);
    mal_intrinsic_define_method_n(vm, prototype, "hasRef", 0, timeout_has_ref);
    mal_intrinsic_define_method_n(vm, prototype, "refresh", 0, timeout_refresh);
    mal_intrinsic_define_method_n(vm, prototype, "close", 0, timeout_close);
    mal_intrinsic_define_symbol_method(vm, prototype, MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE,
        (const byte *) "[Symbol.toPrimitive]", timeout_to_primitive);
    timeout_prototype = roots[0];
    timeout_id_symbol = roots[1];
    timeout_shape = mal_shape_add_property(mal_shape_root(&vm->heap), timeout_id_key(), MAL_PROPERTY_NONE);
    timeout_vm = vm;
    (void) mal_vm_register_runtime_cleanup(vm, timeout_runtime_cleanup);
    mal_gc_unroot(&root);
}

static MalValue mal_host_schedule_node_native(
    MalVm *vm, const MalValue *args, i32 argc, bool repeat) {
    i64 id = mal_host_schedule_native(vm, args, argc, repeat);
    if (id == 0) return mal_value_new_undefined();
    // The timer just scheduled is the newest, and its handle is `this` in the callback.
    MalValue id_value = mal_value_from_f64((f64) id);
    MalHostTimer *timer = mal_host(vm)->timers_tail;
    timer->handle = mal_value_from_object(mal_object_new_shaped(
        &vm->heap, mal_value_to_object(timeout_prototype), timeout_shape, &id_value, 1));
    return timer->handle;
}

static MalValue mal_host_set_timeout_node_native(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    return mal_host_schedule_node_native(vm, args, argc, false);
}

static MalValue mal_host_set_interval_node_native(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    return mal_host_schedule_node_native(vm, args, argc, true);
}

/* clearTimeout reads a Timeout's id directly and converts anything else to a number. */
static MalValue mal_host_clear_timeout_node_native(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    i64 id = argc >= 1 ? timeout_id(vm, args[0]) : 0;
    if (id == 0) return mal_host_clear_timeout_native(vm, self, args, argc, nt, callee);
    mal_host_clear_timeout(vm, id);
    return mal_value_new_undefined();
}

void mal_host_timers_install_node(MalVm *vm, MalObject *global_this) {
    mal_host(vm)->node_timers = true;
    mal_host_timers_install(vm, global_this);
    timeout_prototype_install(vm);
    mal_intrinsic_define_method_n(vm, global_this, "setTimeout", 2, mal_host_set_timeout_node_native);
    mal_intrinsic_define_method_n(vm, global_this, "setInterval", 2, mal_host_set_interval_node_native);
    mal_intrinsic_define_method_n(vm, global_this, "clearTimeout", 1, mal_host_clear_timeout_node_native);
    mal_intrinsic_define_method_n(vm, global_this, "clearInterval", 1, mal_host_clear_timeout_node_native);
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
