#pragma once

#include "./defaults.h"

#define MAL_DEFAULT_HEAP_SIZE 16 * 1024

#define MAL_HEAP_ALIGN_SIZE(size, type) \
    (((size) + alignof(type) - 1) & ~(alignof(type) - 1))

#define MAL_HEAP_ALIGN(type) \
    MAL_HEAP_ALIGN_SIZE(sizeof(type), type)

typedef struct MalHeap MalHeap;

/**
 * Number of segregated size classes for in-block (CELL/RAW) allocation. Must
 * match the `g_class_cell_size` table in heap.c (a static_assert enforces it).
 * Objects larger than the largest class go to the large-object space (LOS).
 */
#define MAL_GC_NUM_SIZE_CLASSES 32

/* Block allocator internals (gc_todo.md Step 7). Defined in heap.c; the heap
 * only holds pointers to them, so forward declarations suffice here. */
typedef struct MalGcChunk MalGcChunk;
typedef struct MalGcBlock MalGcBlock;
typedef struct MalGcLarge MalGcLarge;

/**
 * Block-based, segregated-size-class, non-moving allocator (gc_todo.md Step 7).
 *
 * Chunk (~2 MB mmap, BLOCK_SIZE-aligned) -> Block (~32 KB, one size class + one
 * kind) -> Cell. Allocation bump-points within the current block per size class;
 * a fresh block is claimed when the current one fills. Large objects bypass
 * blocks into the LOS list. Nothing is reclaimed yet — the mark/sweep collector
 * (Phase 3) returns cells to per-block free lists and empty blocks to the OS;
 * for now `mal_heap_free` releases everything at shutdown, as before.
 */
typedef struct MalHeap {
    /** All chunks, newest first (allocation source + shutdown release). */
    MalGcChunk *chunks;
    /** Large-object records (size > largest size class), singly linked. */
    MalGcLarge *large;
    /** Current bump block per size class for managed cells. */
    MalGcBlock *cell_blocks[MAL_GC_NUM_SIZE_CLASSES];
    /** Current bump block per size class for owner-held raw buffers. */
    MalGcBlock *raw_blocks[MAL_GC_NUM_SIZE_CLASSES];
    /** Rough live-bytes accounting (handed-out cell sizes). */
    usize bytes_allocated;
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
    /**
     * RegExp instances (MalRegExpObject): an ordinary object plus the compiled
     * regress matcher handle + [[OriginalSource]]/[[OriginalFlags]]. See
     * regexp_object.h.
     */
    MAL_HEAP_REGEXP_OBJECT,
    /**
     * RegExp String Iterator instances (MalRegExpStringIteratorObject): the
     * iterator returned by RegExp.prototype[@@matchAll] / String.prototype.matchAll.
     */
    MAL_HEAP_REGEXP_STRING_ITERATOR_OBJECT,

    /*
     * GC reservations (Phase 0). No structs/handling yet; the discriminators
     * exist so the future per-type metadata table (trace/finalize dispatch) can
     * be keyed on a complete MalHeapType space. See gc_todo.md Step 11.1.
     */

    /**
     * Closure environment (MalEnv). A first-class GC cell once the collector
     * exists; today MalEnv embeds no header (vm.h). See gc_todo.md B4 / Step 11.2.
     */
    MAL_HEAP_ENV,
    /**
     * Hidden-class shape descriptor (MalShape): the interned key->slot layout
     * shared by objects with the same structure. See gc_todo.md Step 8 B3.
     */
    MAL_HEAP_SHAPE,
    /**
     * WeakRef instances (target held weakly, nulled when the target dies). Not
     * built yet. See gc_todo.md D3.
     */
    MAL_HEAP_WEAK_REF_OBJECT,
    /**
     * FinalizationRegistry instances (weak targets, strong held values + cleanup
     * callback). Not built yet. See gc_todo.md D3.
     */
    MAL_HEAP_FINALIZATION_REGISTRY_OBJECT,

    /**
     * Sentinel: number of distinct heap types. Must stay last. Sizes the baked
     * per-type GC metadata table (gc_todo.md Step 8). Not a usable type tag.
     */
    MAL_HEAP_TYPE_COUNT,
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
 * Allocate raw heap storage without initializing a heap header. Returns an
 * owner-held buffer (a RAW cell, or LOS for large buffers); see gc_todo.md A4.
 */
void *mal_heap_alloc_raw(MalHeap *heap, usize alloc_size);

/**
 * Free a raw buffer previously returned by mal_heap_alloc_raw. Returns an
 * in-block cell to its block's free list, or releases its LOS record. Used by
 * the GC's owner finalizers (Phase 3, gc_todo.md D1); no callers in Phase 1.
 */
void gc_free_raw(MalHeap *heap, void *ptr);
