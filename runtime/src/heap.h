#pragma once

#include "./defaults.h"

#define MAL_DEFAULT_HEAP_SIZE 16 * 1024

typedef struct MalHeap MalHeap;

/**
 * A linked list of memory pools to use.
 *
 * At some point we have to implement a GC. Just not today.
 */
typedef struct MalHeap {
    void *ptr;
    void *next_ptr;

    /**
     * Total heap capacity in bytes
     */
    usize capacity;

    MalHeap *next_heap;
} MalHeap;

/**
 * Runtime heap allocation kinds that may be boxed into a MalValue.
 */
typedef enum MalHeapType {
    MAL_HEAP_STRING,
    MAL_HEAP_SYMBOL,
    MAL_HEAP_OBJECT,
    MAL_HEAP_FUNCTION_OBJECT,
    MAL_HEAP_NATIVE_FUNCTION_OBJECT,
    MAL_HEAP_ARRAY_OBJECT,
} MalHeapType;

/**
 * Common header stored at the start of every pointer-boxed heap allocation.
 */
typedef struct MalHeapHeader {
    MalHeapType type;
} MalHeapHeader;

/**
 * Create a new heap runtime instance.
 *
 * If capacity is 0, a default capacity is used.
 */
void mal_heap_init(MalHeap *heap, usize capacity);

/**
 * Destroy a heap runtime instance.
 */
void mal_heap_free(MalHeap *heap);

/**
 * Linkup a new heap with the given capacity. Pass in 0 to use the default capacity.
 */
void mal_heap_grow(MalHeap *heap, usize new_capacity);
