#pragma once

#include "heap.h"
#include "heap_string.h"
#include "object.h"
#include "value.h"

/*
 * DOM EventTarget + AbortSignal (runtime layer). One heap type backs both:
 * EventTarget instances and AbortSignal instances (AbortSignal.prototype inherits
 * EventTarget.prototype). The native (type, callback, once) listener list lives in
 * the struct, together with AbortSignal's native aborted/reason state. A GC tracer
 * marks the listener types, callbacks, and abort reason; a finalizer frees the
 * array.
 *
 * Event and AbortController are plain ordinary objects (no native state), so they
 * need no heap type here.
 */

typedef struct MalEventListener {
    MalString *type;
    MalValue callback;
    bool once;
    bool removed;
} MalEventListener;

typedef struct MalEventTargetObject {
    MalObject object;
    MalEventListener *listeners;
    i32 count;
    i32 cap;
    i32 dispatch_depth;
    MalValue *dependents;
    i32 dependent_count;
    i32 dependent_cap;
    MalValue abort_reason;
    bool is_abort_signal;
    bool abort_pending;
} MalEventTargetObject;

typedef struct MalVm MalVm;

/* Allocate a branded EventTarget with the supplied prototype. Runtime-owned web
 * objects such as performance use this to inherit the shared listener methods. */
MalEventTargetObject *mal_event_target_object_new(MalHeap *heap, MalObject *prototype);

/* Throw a DOMException backed by the installed intrinsic prototype and hidden
 * name/message slots. The helper roots all intermediate values across GC. */
void mal_dom_exception_throw(MalVm *vm, const byte *message, const byte *name);

/* Install DOMException / Event / EventTarget / AbortController / AbortSignal on
 * globalThis (host entry only). */
void mal_events_install(MalVm *vm, MalObject *global_this);
