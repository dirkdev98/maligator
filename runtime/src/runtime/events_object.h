#pragma once

#include "heap.h"
#include "heap_string.h"
#include "object.h"
#include "value.h"

/*
 * DOM EventTarget + AbortSignal (runtime layer). One heap type backs both:
 * EventTarget instances and AbortSignal instances (AbortSignal.prototype inherits
 * EventTarget.prototype). The native (type, callback, once) listener list lives in
 * the struct; AbortSignal's aborted/reason ride as own properties on the instance.
 * A GC tracer marks the listener types + callbacks; a finalizer frees the array.
 *
 * Event and AbortController are plain ordinary objects (no native state), so they
 * need no heap type here.
 */

typedef struct MalEventListener {
    MalString *type;
    MalValue callback;
    bool once;
} MalEventListener;

typedef struct MalEventTargetObject {
    MalObject object;
    MalEventListener *listeners;
    i32 count;
    i32 cap;
} MalEventTargetObject;

typedef struct MalVm MalVm;

/* Install Event / EventTarget / AbortController / AbortSignal on globalThis
 * (host entry only). */
void mal_events_install(MalVm *vm, MalObject *global_this);
