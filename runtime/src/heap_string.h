#pragma once

#include "./defaults.h"
#include "heap.h"

/**
 * Storage policy for the UTF-16 code units referenced by a MalString.
 */
typedef enum MalStringStorage : u8 {
    MAL_STRING_STORAGE_OWNED,
    MAL_STRING_STORAGE_EXTERNAL,
    MAL_STRING_STORAGE_DEPENDENT,
    MAL_STRING_STORAGE_CONS,
} MalStringStorage;

typedef struct MalString {
    MalHeapHeader header;
    MalStringStorage storage;
    bool hash_valid;
    union {
        /** Cached only for flat (owned/external) strings. */
        u64 hash;
        /** Ultimate flat parent retaining a dependent string's backing store. */
        struct MalString *parent;
        /** Left child of a lazy concatenation. */
        struct MalString *left;
    };
    usize length;
    union {
        const c16 *code_units;
        /** Right child of a lazy concatenation. */
        struct MalString *right;
    };
} MalString;

static_assert(sizeof(MalString) <= 32, "MalString outgrew its 32-byte size class");

/** Engine string lengths are measured in UTF-16 code units. */
#define MAL_STRING_MAX_CODE_UNITS ((usize) 16 * 1024 * 1024)
static_assert(MAL_STRING_MAX_CODE_UNITS <= INT32_MAX, "string length must fit regexp/i32 indices");

/** Checked size arithmetic bounded by an explicit caller-provided limit. */
bool mal_checked_size_add(usize left, usize right, usize limit, usize *out);

bool mal_checked_size_multiply(usize left, usize right, usize limit, usize *out);

bool mal_checked_size_growth(usize current, usize required, usize initial, usize limit, usize *out);

/**
 * Hash a UTF-16 code unit sequence.
 */
u64 mal_string_hash_code_units(const c16 *code_units, usize length);

/**
 * Initialize a string whose UTF-16 storage is copied into heap-owned memory.
 */
void mal_string_init_copy(MalHeap *heap, MalString *string, const c16 *code_units, usize length);

/**
 * Initialize a string that borrows externally managed UTF-16 storage.
 */
void mal_string_init_external(MalString *string, const c16 *code_units, usize length);

/**
 * Allocate and initialize a string with heap-owned UTF-16 storage.
 */
MalString *mal_string_new_copy(MalHeap *heap, const c16 *code_units, usize length);

/**
 * Allocate and initialize a string that borrows external UTF-16 storage.
 */
MalString *mal_string_new_external(MalHeap *heap, const c16 *code_units, usize length);

/**
 * Allocate a substring using dependent storage when doing so will not retain a
 * disproportionate owned backing buffer. Offset and length are UTF-16 code units;
 * the range must be in bounds. Full-range slices may return `parent`.
 */
MalString *mal_string_new_slice(MalHeap *heap, MalString *parent, usize offset, usize length);

/**
 * Allocate a lazy concatenation after checking its combined UTF-16 length.
 * Returns false without allocating when the engine string limit would be exceeded.
 */
bool mal_string_new_cons_checked(MalHeap *heap, MalString *left, MalString *right, MalString **out);

/**
 * Allocate a string that TAKES OWNERSHIP of an existing heap-raw buffer (one
 * returned by `mal_heap_alloc_raw`), freeing it on finalization — no copy. Use
 * when the caller has already built the exact code-unit buffer (e.g. string
 * concatenation), to avoid a redundant alloc+copy (and the leak of the temporary).
 */
MalString *mal_string_new_owned(MalHeap *heap, const c16 *code_units, usize length);

/**
 * Allocate and initialize a string from ASCII bytes.
 */
MalString *mal_string_new_ascii(MalHeap *heap, const byte *bytes, usize length);

/**
 * Return contiguous UTF-16 code units, flattening a lazy concatenation once on
 * first access.
 */
const c16 *mal_string_code_units(const MalString *string);

/**
 * Return the string UTF-16 code unit length.
 */
usize mal_string_length(const MalString *string);

/**
 * Return the string hash, caching it on flat strings and recomputing it for
 * dependent strings whose storage-specific word retains their parent. Lazy
 * concatenations are flattened before hashing.
 */
u64 mal_string_hash(const MalString *string);

/**
 * Return the storage policy used by the string.
 */
MalStringStorage mal_string_storage(const MalString *string);

/**
 * Compare two strings by UTF-16 code units.
 */
bool mal_string_equals(const MalString *left, const MalString *right);

/**
 * Lexicographically compare two strings by UTF-16 code units.
 */
i32 mal_string_compare(const MalString *left, const MalString *right);
