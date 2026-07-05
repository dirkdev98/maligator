#pragma once

#include "heap.h"
#include "heap_string.h"
#include "object.h"
#include "value.h"

/*
 * WHATWG URL + URLSearchParams heap objects (runtime layer, task #17).
 *
 * MalUrlObject wraps an opaque ada-url handle (parsed URL); a GC finalizer frees
 * it via mal_url_free. MalUrlSearchParamsObject owns a growable array of
 * name/value MalString pairs (form-urlencoded model); its tracer marks the strings
 * and its finalizer frees the array (the strings are GC-owned).
 */

typedef struct MalUrlObject {
    MalObject object;
    void *handle; // ada_url::Url, from mal_url_parse; freed by mal_url_free
} MalUrlObject;

typedef struct MalUspPair {
    MalString *name;
    MalString *value;
} MalUspPair;

typedef struct MalUrlSearchParamsObject {
    MalObject object;
    MalUspPair *pairs;
    i32 count;
    i32 cap;
} MalUrlSearchParamsObject;

typedef struct MalVm MalVm;

/* Install URL + URLSearchParams on globalThis (host entry only). */
void mal_url_install(MalVm *vm, MalObject *global_this);
