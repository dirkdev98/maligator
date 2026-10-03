#include "web_host_timer.h"

#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdatomic.h>

#include "async_context.h"
#include "array_object.h"
#include "gc.h"
#include "function_object.h"
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
// Checkpoint hooks belong to the isolate whose mutator registered them.
static MAL_ISOLATE_LOCAL MalHostMacrotaskDrain
    mal_host_macrotask_drains[MAL_HOST_MAX_MACROTASK_DRAINS];
static MAL_ISOLATE_LOCAL i32 mal_host_macrotask_drain_count;
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
    if (t == nullptr) {
        free(args);
        mal_vm_throw_allocation_error(vm);
        return 0;
    }
    t->id = mal_host(vm)->timer_next_id++;
    t->callback = callback;
    t->handle = mal_value_new_undefined();
    t->referenced = true;
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

void mal_host_timer_set_referenced(MalVm *vm, i64 id, bool referenced) {
    for (MalHostTimer *timer = mal_host(vm)->timers; timer != nullptr; timer = timer->next) {
        if (timer->id == id && !timer->cancelled) {
            timer->referenced = referenced;
            return;
        }
    }
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
#if MAL_NODE
            MalAsyncContextScope async_scope;
            mal_async_context_scope_enter(vm, &async_scope, t->async_context);
#endif
            mal_vm_call_value(vm, cb, t->handle, cargs, cargc);
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
        MalValue handle = t->handle;
        MalValue *cargs = t->args;
        i32 cargc = t->arg_count;
#if MAL_NODE
        MalAsyncContext *async_context = t->async_context;
#endif
        free(t); // the task struct is done; cb/cargs kept alive below

        MalRootSpan rs_cb;
        mal_gc_root(&rs_cb, &cb, 1);
        MalRootSpan rs_handle;
        mal_gc_root(&rs_handle, &handle, 1);
        MalRootSpan rs_args;
        if (cargc > 0) {
            mal_gc_root(&rs_args, cargs, cargc);
        }
#if MAL_NODE
        MalAsyncContextScope async_scope;
        mal_async_context_scope_enter(vm, &async_scope, async_context);
#endif
        mal_vm_call_value(vm, cb, handle, cargs, cargc);
#if MAL_NODE
        mal_async_context_scope_exit(vm, &async_scope);
#endif
        if (cargc > 0) {
            mal_gc_unroot(&rs_args);
        }
        mal_gc_unroot(&rs_handle);
        mal_gc_unroot(&rs_cb);

        free(cargs);
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
    return host->reactor.timer_count > unreferenced || host->reactor.pending_ops > 0
        || atomic_load_explicit(&host->reactor.retained_work, memory_order_acquire) > 0
        || atomic_load_explicit(&host->reactor.wake_pending, memory_order_acquire);
}

void mal_host_run_event_loop(MalVm *vm) {
    mal_gc_set_mutator_busy(vm, true);
    // Tracks whether the loop did anything since the last idle notification, so a
    // `beforeExit` listener that schedules new work is notified again next time
    // the loop drains, while one that schedules nothing does not spin forever.
    // Seeded true so the first drain always notifies.
    bool progressed = true;
    for (;;) {
        // A prior macrotask's uncaught throw must survive the next microtask checkpoint.
        if (vm->completion.kind == MAL_COMPLETION_THROW) break;
        if (mal_gc_terminating()) break;
        if (mal_host_termination_check != nullptr && mal_host_termination_check(vm)) break;
        // Microtasks first (promise jobs), then one macrotask, then repeat.
        mal_vm_drain_microtasks(vm);
        if (!mal_vm_check_entry_evaluation(vm)) break;
        if (vm->completion.kind == MAL_COMPLETION_THROW) break;
        if (mal_host_termination_check != nullptr && mal_host_termination_check(vm)) break;
        if (mal_host_run_runtime_macrotask(vm)) {
            progressed = true;
            if (mal_gc_poll) mal_gc_safepoint(vm);
            continue;
        }
        if (mal_host_has_referenced_work(vm) && mal_host_run_one_ready(vm)) {
            progressed = true;
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
            mal_gc_set_mutator_busy(vm, true);
			if (mal_gc_poll) mal_gc_safepoint(vm);
			continue;
        }
        if (!progressed || mal_host_idle_notify == nullptr) {
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
        f64 d;
        if (mal_vm_to_number(vm, args[0], &d) && isfinite(d)
            && d >= 0 && d <= 9007199254740991.0) {
            mal_host_clear_timeout(vm, (i64) d);
        }
    }
    return mal_value_new_undefined();
}

/* Root source: pending timer callbacks + their args must survive until they run.
 * Registered with the engine so the collector roots them without knowing the type. */
static void mal_host_timers_scan_roots(MalVm *vm, void *data) {
    (void) data;
    MalHost *host = mal_host(vm);
    if (host == nullptr) return;
    for (MalHostTimer *t = host->timers; t != nullptr; t = t->next) {
        mal_gc_mark_value(t->callback);
        mal_gc_mark_value(t->handle);
        mal_gc_mark_values(t->args, t->arg_count);
#if MAL_NODE
        mal_gc_mark_value(
            mal_async_internal_value((MalHeapHeader *) t->async_context));
#endif
    }
}

static MalHostTimer *mal_host_timer_from_method(MalVm *vm, MalValue callee) {
    MalValue state = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    MalValue id = mal_object_get_own(mal_value_to_object(state), mal_key_index(0)).desc.value;
    for (MalHostTimer *timer = mal_host(vm)->timers; timer != nullptr; timer = timer->next) {
        if (timer->id == (i64) mal_ops_number_as_f64(id) && !timer->cancelled) return timer;
    }
    return nullptr;
}

static MalValue mal_host_timer_ref(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt;
    MalValue state = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    mal_object_set(mal_value_to_object(state), mal_key_index(1), mal_value_new_boolean(true));
    MalHostTimer *timer = mal_host_timer_from_method(vm, callee);
    if (timer != nullptr) timer->referenced = true;
    return self;
}

static MalValue mal_host_timer_unref(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args; (void) argc; (void) nt;
    MalValue state = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    mal_object_set(mal_value_to_object(state), mal_key_index(1), mal_value_new_boolean(false));
    MalHostTimer *timer = mal_host_timer_from_method(vm, callee);
    if (timer != nullptr) timer->referenced = false;
    return self;
}

static MalValue mal_host_timer_has_ref(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self; (void) args; (void) argc; (void) nt;
    (void) vm;
    MalValue state = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    return mal_object_get_own(mal_value_to_object(state), mal_key_index(1)).desc.value;
}

static MalValue mal_host_timer_to_primitive(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm; (void) self; (void) args; (void) argc; (void) nt;
    MalValue state = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    return mal_object_get_own(mal_value_to_object(state), mal_key_index(0)).desc.value;
}

static void mal_host_timer_handle_method(
    MalVm *vm, MalValue handle, MalKey key, const char *name,
    MalNativeFunctionCallback callback, MalValue state) {
    MalValue method = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) name), callback, &state, 1));
    MalRootSpan root;
    mal_gc_root(&root, &method, 1);
    MalPropertyDesc descriptor = {.value = method,
        .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE};
    mal_object_define_own(mal_value_to_object(handle), key, &descriptor);
    mal_gc_unroot(&root);
}

static MalValue mal_host_schedule_node_native(
    MalVm *vm, const MalValue *args, i32 argc, bool repeat) {
    i64 id = mal_host_schedule_native(vm, args, argc, repeat);
    if (id == 0) return mal_value_new_undefined();
    MalValue handle = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalRootSpan root;
    mal_gc_root(&root, &handle, 1);
    MalValue state = mal_value_from_array_object(mal_intrinsic_new_array(vm, 2));
    MalRootSpan state_root;
    mal_gc_root(&state_root, &state, 1);
    mal_object_set(mal_value_to_object(state), mal_key_index(0), mal_value_from_f64((f64) id));
    mal_object_set(mal_value_to_object(state), mal_key_index(1), mal_value_new_boolean(true));
    mal_host_timer_handle_method(vm, handle,
        mal_intrinsic_string_key(vm, (const byte *) "ref"), "ref", mal_host_timer_ref, state);
    mal_host_timer_handle_method(vm, handle,
        mal_intrinsic_string_key(vm, (const byte *) "unref"), "unref", mal_host_timer_unref, state);
    mal_host_timer_handle_method(vm, handle,
        mal_intrinsic_string_key(vm, (const byte *) "hasRef"), "hasRef", mal_host_timer_has_ref, state);
    mal_host_timer_handle_method(vm, handle,
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_PRIMITIVE),
        "[Symbol.toPrimitive]", mal_host_timer_to_primitive, state);
    for (MalHostTimer *timer = mal_host(vm)->timers_tail; timer != nullptr; timer = timer->previous) {
        if (timer->id == id) {
            timer->handle = handle;
            break;
        }
    }
    mal_gc_unroot(&state_root);
    mal_gc_unroot(&root);
    return handle;
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

void mal_host_timers_install_node(MalVm *vm, MalObject *global_this) {
    mal_host(vm)->node_timers = true;
    mal_host_timers_install(vm, global_this);
    mal_intrinsic_define_method_n(vm, global_this, "setTimeout", 2, mal_host_set_timeout_node_native);
    mal_intrinsic_define_method_n(vm, global_this, "setInterval", 2, mal_host_set_interval_node_native);
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
