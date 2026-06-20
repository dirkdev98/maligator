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

/* Block allocator internals. Defined in heap.c; the heap
 * only holds pointers to them, so forward declarations suffice here. */
typedef struct MalGcChunk MalGcChunk;
typedef struct MalGcBlock MalGcBlock;
typedef struct MalGcLarge MalGcLarge;

/**
 * Block-based, segregated-size-class, non-moving allocator.
 *
 * Chunk (~2 MB mmap, BLOCK_SIZE-aligned) -> Block (~32 KB, one size class + one
 * kind) -> Cell. Allocation pops a reclaimed cell from the size class's free list
 * (populated by the sweep) and otherwise bump-points within the current block; a
 * fresh block is claimed when the current one fills. Large objects bypass blocks
 * into the LOS list. `mal_heap_free` releases everything at shutdown.
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
    /** Fully-empty blocks reclaimed by the sweep (pages madvised to the OS),
     * recycled by mal_gc_new_block before carving a fresh block from a chunk.
     * A blank block can serve any size class / kind after re-init. */
    MalGcBlock *free_blocks;
    /** Reclaimed managed cells per size class, rebuilt by the sweep; the
     * allocator reuses these before bumping. Empty between (and without) any
     * collection, so an uncollected run is pure bump allocation as before. */
    void *cell_free[MAL_GC_NUM_SIZE_CLASSES];
    /** Monotonic total of handed-out cell sizes (never decremented); the
     * auto-collection trigger compares it against mal_gc_next_at. */
    usize bytes_allocated;
    /** Bytes of managed cells that survived the last sweep; sizes the next
     * auto-collection trigger. Zero until the first collection. */
    usize live_bytes;
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
     * be keyed on a complete MalHeapType space.
     */

    /**
     * Closure environment (MalEnv). A first-class GC cell once the collector
     * exists; today MalEnv embeds no header (vm.h).
     */
    MAL_HEAP_ENV,
    /**
     * Hidden-class shape descriptor (MalShape): the interned key->slot layout
     * shared by objects with the same structure.
     */
    MAL_HEAP_SHAPE,
    /**
     * WeakRef instances (target held weakly, nulled when the target dies). Not
     * built yet.
     */
    MAL_HEAP_WEAK_REF_OBJECT,
    /**
     * FinalizationRegistry instances (weak targets, strong held values + cleanup
     * callback). Not built yet.
     */
    MAL_HEAP_FINALIZATION_REGISTRY_OBJECT,

    /**
     * Sentinel: number of distinct heap types. Must stay last. Sizes the baked
     * per-type GC metadata table. Not a usable type tag.
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
 * Mark state of a managed cell, tracked in its header for the stop-the-world
 * mark/sweep collector. WHITE is the default (unmarked / live-but-unreached);
 * BLACK is set when the cell is reached during marking; FREE marks a reclaimed
 * cell on its block's free list, so the sweep never finalizes it twice. (A side
 * mark bitmap replaces this header field when marking goes concurrent.)
 */
typedef enum MalHeapMark {
    MAL_MARK_WHITE = 0,
    MAL_MARK_BLACK = 1,
    MAL_MARK_FREE = 2,
} MalHeapMark;

/**
 * Common header stored at the start of every pointer-boxed heap allocation.
 */
typedef struct MalHeapHeader {
    MalHeapType type;
    MalHeapStorage storage;
    u8 mark;
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
 * owner-held buffer (a RAW cell, or LOS for large buffers).
 */
void *mal_heap_alloc_raw(MalHeap *heap, usize alloc_size);

/**
 * Free a raw buffer previously returned by mal_heap_alloc_raw. Returns an
 * in-block cell to its block's free list, or releases its LOS record. Used by
 * the GC's owner finalizers.
 */
void gc_free_raw(MalHeap *heap, void *ptr);

/** Finalizer applied to a dead cell during the sweep (frees owned buffers). */
typedef void (*MalHeapFinalizeFn)(MalHeapHeader *cell);

/**
 * Reclaim every unmarked (WHITE) managed cell: run `finalize` on it, mark it
 * FREE, and return it to its block's free list for reuse. Marked (BLACK) cells
 * are kept and reset to WHITE for the next cycle. Caller must have completed the
 * mark phase first. Large-object cells are not yet swept.
 */
void mal_heap_sweep(MalHeap *heap, MalHeapFinalizeFn finalize);

/** Call `visit` on every managed (CELL) cell, in any state. Used by the heap
 * verifier to re-examine each cell's edges after marking. */
void mal_heap_walk_cells(MalHeap *heap, MalHeapFinalizeFn visit);
