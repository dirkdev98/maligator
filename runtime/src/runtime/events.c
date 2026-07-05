#include "events_object.h"

#include <stdlib.h>
#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "heap.h"
#include "heap_string.h"
#include "host_timer.h" // AbortSignal.timeout
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "property_store.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/* ---------------------------------------------------------------------------
 * Shared helpers.
 * --------------------------------------------------------------------------- */

/* OrdinaryCreateFromConstructor prototype (native ctors get this = undefined). */
static MalObject *ev_instance_proto(MalVm *vm, MalValue new_target, MalIntrinsic fallback) {
    MalObject *proto = mal_value_to_object(vm->intrinsics[fallback]);
    if (mal_value_is_object(new_target)) {
        MalValue p = mal_vm_function_prototype(vm, new_target);
        if (mal_value_is_object(p)) {
            proto = mal_value_to_object(p);
        }
    }
    return proto;
}

static void ev_set(MalVm *vm, MalObject *obj, const byte *name, MalValue value) {
    mal_object_set(obj, mal_intrinsic_string_key(vm, name), value);
}

/* Read a property and coerce to boolean (absent -> false). */
static bool ev_get_bool(MalVm *vm, MalValue obj, const byte *name) {
    MalValue v;
    return mal_vm_get_property(vm, obj, mal_intrinsic_string_key(vm, name), &v)
        && mal_value_is_truthy(v);
}

/* ---------------------------------------------------------------------------
 * EventTarget object (also backs AbortSignal instances).
 * --------------------------------------------------------------------------- */

static MalEventTargetObject *event_target_new(MalHeap *heap, MalObject *prototype) {
    MalEventTargetObject *t =
        mal_heap_alloc(heap, sizeof(MalEventTargetObject), MAL_HEAP_EVENT_TARGET_OBJECT);
    mal_object_init(heap, &t->object, MAL_HEAP_EVENT_TARGET_OBJECT, prototype);
    t->listeners = nullptr;
    t->count = 0;
    t->cap = 0;
    return t;
}

static void event_target_finalize(MalHeapHeader *cell) {
    MalEventTargetObject *t = (MalEventTargetObject *) cell;
    free(t->listeners);
    t->listeners = nullptr;
    t->count = 0;
    t->cap = 0;
}

static void event_target_trace(MalHeapHeader *cell) {
    MalEventTargetObject *t = (MalEventTargetObject *) cell;
    for (i32 i = 0; i < t->count; i++) {
        mal_gc_mark_value(mal_value_from_string(t->listeners[i].type));
        mal_gc_mark_value(t->listeners[i].callback);
    }
}

static void event_target_add(MalEventTargetObject *t, MalString *type, MalValue cb, bool once) {
    for (i32 i = 0; i < t->count; i++) {
        if (mal_string_equals(t->listeners[i].type, type) && t->listeners[i].callback == cb) {
            return; // duplicate (same type + callback): a no-op per spec
        }
    }
    if (t->count == t->cap) {
        t->cap = t->cap == 0 ? 4 : t->cap * 2;
        t->listeners = realloc(t->listeners, sizeof(MalEventListener) * (usize) t->cap);
    }
    t->listeners[t->count].type = type;
    t->listeners[t->count].callback = cb;
    t->listeners[t->count].once = once;
    t->count++;
}

static void event_target_remove(MalEventTargetObject *t, const MalString *type, MalValue cb) {
    i32 w = 0;
    for (i32 i = 0; i < t->count; i++) {
        if (!(mal_string_equals(t->listeners[i].type, type) && t->listeners[i].callback == cb)) {
            t->listeners[w++] = t->listeners[i];
        }
    }
    t->count = w;
}

static MalEventTargetObject *event_target_this(MalValue self) {
    return mal_value_is_event_target_object(self) ? mal_value_to_event_target_object(self) : nullptr;
}

/* Dispatch `event` on `target` (both must be rooted by the caller). Fires matching
 * listeners in insertion order over a rooted snapshot; honors once +
 * stopImmediatePropagation. Returns !event.defaultPrevented. Single-target model:
 * no capture/bubble phases. */
static bool mal_event_dispatch(MalVm *vm, MalValue target_val, MalValue event_val) {
    MalEventTargetObject *t = mal_value_to_event_target_object(target_val);
    MalObject *ev = mal_value_to_object(event_val);
    ev_set(vm, ev, (const byte *) "target", target_val);
    ev_set(vm, ev, (const byte *) "currentTarget", target_val);

    MalValue tv;
    if (!mal_vm_get_property(vm, event_val, mal_intrinsic_string_key(vm, (const byte *) "type"), &tv)
        || !mal_value_is_string(tv)) {
        return true;
    }
    MalString *etype = mal_value_to_string(tv); // reachable via event.type (rooted)

    i32 n = 0;
    for (i32 i = 0; i < t->count; i++) {
        if (mal_string_equals(t->listeners[i].type, etype)) {
            n++;
        }
    }
    if (n > 0) {
        MalValue *cbs = malloc(sizeof(MalValue) * (usize) n);
        bool *onces = malloc(sizeof(bool) * (usize) n);
        i32 j = 0;
        for (i32 i = 0; i < t->count; i++) {
            if (mal_string_equals(t->listeners[i].type, etype)) {
                cbs[j] = t->listeners[i].callback;
                onces[j] = t->listeners[i].once;
                j++;
            }
        }
        MalRootSpan rs;
        mal_gc_root(&rs, cbs, n); // the snapshot survives once-removal + callbacks
        for (j = 0; j < n; j++) {
            mal_vm_call_value(vm, cbs[j], target_val, &event_val, 1);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                // A listener's exception is reported, not propagated (spec).
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL,
                    .value = mal_value_new_undefined()};
            }
            if (onces[j]) {
                event_target_remove(t, etype, cbs[j]);
            }
            if (ev_get_bool(vm, event_val, (const byte *) "__stopImmediate")) {
                break;
            }
        }
        mal_gc_unroot(&rs);
        free(cbs);
        free(onces);
    }
    return !ev_get_bool(vm, event_val, (const byte *) "defaultPrevented");
}

static MalValue event_target_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) argc;
    (void) callee;
    MalObject *proto = ev_instance_proto(vm, nt, MAL_INTRINSIC_EVENT_TARGET_PROTOTYPE);
    return mal_value_from_event_target_object(event_target_new(&vm->heap, proto));
}

static MalValue event_target_add_listener(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalEventTargetObject *t = event_target_this(self);
    if (t == nullptr || argc < 2 || !mal_value_is_callable(args[1])) {
        return mal_value_new_undefined(); // v1: only callable listeners (no handleEvent)
    }
    MalString *type;
    if (!mal_vm_to_string(vm, args[0], &type)) {
        return mal_value_new_undefined();
    }
    MalValue type_val = mal_value_from_string(type);
    MalRootSpan rs;
    mal_gc_root(&rs, &type_val, 1); // survives the options.once read (may run a getter)
    bool once = argc >= 3 && mal_value_is_object(args[2]) && ev_get_bool(vm, args[2], (const byte *) "once");
    event_target_add(t, mal_value_to_string(type_val), args[1], once);
    mal_gc_unroot(&rs);
    return mal_value_new_undefined();
}

static MalValue event_target_remove_listener(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalEventTargetObject *t = event_target_this(self);
    if (t == nullptr || argc < 2) {
        return mal_value_new_undefined();
    }
    MalString *type;
    if (!mal_vm_to_string(vm, args[0], &type)) {
        return mal_value_new_undefined();
    }
    event_target_remove(t, type, args[1]);
    return mal_value_new_undefined();
}

static MalValue event_target_dispatch_event(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    if (event_target_this(self) == nullptr || argc < 1 || !mal_value_is_object(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "dispatchEvent requires an Event");
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(mal_event_dispatch(vm, self, args[0]));
}

/* ---------------------------------------------------------------------------
 * Event (ordinary object with own properties).
 * --------------------------------------------------------------------------- */

static MalValue mal_event_new(MalVm *vm, const char *type) {
    MalObject *ev = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_EVENT_PROTOTYPE]));
    MalValue evval = mal_value_from_object(ev);
    MalRootSpan rs;
    mal_gc_root(&rs, &evval, 1);
    ev_set(vm, ev, (const byte *) "type",
        mal_value_from_string(mal_string_new_ascii(&vm->heap, type, strlen(type))));
    ev_set(vm, ev, (const byte *) "bubbles", mal_value_new_boolean(false));
    ev_set(vm, ev, (const byte *) "cancelable", mal_value_new_boolean(false));
    ev_set(vm, ev, (const byte *) "defaultPrevented", mal_value_new_boolean(false));
    mal_gc_unroot(&rs);
    return evval;
}

static MalValue event_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) callee;
    if (argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Event requires a type");
        return mal_value_new_undefined();
    }
    MalString *type;
    if (!mal_vm_to_string(vm, args[0], &type)) {
        return mal_value_new_undefined();
    }
    MalObject *proto = ev_instance_proto(vm, nt, MAL_INTRINSIC_EVENT_PROTOTYPE);
    MalObject *ev = mal_object_new(&vm->heap, proto);
    MalValue evval = mal_value_from_object(ev);
    MalRootSpan rs;
    mal_gc_root(&rs, &evval, 1);
    bool bubbles = argc >= 2 && mal_value_is_object(args[1]) && ev_get_bool(vm, args[1], (const byte *) "bubbles");
    bool cancelable = argc >= 2 && mal_value_is_object(args[1]) && ev_get_bool(vm, args[1], (const byte *) "cancelable");
    ev_set(vm, ev, (const byte *) "type", mal_value_from_string(type));
    ev_set(vm, ev, (const byte *) "bubbles", mal_value_new_boolean(bubbles));
    ev_set(vm, ev, (const byte *) "cancelable", mal_value_new_boolean(cancelable));
    ev_set(vm, ev, (const byte *) "defaultPrevented", mal_value_new_boolean(false));
    mal_gc_unroot(&rs);
    return evval;
}

static MalValue event_prevent_default(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    if (mal_value_is_object(self) && ev_get_bool(vm, self, (const byte *) "cancelable")) {
        ev_set(vm, mal_value_to_object(self), (const byte *) "defaultPrevented",
            mal_value_new_boolean(true));
    }
    return mal_value_new_undefined();
}

static MalValue event_stop_propagation(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm;
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return mal_value_new_undefined(); // single-target model: nothing to stop
}

static MalValue event_stop_immediate(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    if (mal_value_is_object(self)) {
        ev_set(vm, mal_value_to_object(self), (const byte *) "__stopImmediate",
            mal_value_new_boolean(true));
    }
    return mal_value_new_undefined();
}

/* ---------------------------------------------------------------------------
 * AbortSignal + AbortController.
 * --------------------------------------------------------------------------- */

/* A fresh, non-aborted AbortSignal (an EventTarget instance + aborted/reason/onabort
 * own properties). Returns a boxed value the caller should root before allocating. */
static MalValue mal_abort_signal_new(MalVm *vm) {
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ABORT_SIGNAL_PROTOTYPE]);
    MalEventTargetObject *s = event_target_new(&vm->heap, proto);
    MalValue sval = mal_value_from_event_target_object(s);
    MalRootSpan rs;
    mal_gc_root(&rs, &sval, 1);
    ev_set(vm, &s->object, (const byte *) "aborted", mal_value_new_boolean(false));
    ev_set(vm, &s->object, (const byte *) "reason", mal_value_new_undefined());
    ev_set(vm, &s->object, (const byte *) "onabort", mal_value_new_null());
    mal_gc_unroot(&rs);
    return sval;
}

/* Construct a default abort reason (v1: a plain Error, not a DOMException). */
static MalValue mal_abort_error(MalVm *vm, const char *message) {
    MalValue m = mal_value_from_string(mal_string_new_ascii(&vm->heap, message, strlen(message)));
    MalRootSpan rs;
    mal_gc_root(&rs, &m, 1);
    MalCompletion c = mal_vm_construct_value(vm, vm->intrinsics[MAL_INTRINSIC_ERROR_CONSTRUCTOR], &m, 1);
    mal_gc_unroot(&rs);
    return c.kind == MAL_COMPLETION_NORMAL ? c.value : mal_value_new_undefined();
}

/* The "signal abort" algorithm: mark aborted, store reason, fire onabort + dispatch
 * an "abort" event. No-op if already aborted. `signal_val` must be rooted by caller. */
static void mal_abort_signal_run(MalVm *vm, MalValue signal_val, MalValue reason) {
    MalEventTargetObject *s = mal_value_to_event_target_object(signal_val);
    if (ev_get_bool(vm, signal_val, (const byte *) "aborted")) {
        return;
    }
    MalValue slots[3];
    slots[0] = signal_val;
    slots[1] = reason;
    slots[2] = mal_value_new_undefined(); // abort event
    MalRootSpan rs;
    mal_gc_root(&rs, slots, 3);
    if (mal_value_is_undefined(slots[1])) {
        slots[1] = mal_abort_error(vm, "The operation was aborted");
    }
    ev_set(vm, &s->object, (const byte *) "aborted", mal_value_new_boolean(true));
    ev_set(vm, &s->object, (const byte *) "reason", slots[1]);

    slots[2] = mal_event_new(vm, "abort");
    mal_event_dispatch(vm, slots[0], slots[2]);

    MalValue onabort;
    if (mal_vm_get_property(vm, slots[0], mal_intrinsic_string_key(vm, (const byte *) "onabort"), &onabort)
        && mal_value_is_callable(onabort)) {
        mal_vm_call_value(vm, onabort, slots[0], &slots[2], 1);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            vm->completion =
                (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        }
    }
    mal_gc_unroot(&rs);
}

static MalValue abort_signal_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    // AbortSignal is not constructable; create one via AbortController or the statics.
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Illegal constructor");
    return mal_value_new_undefined();
}

static MalValue abort_signal_throw_if_aborted(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    if (mal_value_is_event_target_object(self) && ev_get_bool(vm, self, (const byte *) "aborted")) {
        MalValue reason;
        if (!mal_vm_get_property(vm, self, mal_intrinsic_string_key(vm, (const byte *) "reason"), &reason)) {
            reason = mal_value_new_undefined();
        }
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = reason};
    }
    return mal_value_new_undefined();
}

static MalValue abort_signal_static_abort(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    MalValue signal = mal_abort_signal_new(vm);
    MalRootSpan rs;
    mal_gc_root(&rs, &signal, 1);
    mal_abort_signal_run(vm, signal, argc >= 1 ? args[0] : mal_value_new_undefined());
    mal_gc_unroot(&rs);
    return signal;
}

/* Timer callback: abort the carried signal with a timeout error. */
static MalValue abort_signal_timeout_fire(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *fn = mal_value_to_native_function_object(callee);
    MalValue signal = mal_native_function_object_get_slot(fn, 0);
    MalRootSpan rs;
    mal_gc_root(&rs, &signal, 1);
    mal_abort_signal_run(vm, signal, mal_abort_error(vm, "The operation timed out"));
    mal_gc_unroot(&rs);
    return mal_value_new_undefined();
}

static MalValue abort_signal_static_timeout(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    i64 ms = 0;
    if (argc >= 1) {
        f64 d = mal_ops_to_number(args[0]);
        if (d == d && d > 0) {
            ms = (i64) d;
        }
    }
    MalValue signal = mal_abort_signal_new(vm);
    MalRootSpan rs;
    mal_gc_root(&rs, &signal, 1);
    // The timer keeps the callback (and its captured signal slot) alive until it fires.
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalNativeFunctionObject *cb = mal_native_function_object_new_with_slots(
        &vm->heap, fn_proto, mal_intrinsic_ascii(vm, (const byte *) ""), abort_signal_timeout_fire,
        &signal, 1);
    mal_host_set_timeout(vm, mal_value_from_native_function_object(cb), ms, nullptr, 0);
    mal_gc_unroot(&rs);
    return signal;
}

static MalValue abort_controller_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) argc;
    (void) callee;
    MalObject *proto = ev_instance_proto(vm, nt, MAL_INTRINSIC_ABORT_CONTROLLER_PROTOTYPE);
    MalObject *ctrl = mal_object_new(&vm->heap, proto);
    MalValue slots[2];
    slots[0] = mal_value_from_object(ctrl);
    slots[1] = mal_abort_signal_new(vm);
    MalRootSpan rs;
    mal_gc_root(&rs, slots, 2);
    ev_set(vm, mal_value_to_object(slots[0]), (const byte *) "signal", slots[1]);
    mal_gc_unroot(&rs);
    return slots[0];
}

static MalValue abort_controller_abort(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    if (!mal_value_is_object(self)) {
        return mal_value_new_undefined();
    }
    MalValue signal;
    if (!mal_vm_get_property(vm, self, mal_intrinsic_string_key(vm, (const byte *) "signal"), &signal)
        || !mal_value_is_event_target_object(signal)) {
        return mal_value_new_undefined();
    }
    MalRootSpan rs;
    mal_gc_root(&rs, &signal, 1);
    mal_abort_signal_run(vm, signal, argc >= 1 ? args[0] : mal_value_new_undefined());
    mal_gc_unroot(&rs);
    return mal_value_new_undefined();
}

/* ---------------------------------------------------------------------------
 * Installation.
 * --------------------------------------------------------------------------- */

/* Create a constructor + prototype, wire prototype/constructor + globalThis, and
 * store both in intrinsic slots. `proto_parent` is the prototype's [[Prototype]]. */
static MalObject *ev_install_class(MalVm *vm, MalObject *global_this, const byte *name, i32 length,
    MalNativeFunctionCallback ctor_fn, MalObject *proto_parent, MalIntrinsic ctor_slot,
    MalIntrinsic proto_slot) {
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *proto = mal_object_new(&vm->heap, proto_parent);
    MalNativeFunctionObject *ctor = mal_native_function_object_new_arity(
        &vm->heap, fn_proto, mal_intrinsic_ascii(vm, name), length, ctor_fn);
    mal_native_function_object_set_constructor(ctor);
    vm->intrinsics[ctor_slot] = mal_value_from_native_function_object(ctor);
    vm->intrinsics[proto_slot] = mal_value_from_object(proto);
    mal_intrinsic_define_data(vm, (MalObject *) ctor, (const byte *) "prototype",
        vm->intrinsics[proto_slot], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, proto, (const byte *) "constructor", vm->intrinsics[ctor_slot],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, global_this, name, vm->intrinsics[ctor_slot],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    return proto;
}

void mal_events_install(MalVm *vm, MalObject *global_this) {
    MalObject *obj_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);

    // Event.
    MalObject *event_proto = ev_install_class(vm, global_this, (const byte *) "Event", 1,
        event_constructor, obj_proto, MAL_INTRINSIC_EVENT_CONSTRUCTOR, MAL_INTRINSIC_EVENT_PROTOTYPE);
    mal_intrinsic_define_method_n(vm, event_proto, (const byte *) "preventDefault", 0, event_prevent_default);
    mal_intrinsic_define_method_n(vm, event_proto, (const byte *) "stopPropagation", 0, event_stop_propagation);
    mal_intrinsic_define_method_n(
        vm, event_proto, (const byte *) "stopImmediatePropagation", 0, event_stop_immediate);

    // EventTarget.
    MalObject *et_proto = ev_install_class(vm, global_this, (const byte *) "EventTarget", 0,
        event_target_constructor, obj_proto, MAL_INTRINSIC_EVENT_TARGET_CONSTRUCTOR,
        MAL_INTRINSIC_EVENT_TARGET_PROTOTYPE);
    mal_intrinsic_define_method_n(
        vm, et_proto, (const byte *) "addEventListener", 2, event_target_add_listener);
    mal_intrinsic_define_method_n(
        vm, et_proto, (const byte *) "removeEventListener", 2, event_target_remove_listener);
    mal_intrinsic_define_method_n(
        vm, et_proto, (const byte *) "dispatchEvent", 1, event_target_dispatch_event);

    // AbortSignal (prototype inherits EventTarget.prototype -> addEventListener etc.).
    MalObject *sig_proto = ev_install_class(vm, global_this, (const byte *) "AbortSignal", 0,
        abort_signal_constructor, et_proto, MAL_INTRINSIC_ABORT_SIGNAL_CONSTRUCTOR,
        MAL_INTRINSIC_ABORT_SIGNAL_PROTOTYPE);
    mal_intrinsic_define_method_n(
        vm, sig_proto, (const byte *) "throwIfAborted", 0, abort_signal_throw_if_aborted);
    MalValue sig_ctor = vm->intrinsics[MAL_INTRINSIC_ABORT_SIGNAL_CONSTRUCTOR];
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(sig_ctor), (const byte *) "abort", 0, abort_signal_static_abort);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(sig_ctor), (const byte *) "timeout", 1, abort_signal_static_timeout);

    // AbortController.
    MalObject *ctrl_proto = ev_install_class(vm, global_this, (const byte *) "AbortController", 0,
        abort_controller_constructor, obj_proto, MAL_INTRINSIC_ABORT_CONTROLLER_CONSTRUCTOR,
        MAL_INTRINSIC_ABORT_CONTROLLER_PROTOTYPE);
    mal_intrinsic_define_method_n(vm, ctrl_proto, (const byte *) "abort", 0, abort_controller_abort);

    mal_gc_register_finalizer(MAL_HEAP_EVENT_TARGET_OBJECT, event_target_finalize);
    mal_gc_register_tracer(MAL_HEAP_EVENT_TARGET_OBJECT, event_target_trace);
}
