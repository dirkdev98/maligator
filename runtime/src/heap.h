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

    /**
     * Root pool only: the last pool in the chain, i.e. the one with free space.
     * Allocation goes straight here (O(1)) instead of re-walking the chain from
     * the head on every call. Sub-pools leave this pointing at themselves.
     */
    MalHeap *tail;
} MalHeap;

/**
 * Runtime heap allocation kinds that may be boxed into a MalValue.
 */
typedef enum MalHeapType {
    /**
     * Primitive wrapper exotic objects (new String/Number/Boolean(...),
     * Object(primitive)) holding a [[PrimitiveData]] slot. See
     * primitive_wrapper_object.h.
     */
    MAL_HEAP_PRIMITIVE_WRAPPER_OBJECT,
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
    /**
     * Promise instances (MalPromiseObject): state, settled result, and the
     * pending fulfill/reject reaction lists.
     */
    MAL_HEAP_PROMISE_OBJECT,
    /**
     * Iterator Helper instances (map/filter/take/drop/flatMap results +
     * Iterator.from wrappers): MalIteratorHelperObject, carrying the lazy
     * transform state so next/return live on %IteratorHelperPrototype%.
     */
    MAL_HEAP_ITERATOR_HELPER_OBJECT,
    /**
     * ES Module Namespace exotic objects (`import * as ns`): null prototype,
     * non-extensible, with live string-keyed exports (read from global slots)
     * plus a @@toStringTag of "Module". See module_namespace_object.h.
     */
    MAL_HEAP_MODULE_NAMESPACE_OBJECT,
    /**
     * Proxy exotic objects (MalProxyObject): a [[ProxyTarget]] + [[ProxyHandler]]
     * pair whose meta-object-protocol operations are routed through handler traps.
     * Revoking sets both to null. See proxy_object.h.
     */
    MAL_HEAP_PROXY_OBJECT,
    /**
     * Date instances (MalDateObject): an ordinary object plus the [[DateValue]]
     * internal slot (a time value in ms since the epoch, or NaN). See
     * date_object.h.
     */
    MAL_HEAP_DATE_OBJECT,
    /**
     * Intl service instances (MalIntlObject): Intl.Locale and the formatter
     * objects, holding an (optional) Rust-owned ICU4X handle + per-kind data.
     * See intl_object.h.
     */
    MAL_HEAP_INTL_OBJECT,
} MalHeapType;

/**
 * Storage class of a pointer-boxed value.
 *
 * DYNAMIC objects come from the heap allocator and will be owned by the GC once
 * it exists. IMMORTAL objects live in static storage (compile-time constants
 * baked into the program image): they are never freed, and a future GC neither
 * collects them nor traces through them as owned. The boundary is defined here
 * so the eventual GC is correct-by-construction for constants.
 */
typedef enum MalHeapStorage {
    MAL_HEAP_STORAGE_DYNAMIC,
    MAL_HEAP_STORAGE_IMMORTAL,
} MalHeapStorage;

/**
 * Common header stored at the start of every pointer-boxed heap allocation.
 */
typedef struct MalHeapHeader {
    MalHeapType type;
    MalHeapStorage storage;
} MalHeapHeader;

/**
 * Static initializer for the header of an immortal (statically allocated)
 * value. Used by the emitted program image for baked string/bigint constants.
 */
#define MAL_HEAP_HEADER_IMMORTAL(heap_type) \
    { .type = (heap_type), .storage = MAL_HEAP_STORAGE_IMMORTAL }

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
