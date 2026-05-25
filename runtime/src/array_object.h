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
