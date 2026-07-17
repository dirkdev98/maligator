#pragma once

#include "heap.h"
#include "heap_string.h"
#include "object.h"

typedef struct MalVm MalVm;

/*
 * WinterTC fetch Headers (runtime layer): an ordered list of normalized (lowercase
 * name, trimmed value) string pairs. Duplicate tuples stay separate so Set-Cookie
 * can be exposed losslessly; JS iteration computes Fetch's sorted/combined view.
 * The owned C array needs a registered GC tracer and finalizer.
 */
typedef struct MalHeaderEntry {
    MalString *name; // validated lowercase HTTP token
    MalString *value;
} MalHeaderEntry;

typedef struct MalHeadersObject {
    MalObject object;
    MalHeaderEntry *entries; // owned
    i32 count;
    i32 cap;
} MalHeadersObject;

MalHeadersObject *mal_headers_object_new(MalHeap *heap, MalObject *prototype);

/* Low-level append for already-normalized entries. name/value are traced. */
void mal_headers_append_entry(MalHeadersObject *headers, MalString *name, MalString *value);

/* Create an empty Headers using the intrinsic prototype. */
MalHeadersObject *mal_headers_create(MalVm *vm);

/* Create a Headers filled from an init (another Headers or an enumerable record).
 * Record keys and values use Web IDL-ish string coercion. */
MalHeadersObject *mal_headers_from_init(MalVm *vm, MalValue init);

/* Append normalized copies of raw host bytes to a JS Headers view. */
void mal_headers_append_bytes(
    MalVm *vm, MalHeadersObject *headers, const char *name, usize name_len, const char *value,
    usize value_len);

/* Install Headers (constructor + prototype) on globalThis + register GC hooks. */
void mal_headers_install(MalVm *vm, MalObject *global_this);
