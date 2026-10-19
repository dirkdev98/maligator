#include "node_timers_promises.h"

#if MAL_NODE

#include <string.h>

#include "builtin_promise.h"
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "iterator_object.h"
#include "node_module.h"
#include "object.h"
#include "promise_object.h"
#include "value_ops.h"
#include "vm_ops.h"
#include "web_events_object.h"
#include "web_host_timer.h"

#define TP_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)

typedef enum TpTimerKind {
    TP_TIMEOUT,
    TP_IMMEDIATE,
    TP_INTERVAL,
} TpTimerKind;

/* Slots of a pending timeout or immediate's native callbacks. */
enum {
    TP_PENDING_PROMISE,
    TP_PENDING_VALUE,
    TP_PENDING_SIGNAL,
    TP_PENDING_HANDLE,
    TP_PENDING_LISTENER,
    TP_PENDING_KIND,
    TP_PENDING_SLOTS,
};

/* Slots of a setInterval iterator's state object, kept in its methods' slot 0. */
enum {
    TP_INTERVAL_VALUE,
    TP_INTERVAL_SIGNAL,
    TP_INTERVAL_HANDLE,
    TP_INTERVAL_LISTENER,
    TP_INTERVAL_WAITING,
    TP_INTERVAL_COUNT,
    TP_INTERVAL_DONE,
    TP_INTERVAL_ERROR,
    TP_INTERVAL_SLOTS,
};

static MalValue tp_global(MalVm *vm, const char *name) {
    MalValue value = mal_value_new_undefined();
    mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS],
        mal_intrinsic_string_key(vm, (const byte *) name), &value);
    return value;
}

static MalValue tp_call_global(MalVm *vm, const char *name, const MalValue *args, i32 argc) {
    MalValue function = tp_global(vm, name);
    if (!mal_value_is_callable(function)) return mal_value_new_undefined();
    MalCompletion completion = mal_vm_call_value(vm, function, mal_value_new_undefined(), args, argc);
    if (completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = completion;
        return mal_value_new_undefined();
    }
    return completion.value;
}

static void tp_call_method(MalVm *vm, MalValue target, const char *name, const MalValue *args, i32 argc) {
    MalValue method;
    if (!mal_vm_get_property(vm, target, mal_intrinsic_string_key(vm, (const byte *) name), &method)
        || !mal_value_is_callable(method)) {
        return;
    }
    MalCompletion completion = mal_vm_call_value(vm, method, target, args, argc);
    if (completion.kind == MAL_COMPLETION_THROW) vm->completion = completion;
}

static MalValue tp_new_promise(MalVm *vm) {
    MalValue promise, resolve, reject;
    mal_promise_new_direct_capability(vm, &promise, &resolve, &reject);
    return promise;
}

static void tp_settle(MalVm *vm, MalValue promise, bool rejected, MalValue value) {
    if (!mal_value_is_promise_object(promise)
        || mal_value_to_promise_object(promise)->state != MAL_PROMISE_PENDING) {
        return;
    }
    mal_promise_settle_direct(
        vm, promise, vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], rejected, value);
}

static MalValue tp_rejected(MalVm *vm, MalValue reason) {
    MalValue roots[] = {reason, tp_new_promise(vm)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    tp_settle(vm, roots[1], true, roots[0]);
    mal_gc_unroot(&root);
    return roots[1];
}

static MalValue tp_take_throw(MalVm *vm) {
    MalValue error = vm->completion.value;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    return error;
}

static MalValue tp_signal_reason(MalVm *vm, MalValue signal) {
    MalValue reason = mal_value_new_undefined();
    if (mal_value_is_object(signal)) {
        mal_vm_get_property(vm, signal, mal_intrinsic_string_key(vm, (const byte *) "reason"), &reason);
    }
    return reason;
}

/* Validates (delay, options) as lib/timers/promises.js does; false leaves the error pending. */
static bool tp_options(MalVm *vm, MalValue delay, bool check_delay, MalValue options,
    MalValue *signal, bool *ref) {
    *signal = mal_value_new_undefined();
    *ref = true;
    if (check_delay && !mal_value_is_undefined(delay) && !mal_node_validate_number(vm, delay, "delay")) {
        return false;
    }
    if (mal_value_is_undefined(options)) return true;
    if (!mal_value_is_object(options) || mal_value_is_callable(options) || mal_value_is_array_object(options)) {
        mal_node_throw_invalid_arg_type(vm, "options", "of type object", options);
        return false;
    }
    MalValue value;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "signal"), &value)) {
        return false;
    }
    if (!mal_value_is_undefined(value)) {
        if (!mal_value_is_event_target_object(value)
            || !mal_value_to_event_target_object(value)->is_abort_signal) {
            mal_node_throw_invalid_arg_type(vm, "options.signal", "an instance of AbortSignal", value);
            return false;
        }
        *signal = value;
    }
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, (const byte *) "ref"), &value)) {
        return false;
    }
    if (!mal_value_is_undefined(value)) {
        if (!mal_value_is_boolean(value)) {
            mal_node_throw_invalid_arg_type(vm, "options.ref", "of type boolean", value);
            return false;
        }
        *ref = mal_value_is_truthy(value);
    }
    return true;
}

static MalValue tp_slot(MalValue callee, i32 index) {
    return mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), index);
}

static MalValue tp_function(MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    const MalValue *slots, i32 slot_count) {
    return mal_value_from_native_function_object(mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, callback, slots, slot_count));
}

static void tp_remove_listener(MalVm *vm, MalValue signal, MalValue listener) {
    if (!mal_value_is_object(signal) || !mal_value_is_callable(listener)) return;
    MalValue args[] = {mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "abort")), listener};
    MalCompletion saved = vm->completion;
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    tp_call_method(vm, signal, "removeEventListener", args, 2);
    if (vm->completion.kind != MAL_COMPLETION_THROW) vm->completion = saved;
}

/* The timer fired: settle with the value and stop watching the signal. */
static MalValue tp_pending_fire(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue state = mal_native_function_object_get_slot(self, 0);
    MalNativeFunctionObject *owner = mal_value_to_native_function_object(state);
    MalValue roots[] = {state, mal_native_function_object_get_slot(owner, TP_PENDING_PROMISE),
        mal_native_function_object_get_slot(owner, TP_PENDING_VALUE),
        mal_native_function_object_get_slot(owner, TP_PENDING_SIGNAL),
        mal_native_function_object_get_slot(owner, TP_PENDING_LISTENER)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    tp_remove_listener(vm, roots[3], roots[4]);
    tp_settle(vm, roots[1], false, roots[2]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

/* The signal aborted first: clear the timer and reject with an AbortError. */
static MalValue tp_pending_abort(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    MalNativeFunctionObject *self = mal_value_to_native_function_object(callee);
    MalValue roots[] = {mal_native_function_object_get_slot(self, TP_PENDING_PROMISE),
        mal_native_function_object_get_slot(self, TP_PENDING_HANDLE),
        mal_native_function_object_get_slot(self, TP_PENDING_SIGNAL), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    TpTimerKind kind = (TpTimerKind) mal_value_to_i32(mal_native_function_object_get_slot(self, TP_PENDING_KIND));
    tp_call_global(vm, kind == TP_IMMEDIATE ? "clearImmediate" : "clearTimeout", &roots[1], 1);
    roots[3] = mal_node_abort_error(vm, tp_signal_reason(vm, roots[2]));
    tp_settle(vm, roots[0], true, roots[3]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue tp_schedule(MalVm *vm, TpTimerKind kind, MalValue delay, MalValue value, MalValue options) {
    MalValue signal;
    bool ref;
    if (!tp_options(vm, delay, kind == TP_TIMEOUT, options, &signal, &ref)) {
        return tp_rejected(vm, tp_take_throw(vm));
    }
    MalValue roots[TP_PENDING_SLOTS + 1];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[TP_PENDING_SIGNAL] = signal;
    if (mal_value_is_object(signal) && mal_abort_signal_is_aborted(signal)) {
        roots[TP_PENDING_SLOTS] = tp_rejected(vm, mal_node_abort_error(vm, tp_signal_reason(vm, signal)));
        mal_gc_unroot(&root);
        return roots[TP_PENDING_SLOTS];
    }
    roots[TP_PENDING_PROMISE] = tp_new_promise(vm);
    roots[TP_PENDING_VALUE] = value;
    roots[TP_PENDING_KIND] = mal_value_from_i32((i32) kind);
    // The abort listener doubles as the shared state the fire callback reads.
    roots[TP_PENDING_LISTENER] = tp_function(vm, "", 0, tp_pending_abort, roots, TP_PENDING_SLOTS);
    MalNativeFunctionObject *state = mal_value_to_native_function_object(roots[TP_PENDING_LISTENER]);
    mal_native_function_object_set_slot(state, TP_PENDING_LISTENER,
        mal_value_is_object(signal) ? roots[TP_PENDING_LISTENER] : mal_value_new_undefined());
    roots[TP_PENDING_SLOTS] = tp_function(vm, kind == TP_IMMEDIATE ? "immediate" : "timeout", 0,
        tp_pending_fire, &roots[TP_PENDING_LISTENER], 1);
    MalValue schedule_args[] = {roots[TP_PENDING_SLOTS], mal_value_is_undefined(delay) ? mal_value_from_i32(1) : delay};
    roots[TP_PENDING_HANDLE] = tp_call_global(vm, kind == TP_IMMEDIATE ? "setImmediate" : "setTimeout",
        schedule_args, kind == TP_IMMEDIATE ? 1 : 2);
    mal_native_function_object_set_slot(state, TP_PENDING_HANDLE, roots[TP_PENDING_HANDLE]);
    if (!ref && mal_value_is_object(roots[TP_PENDING_HANDLE])) tp_call_method(vm, roots[TP_PENDING_HANDLE], "unref", nullptr, 0);
    if (mal_value_is_object(signal) && vm->completion.kind != MAL_COMPLETION_THROW) {
        MalValue listen_args[] = {mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "abort")),
            roots[TP_PENDING_LISTENER]};
        tp_call_method(vm, signal, "addEventListener", listen_args, 2);
    }
    MalValue result = roots[TP_PENDING_PROMISE];
    if (vm->completion.kind == MAL_COMPLETION_THROW) result = tp_rejected(vm, tp_take_throw(vm));
    mal_gc_unroot(&root);
    return result;
}

static MalValue tp_set_timeout(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    return tp_schedule(vm, TP_TIMEOUT, argc > 0 ? args[0] : mal_value_new_undefined(),
        argc > 1 ? args[1] : mal_value_new_undefined(), argc > 2 ? args[2] : mal_value_new_undefined());
}

static MalValue tp_set_immediate(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    return tp_schedule(vm, TP_IMMEDIATE, mal_value_new_undefined(),
        argc > 0 ? args[0] : mal_value_new_undefined(), argc > 1 ? args[1] : mal_value_new_undefined());
}

static MalValue tp_scheduler_wait(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    return tp_schedule(vm, TP_TIMEOUT, argc > 0 ? args[0] : mal_value_new_undefined(),
        mal_value_new_undefined(), argc > 1 ? args[1] : mal_value_new_undefined());
}

static MalValue tp_scheduler_yield(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target, (void) callee;
    return tp_schedule(vm, TP_IMMEDIATE, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined());
}

static MalNativeFunctionObject *tp_interval_state(MalValue callee) {
    return mal_value_to_native_function_object(tp_slot(callee, 0));
}

static MalValue tp_iter_result(MalVm *vm, MalValue value, bool done) {
    return mal_vm_create_iter_result(vm, value, done);
}

static void tp_interval_stop(MalVm *vm, MalNativeFunctionObject *state) {
    mal_native_function_object_set_slot(state, TP_INTERVAL_DONE, mal_value_new_boolean(true));
    MalValue roots[] = {mal_native_function_object_get_slot(state, TP_INTERVAL_HANDLE),
        mal_native_function_object_get_slot(state, TP_INTERVAL_SIGNAL),
        mal_native_function_object_get_slot(state, TP_INTERVAL_LISTENER)};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_undefined(roots[0])) tp_call_global(vm, "clearInterval", &roots[0], 1);
    tp_remove_listener(vm, roots[1], roots[2]);
    mal_gc_unroot(&root);
}

/* Each tick is counted, or delivered straight to a next() that is already waiting. */
static MalValue tp_interval_tick(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    MalNativeFunctionObject *state = tp_interval_state(callee);
    MalValue waiting = mal_native_function_object_get_slot(state, TP_INTERVAL_WAITING);
    if (mal_value_is_promise_object(waiting)) {
        MalValue roots[] = {waiting, mal_value_new_undefined()};
        MalRootSpan root;
        mal_gc_root(&root, roots, countof(roots));
        mal_native_function_object_set_slot(state, TP_INTERVAL_WAITING, mal_value_new_undefined());
        roots[1] = tp_iter_result(vm, mal_native_function_object_get_slot(state, TP_INTERVAL_VALUE), false);
        tp_settle(vm, roots[0], false, roots[1]);
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    i32 count = mal_value_to_i32(mal_native_function_object_get_slot(state, TP_INTERVAL_COUNT));
    mal_native_function_object_set_slot(state, TP_INTERVAL_COUNT, mal_value_from_i32(count + 1));
    return mal_value_new_undefined();
}

static MalValue tp_interval_abort(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    MalNativeFunctionObject *state = tp_interval_state(callee);
    MalValue roots[] = {mal_native_function_object_get_slot(state, TP_INTERVAL_WAITING),
        mal_node_abort_error(vm, tp_signal_reason(vm, mal_native_function_object_get_slot(state, TP_INTERVAL_SIGNAL)))};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    tp_interval_stop(vm, state);
    mal_native_function_object_set_slot(state, TP_INTERVAL_WAITING, mal_value_new_undefined());
    tp_settle(vm, roots[0], true, roots[1]);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue tp_interval_next(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) args, (void) argc, (void) new_target;
    MalNativeFunctionObject *state = tp_interval_state(callee);
    MalValue error = mal_native_function_object_get_slot(state, TP_INTERVAL_ERROR);
    if (!mal_value_is_undefined(error)) {
        mal_native_function_object_set_slot(state, TP_INTERVAL_ERROR, mal_value_new_undefined());
        return tp_rejected(vm, error);
    }
    MalValue signal = mal_native_function_object_get_slot(state, TP_INTERVAL_SIGNAL);
    if (mal_value_is_object(signal) && mal_abort_signal_is_aborted(signal)) {
        tp_interval_stop(vm, state);
        return tp_rejected(vm, mal_node_abort_error(vm, tp_signal_reason(vm, signal)));
    }
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    roots[0] = tp_new_promise(vm);
    if (mal_value_is_truthy(mal_native_function_object_get_slot(state, TP_INTERVAL_DONE))) {
        roots[1] = tp_iter_result(vm, mal_value_new_undefined(), true);
        tp_settle(vm, roots[0], false, roots[1]);
    } else {
        i32 count = mal_value_to_i32(mal_native_function_object_get_slot(state, TP_INTERVAL_COUNT));
        if (count > 0) {
            mal_native_function_object_set_slot(state, TP_INTERVAL_COUNT, mal_value_from_i32(count - 1));
            roots[1] = tp_iter_result(vm, mal_native_function_object_get_slot(state, TP_INTERVAL_VALUE), false);
            tp_settle(vm, roots[0], false, roots[1]);
        } else {
            mal_native_function_object_set_slot(state, TP_INTERVAL_WAITING, roots[0]);
        }
    }
    mal_gc_unroot(&root);
    return roots[0];
}

static MalValue tp_interval_return(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target;
    MalNativeFunctionObject *state = tp_interval_state(callee);
    MalValue roots[] = {mal_native_function_object_get_slot(state, TP_INTERVAL_WAITING),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    tp_interval_stop(vm, state);
    mal_native_function_object_set_slot(state, TP_INTERVAL_WAITING, mal_value_new_undefined());
    roots[1] = tp_iter_result(vm, argc > 0 ? args[0] : mal_value_new_undefined(), true);
    tp_settle(vm, roots[0], false, roots[1]);
    roots[2] = tp_new_promise(vm);
    tp_settle(vm, roots[2], false, roots[1]);
    mal_gc_unroot(&root);
    return roots[2];
}

static MalValue tp_iterator_self(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) vm, (void) args, (void) argc, (void) new_target, (void) callee;
    return receiver;
}

static MalValue tp_set_interval(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver, (void) new_target, (void) callee;
    MalValue delay = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue signal;
    bool ref;
    MalValue roots[TP_INTERVAL_SLOTS + 4];
    for (usize i = 0; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    enum { ITERATOR = TP_INTERVAL_SLOTS, STATE, FUNCTION, LISTEN_EVENT };
    // Validation errors and an aborted signal surface from the first next(), as the async generator's do.
    bool valid = tp_options(vm, delay, false, argc > 2 ? args[2] : mal_value_new_undefined(), &signal, &ref);
    roots[TP_INTERVAL_ERROR] = valid ? mal_value_new_undefined() : tp_take_throw(vm);
    roots[TP_INTERVAL_VALUE] = argc > 1 ? args[1] : mal_value_new_undefined();
    roots[TP_INTERVAL_SIGNAL] = valid ? signal : mal_value_new_undefined();
    roots[TP_INTERVAL_COUNT] = mal_value_from_i32(0);
    roots[TP_INTERVAL_DONE] = mal_value_new_boolean(!valid);
    // A never-called function carries the iterator state in its slots.
    roots[STATE] = tp_function(vm, "", 0, tp_iterator_self, roots, TP_INTERVAL_SLOTS);
    MalNativeFunctionObject *state = mal_value_to_native_function_object(roots[STATE]);
    roots[ITERATOR] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *iterator = mal_value_to_object(roots[ITERATOR]);
    roots[FUNCTION] = tp_function(vm, "next", 0, tp_interval_next, &roots[STATE], 1);
    mal_intrinsic_define_data(vm, iterator, (const byte *) "next", roots[FUNCTION],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    roots[FUNCTION] = tp_function(vm, "return", 1, tp_interval_return, &roots[STATE], 1);
    mal_intrinsic_define_data(vm, iterator, (const byte *) "return", roots[FUNCTION],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    roots[FUNCTION] = tp_function(vm, "[Symbol.asyncIterator]", 0, tp_iterator_self, nullptr, 0);
    MalPropertyDesc self = mal_intrinsic_data_desc(roots[FUNCTION], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(iterator, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ASYNC_ITERATOR), &self);
    if (valid && !(mal_value_is_object(signal) && mal_abort_signal_is_aborted(signal))) {
        roots[FUNCTION] = tp_function(vm, "tick", 0, tp_interval_tick, &roots[STATE], 1);
        MalValue interval_args[] = {roots[FUNCTION], mal_value_is_undefined(delay) ? mal_value_from_i32(1) : delay};
        MalValue handle = tp_call_global(vm, "setInterval", interval_args, 2);
        mal_native_function_object_set_slot(state, TP_INTERVAL_HANDLE, handle);
        if (!ref && mal_value_is_object(handle)) tp_call_method(vm, handle, "unref", nullptr, 0);
        if (mal_value_is_object(signal) && vm->completion.kind != MAL_COMPLETION_THROW) {
            roots[FUNCTION] = tp_function(vm, "", 0, tp_interval_abort, &roots[STATE], 1);
            mal_native_function_object_set_slot(state, TP_INTERVAL_LISTENER, roots[FUNCTION]);
            roots[LISTEN_EVENT] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "abort"));
            MalValue listen_args[] = {roots[LISTEN_EVENT], roots[FUNCTION]};
            tp_call_method(vm, signal, "addEventListener", listen_args, 2);
        }
    }
    MalValue result = roots[ITERATOR];
    mal_gc_unroot(&root);
    return result;
}

void mal_host_install_node_timers_promises(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:timers/promises", slots, count)) return;
    (void) launch;
    MalObject *global_this = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_host_timers_install_node(vm, global_this);
    MalValue roots[] = {
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_from_object(mal_intrinsic_new_object(vm)),
        mal_value_from_object(mal_intrinsic_new_object(vm)),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *module = mal_value_to_object(roots[0]);
    mal_intrinsic_define_method_n(vm, module, (const byte *) "setTimeout", 3, tp_set_timeout);
    mal_intrinsic_define_method_n(vm, module, (const byte *) "setImmediate", 2, tp_set_immediate);
    mal_intrinsic_define_method_n(vm, module, (const byte *) "setInterval", 3, tp_set_interval);
    MalObject *scheduler_prototype = mal_value_to_object(roots[1]);
    mal_intrinsic_define_method_n(vm, scheduler_prototype, (const byte *) "yield", 0, tp_scheduler_yield);
    mal_intrinsic_define_method_n(vm, scheduler_prototype, (const byte *) "wait", 2, tp_scheduler_wait);
    roots[2] = mal_value_from_object(mal_object_new(&vm->heap, scheduler_prototype));
    mal_intrinsic_define_data(vm, module, (const byte *) "scheduler", roots[2], TP_VISIBLE);
    mal_node_module_publish(vm, "node:timers/promises", slots, count, roots[0]);
    mal_gc_unroot(&root);
}

void mal_host_install_node_timers(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    if (mal_node_module_install_cached(vm, "node:timers", slots, count)) return;
    mal_host_install_node_timers_promises(vm, nullptr, 0, launch);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return;
    MalValue roots[] = {mal_value_from_object(mal_intrinsic_new_object(vm)), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    // node:timers re-exports the very global functions, so identity checks hold.
    static const char *const names[] = {"setTimeout", "clearTimeout", "setImmediate", "clearImmediate",
        "setInterval", "clearInterval"};
    for (usize i = 0; i < countof(names); i++) {
        roots[1] = tp_global(vm, names[i]);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) names[i], roots[1], TP_VISIBLE);
    }
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "promises",
        mal_node_module_get_cached(vm, "node:timers/promises"), TP_VISIBLE);
    mal_node_module_publish(vm, "node:timers", slots, count, roots[0]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
