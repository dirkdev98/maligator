#pragma once

#include "heap.h"
#include "heap_string.h"
#include "object.h"

typedef struct MalVm MalVm;

/*
 * WinterTC fetch Headers (runtime layer): an ordered, case-insensitive list of
 * (name, value) string pairs. Stored in an owned C array, so it needs a registered
 * GC tracer (mark the name/value strings) + finalizer (free the array). Multi-value
 * headers are comma-joined on get for v1 (Set-Cookie special-casing is a follow-up).
 */
typedef struct MalHeaderEntry {
    MalString *name; // original case preserved
    MalString *value;
} MalHeaderEntry;

typedef struct MalHeadersObject {
    MalObject object;
    MalHeaderEntry *entries; // owned
    i32 count;
    i32 cap;
} MalHeadersObject;

MalHeadersObject *mal_headers_object_new(MalHeap *heap, MalObject *prototype);

/* Low-level append (grows the array; keeps insertion order). name/value are kept
 * by the Headers and traced. */
void mal_headers_append_entry(MalHeadersObject *headers, MalString *name, MalString *value);

/* Create an empty Headers using the intrinsic prototype. */
MalHeadersObject *mal_headers_create(MalVm *vm);

/* Create a Headers filled from an init (another Headers, or a plain object with
 * string values). Used by the Response constructor for its `headers` init option. */
MalHeadersObject *mal_headers_from_init(MalVm *vm, MalValue init);

/* Append from raw bytes (for building request.headers from the parsed request). */
void mal_headers_append_bytes(
    MalVm *vm, MalHeadersObject *headers, const char *name, usize name_len, const char *value,
    usize value_len);

/* Install Headers (constructor + prototype) on globalThis + register GC hooks. */
void mal_headers_install(MalVm *vm, MalObject *global_this);
