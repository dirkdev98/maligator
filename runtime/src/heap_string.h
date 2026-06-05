#pragma once

#include "./defaults.h"
#include "heap.h"

/**
 * Storage policy for the UTF-16 code units referenced by a MalString.
 */
typedef enum MalStringStorage {
    MAL_STRING_STORAGE_OWNED,
    MAL_STRING_STORAGE_EXTERNAL,
} MalStringStorage;

typedef struct MalString {
    MalHeapHeader header;
    MalStringStorage storage;
    u64 hash;
    usize length;
    const c16 *code_units;
} MalString;

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
 * Allocate and initialize a string from ASCII bytes.
 */
MalString *mal_string_new_ascii(MalHeap *heap, const byte *bytes, usize length);

/**
 * Return the raw UTF-16 code units referenced by the string.
 */
const c16 *mal_string_code_units(const MalString *string);

/**
 * Return the string UTF-16 code unit length.
 */
usize mal_string_length(const MalString *string);

/**
 * Return the cached string hash.
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
