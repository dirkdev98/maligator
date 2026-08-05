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
typedef struct MalShape MalShape;

#if MAL_REALMS
/* Realm metadata is defined in vm.h; the heap caches only a back-pointer to the
 * current realm so function-object init can stamp the active realm without
 * threading the VM through every allocation choke point. */
typedef struct MalRealm MalRealm;
#endif

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
    /** Per-size-class list of RAW blocks that hold at least one reclaimable cell
     * (a doubly-linked intrusive list threaded through MalGcBlock.next_free /
     * prev_free). Unlike cell_free this is NOT rebuilt by the sweep — RAW buffers
     * have no per-cell mark; they are freed EXPLICITLY by owner finalizers
     * (gc_free_raw) onto their OWN block's free list, never a global cell list.
     * Keeping freed cells per-block (rather than on one global chain) is what lets
     * a block whose every cell has been freed be handed back to the OS (madvised +
     * recycled) like an empty CELL block, instead of pinning its pages forever. The
     * allocator pops a cell from a partial block before bumping a fresh one, which
     * bounds RAW footprint. */
    MalGcBlock *raw_partial[MAL_GC_NUM_SIZE_CLASSES];
    /** Monotonic total of handed-out cell sizes (never decremented); the
     * auto-collection trigger compares it against mal_gc_next_at. */
    usize bytes_allocated;
    /** Bytes of managed cells that survived the last sweep; sizes the next
     * auto-collection trigger. Zero until the first collection. */
    usize live_bytes;
    /** Heap-lifetime root of this isolate's hidden-class transition tree. */
    MalShape *shape_root;
    /** Process-unique heap lifetime identity. Static native call caches use this
     * with epoch so exact object identities never cross VM lifetimes. */
    u64 identity;
    /** Bumped at the start of every sweep. A cell address can only be freed and
     * reused across a sweep, so callers that cache a raw cell pointer by identity
     * (the native backend's call-site cache) tag it with the epoch and treat a
     * changed epoch as an invalidation — closing the ABA hole without rooting. */
    u32 epoch;
    /** Test-only one-shot failure consumed by mal_heap_try_alloc. */
    bool fail_next_cell_allocation;
#if MAL_GC_CONCURRENT
    /** Incremental-sweep cursor (concurrent build): the chunk + in-chunk block
     * index the lazy per-safepoint sweep has reached, and the survivor-byte total
     * accumulated so far this sweep. Set by mal_heap_sweep_begin; advanced by
     * mal_heap_sweep_step until the cursor is exhausted (the cycle is done). Only
     * the chunks that existed at begin are walked — chunks prepended during the
     * sweep hold only black-allocated (mid-cycle) cells, which are never garbage
     * this cycle, so skipping them is correct. */
    MalGcChunk *sweep_chunk;
    usize sweep_block;
    usize sweep_live_bytes;
    bool sweeping;
#endif
#if MAL_REALMS
    /** Cached back-pointer to the VM's current realm, kept in lockstep with
     * vm->current_realm by mal_realm_switch. Lets function-object init stamp a new
     * closure's owning realm from the heap alone (the init choke points already hold
     * a MalHeap*, not a MalVm*). Not owned here — realms are freed by
     * mal_realm_free_all. */
    MalRealm *current_realm;
#endif
} MalHeap;

/**
 * Runtime heap allocation kinds that may be boxed into a MalValue.
 */
typedef enum MalHeapType : u8 {
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
     * precision. BigInt still needs real arbitrary-precision digits.
     */
    MAL_HEAP_BIGINT,
    MAL_HEAP_OBJECT,
    /** Arguments exotic object with a mutable formal-parameter map. */
    MAL_HEAP_ARGUMENTS_OBJECT,
#if MAL_REALMS
    /**
     * ShadowRealm instances (MalShadowRealmObject): an ordinary object holding a
     * raw pointer to its VM-owned shadow realm. See shadow_realm_object.h.
     */
    MAL_HEAP_SHADOW_REALM_OBJECT,
#endif
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
     * WinterTC fetch Response (MalResponseObject): status + an owned UTF-8 body
     * byte buffer. Freed by the GC finalizer. See runtime/web_response_object.h.
     */
    MAL_HEAP_RESPONSE_OBJECT,
    /**
     * WinterTC fetch Request (MalRequestObject): method/url own-properties + an
     * (optional) owned body byte buffer. See runtime/web_request_object.h.
     */
    MAL_HEAP_REQUEST_OBJECT,
    /**
     * WinterTC fetch Headers (MalHeadersObject): an ordered, case-insensitive list
     * of (name, value) string pairs. Traced + finalized via registered hooks. See
     * runtime/web_headers_object.h.
     */
    MAL_HEAP_HEADERS_OBJECT,
    /** Iterator over a live Headers list. See runtime/web_headers_object.h. */
    MAL_HEAP_HEADERS_ITERATOR_OBJECT,
    /**
     * WHATWG URL (MalUrlObject): wraps an opaque ada-url handle, freed by the GC
     * finalizer via mal_url_free. See runtime/web_url_object.h.
     */
    MAL_HEAP_URL_OBJECT,
    /**
     * WHATWG URLSearchParams (MalUrlSearchParamsObject): an ordered list of
     * (name, value) string pairs. Traced + finalized via registered hooks. See
     * runtime/web_url_object.h.
     */
    MAL_HEAP_URL_SEARCH_PARAMS_OBJECT,
    /**
     * Iterator over a live URLSearchParams list. The iterator strongly retains
     * its params object, which in turn retains an associated URL when present.
     */
    MAL_HEAP_URL_SEARCH_PARAMS_ITERATOR_OBJECT,
    /**
     * DOM EventTarget / AbortSignal instances (MalEventTargetObject): an ordinary
     * object plus a native (type, callback, once) listener list. Traced + finalized
     * via registered hooks. AbortSignal state (aborted/reason) rides as own
     * properties. See runtime/web_events_object.h.
     */
    MAL_HEAP_EVENT_TARGET_OBJECT,
    /**
     * WHATWG default readable-stream objects. A private kind tag distinguishes
     * ReadableStream, ReadableStreamDefaultController, and
     * ReadableStreamDefaultReader instances. See runtime/web_readable_stream_object.h.
     */
    MAL_HEAP_READABLE_STREAM_OBJECT,
    /**
     * node:zlib decompressor state: an ordinary object wrapping one opaque Rust
     * codec handle. See runtime/node_zlib_object.h.
     */
    MAL_HEAP_NODE_ZLIB_OBJECT,
    /** node:sqlite DatabaseSync instances. See runtime/node_sqlite_object.h. */
    MAL_HEAP_NODE_SQLITE_DATABASE_OBJECT,
    /** node:sqlite StatementSync instances. See runtime/node_sqlite_object.h. */
    MAL_HEAP_NODE_SQLITE_STATEMENT_OBJECT,
    /**
     * Internal immutable AsyncLocalStorage context frame. This is not exposed to
     * JavaScript; it is boxed only while carried by native closure slots.
     */
    MAL_HEAP_ASYNC_CONTEXT,
    /** Internal mutable state for one AsyncLocalStorage instance. */
    MAL_HEAP_ASYNC_LOCAL_STORAGE_STATE,
    /** Internal captured execution context for one AsyncResource instance. */
    MAL_HEAP_ASYNC_RESOURCE_STATE,

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
typedef enum MalHeapStorage : u8 {
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
 *
 * `type` and `storage` are u8-backed enums and `mark` a u8, so the header is
 * 3 bytes (align 1) and any embedder's first pointer follows in the same 8-byte
 * word rather than after a 4-byte-enum-padded 12-byte header.
 *
 * Under MAL_GC_GENERATIONAL the `dirty` byte records remembered-set membership:
 * the generational write barrier sets it (and links the cell on the remembered
 * set) when an old (survived-a-collection, sticky-BLACK) cell is written with a
 * young pointer, so the minor collector traces that cell without re-marking the
 * whole old generation. The 4th byte it occupies falls in the padding every
 * embedder already carries after the header (MalObject packs its flags into one
 * byte, leaving the rest of the word slack), so `dirty` grows neither the header
 * nor the cell and never shifts the free-list link.
 */
typedef struct MalHeapHeader {
    MalHeapType type;
    MalHeapStorage storage;
    u8 mark;
#if MAL_GC_GENERATIONAL
    u8 dirty;
#endif
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

/** Fallible managed-cell allocation. Existing infallible callers retain abort-on-OOM. */
void *mal_heap_try_alloc(MalHeap *heap, usize alloc_size, MalHeapType type);

/**
 * Allocate raw heap storage without initializing a heap header. Returns an
 * owner-held buffer (a RAW cell, or LOS for large buffers).
 */
void *mal_heap_alloc_raw(MalHeap *heap, usize alloc_size);

/**
 * Free a raw buffer previously returned by mal_heap_alloc_raw. Returns an
 * in-block cell to its block's free list, or releases its LOS record. Used by
 * the GC's owner finalizers. A RAW block whose every cell has been freed is
 * returned to the OS (madvised) and recycled for any size class / kind.
 */
void gc_free_raw(MalHeap *heap, void *ptr);

/**
 * Grow (or shrink) a raw buffer previously returned by mal_heap_alloc_raw,
 * preserving its contents. RAW cells have no realloc, so a grow that outgrows the
 * current cell's size class is alloc-new / copy / free-old; a request that still
 * fits the current cell returns it unchanged. `ptr == nullptr` allocates fresh.
 * Copies the smaller of the old and new sizes. Owner-held only (no header).
 */
void *gc_realloc_raw(MalHeap *heap, void *ptr, usize new_size);

/** Finalizer applied to a dead cell during the sweep (frees owned buffers). */
typedef void (*MalHeapFinalizeFn)(MalHeapHeader *cell);

/**
 * When set, the sweep stomps every reclaimed cell's payload (past the intrusive
 * free-list link) with a poison pattern, so a use-after-free of a cell that was
 * dropped because a root was missed reads obviously-wrong data — turning silent
 * heap corruption into a loud crash. Debug aid; enabled by MAL_GC_VERIFY. Only
 * touches dead cells, so a correctly-rooted program is unaffected. */
extern bool mal_heap_poison_on_free;

/**
 * When set, the sweep does NOT reset surviving (BLACK) cells back to WHITE — they
 * stay marked so the generational collector treats them as old (sticky mark-bit).
 * The generational minor and major collectors set it around their sweep; a normal
 * full collection leaves it false and resets marks as before. No effect unless
 * MAL_GC_GENERATIONAL is built. */
extern bool mal_heap_sweep_sticky;

/**
 * Reclaim every unmarked (WHITE) managed cell: run `finalize` on it, mark it
 * FREE, and return it to its block's free list for reuse. Marked (BLACK) cells
 * are kept and reset to WHITE for the next cycle. Caller must have completed the
 * mark phase first. Large-object cells are not yet swept.
 */
void mal_heap_sweep(MalHeap *heap, MalHeapFinalizeFn finalize);

#if MAL_GC_CONCURRENT
/**
 * Begin an incremental sweep (concurrent collector): bump the epoch (before any
 * cell can be reused), clear the reclaimed-cell free lists (rebuilt as blocks are
 * swept), and point the cursor at the first block. Call once at the remark→sweep
 * transition, then drive mal_heap_sweep_step until it returns true.
 */
void mal_heap_sweep_begin(MalHeap *heap);

/**
 * Sweep up to `max_blocks` managed (CELL) blocks from the cursor, reclaiming their
 * WHITE cells (finalize + free list) and recycling fully-dead blocks. Returns true
 * once the whole heap is swept (cursor exhausted) — the caller then closes the
 * cycle. `max_blocks == (usize)-1` sweeps everything remaining (the synchronous
 * finish). Requires a prior mal_heap_sweep_begin.
 */
bool mal_heap_sweep_step(MalHeap *heap, MalHeapFinalizeFn finalize, usize max_blocks);
#endif

/** Call `visit` on every managed (CELL) cell, in any state. Used by the heap
 * verifier to re-examine each cell's edges after marking. */
void mal_heap_walk_cells(MalHeap *heap, MalHeapFinalizeFn visit);
