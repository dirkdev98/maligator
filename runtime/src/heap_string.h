#pragma once

#include "./defaults.h"
#include "heap.h"

/**
 * Storage policy for the bytes referenced by a MalString.
 */
typedef enum MalStringStorage {
    MAL_STRING_STORAGE_OWNED,
    MAL_STRING_STORAGE_EXTERNAL,
} MalStringStorage;

typedef struct MalString {
    MalHeapHeader header;
    MalStringStorage storage;
    usize length;
    const byte *bytes;
} MalString;

/**
 * Initialize a string whose byte storage is copied into heap-owned memory.
 */
void mal_string_init_copy(MalHeap *heap, MalString *string, const byte *bytes, usize length);

/**
 * Initialize a string that borrows externally managed bytes.
 */
void mal_string_init_external(MalString *string, const byte *bytes, usize length);

/**
 * Allocate and initialize a string with heap-owned byte storage.
 */
MalString *mal_string_new_copy(MalHeap *heap, const byte *bytes, usize length);

/**
 * Allocate and initialize a string that borrows external byte storage.
 */
MalString *mal_string_new_external(MalHeap *heap, const byte *bytes, usize length);

/**
 * Return the raw bytes referenced by the string.
 */
const byte *mal_string_bytes(const MalString *string);

/**
 * Return the string byte length.
 */
usize mal_string_length(const MalString *string);

/**
 * Return the storage policy used by the string.
 */
MalStringStorage mal_string_storage(const MalString *string);
