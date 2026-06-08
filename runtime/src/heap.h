#pragma once

#include "./defaults.h"

#define MAL_DEFAULT_HEAP_SIZE 16 * 1024

#define MAL_HEAP_ALIGN_SIZE(size, type) \
    (((size) + alignof(type) - 1) & ~(alignof(type) - 1))

#define MAL_HEAP_ALIGN(type) \
    MAL_HEAP_ALIGN_SIZE(sizeof(type), type)

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
    /**
     * BigInt primitive (MalBigInt). Currently 128-bit backed, not arbitrary
     * precision. TODO(bigint): real arbitrary-precision digits.
     */
    MAL_HEAP_BIGINT,
    MAL_HEAP_OBJECT,
    MAL_HEAP_FUNCTION_OBJECT,
    MAL_HEAP_NATIVE_FUNCTION_OBJECT,
    MAL_HEAP_BOUND_FUNCTION_OBJECT,
    MAL_HEAP_ARRAY_OBJECT,
    /**
     * Map and WeakMap instances (MalMapObject; the weak flag distinguishes).
     */
    MAL_HEAP_MAP_OBJECT,
    /**
     * Set and WeakSet instances (MalMapObject with ignored entry values).
     */
    MAL_HEAP_SET_OBJECT,
    /**
     * Built-in iterator instances (MalIteratorObject) for the Map/Set/Array/
     * String iteration methods.
     */
    MAL_HEAP_ITERATOR_OBJECT,
    /**
     * Generator instances (MalGeneratorObject) holding a suspended frame.
     */
    MAL_HEAP_GENERATOR_OBJECT,
    /**
     * ArrayBuffer / SharedArrayBuffer backing store (MalArrayBufferObject).
     */
    MAL_HEAP_ARRAY_BUFFER_OBJECT,
    /**
     * TypedArray views (MalTypedArrayObject; the kind field discriminates).
     */
    MAL_HEAP_TYPED_ARRAY_OBJECT,
    /**
     * DataView instances (MalDataViewObject).
     */
    MAL_HEAP_DATA_VIEW_OBJECT,
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
 * Initialize a heap header in place.
 */
void mal_heap_header_init(MalHeapHeader *header, MalHeapType type);

/**
 * Read the type tag from a heap allocation header.
 */
MalHeapType mal_heap_header_type(const MalHeapHeader *header);

/**
 * Allocate a new heap object.
 */
void *mal_heap_alloc(MalHeap *heap, usize alloc_size, MalHeapType type);

/**
 * Allocate raw heap storage without initializing a heap header.
 */
void *mal_heap_alloc_raw(MalHeap *heap, usize alloc_size);
