#pragma once

#include "./defaults.h"
#include "heap.h"
#include "table.h"

typedef struct MalObject {
    MalHeapHeader header;
    MalTable *properties;
    struct MalObject *prototype;
    bool extensible;
} MalObject;

/**
 * Initialize object state in caller-provided storage.
 */
void mal_object_init(MalHeap *heap, MalObject *object, MalHeapType type, MalObject *prototype);

/**
 * Allocate and initialize a new ordinary object.
 */
MalObject *mal_object_new(MalHeap *heap, MalObject *prototype);
