#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalArrayObject {
    MalObject object;
    u32 length;
} MalArrayObject;

/**
 * Initialize array object state in caller-provided storage.
 */
void mal_array_object_init(MalHeap *heap, MalArrayObject *array, MalObject *prototype);

/**
 * Allocate and initialize a new array object.
 */
MalArrayObject *mal_array_object_new(MalHeap *heap, MalObject *prototype);

/**
 * Return the raw array length field.
 */
u32 mal_array_object_length(const MalArrayObject *array);

/**
 * Update the raw array length field.
 */
void mal_array_object_set_length(MalArrayObject *array, u32 length);

/**
 * Check if the key is the "length" string key.
 */
bool mal_array_key_is_length(MalKey key);

/**
 * Store with JS array semantics: index stores grow the length field, "length"
 * stores update the length field instead of defining a property.
 */
void mal_array_object_store(MalArrayObject *array, MalKey key, MalValue value);
