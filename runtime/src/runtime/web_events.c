#include "web_events_object.h"

#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "builtin_iterator.h"
#include "function_object.h"
#include "gc.h"
#include "heap.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "web_host_timer.h" // AbortSignal.timeout
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

static MalKey event_trusted_slot_key(MalVm *vm);
static bool event_set_trusted(MalVm *vm, MalValue event, bool trusted);

static void ev_define_getter(MalVm *vm, MalObject *proto, const byte *name,
    const byte *function_name, MalNativeFunctionCallback getter) {
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap, fn_proto, mal_intrinsic_ascii(vm, function_name), getter)),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(proto, mal_intrinsic_string_key(vm, name), &desc);
}

/* ---------------------------------------------------------------------------
 * DOMException (ordinary objects with hidden name/message slots).
 * --------------------------------------------------------------------------- */

typedef struct MalDomExceptionCode {
    const char *name;
    u16 code;
} MalDomExceptionCode;

static const MalDomExceptionCode dom_exception_codes[] = {
    {"IndexSizeError", 1},
    {"HierarchyRequestError", 3},
    {"WrongDocumentError", 4},
    {"InvalidCharacterError", 5},
    {"NoModificationAllowedError", 7},
    {"NotFoundError", 8},
    {"NotSupportedError", 9},
    {"InUseAttributeError", 10},
    {"InvalidStateError", 11},
    {"SyntaxError", 12},
    {"InvalidModificationError", 13},
    {"NamespaceError", 14},
    {"InvalidAccessError", 15},
    {"TypeMismatchError", 17},
    {"SecurityError", 18},
    {"NetworkError", 19},
    {"AbortError", 20},
    {"URLMismatchError", 21},
    {"QuotaExceededError", 22},
    {"TimeoutError", 23},
    {"InvalidNodeTypeError", 24},
    {"DataCloneError", 25},
};

static MalKey dom_exception_slot_key(MalVm *vm, MalIntrinsic slot) {
    return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = vm->intrinsics[slot]};
}

static bool dom_exception_slot(
    MalVm *vm, MalValue self, MalIntrinsic slot, MalValue *value_out) {
    if (mal_value_is_object(self)) {
        MalPropertyLookup lookup =
            mal_object_get_own(mal_value_to_object(self), dom_exception_slot_key(vm, slot));
        if (lookup.present) {
            *value_out = lookup.desc.value;
            return true;
        }
    }
    mal_vm_throw_error(
        vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "DOMException getter called on incompatible receiver");
    return false;
}

static u16 dom_exception_legacy_code(const MalString *name) {
    usize length = mal_string_length(name);
    const c16 *units = mal_string_code_units(name);
    for (usize i = 0; i < countof(dom_exception_codes); i++) {
        const char *candidate = dom_exception_codes[i].name;
        usize candidate_length = strlen(candidate);
        if (candidate_length != length) {
            continue;
        }
        bool equal = true;
        for (usize j = 0; j < length; j++) {
            if (units[j] != (u8) candidate[j]) {
                equal = false;
                break;
            }
        }
        if (equal) {
            return dom_exception_codes[i].code;
        }
    }
    return 0;
}

static MalValue dom_exception_create(
    MalVm *vm, MalObject *prototype, MalValue message, MalValue name) {
    MalObject *exception = mal_object_new(&vm->heap, prototype);
    MalValue exception_value = mal_value_from_object(exception);
    MalValue roots[] = {exception_value, message, name};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, countof(roots));
    MalPropertyDesc desc = mal_intrinsic_data_desc(roots[1], MAL_PROPERTY_NONE);
    mal_object_define_own(exception,
        dom_exception_slot_key(vm, MAL_INTRINSIC_DOM_EXCEPTION_MESSAGE_KEY), &desc);
    desc.value = roots[2];
    mal_object_define_own(
        exception, dom_exception_slot_key(vm, MAL_INTRINSIC_DOM_EXCEPTION_NAME_KEY), &desc);
    mal_gc_unroot(&rs);
    return exception_value;
}

static MalValue dom_exception_new(MalVm *vm, const char *message, const char *name) {
    MalValue values[] = {
        mal_value_from_string(mal_string_new_ascii(&vm->heap, message, strlen(message))),
        mal_value_new_undefined(),
    };
    MalRootSpan rs;
    mal_gc_root(&rs, values, countof(values));
    values[1] = mal_value_from_string(mal_string_new_ascii(&vm->heap, name, strlen(name)));
    MalValue result = dom_exception_create(vm,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_DOM_EXCEPTION_PROTOTYPE]), values[0],
        values[1]);
    mal_gc_unroot(&rs);
    return result;
}

void mal_dom_exception_throw(MalVm *vm, const byte *message, const byte *name) {
    MalValue exception = dom_exception_new(vm, message, name);
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = exception};
}

static MalValue dom_exception_constructor(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) callee;
    if (mal_value_is_undefined(nt)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Constructor DOMException requires 'new'");
        return mal_value_new_undefined();
    }

    MalString *message;
    MalValue values[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    if (argc < 1 || mal_value_is_undefined(args[0])) {
        message = mal_intrinsic_ascii(vm, (const byte *) "");
    } else if (!mal_vm_to_string(vm, args[0], &message)) {
        return mal_value_new_undefined();
    }
    values[0] = mal_value_from_string(message);
    MalRootSpan rs;
    mal_gc_root(&rs, values, countof(values));

    MalString *name;
    if (argc < 2 || mal_value_is_undefined(args[1])) {
        name = mal_intrinsic_ascii(vm, (const byte *) "Error");
    } else if (!mal_vm_to_string(vm, args[1], &name)) {
        mal_gc_unroot(&rs);
        return mal_value_new_undefined();
    }
    values[1] = mal_value_from_string(name);

    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, nt, MAL_INTRINSIC_DOM_EXCEPTION_PROTOTYPE, &prototype)) {
        mal_gc_unroot(&rs);
        return mal_value_new_undefined();
    }
    MalValue result = dom_exception_create(vm, prototype, values[0], values[1]);
    mal_gc_unroot(&rs);
    return result;
}

static MalValue dom_exception_get_name(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalValue value;
    return dom_exception_slot(vm, self, MAL_INTRINSIC_DOM_EXCEPTION_NAME_KEY, &value)
        ? value
        : mal_value_new_undefined();
}

static MalValue dom_exception_get_message(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalValue value;
    return dom_exception_slot(vm, self, MAL_INTRINSIC_DOM_EXCEPTION_MESSAGE_KEY, &value)
        ? value
        : mal_value_new_undefined();
}

static MalValue dom_exception_get_code(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalValue name;
    if (!dom_exception_slot(vm, self, MAL_INTRINSIC_DOM_EXCEPTION_NAME_KEY, &name)) {
        return mal_value_new_undefined();
    }
    return mal_value_from_i32(dom_exception_legacy_code(mal_value_to_string(name)));
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
    t->dispatch_depth = 0;
    t->dependents = nullptr;
    t->dependent_count = 0;
    t->dependent_cap = 0;
    t->abort_reason = mal_value_new_undefined();
    t->is_abort_signal = false;
    t->abort_pending = false;
    return t;
}

static void event_target_finalize(MalHeapHeader *cell) {
    MalEventTargetObject *t = (MalEventTargetObject *) cell;
    free(t->listeners);
    free(t->dependents);
    t->listeners = nullptr;
    t->dependents = nullptr;
    t->count = 0;
    t->cap = 0;
    t->dependent_count = 0;
    t->dependent_cap = 0;
}

static void event_target_trace(MalHeapHeader *cell) {
    MalEventTargetObject *t = (MalEventTargetObject *) cell;
    for (i32 i = 0; i < t->count; i++) {
        mal_gc_mark_value(mal_value_from_string(t->listeners[i].type));
        mal_gc_mark_value(t->listeners[i].callback);
    }
    mal_gc_mark_values(t->dependents, t->dependent_count);
    mal_gc_mark_value(t->abort_reason);
}

static void event_target_add(MalEventTargetObject *t, MalString *type, MalValue cb, bool once) {
    for (i32 i = 0; i < t->count; i++) {
        if (!t->listeners[i].removed && mal_string_equals(t->listeners[i].type, type)
            && t->listeners[i].callback == cb) {
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
    t->listeners[t->count].removed = false;
    t->count++;
    mal_gc_card(&t->object.header, mal_value_from_string(type));
    mal_gc_card(&t->object.header, cb);
}

static void event_target_remove_at(MalEventTargetObject *t, i32 index) {
    if (t->dispatch_depth > 0) {
        mal_gc_write_barrier(mal_value_from_string(t->listeners[index].type));
        mal_gc_write_barrier(t->listeners[index].callback);
        t->listeners[index].removed = true;
        return;
    }
    for (i32 i = 0; i < t->count; i++) {
        mal_gc_write_barrier(mal_value_from_string(t->listeners[i].type));
        mal_gc_write_barrier(t->listeners[i].callback);
    }
    for (i32 i = index + 1; i < t->count; i++) {
        t->listeners[i - 1] = t->listeners[i];
    }
    t->count--;
}

static void event_target_compact(MalEventTargetObject *t) {
    i32 write = 0;
    for (i32 i = 0; i < t->count; i++) {
        if (t->listeners[i].removed) {
            mal_gc_write_barrier(mal_value_from_string(t->listeners[i].type));
            mal_gc_write_barrier(t->listeners[i].callback);
        } else {
            t->listeners[write++] = t->listeners[i];
        }
    }
    t->count = write;
}

static void event_target_remove(MalEventTargetObject *t, const MalString *type, MalValue cb) {
    for (i32 i = 0; i < t->count; i++) {
        if (!t->listeners[i].removed && mal_string_equals(t->listeners[i].type, type)
            && t->listeners[i].callback == cb) {
            event_target_remove_at(t, i);
            return;
        }
    }
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
        if (!t->listeners[i].removed && mal_string_equals(t->listeners[i].type, etype)) {
            n++;
        }
    }
    if (n > 0) {
        MalValue *cbs = malloc(sizeof(MalValue) * (usize) n);
        i32 *indices = malloc(sizeof(i32) * (usize) n);
        i32 j = 0;
        for (i32 i = 0; i < t->count; i++) {
            if (!t->listeners[i].removed && mal_string_equals(t->listeners[i].type, etype)) {
                cbs[j] = t->listeners[i].callback;
                indices[j] = i;
                j++;
            }
        }
        MalRootSpan rs;
        mal_gc_root(&rs, cbs, n); // the snapshot survives once-removal + callbacks
        t->dispatch_depth++;
        for (j = 0; j < n; j++) {
            i32 listener_index = indices[j];
            if (t->listeners[listener_index].removed) {
                continue;
            }
            if (t->listeners[listener_index].once) {
                // Remove before invoking so a nested dispatch cannot observe it.
                event_target_remove_at(t, listener_index);
            }
            mal_vm_call_value(vm, cbs[j], target_val, &event_val, 1);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                // A listener's exception is reported, not propagated (spec).
                vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL,
                    .value = mal_value_new_undefined()};
            }
            if (ev_get_bool(vm, event_val, (const byte *) "__stopImmediate")) {
                break;
            }
        }
        t->dispatch_depth--;
        if (t->dispatch_depth == 0) {
            event_target_compact(t);
        }
        mal_gc_unroot(&rs);
        free(cbs);
        free(indices);
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
    if (event_target_this(self) == nullptr || argc < 1 ||
        !event_set_trusted(vm, args[0], false)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "dispatchEvent requires an Event");
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(mal_event_dispatch(vm, self, args[0]));
}

/* ---------------------------------------------------------------------------
 * Event (ordinary object with own properties).
 * --------------------------------------------------------------------------- */

static MalKey event_trusted_slot_key(MalVm *vm) {
    return (MalKey) {.kind = MAL_KEY_SYMBOL,
        .value = vm->intrinsics[MAL_INTRINSIC_EVENT_TRUSTED_KEY]};
}

static bool event_set_trusted(MalVm *vm, MalValue event, bool trusted) {
    if (!mal_value_is_object(event) ||
        !mal_object_get_own(
            mal_value_to_object(event), event_trusted_slot_key(vm)).present) {
        return false;
    }
    return mal_object_set(mal_value_to_object(event), event_trusted_slot_key(vm),
        mal_value_new_boolean(trusted));
}

static MalValue event_get_is_trusted(MalVm *vm, MalValue self,
    const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    if (mal_value_is_object(self)) {
        MalPropertyLookup lookup =
            mal_object_get_own(mal_value_to_object(self), event_trusted_slot_key(vm));
        if (lookup.present) {
            return lookup.desc.value;
        }
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "Event.isTrusted getter called on incompatible receiver");
    return mal_value_new_undefined();
}

static void event_define_trusted_state(MalVm *vm, MalObject *event, bool trusted) {
    MalPropertyDesc state = mal_intrinsic_data_desc(
        mal_value_new_boolean(trusted), MAL_PROPERTY_WRITABLE);
    mal_object_define_own(event, event_trusted_slot_key(vm), &state);
    MalPropertyDesc accessor = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_ENUMERABLE,
        .value = mal_value_new_undefined(),
        .getter = vm->intrinsics[MAL_INTRINSIC_EVENT_IS_TRUSTED_GETTER],
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(event,
        mal_intrinsic_string_key(vm, (const byte *) "isTrusted"), &accessor);
}

static MalValue mal_event_new(MalVm *vm, const char *type, bool trusted) {
    MalObject *ev = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_EVENT_PROTOTYPE]));
    MalValue evval = mal_value_from_object(ev);
    MalRootSpan rs;
    mal_gc_root(&rs, &evval, 1);
    ev_set(vm, ev, (const byte *) "type",
        mal_value_from_string(mal_string_new_ascii(&vm->heap, type, strlen(type))));
    ev_set(vm, ev, (const byte *) "bubbles", mal_value_new_boolean(false));
    ev_set(vm, ev, (const byte *) "cancelable", mal_value_new_boolean(false));
    ev_set(vm, ev, (const byte *) "defaultPrevented", mal_value_new_boolean(false));
    event_define_trusted_state(vm, ev, trusted);
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
    event_define_trusted_state(vm, ev, false);
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

/* A fresh, non-aborted AbortSignal. Returns a boxed value the caller should root
 * before allocating. */
static MalValue mal_abort_signal_new(MalVm *vm) {
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ABORT_SIGNAL_PROTOTYPE]);
    MalEventTargetObject *s = event_target_new(&vm->heap, proto);
    MalValue sval = mal_value_from_event_target_object(s);
    MalRootSpan rs;
    mal_gc_root(&rs, &sval, 1);
    s->is_abort_signal = true;
    ev_set(vm, &s->object, (const byte *) "onabort", mal_value_new_null());
    mal_gc_unroot(&rs);
    return sval;
}

static MalEventTargetObject *abort_signal_this(MalValue value) {
    if (!mal_value_is_event_target_object(value)) {
        return nullptr;
    }
    MalEventTargetObject *signal = mal_value_to_event_target_object(value);
    return signal->is_abort_signal ? signal : nullptr;
}

static void abort_signal_add_dependent(MalEventTargetObject *source, MalValue dependent) {
    for (i32 i = 0; i < source->dependent_count; i++) {
        if (source->dependents[i] == dependent) {
            return;
        }
    }
    if (source->dependent_count == source->dependent_cap) {
        source->dependent_cap = source->dependent_cap == 0 ? 4 : source->dependent_cap * 2;
        source->dependents =
            realloc(source->dependents, sizeof(MalValue) * (usize) source->dependent_cap);
    }
    source->dependents[source->dependent_count++] = dependent;
    mal_gc_card(&source->object.header, dependent);
}

/* Set the whole dependent tree before firing any events. Thus a source's abort
 * listeners observe every affected dependent as already aborted. */
static void abort_signal_set_tree(MalEventTargetObject *signal, MalValue reason) {
    if (!mal_value_is_undefined(signal->abort_reason)) {
        return;
    }
    signal->abort_reason = reason;
    signal->abort_pending = true;
    mal_gc_card(&signal->object.header, reason);
    for (i32 i = 0; i < signal->dependent_count; i++) {
        abort_signal_set_tree(abort_signal_this(signal->dependents[i]), reason);
    }
}

static void abort_signal_fire_tree(MalVm *vm, MalValue signal_val) {
    MalEventTargetObject *signal = abort_signal_this(signal_val);
    if (!signal->abort_pending) {
        return;
    }
    signal->abort_pending = false;

    MalValue slots[] = {signal_val, mal_value_new_undefined()};
    MalRootSpan rs;
    mal_gc_root(&rs, slots, countof(slots));
    slots[1] = mal_event_new(vm, "abort", true);
    mal_event_dispatch(vm, slots[0], slots[1]);

    MalValue onabort;
    if (mal_vm_get_property(vm, slots[0], mal_intrinsic_string_key(vm, (const byte *) "onabort"), &onabort)
        && mal_value_is_callable(onabort)) {
        mal_vm_call_value(vm, onabort, slots[0], &slots[1], 1);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            vm->completion =
                (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
        }
    }

    for (i32 i = 0; i < signal->dependent_count; i++) {
        abort_signal_fire_tree(vm, signal->dependents[i]);
    }
    for (i32 i = 0; i < signal->dependent_count; i++) {
        mal_gc_write_barrier(signal->dependents[i]);
    }
    signal->dependent_count = 0;
    mal_gc_unroot(&rs);
}

/* The "signal abort" algorithm. No-op if already aborted. `signal_val` must be
 * rooted by the caller. */
static void mal_abort_signal_run(MalVm *vm, MalValue signal_val, MalValue reason) {
    MalEventTargetObject *signal = abort_signal_this(signal_val);
    if (signal == nullptr || !mal_value_is_undefined(signal->abort_reason)) {
        return;
    }
    MalValue roots[] = {signal_val, reason};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, countof(roots));
    if (mal_value_is_undefined(roots[1])) {
        roots[1] = dom_exception_new(vm, "This operation was aborted", "AbortError");
    }
    abort_signal_set_tree(signal, roots[1]);
    abort_signal_fire_tree(vm, roots[0]);
    mal_gc_unroot(&rs);
}

static MalValue abort_signal_get_aborted(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalEventTargetObject *signal = abort_signal_this(self);
    if (signal == nullptr) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "AbortSignal getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(!mal_value_is_undefined(signal->abort_reason));
}

static MalValue abort_signal_get_reason(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalEventTargetObject *signal = abort_signal_this(self);
    if (signal == nullptr) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "AbortSignal getter called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return signal->abort_reason;
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
    MalEventTargetObject *signal = abort_signal_this(self);
    if (signal == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "AbortSignal.throwIfAborted called on incompatible receiver");
    } else if (!mal_value_is_undefined(signal->abort_reason)) {
        vm->completion =
            (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = signal->abort_reason};
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
    mal_abort_signal_run(vm, signal,
        dom_exception_new(vm, "The operation was aborted due to timeout", "TimeoutError"));
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

static MalValue abort_signal_static_any(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    MalValue iterable = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalIteratorRecord record;
    if (!mal_vm_get_iterator(vm, iterable, &record)) {
        return mal_value_new_undefined();
    }

    MalValue roots[] = {
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan record_span, roots_span;
    mal_gc_root(&record_span, &record.iterator, 2);
    mal_gc_root(&roots_span, roots, countof(roots));
    mal_gc_native_rooted_begin(vm);
    roots[0] = mal_abort_signal_new(vm);
    roots[1] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    i32 count = 0;
    bool valid = true;

    while (true) {
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &roots[2], &done)) {
            valid = false;
            break;
        }
        if (done) {
            break;
        }
        if (abort_signal_this(roots[2]) == nullptr) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "AbortSignal.any requires AbortSignal values");
            mal_vm_iterator_close(vm, &record);
            valid = false;
            break;
        }
        mal_array_object_store(mal_value_to_array_object(roots[1]),
            mal_key_index(count++), roots[2]);
    }

    if (valid) {
        for (i32 i = 0; i < count; i++) {
            mal_vm_get_property(vm, roots[1],
                mal_key_index(i), &roots[2]);
            MalEventTargetObject *source = abort_signal_this(roots[2]);
            if (!mal_value_is_undefined(source->abort_reason)) {
                mal_abort_signal_run(vm, roots[0], source->abort_reason);
                goto done;
            }
        }

        for (i32 i = 0; i < count; i++) {
            mal_vm_get_property(vm, roots[1],
                mal_key_index(i), &roots[2]);
            abort_signal_add_dependent(abort_signal_this(roots[2]), roots[0]);
        }
    }

done:
    MalValue result = valid ? roots[0] : mal_value_new_undefined();
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&roots_span);
    mal_gc_unroot(&record_span);
    return result;
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

typedef struct MalDomExceptionConstant {
    const byte *name;
    i32 value;
} MalDomExceptionConstant;

static const MalDomExceptionConstant dom_exception_constants[] = {
    {(const byte *) "INDEX_SIZE_ERR", 1},
    {(const byte *) "DOMSTRING_SIZE_ERR", 2},
    {(const byte *) "HIERARCHY_REQUEST_ERR", 3},
    {(const byte *) "WRONG_DOCUMENT_ERR", 4},
    {(const byte *) "INVALID_CHARACTER_ERR", 5},
    {(const byte *) "NO_DATA_ALLOWED_ERR", 6},
    {(const byte *) "NO_MODIFICATION_ALLOWED_ERR", 7},
    {(const byte *) "NOT_FOUND_ERR", 8},
    {(const byte *) "NOT_SUPPORTED_ERR", 9},
    {(const byte *) "INUSE_ATTRIBUTE_ERR", 10},
    {(const byte *) "INVALID_STATE_ERR", 11},
    {(const byte *) "SYNTAX_ERR", 12},
    {(const byte *) "INVALID_MODIFICATION_ERR", 13},
    {(const byte *) "NAMESPACE_ERR", 14},
    {(const byte *) "INVALID_ACCESS_ERR", 15},
    {(const byte *) "VALIDATION_ERR", 16},
    {(const byte *) "TYPE_MISMATCH_ERR", 17},
    {(const byte *) "SECURITY_ERR", 18},
    {(const byte *) "NETWORK_ERR", 19},
    {(const byte *) "ABORT_ERR", 20},
    {(const byte *) "URL_MISMATCH_ERR", 21},
    {(const byte *) "QUOTA_EXCEEDED_ERR", 22},
    {(const byte *) "TIMEOUT_ERR", 23},
    {(const byte *) "INVALID_NODE_TYPE_ERR", 24},
    {(const byte *) "DATA_CLONE_ERR", 25},
};

void mal_events_install(MalVm *vm, MalObject *global_this) {
    MalObject *obj_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);

    // DOMException uses ordinary objects; private symbols provide reflection-hidden
    // internal name/message slots and their intrinsic entries keep those keys rooted.
    vm->intrinsics[MAL_INTRINSIC_DOM_EXCEPTION_NAME_KEY] =
        mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    vm->intrinsics[MAL_INTRINSIC_DOM_EXCEPTION_MESSAGE_KEY] =
        mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    MalObject *dom_exception_proto = ev_install_class(vm, global_this,
        (const byte *) "DOMException", 0, dom_exception_constructor,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ERROR_PROTOTYPE]),
        MAL_INTRINSIC_DOM_EXCEPTION_CONSTRUCTOR, MAL_INTRINSIC_DOM_EXCEPTION_PROTOTYPE);
    ev_define_getter(vm, dom_exception_proto, (const byte *) "name", (const byte *) "get name",
        dom_exception_get_name);
    ev_define_getter(vm, dom_exception_proto, (const byte *) "message",
        (const byte *) "get message", dom_exception_get_message);
    ev_define_getter(vm, dom_exception_proto, (const byte *) "code", (const byte *) "get code",
        dom_exception_get_code);
    MalObject *dom_exception_ctor =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_DOM_EXCEPTION_CONSTRUCTOR]);
    for (usize i = 0; i < countof(dom_exception_constants); i++) {
        MalValue value = mal_value_from_i32(dom_exception_constants[i].value);
        mal_intrinsic_define_data(vm, dom_exception_ctor, dom_exception_constants[i].name, value,
            MAL_PROPERTY_ENUMERABLE);
        mal_intrinsic_define_data(vm, dom_exception_proto, dom_exception_constants[i].name, value,
            MAL_PROPERTY_ENUMERABLE);
    }
    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "DOMException")),
        MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(dom_exception_proto,
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    // Event.
    vm->intrinsics[MAL_INTRINSIC_EVENT_TRUSTED_KEY] =
        mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    vm->intrinsics[MAL_INTRINSIC_EVENT_IS_TRUSTED_GETTER] =
        mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, (const byte *) "get isTrusted"),
            event_get_is_trusted));
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
    ev_define_getter(vm, sig_proto, (const byte *) "aborted", (const byte *) "get aborted",
        abort_signal_get_aborted);
    ev_define_getter(vm, sig_proto, (const byte *) "reason", (const byte *) "get reason",
        abort_signal_get_reason);
    MalValue sig_ctor = vm->intrinsics[MAL_INTRINSIC_ABORT_SIGNAL_CONSTRUCTOR];
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(sig_ctor), (const byte *) "abort", 0, abort_signal_static_abort);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(sig_ctor), (const byte *) "timeout", 1, abort_signal_static_timeout);
    mal_intrinsic_define_method_n(
        vm, mal_value_to_object(sig_ctor), (const byte *) "any", 1, abort_signal_static_any);

    // AbortController.
    MalObject *ctrl_proto = ev_install_class(vm, global_this, (const byte *) "AbortController", 0,
        abort_controller_constructor, obj_proto, MAL_INTRINSIC_ABORT_CONTROLLER_CONSTRUCTOR,
        MAL_INTRINSIC_ABORT_CONTROLLER_PROTOTYPE);
    mal_intrinsic_define_method_n(vm, ctrl_proto, (const byte *) "abort", 0, abort_controller_abort);

    mal_gc_register_finalizer(MAL_HEAP_EVENT_TARGET_OBJECT, event_target_finalize);
    mal_gc_register_tracer(MAL_HEAP_EVENT_TARGET_OBJECT, event_target_trace);
}
