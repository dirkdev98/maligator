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

typedef enum MalHeadersGuard {
    MAL_HEADERS_GUARD_NONE,
    MAL_HEADERS_GUARD_IMMUTABLE,
} MalHeadersGuard;

typedef struct MalHeadersObject {
    MalObject object;
    MalHeaderEntry *entries; // owned
    i32 count;
    i32 cap;
    MalHeadersGuard guard;
} MalHeadersObject;

typedef enum MalHeadersIteratorKind : u8 {
    MAL_HEADERS_ITERATOR_ENTRIES,
    MAL_HEADERS_ITERATOR_KEYS,
    MAL_HEADERS_ITERATOR_VALUES,
} MalHeadersIteratorKind;

typedef struct MalHeadersIteratorObject {
    MalObject object;
    MalHeadersObject *headers;
    i32 index;
    MalHeadersIteratorKind kind;
} MalHeadersIteratorObject;

static_assert(sizeof(MalHeadersObject) <= 64,
    "MalHeadersObject outgrew its 64-byte size class");

MalHeadersObject *mal_headers_object_new(MalHeap *heap, MalObject *prototype);

/* Low-level append for already-normalized entries. name/value are traced. */
/* Returns false when the entry list could not grow; the list is left unchanged. */
bool mal_headers_append_entry(MalHeadersObject *headers, MalString *name, MalString *value);

/* Create an empty Headers using the intrinsic prototype. */
MalHeadersObject *mal_headers_create(MalVm *vm);

/* Create an intrinsic-prototype Headers filled from a Web IDL HeadersInit. */
MalHeadersObject *mal_headers_from_init(MalVm *vm, MalValue init);

/* Create one owned lowercase string from an already-validated ASCII header name. */
MalString *mal_headers_new_lowercase_name(
    MalVm *vm, const char *name, usize name_len);

/* Append normalized copies of raw host bytes to a JS Headers view. */
void mal_headers_append_bytes(
    MalVm *vm, MalHeadersObject *headers, const char *name, usize name_len, const char *value,
    usize value_len);

/* Install Headers (constructor + prototype) on globalThis + register GC hooks. */
void mal_headers_install(MalVm *vm, MalObject *global_this);
