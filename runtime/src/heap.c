#include "./heap.h"

#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#include "./gc.h"
#include "./perf_stats.h"
#include "./profile.h"
#include "./shape.h"

static _Atomic(u64) g_next_heap_identity = 1;
/* One active mutator binds header initialization to its heap's major color. */
static u8 g_allocation_mark_color;

static inline u8 mal_heap_sweep_mark_load(const MalHeapHeader *header) {
#if defined(__wasi__)
    return header->mark;
#else
    return atomic_load_explicit(&header->mark, memory_order_relaxed);
#endif
}

static inline void mal_heap_sweep_mark_store(MalHeapHeader *header, u8 mark) {
#if defined(__wasi__)
    header->mark = mark;
#else
    atomic_store_explicit(&header->mark, mark, memory_order_relaxed);
#endif
}

/* Poll only requests mutator service; it does not publish heap or worker data. */
static inline void mal_heap_maybe_trigger_gc(const MalHeap *heap) {
    if (heap->bytes_allocated >= heap->next_gc_at) {
#if defined(__wasi__)
        mal_gc_poll = true;
#else
        atomic_store_explicit(&mal_gc_poll, true, memory_order_relaxed);
#endif
    }
}

/*
 * Block-based, segregated-size-class, non-moving allocator.
 *
 * Layout:  Chunk (CHUNK_SIZE mmap, BLOCK_SIZE-aligned)
 *            -> Block (BLOCK_SIZE, address-aligned: block = ptr & ~(BLOCK_SIZE-1))
 *              -> Cell (header + payload, rounded to a size class)
 *
 * Each block carries one size class and one kind (CELL / RAW). Cells are
 * bump-allocated within the current block per (kind, size class); a fresh block
 * is claimed from the newest chunk when the current block fills, and a new chunk
 * is mmap'd when the newest is exhausted. Objects larger than the largest size
 * class go to the large-object space (LOS) as individually-malloc'd records.
 *
 * The structure (per-block free lists, BLOCK_SIZE-aligned blocks, chunk
 * enumeration) lets the mark/sweep collector sweep the allocation bitmap, return
 * dead cells to their free lists, and madvise empty blocks back to the OS without
 * touching the mutator-facing API. mal_heap_free releases everything at shutdown.
 */

#define MAL_GC_BLOCK_SIZE (32u * 1024u)
#define MAL_GC_CHUNK_SIZE (2u * 1024u * 1024u)
/* Cells of this size or smaller are size-classed in blocks; larger -> LOS. */
#define MAL_GC_LARGE_THRESHOLD (MAL_GC_BLOCK_SIZE / 4u)
/* Every cell is 16-byte aligned: covers void*, f64, and MalBigInt's i128. */
#define MAL_GC_CELL_ALIGN 16u

typedef enum MalGcBlockKind {
    MAL_GC_BLOCK_CELL,
    MAL_GC_BLOCK_RAW,
} MalGcBlockKind;

/* Block header, stored inline at the (BLOCK_SIZE-aligned) block base so a cell's
 * block is recovered with a single mask. Cells follow the header. */
struct MalGcBlock {
    u8 kind;        /* MalGcBlockKind */
    u8 on_young;    /* on heap->young_blocks; guards duplicate enrollment */
    u8 recycled;    /* on the heap free-block list: fully swept, pages madvised away,
                     * bump reset. The sweep skips it (so it is not re-recycled) until
                     * mal_gc_new_block reclaims it. */
    u8 on_partial;  /* RAW only: block is currently on heap->raw_partial[size_class]
                     * (has reclaimable free cells). Guards double-linking and tells
                     * gc_free_raw whether to unlink when the block empties. */
    u16 size_class; /* index into g_class_cell_size */
    u32 cell_size;  /* bytes per cell in this block */
    u32 live;       /* RAW: outstanding cells. CELL: survivors counted by the last
                     * sweep, so a minor adds only newly surviving bytes. */
    u8 *bump;       /* next unallocated byte */
    u8 *limit;      /* one past the last usable byte (block_base + BLOCK_SIZE) */
    void *free_list; /* reclaimed cells (Phase 3 sweep / gc_free_raw); intrusive */
    /* Intrusive links: heap->free_blocks (recycled, singly linked via next_free) OR
     * heap->raw_partial[size_class] (RAW partial blocks, doubly linked). A block is
     * on at most one list at a time, so the two uses never overlap. */
    struct MalGcBlock *next_free;
    struct MalGcBlock *prev_free;
    struct MalGcBlock *next_young;
    u64 sweep_epoch;
    // Index cell starts by alignment units so allocation needs no size-class division.
    u64 young_cells[MAL_GC_BLOCK_SIZE / MAL_GC_CELL_ALIGN / 64];
};

struct MalGcChunk {
    void *base;          /* BLOCK_SIZE-aligned, CHUNK_SIZE usable bytes */
    void *mmap_base;     /* original mmap address (for munmap) */
    usize mmap_size;     /* original mmap length */
    usize next_block;    /* index of the next unused block in this chunk */
    usize block_count;   /* CHUNK_SIZE / BLOCK_SIZE */
    struct MalGcChunk *next;
    u64 sweep_epoch;
};

struct MalGcLarge {
    struct MalGcLarge *next;
    struct MalGcLarge *prev;
    struct MalGcLarge *young_next;
    struct MalGcLarge *young_prev;
    usize size; /* payload bytes */
    u8 kind;    /* MalGcBlockKind */
    u8 accounted;
};

static inline usize mal_gc_align_up(usize value) {
    return (value + (MAL_GC_CELL_ALIGN - 1)) & ~(usize) (MAL_GC_CELL_ALIGN - 1);
}

/* Cell payload offset within a block (block header rounded up to cell align). */
static inline usize mal_gc_cell_data_offset(void) {
    return mal_gc_align_up(sizeof(struct MalGcBlock));
}

/* Payload offset within a LOS record (record header rounded up to cell align). */
static inline usize mal_gc_large_data_offset(void) {
    return mal_gc_align_up(sizeof(struct MalGcLarge));
}

/* Offset of the intrusive free-list link inside a reclaimed CELL cell: past the
 * header, pointer-aligned. The header (type/storage/mark) is left intact so the
 * sweep can tell a FREE cell from a newly-dead one. A cell is reclaimable only if
 * it can hold the link past this offset; every managed object can (the smallest
 * is well over this), the 16-byte class cannot but no object is that small. */
static inline usize mal_gc_free_next_offset(void) {
    return (sizeof(MalHeapHeader) + alignof(void *) - 1) & ~(usize) (alignof(void *) - 1);
}

static inline bool mal_gc_cell_reclaimable(u32 cell_size) {
    return cell_size >= mal_gc_free_next_offset() + sizeof(void *);
}

/*
 * Size classes (cell sizes in bytes), 16-aligned with jemalloc-style spacing
 * (four classes per power-of-two band) so internal fragmentation stays under
 * ~15%. The last entry is the in-block ceiling; requests above MAL_GC_LARGE_
 * THRESHOLD never reach this table. Keep MAL_GC_NUM_SIZE_CLASSES in sync.
 */
static const u32 g_class_cell_size[MAL_GC_NUM_SIZE_CLASSES] = {
    16, 32, 48, 64, 80, 96, 112, 128,         //
    160, 192, 224, 256,                        //
    320, 384, 448, 512,                        //
    640, 768, 896, 1024,                       //
    1280, 1536, 1792, 2048,                    //
    2560, 3072, 3584, 4096,                    //
    5120, 6144, 7168, 8192,                    //
};

static_assert(
    sizeof(g_class_cell_size) / sizeof(g_class_cell_size[0]) == MAL_GC_NUM_SIZE_CLASSES,
    "size class table length must equal MAL_GC_NUM_SIZE_CLASSES");
static_assert(MAL_GC_BLOCK_SIZE != 0 && (MAL_GC_BLOCK_SIZE & (MAL_GC_BLOCK_SIZE - 1)) == 0,
    "block size must be a power of two for the masking trick");

/* size -> size-class index, O(1). Slot s covers requests in (16*(s-1), 16*s]. */
#define MAL_GC_MAX_SLOT (MAL_GC_LARGE_THRESHOLD / MAL_GC_CELL_ALIGN)
static u8 g_size_to_class[MAL_GC_MAX_SLOT + 1];
static bool g_tables_ready = false;

static void mal_gc_ensure_tables(void) {
    if (g_tables_ready) {
        return;
    }
    usize ci = 0;
    for (usize slot = 0; slot <= MAL_GC_MAX_SLOT; ++slot) {
        usize needed = slot * MAL_GC_CELL_ALIGN;
        if (needed < g_class_cell_size[0]) {
            needed = g_class_cell_size[0];
        }
        while (ci < MAL_GC_NUM_SIZE_CLASSES - 1 && g_class_cell_size[ci] < needed) {
            ++ci;
        }
        g_size_to_class[slot] = (u8) ci;
    }
    g_tables_ready = true;
}

usize mal_heap_allocation_charge(usize alloc_size) {
    mal_gc_ensure_tables();
    usize size = alloc_size == 0 ? 1 : alloc_size;
    if (size > MAL_GC_LARGE_THRESHOLD) {
        return size;
    }
    usize slot = (size + MAL_GC_CELL_ALIGN - 1) / MAL_GC_CELL_ALIGN;
    return g_class_cell_size[g_size_to_class[slot]];
}

/* mmap a region of `size` bytes aligned to `align` (a power of two). Records the
 * raw mapping in *mmap_base_out / *mmap_size_out for later munmap. */
static void *mal_gc_aligned_mmap(usize size, usize align, void **mmap_base_out, usize *mmap_size_out) {
    usize total = size + align;
    void *raw = mmap(nullptr, total, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (raw == MAP_FAILED) {
        return nullptr;
    }
    uptr aligned = ((uptr) raw + (align - 1)) & ~(uptr) (align - 1);
    *mmap_base_out = raw;
    *mmap_size_out = total;
    return (void *) aligned;
}

static bool mal_gc_index_chunk(MalHeap *heap, MalGcChunk *chunk) {
    if (heap->chunk_count == heap->chunk_capacity) {
        usize next_capacity = heap->chunk_capacity == 0 ? 16 : heap->chunk_capacity * 2;
        if (next_capacity < heap->chunk_capacity ||
            next_capacity > (usize) -1 / sizeof(MalGcChunk *)) {
            return false;
        }
        MalGcChunk **grown = realloc(heap->chunk_index, next_capacity * sizeof(MalGcChunk *));
        if (grown == nullptr) {
            return false;
        }
        heap->chunk_index = grown;
        heap->chunk_capacity = next_capacity;
    }

    uptr base = (uptr) chunk->base;
    usize low = 0;
    usize high = heap->chunk_count;
    while (low < high) {
        usize middle = low + (high - low) / 2;
        if ((uptr) heap->chunk_index[middle]->base < base) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    memmove(&heap->chunk_index[low + 1], &heap->chunk_index[low],
        (heap->chunk_count - low) * sizeof(MalGcChunk *));
    heap->chunk_index[low] = chunk;
    heap->chunk_count++;
    return true;
}

static MalGcChunk *mal_gc_new_chunk(MalHeap *heap) {
    void *mmap_base;
    usize mmap_size;
    void *base = mal_gc_aligned_mmap(MAL_GC_CHUNK_SIZE, MAL_GC_BLOCK_SIZE, &mmap_base, &mmap_size);
    if (base == nullptr) {
        return nullptr;
    }
    MalGcChunk *chunk = malloc(sizeof(MalGcChunk));
    if (chunk == nullptr) {
        munmap(mmap_base, mmap_size);
        return nullptr;
    }
    chunk->base = base;
    chunk->mmap_base = mmap_base;
    chunk->mmap_size = mmap_size;
    chunk->block_count = MAL_GC_CHUNK_SIZE / MAL_GC_BLOCK_SIZE;
    chunk->next_block = 0;
    chunk->sweep_epoch = heap->sweeping ? heap->sweep_epoch : 0;
    if (!mal_gc_index_chunk(heap, chunk)) {
        free(chunk);
        munmap(mmap_base, mmap_size);
        return nullptr;
    }
    chunk->next = heap->chunks;
    heap->chunks = chunk;
    return chunk;
}

static MalGcBlock *mal_gc_new_block(MalHeap *heap, u16 size_class, u8 kind) {
    // Reclaim a fully-empty block the sweep returned to the OS before carving a
    // fresh one. A blank block can serve any size class / kind after re-init; its
    // madvised pages refault on first write.
    MalGcBlock *recycled = heap->free_blocks;
    u8 *block_base;
    u64 sweep_epoch;
    if (recycled != nullptr) {
        heap->free_blocks = recycled->next_free;
        block_base = (u8 *) recycled;
        sweep_epoch = recycled->sweep_epoch;
    } else {
        MalGcChunk *chunk = heap->chunks;
        if (chunk == nullptr || chunk->next_block >= chunk->block_count) {
            chunk = mal_gc_new_chunk(heap);
            if (chunk == nullptr) return nullptr;
        }
        block_base = (u8 *) chunk->base + chunk->next_block * MAL_GC_BLOCK_SIZE;
        chunk->next_block++;
        sweep_epoch = chunk->sweep_epoch;
    }

    MalGcBlock *block = (MalGcBlock *) block_base;
    block->kind = kind;
    block->on_young = 0;
    block->next_young = nullptr;
    memset(block->young_cells, 0, sizeof(block->young_cells));
    block->recycled = 0;
    block->on_partial = 0;
    block->size_class = size_class;
    block->cell_size = g_class_cell_size[size_class];
    block->live = 0;
    block->sweep_epoch = sweep_epoch;
    block->free_list = nullptr;
    block->next_free = nullptr;
    block->prev_free = nullptr;
    block->bump = block_base + mal_gc_cell_data_offset();
    block->limit = block_base + MAL_GC_BLOCK_SIZE;
    return block;
}

static inline void mal_gc_track_young_block(MalHeap *heap, MalGcBlock *block, void *cell) {
    if (mal_gc_black_alloc) return;
    usize slot = ((uptr) cell & (MAL_GC_BLOCK_SIZE - 1)) / MAL_GC_CELL_ALIGN;
    block->young_cells[slot / 64] |= UINT64_C(1) << (slot % 64);
    if (!block->on_young) {
        block->on_young = 1;
        block->next_young = heap->young_blocks;
        heap->young_blocks = block;
    }
}

static void mal_gc_clear_young_blocks(MalHeap *heap) {
    MalGcBlock *block = heap->young_blocks;
    heap->young_blocks = nullptr;
    while (block != nullptr) {
        MalGcBlock *next = block->next_young;
        block->on_young = 0;
        block->next_young = nullptr;
        memset(block->young_cells, 0, sizeof(block->young_cells));
        block = next;
    }
}

static void mal_gc_untrack_young_large(MalHeap *heap, MalGcLarge *rec) {
    if (rec->young_prev != nullptr) {
        rec->young_prev->young_next = rec->young_next;
    } else if (heap->young_large == rec) {
        heap->young_large = rec->young_next;
    } else {
        return;
    }
    if (rec->young_next != nullptr) rec->young_next->young_prev = rec->young_prev;
    rec->young_next = nullptr;
    rec->young_prev = nullptr;
}

static void mal_gc_clear_young_large(MalHeap *heap) {
    MalGcLarge *rec = heap->young_large;
    heap->young_large = nullptr;
    while (rec != nullptr) {
        MalGcLarge *next = rec->young_next;
        rec->young_next = nullptr;
        rec->young_prev = nullptr;
        rec = next;
    }
}

static void mal_gc_unlink_large(MalGcLarge **head, MalGcLarge *rec) {
    if (rec->prev != nullptr) rec->prev->next = rec->next;
    else *head = rec->next;
    if (rec->next != nullptr) rec->next->prev = rec->prev;
}

static bool mal_gc_sweep_large(MalHeap *heap, MalGcLarge *rec, MalHeapFinalizeFn finalize, bool major) {
    MalHeapHeader *header = (MalHeapHeader *) ((u8 *) rec + mal_gc_large_data_offset());
    bool live = major ? mal_heap_mark_is_current(header->mark, heap->mark_color)
        : mal_heap_mark_is_old(header->mark);
    if (live) {
        if (major) header->mark |= MAL_MARK_OLD;
        rec->accounted = 1;
        return true;
    }
    mal_gc_untrack_young_large(heap, rec);
    mal_gc_unlink_large(&heap->large, rec);
    finalize(header);
    free(rec);
    return false;
}

/* A black cell behind the sweep cursor needs immediate survivor accounting. */
static inline void mal_gc_count_black(MalHeap *heap, MalGcBlock *block, u8 kind, usize size) {
    if (kind == MAL_GC_BLOCK_CELL && mal_gc_black_alloc) {
        mal_gc_black_alloc_bytes += size;
        if (block != nullptr && heap->sweeping && block->sweep_epoch == heap->sweep_epoch) {
            heap->sweep_live_bytes += size;
            block->live++;
        }
    }
}

static void *mal_gc_alloc_large(MalHeap *heap, usize size, u8 kind) {
    usize offset = mal_gc_large_data_offset();
    if (size > SIZE_MAX - offset) return nullptr;
    MalGcLarge *rec = malloc(offset + size);
    if (rec == nullptr) {
        return nullptr;
    }
    rec->size = size;
    rec->kind = kind;
    rec->accounted = 0;
    rec->prev = nullptr;
    rec->young_next = nullptr;
    rec->young_prev = nullptr;
    MalGcLarge **head = kind == MAL_GC_BLOCK_CELL ? &heap->large : &heap->raw_large;
    rec->next = *head;
    if (*head != nullptr) (*head)->prev = rec;
    *head = rec;
    if (kind == MAL_GC_BLOCK_CELL) {
        rec->young_next = heap->young_large;
        if (heap->young_large != nullptr) heap->young_large->young_prev = rec;
        heap->young_large = rec;
        if (heap->sweeping) {
            heap->sweep_live_bytes += size;
            rec->accounted = 1;
        }
    }
    heap->bytes_allocated += size;
    mal_gc_count_black(heap, nullptr, kind, size);
    mal_heap_maybe_trigger_gc(heap);
    return (u8 *) rec + offset;
}

static void *mal_gc_alloc(MalHeap *heap, usize size, u8 kind) {
    if (size == 0) {
        size = 1;
    }
    if (size > MAL_GC_LARGE_THRESHOLD) {
        return mal_gc_alloc_large(heap, size, kind);
    }

    usize slot = (size + MAL_GC_CELL_ALIGN - 1) / MAL_GC_CELL_ALIGN;
    u16 size_class = g_size_to_class[slot];

    // Reuse a cell reclaimed by the sweep (CELL) or freed by an owner finalizer
    // (RAW) before bumping. CELL cells thread the free link past their header
    // (mal_gc_free_next_offset); RAW cells have no header, so the link sits at
    // offset 0. Both lists are empty until something is reclaimed, so an
    // uncollected run is still pure bump allocation.
    if (kind == MAL_GC_BLOCK_CELL && heap->cell_free[size_class] != nullptr) {
        void *cell = heap->cell_free[size_class];
        heap->cell_free[size_class] = *(void **) ((u8 *) cell + mal_gc_free_next_offset());
        MalGcBlock *block = (MalGcBlock *) ((uptr) cell & ~(uptr) (MAL_GC_BLOCK_SIZE - 1));
        mal_gc_track_young_block(heap, block, cell);
        heap->bytes_allocated += g_class_cell_size[size_class];
        mal_gc_count_black(heap, block, kind, g_class_cell_size[size_class]);
        mal_heap_maybe_trigger_gc(heap);
        return cell;
    }
    if (kind == MAL_GC_BLOCK_RAW && heap->raw_partial[size_class] != nullptr) {
        // Reuse a cell freed by an owner finalizer from a partially-empty RAW block
        // (its OWN free list — RAW cells never mix into a global chain, so the block
        // stays independently recyclable). The free link sits at offset 0.
        MalGcBlock *partial = heap->raw_partial[size_class];
        void *cell = partial->free_list;
        partial->free_list = *(void **) cell;
        partial->live++;
        if (partial->free_list == nullptr) {
            // Exhausted this block's free cells: unlink it from the partial list. It
            // is the list head (allocation only pops the head), so this is O(1). It
            // may still be the current bump block; a later free re-adds it.
            heap->raw_partial[size_class] = partial->next_free;
            if (partial->next_free != nullptr) {
                partial->next_free->prev_free = nullptr;
            }
            partial->next_free = nullptr;
            partial->on_partial = 0;
        }
        heap->bytes_allocated += g_class_cell_size[size_class];
        mal_heap_maybe_trigger_gc(heap);
        return cell;
    }

    MalGcBlock **current = (kind == MAL_GC_BLOCK_CELL)
        ? &heap->cell_blocks[size_class]
        : &heap->raw_blocks[size_class];

    MalGcBlock *block = *current;
    if (block == nullptr || block->bump + block->cell_size > block->limit) {
        block = mal_gc_new_block(heap, size_class, kind);
        if (block == nullptr) return nullptr;
        *current = block;
    }

    void *cell = block->bump;
    block->bump += block->cell_size;
    if (kind == MAL_GC_BLOCK_RAW) {
        block->live++; // per-block live count drives empty-block reclamation
    } else {
        mal_gc_track_young_block(heap, block, cell);
    }
    heap->bytes_allocated += block->cell_size;
    mal_gc_count_black(heap, block, kind, block->cell_size);
    mal_heap_maybe_trigger_gc(heap);
    return cell;
}

void mal_heap_init(MalHeap *heap, usize capacity) {
    (void) capacity; // the block allocator sizes itself; capacity is now advisory
    mal_gc_ensure_tables();
    heap->chunks = nullptr;
    heap->raw_lookup_chunk = nullptr;
    heap->chunk_index = nullptr;
    heap->chunk_count = 0;
    heap->chunk_capacity = 0;
    heap->large = nullptr;
    heap->raw_large = nullptr;
    heap->young_large = nullptr;
    heap->mark_color = 0;
    g_allocation_mark_color = 0;
    memset(heap->cell_blocks, 0, sizeof(heap->cell_blocks));
    memset(heap->raw_blocks, 0, sizeof(heap->raw_blocks));
    memset(heap->cell_free, 0, sizeof(heap->cell_free));
    memset(heap->raw_partial, 0, sizeof(heap->raw_partial));
    heap->free_blocks = nullptr;
    heap->young_blocks = nullptr;
    heap->bytes_allocated = 0;
    heap->next_gc_at = (usize) -1;
    heap->poison_on_free = false;
    heap->live_bytes = 0;
    heap->gc_stats = false;
    heap->minor_cells_inspected = 0;
    heap->minor_blocks_inspected = 0;
    mal_shape_heap_init(heap);
    heap->native_function_length_key = nullptr;
    heap->native_function_name_key = nullptr;
    do {
        heap->identity = atomic_fetch_add(&g_next_heap_identity, 1);
    } while (heap->identity == 0);
    heap->epoch = 0;
	heap->fail_next_cell_allocation = false;
#if MAL_PERF_STATS
    heap->fail_next_raw_allocation = false;
#endif
#if MAL_PROFILE
	heap->profile_state = nullptr;
	heap->profile_allocation_budget = 0;
#endif
    heap->sweep_chunk = nullptr;
    heap->sweep_block = 0;
    heap->sweep_large = nullptr;
    heap->sweep_live_bytes = 0;
    heap->sweep_epoch = 0;
    heap->sweeping = false;
#if MAL_REALMS
    // Set once the VM creates its initial realm (mal_realm_switch). Null until then,
    // and no function object is allocated before that point.
    heap->current_realm = nullptr;
#endif
}

void mal_heap_free(MalHeap *heap) {
    mal_shape_heap_free(heap);
    MalGcChunk *chunk = heap->chunks;
    while (chunk != nullptr) {
        MalGcChunk *next = chunk->next;
        munmap(chunk->mmap_base, chunk->mmap_size);
        free(chunk);
        chunk = next;
    }
    free(heap->chunk_index);
    MalGcLarge *large = heap->large;
    while (large != nullptr) {
        MalGcLarge *next = large->next;
        free(large);
        large = next;
    }
    large = heap->raw_large;
    while (large != nullptr) {
        MalGcLarge *next = large->next;
        free(large);
        large = next;
    }
    heap->chunks = nullptr;
    heap->raw_lookup_chunk = nullptr;
    heap->chunk_index = nullptr;
    heap->chunk_count = 0;
    heap->chunk_capacity = 0;
    heap->large = nullptr;
    heap->raw_large = nullptr;
    heap->young_large = nullptr;
    heap->sweep_large = nullptr;
    memset(heap->cell_blocks, 0, sizeof(heap->cell_blocks));
    memset(heap->raw_blocks, 0, sizeof(heap->raw_blocks));
    memset(heap->cell_free, 0, sizeof(heap->cell_free));
    memset(heap->raw_partial, 0, sizeof(heap->raw_partial));
    heap->free_blocks = nullptr; // the blocks themselves are freed via the chunks above
    heap->young_blocks = nullptr;
    heap->bytes_allocated = 0;
    heap->next_gc_at = (usize) -1;
    heap->poison_on_free = false;
    heap->live_bytes = 0;
    heap->gc_stats = false;
    heap->minor_cells_inspected = 0;
    heap->minor_blocks_inspected = 0;
}

MalHeapUsage mal_heap_usage(const MalHeap *heap) {
    MalHeapUsage usage = {0};
    for (const MalGcChunk *chunk = heap->chunks; chunk != nullptr; chunk = chunk->next) {
        usage.chunk_mapped_bytes += chunk->mmap_size;
        usage.unclaimed_chunk_bytes +=
            (chunk->block_count - chunk->next_block) * MAL_GC_BLOCK_SIZE;
        for (usize index = 0; index < chunk->next_block; ++index) {
            const MalGcBlock *block =
                (const MalGcBlock *) ((const u8 *) chunk->base + index * MAL_GC_BLOCK_SIZE);
            if (block->recycled) continue;
            if (block->kind == MAL_GC_BLOCK_RAW) {
                usize occupied = (usize) block->live * block->cell_size;
                usize handed_out =
                    (usize) (block->bump - ((const u8 *) block + mal_gc_cell_data_offset()));
                if (occupied > handed_out) abort();
                usage.raw_owned_bytes += occupied;
                usage.raw_free_cell_bytes += handed_out - occupied;
            }
        }
    }
    for (const MalGcLarge *large = heap->raw_large; large != nullptr; large = large->next) {
        usage.raw_owned_bytes += large->size;
    }
    for (usize size_class = 0; size_class < MAL_GC_NUM_SIZE_CLASSES; ++size_class) {
        for (const void *cell = heap->cell_free[size_class]; cell != nullptr;
            cell = *(void *const *) ((const u8 *) cell + mal_gc_free_next_offset())) {
            usage.managed_free_cell_bytes += g_class_cell_size[size_class];
        }
        const MalGcBlock *cell_block = heap->cell_blocks[size_class];
        if (cell_block != nullptr) {
            usage.bump_free_bytes +=
                (usize) (cell_block->limit - cell_block->bump) / cell_block->cell_size *
                cell_block->cell_size;
        }
        const MalGcBlock *raw_block = heap->raw_blocks[size_class];
        if (raw_block != nullptr) {
            usage.bump_free_bytes +=
                (usize) (raw_block->limit - raw_block->bump) / raw_block->cell_size *
                raw_block->cell_size;
        }
    }
    for (const MalGcBlock *block = heap->free_blocks; block != nullptr;
        block = block->next_free) {
        usage.recycled_block_bytes += MAL_GC_BLOCK_SIZE;
    }
    return usage;
}

void mal_heap_header_init(MalHeapHeader *header, MalHeapType type) {
    header->type = type;
    header->storage = MAL_HEAP_STORAGE_DYNAMIC;
    // New cells stay live when allocated during an in-flight incremental sweep.
    u8 initial_mark = g_allocation_mark_color | (mal_gc_black_alloc ? MAL_MARK_OLD : 0);
#if defined(__wasi__)
    header->mark = initial_mark;
#else
    // The constructor publishes the cell only after its header and payload are initialized.
    atomic_store_explicit(&header->mark, initial_mark, memory_order_relaxed);
#endif
    header->dirty = 0; // not on the remembered set
}

void mal_heap_begin_major(MalHeap *heap) {
    heap->mark_color ^= MAL_MARK_COLOR;
    g_allocation_mark_color = heap->mark_color;
}

MalHeapType mal_heap_header_type(const MalHeapHeader *header) {
    return header->type;
}

#if MAL_PROFILE
static MalProfileAllocationFamily mal_profile_family_for_heap_type(MalHeapType type) {
    switch (type) {
        case MAL_HEAP_STRING:
            return MAL_PROFILE_ALLOCATION_FAMILY_STRING;
        case MAL_HEAP_FUNCTION_OBJECT:
        case MAL_HEAP_NATIVE_FUNCTION_OBJECT:
        case MAL_HEAP_BOUND_FUNCTION_OBJECT:
            return MAL_PROFILE_ALLOCATION_FAMILY_FUNCTION;
        case MAL_HEAP_ARRAY_OBJECT:
            return MAL_PROFILE_ALLOCATION_FAMILY_ARRAY;
        case MAL_HEAP_MAP_OBJECT:
        case MAL_HEAP_SET_OBJECT:
        case MAL_HEAP_WEAK_MAP_OBJECT:
        case MAL_HEAP_WEAK_SET_OBJECT:
            return MAL_PROFILE_ALLOCATION_FAMILY_COLLECTION;
        case MAL_HEAP_ARRAY_BUFFER_OBJECT:
        case MAL_HEAP_TYPED_ARRAY_OBJECT:
        case MAL_HEAP_DATA_VIEW_OBJECT:
            return MAL_PROFILE_ALLOCATION_FAMILY_BUFFER;
        case MAL_HEAP_PROMISE_OBJECT:
            return MAL_PROFILE_ALLOCATION_FAMILY_PROMISE;
        case MAL_HEAP_ITERATOR_OBJECT:
        case MAL_HEAP_STRING_CURSOR:
        case MAL_HEAP_GENERATOR_OBJECT:
        case MAL_HEAP_ITERATOR_HELPER_OBJECT:
        case MAL_HEAP_REGEXP_STRING_ITERATOR_OBJECT:
            return MAL_PROFILE_ALLOCATION_FAMILY_ITERATOR;
        case MAL_HEAP_REGEXP_OBJECT:
            return MAL_PROFILE_ALLOCATION_FAMILY_REGEXP;
        case MAL_HEAP_ENV:
        case MAL_HEAP_SHAPE:
            return MAL_PROFILE_ALLOCATION_FAMILY_METADATA;
        case MAL_HEAP_RESPONSE_OBJECT:
        case MAL_HEAP_REQUEST_OBJECT:
        case MAL_HEAP_HEADERS_OBJECT:
        case MAL_HEAP_HEADERS_ITERATOR_OBJECT:
        case MAL_HEAP_BLOB_OBJECT:
        case MAL_HEAP_FORM_DATA_OBJECT:
        case MAL_HEAP_FORM_DATA_ITERATOR_OBJECT:
        case MAL_HEAP_URL_OBJECT:
        case MAL_HEAP_URL_SEARCH_PARAMS_OBJECT:
        case MAL_HEAP_URL_SEARCH_PARAMS_ITERATOR_OBJECT:
        case MAL_HEAP_EVENT_TARGET_OBJECT:
        case MAL_HEAP_READABLE_STREAM_OBJECT:
        case MAL_HEAP_NODE_ZLIB_OBJECT:
        case MAL_HEAP_NODE_SQLITE_DATABASE_OBJECT:
        case MAL_HEAP_NODE_SQLITE_STATEMENT_OBJECT:
        case MAL_HEAP_NODE_FS_FILE_HANDLE_OBJECT:
        case MAL_HEAP_ASYNC_CONTEXT:
        case MAL_HEAP_ASYNC_LOCAL_STORAGE_STATE:
        case MAL_HEAP_ASYNC_RESOURCE_STATE:
        case MAL_HEAP_ASYNC_RUN_SCOPE_STATE:
            return MAL_PROFILE_ALLOCATION_FAMILY_HOST;
        default:
            return MAL_PROFILE_ALLOCATION_FAMILY_OBJECT;
    }
}

#if !MAL_PERF_STATS
static inline void mal_heap_profile_allocation(
    MalHeap *heap, usize requested_size, usize charged_size,
    MalProfileAllocationStorage storage, MalProfileAllocationFamily family,
    u8 object_type
) {
    if (heap->profile_state == nullptr) return;
    if (charged_size < heap->profile_allocation_budget) {
        heap->profile_allocation_budget -= charged_size;
        return;
    }
    mal_profile_allocation(
        heap, requested_size, charged_size, storage, family, object_type);
}
#else
#define mal_heap_profile_allocation mal_profile_allocation
#endif
#else
#define mal_heap_profile_allocation(...) ((void) 0)
#endif

void *mal_heap_alloc(MalHeap *heap, usize alloc_size, MalHeapType type) {
    void *ptr = mal_gc_alloc(heap, alloc_size, MAL_GC_BLOCK_CELL);
    if (ptr == nullptr) abort();
	mal_heap_header_init(ptr, type);
	mal_heap_profile_allocation(
        heap, alloc_size, mal_heap_allocation_charge(alloc_size),
        MAL_PROFILE_ALLOCATION_MANAGED_CELL, mal_profile_family_for_heap_type(type),
        (u8) type);
    return ptr;
}

void *mal_heap_try_alloc(MalHeap *heap, usize alloc_size, MalHeapType type) {
    if (heap->fail_next_cell_allocation) {
        heap->fail_next_cell_allocation = false;
        return nullptr;
    }
    void *ptr = mal_gc_alloc(heap, alloc_size, MAL_GC_BLOCK_CELL);
	if (ptr != nullptr) mal_heap_header_init(ptr, type);
	if (ptr != nullptr) {
        mal_heap_profile_allocation(
            heap, alloc_size, mal_heap_allocation_charge(alloc_size),
            MAL_PROFILE_ALLOCATION_MANAGED_CELL, mal_profile_family_for_heap_type(type),
            (u8) type);
    }
    return ptr;
}

void *mal_heap_alloc_raw(MalHeap *heap, usize alloc_size) {
    return mal_heap_alloc_raw_profiled(
        heap, alloc_size, MAL_PROFILE_ALLOCATION_FAMILY_UNKNOWN);
}

void *mal_heap_alloc_raw_profiled(MalHeap *heap, usize alloc_size, u8 profile_family) {
    void *ptr = mal_gc_alloc(heap, alloc_size, MAL_GC_BLOCK_RAW);
    if (ptr == nullptr) abort();
    mal_heap_profile_allocation(
        heap, alloc_size, mal_heap_allocation_charge(alloc_size),
        MAL_PROFILE_ALLOCATION_RAW_PAYLOAD,
        (MalProfileAllocationFamily) profile_family, MAL_PROFILE_OBJECT_TYPE_NONE);
    return ptr;
}

void *mal_heap_try_alloc_raw(MalHeap *heap, usize alloc_size) {
    return mal_heap_try_alloc_raw_profiled(
        heap, alloc_size, MAL_PROFILE_ALLOCATION_FAMILY_UNKNOWN);
}

void *mal_heap_try_alloc_raw_profiled(MalHeap *heap, usize alloc_size, u8 profile_family) {
#if MAL_PERF_STATS
    if (heap->fail_next_raw_allocation) {
        heap->fail_next_raw_allocation = false;
        return nullptr;
    }
#endif
    void *ptr = mal_gc_alloc(heap, alloc_size, MAL_GC_BLOCK_RAW);
    if (ptr != nullptr) {
        mal_heap_profile_allocation(
            heap, alloc_size, mal_heap_allocation_charge(alloc_size),
            MAL_PROFILE_ALLOCATION_RAW_PAYLOAD,
            (MalProfileAllocationFamily) profile_family, MAL_PROFILE_OBJECT_TYPE_NONE);
    }
    return ptr;
}

static inline bool mal_gc_ptr_in_chunk(const MalGcChunk *chunk, const void *ptr) {
    uptr address = (uptr) ptr;
    uptr base = (uptr) chunk->base;
    return address >= base && address - base < MAL_GC_CHUNK_SIZE;
}

static bool mal_gc_ptr_in_chunks(MalHeap *heap, const void *ptr) {
    if (heap->raw_lookup_chunk != nullptr && mal_gc_ptr_in_chunk(heap->raw_lookup_chunk, ptr)) {
        return true;
    }
    uptr address = (uptr) ptr;
    usize low = 0;
    usize high = heap->chunk_count;
    while (low < high) {
        usize middle = low + (high - low) / 2;
        if ((uptr) heap->chunk_index[middle]->base <= address) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    if (low > 0) {
        MalGcChunk *chunk = heap->chunk_index[low - 1];
        if (mal_gc_ptr_in_chunk(chunk, ptr)) {
            heap->raw_lookup_chunk = chunk;
            return true;
        }
    }
    return false;
}

/* OS page size, cached. madvise ranges must be page-aligned. */
static usize mal_gc_page_size(void) {
    static usize cached = 0;
    if (cached == 0) {
        long ps = sysconf(_SC_PAGESIZE);
        cached = ps > 0 ? (usize) ps : 4096u;
    }
    return cached;
}

/* "Reclaim these pages" hint: MADV_FREE where available (Darwin/BSD; lazy, no
 * immediate zero) else MADV_DONTNEED (Linux). Either drops RSS; page contents
 * become undefined, fine for a block that is reset and rewritten on reuse. */
#ifdef MADV_FREE
#define MAL_GC_MADV_REUSE MADV_FREE
#else
#define MAL_GC_MADV_REUSE MADV_DONTNEED
#endif

/* Return a fully-empty block's cell pages to the OS and push it onto the heap's
 * free-block list: reset to pristine and flagged `recycled` so the sweep skips
 * it until mal_gc_new_block reclaims it. The header lives in the first page and
 * is preserved; whole pages strictly inside the cell region are madvised away. */
static void mal_gc_recycle_block(MalHeap *heap, MalGcBlock *block) {
    u8 *block_base = (u8 *) block;

#if !defined(__wasi__)
    usize page = mal_gc_page_size();
    uptr madv_start =
        ((uptr) block_base + mal_gc_cell_data_offset() + (page - 1)) & ~(uptr) (page - 1);
    uptr madv_end = (uptr) block_base + MAL_GC_BLOCK_SIZE;
    if (madv_end > madv_start) {
        madvise((void *) madv_start, (usize) (madv_end - madv_start), MAL_GC_MADV_REUSE);
    }
#endif
    block->bump = block_base + mal_gc_cell_data_offset();
    block->free_list = nullptr;
    block->recycled = 1;
    block->next_free = heap->free_blocks;
    heap->free_blocks = block;
}

/* Stomp a reclaimed cell's payload past the free-list link with a recognizable
 * pattern. 0xDF bytes decode, as a
 * NaN-boxed MalValue, to a non-finite double far from any valid pointer or int,
 * so a use-after-free read fails loudly instead of silently aliasing. */
static inline void mal_gc_poison_cell(u8 *cell, u32 cell_size, usize free_offset) {
    usize start = free_offset + sizeof(void *);
    if (cell_size > start) {
        memset(cell + start, 0xDF, cell_size - start);
    }
}

/* Sweep one managed (CELL) block: finalize + reclaim its WHITE cells into the size
 * class's free list, count survivors (accumulated into *live_bytes), and recycle a
 * fully-dead block to the OS. Skips RAW / already-recycled blocks. Shared by the
 * full sweep and the incremental sweep step, so the reclamation rule lives in one
 * place. */
static void mal_heap_sweep_block(
    MalHeap *heap, MalGcBlock *block, MalHeapFinalizeFn finalize,
    usize data_offset, usize free_offset, usize *live_bytes) {
    if (block->kind != MAL_GC_BLOCK_CELL || block->recycled) {
        return;
    }
    // Sweep the block's cells into a per-block free chain while counting survivors.
    // Publishing the chain is deferred so a block with no live cell can be handed
    // back to the OS instead of pooling dead cells.
    void *local_head = nullptr;
    void *local_tail = nullptr;
    usize block_live = 0;
    for (u8 *cell = (u8 *) block + data_offset; cell + block->cell_size <= block->bump;
        cell += block->cell_size) {
        MalHeapHeader *header = (MalHeapHeader *) cell;
        u8 mark = mal_heap_sweep_mark_load(header);
        if (mal_heap_mark_is_current(mark, heap->mark_color)) {
            // Marking has completed before the mutator owns sweep.
            mal_heap_sweep_mark_store(header, mark | MAL_MARK_OLD);
            *live_bytes += block->cell_size;
            block_live++;
            continue;
        }
        if ((mark & MAL_MARK_FREE) == 0) {
            // Unreached: dead. Finalize (frees its owned side allocations), then
            // tombstone so a later sweep does not finalize it again.
            finalize(header);
            mal_heap_sweep_mark_store(header, MAL_MARK_FREE);
            if (heap->poison_on_free) {
                mal_gc_poison_cell(cell, block->cell_size, free_offset);
            }
        }
        // FREE (incl. just-finalized): thread onto this block's local chain
        // (head-prepend; tail is the first cell linked).
        if (mal_gc_cell_reclaimable(block->cell_size)) {
            if (local_tail == nullptr) {
                local_tail = cell;
            }
            *(void **) (cell + free_offset) = local_head;
            local_head = cell;
        }
    }

    block->live = block_live;
    if (block_live == 0) {
        // Whole block dead: its owned side-allocations were freed above; return its
        // pages to the OS and recycle the block rather than pooling the dead cells.
        mal_gc_recycle_block(heap, block);
        if (heap->cell_blocks[block->size_class] == block) {
            heap->cell_blocks[block->size_class] = nullptr;
        }
    } else if (local_head != nullptr) {
        // Survivors remain: splice this block's reclaimed cells onto the size
        // class's free list for reuse.
        *(void **) ((u8 *) local_tail + free_offset) = heap->cell_free[block->size_class];
        heap->cell_free[block->size_class] = local_head;
    }
}

void mal_heap_sweep(MalHeap *heap, MalHeapFinalizeFn finalize) {
    // A cell may be freed (below) and its address later reused, so any identity cache
    // keyed on a raw cell pointer is only valid within one epoch (see MalHeap.epoch).
    heap->epoch++;
    mal_perf_collection_epoch(heap->epoch);
    usize data_offset = mal_gc_cell_data_offset();
    usize free_offset = mal_gc_free_next_offset();
    mal_gc_clear_young_blocks(heap);
    mal_gc_clear_young_large(heap);

    // Rebuild the reclaimed-cell free lists from scratch: every non-live cell
    // (newly dead or already free) is re-linked, so cells reused since the last
    // sweep that are now live simply drop off.
    memset(heap->cell_free, 0, sizeof(heap->cell_free));
    usize live_bytes = 0;

    for (MalGcChunk *chunk = heap->chunks; chunk != nullptr; chunk = chunk->next) {
        for (usize block_index = 0; block_index < chunk->next_block; ++block_index) {
            MalGcBlock *block = (MalGcBlock *) ((u8 *) chunk->base + block_index * MAL_GC_BLOCK_SIZE);
            mal_heap_sweep_block(heap, block, finalize, data_offset, free_offset, &live_bytes);
        }
    }

    MalGcLarge *large = heap->large;
    while (large != nullptr) {
        MalGcLarge *next = large->next;
        if (mal_gc_sweep_large(heap, large, finalize, true)) live_bytes += large->size;
        large = next;
    }

    heap->live_bytes = live_bytes;
}

void mal_heap_sweep_minor(MalHeap *heap, MalHeapFinalizeFn finalize) {
    heap->epoch++;
    mal_perf_collection_epoch(heap->epoch);
    usize free_offset = mal_gc_free_next_offset();
    MalGcBlock *block = heap->young_blocks;
    heap->young_blocks = nullptr;
    while (block != nullptr) {
        MalGcBlock *next = block->next_young;
        block->on_young = 0;
        block->next_young = nullptr;
        u64 young_cells[countof(block->young_cells)];
        memcpy(young_cells, block->young_cells, sizeof(young_cells));
        memset(block->young_cells, 0, sizeof(block->young_cells));
        usize block_live = 0;
        if (heap->gc_stats) {
            heap->minor_blocks_inspected++;
        }
        for (usize word = 0; word < countof(young_cells); word++) {
            u64 remaining = young_cells[word];
            if (heap->gc_stats) heap->minor_cells_inspected += (usize) __builtin_popcountll(remaining);
            while (remaining != 0) {
                usize slot = word * 64 + (usize) __builtin_ctzll(remaining);
                remaining &= remaining - 1;
                u8 *cell = (u8 *) block + slot * MAL_GC_CELL_ALIGN;
                MalHeapHeader *header = (MalHeapHeader *) cell;
                u8 mark = mal_heap_sweep_mark_load(header);
                if (mal_heap_mark_is_old(mark)) {
                    block_live++;
                } else if ((mark & MAL_MARK_FREE) == 0) {
                    finalize(header);
                    mal_heap_sweep_mark_store(header, MAL_MARK_FREE);
                    if (heap->poison_on_free) {
                        mal_gc_poison_cell(cell, block->cell_size, free_offset);
                    }
                    // Already-FREE cells remain linked; adding them again creates cycles.
                    if (mal_gc_cell_reclaimable(block->cell_size)) {
                        *(void **) (cell + free_offset) = heap->cell_free[block->size_class];
                        heap->cell_free[block->size_class] = cell;
                    }
                }
            }
        }
        // Only newly allocated cells were visited; old survivors remain accounted for.
        heap->live_bytes += block_live * block->cell_size;
        block->live += block_live;
        block = next;
    }
    MalGcLarge *large = heap->young_large;
    heap->young_large = nullptr;
    while (large != nullptr) {
        MalGcLarge *next = large->young_next;
        large->young_next = nullptr;
        large->young_prev = nullptr;
        if (large->kind == MAL_GC_BLOCK_CELL) {
            bool accounted = large->accounted;
            if (mal_gc_sweep_large(heap, large, finalize, false) && !accounted) {
                heap->live_bytes += large->size;
            }
        }
        large = next;
    }
}

void mal_heap_sweep_begin(MalHeap *heap) {
    // Bump the epoch BEFORE any reclaimed cell can be handed back out (the ABA
    // guard for identity caches — see MalHeap.epoch). Clear the reclaimed-cell free
    // lists; the incremental step re-populates them per block as it sweeps. During
    // the gap the allocator carves fresh blocks (whose cells are black-allocated).
    heap->epoch++;
    mal_perf_collection_epoch(heap->epoch);
    if (++heap->sweep_epoch == 0) {
        for (MalGcChunk *chunk = heap->chunks; chunk != nullptr; chunk = chunk->next) {
            chunk->sweep_epoch = 0;
            for (usize index = 0; index < chunk->next_block; index++) {
                MalGcBlock *block =
                    (MalGcBlock *) ((u8 *) chunk->base + index * MAL_GC_BLOCK_SIZE);
                block->sweep_epoch = 0;
            }
        }
        heap->sweep_epoch = 1;
    }
    memset(heap->cell_free, 0, sizeof(heap->cell_free));
    // Black allocations during sweep are already OLD and accounted for by the
    // sweep cursor or mal_gc_count_black, so they need no minor enrollment.
    mal_gc_clear_young_blocks(heap);
    mal_gc_clear_young_large(heap);
    // Walk only the chunks that exist NOW: chunks prepended during the sweep sit
    // ahead of this cursor in the (newest-first) list, hold only black-allocated
    // mid-cycle cells, and so are never garbage this cycle. The head chunk's
    // block count is bounded (a full chunk triggers a fresh prepended head), so the
    // walk terminates even as the mutator allocates.
    heap->sweep_chunk = heap->chunks;
    heap->sweep_block = 0;
    heap->sweep_large = heap->large;
    heap->sweep_live_bytes = 0;
    heap->sweeping = true;
}

bool mal_heap_sweep_step(MalHeap *heap, MalHeapFinalizeFn finalize, usize max_blocks) {
    if (!heap->sweeping) {
        return true;
    }
    usize data_offset = mal_gc_cell_data_offset();
    usize free_offset = mal_gc_free_next_offset();
    usize swept = 0;
    while (heap->sweep_chunk != nullptr) {
        MalGcChunk *chunk = heap->sweep_chunk;
        while (heap->sweep_block < chunk->next_block) {
            if (swept >= max_blocks) {
                return false; // budget spent; more blocks remain
            }
            MalGcBlock *block =
                (MalGcBlock *) ((u8 *) chunk->base + heap->sweep_block * MAL_GC_BLOCK_SIZE);
            heap->sweep_block++;
            swept++;
            if (block->kind != MAL_GC_BLOCK_CELL || block->recycled) {
                block->sweep_epoch = heap->sweep_epoch;
                continue;
            }
            mal_heap_sweep_block(heap, block, finalize, data_offset, free_offset, &heap->sweep_live_bytes);
            block->sweep_epoch = heap->sweep_epoch;
        }
        chunk->sweep_epoch = heap->sweep_epoch;
        heap->sweep_chunk = chunk->next;
        heap->sweep_block = 0;
    }
    while (heap->sweep_large != nullptr) {
        if (swept >= max_blocks) return false;
        MalGcLarge *large = heap->sweep_large;
        heap->sweep_large = large->next;
        if (mal_gc_sweep_large(heap, large, finalize, true)) heap->sweep_live_bytes += large->size;
        swept++;
    }
    // Cursor exhausted: the whole heap is swept.
    heap->live_bytes = heap->sweep_live_bytes;
    heap->sweeping = false;
    return true;
}

void mal_heap_walk_cells(MalHeap *heap, MalHeapFinalizeFn visit) {
    usize data_offset = mal_gc_cell_data_offset();
    for (MalGcChunk *chunk = heap->chunks; chunk != nullptr; chunk = chunk->next) {
        for (usize block_index = 0; block_index < chunk->next_block; ++block_index) {
            MalGcBlock *block = (MalGcBlock *) ((u8 *) chunk->base + block_index * MAL_GC_BLOCK_SIZE);
            if (block->kind != MAL_GC_BLOCK_CELL) {
                continue;
            }
            for (u8 *cell = (u8 *) block + data_offset; cell + block->cell_size <= block->bump;
                cell += block->cell_size) {
                visit((MalHeapHeader *) cell);
            }
        }
    }
    for (MalGcLarge *large = heap->large; large != nullptr; large = large->next) {
        visit((MalHeapHeader *) ((u8 *) large + mal_gc_large_data_offset()));
    }
}

static usize mal_gc_raw_capacity(MalHeap *heap, const void *ptr, MalGcLarge **large_out) {
    if (mal_gc_ptr_in_chunks(heap, ptr)) {
        const MalGcBlock *block = (const MalGcBlock *) ((uptr) ptr & ~(uptr) (MAL_GC_BLOCK_SIZE - 1));
        if (block->kind != MAL_GC_BLOCK_RAW) abort();
        if (large_out != nullptr) *large_out = nullptr;
        return block->cell_size;
    }
    MalGcLarge *large = (MalGcLarge *) ((const u8 *) ptr - mal_gc_large_data_offset());
    if (large->kind != MAL_GC_BLOCK_RAW) abort();
    if (large_out != nullptr) *large_out = large;
    return large->size;
}

usize mal_heap_raw_capacity(MalHeap *heap, const void *ptr) {
    return mal_gc_raw_capacity(heap, ptr, nullptr);
}

void gc_free_raw(MalHeap *heap, void *ptr) {
    if (ptr == nullptr) {
        return;
    }
    if (mal_gc_ptr_in_chunks(heap, ptr)) {
        // In-block RAW cell: the block is recovered by masking to BLOCK_SIZE
        // alignment. Decrement the block's live count; when it hits zero the whole
        // block is empty and its pages go back to the OS (recycled for any
        // class/kind) instead of pinning them on a free list forever.
        MalGcBlock *block = (MalGcBlock *) ((uptr) ptr & ~(uptr) (MAL_GC_BLOCK_SIZE - 1));
        block->live--;
        if (block->live == 0) {
            if (heap->raw_blocks[block->size_class] == block) {
                heap->raw_blocks[block->size_class] = nullptr; // stop bumping into it
            }
            if (block->on_partial) {
                // Unlink from the doubly-linked partial list (O(1); may be a middle
                // node, hence the back-pointer rather than a global-list scan).
                if (block->prev_free != nullptr) {
                    block->prev_free->next_free = block->next_free;
                } else {
                    heap->raw_partial[block->size_class] = block->next_free;
                }
                if (block->next_free != nullptr) {
                    block->next_free->prev_free = block->prev_free;
                }
                block->on_partial = 0;
            }
            mal_gc_recycle_block(heap, block);
            return;
        }
        // Still has live cells: thread this cell onto the block's OWN free list (link
        // at offset 0 — RAW cells carry no header) and put the block on its class's
        // partial list so the allocator reuses the cell before bumping a fresh one.
        *(void **) ptr = block->free_list;
        block->free_list = ptr;
        if (!block->on_partial) {
            block->on_partial = 1;
            block->prev_free = nullptr;
            block->next_free = heap->raw_partial[block->size_class];
            if (block->next_free != nullptr) {
                block->next_free->prev_free = block;
            }
            heap->raw_partial[block->size_class] = block;
        }
        return;
    }
    // Large-object buffer: unlink its record from the LOS list and free it.
    MalGcLarge *target = (MalGcLarge *) ((u8 *) ptr - mal_gc_large_data_offset());
    if (target->kind != MAL_GC_BLOCK_RAW) abort();
    mal_gc_unlink_large(&heap->raw_large, target);
    free(target);
}

void *gc_realloc_raw(MalHeap *heap, void *ptr, usize new_size) {
    return gc_realloc_raw_profiled(
        heap, ptr, new_size, MAL_PROFILE_ALLOCATION_FAMILY_UNKNOWN);
}

void *gc_realloc_raw_profiled(MalHeap *heap, void *ptr, usize new_size, u8 profile_family) {
    void *grown = mal_heap_try_realloc_raw_profiled(heap, ptr, new_size, profile_family);
    if (grown == nullptr) abort();
    return grown;
}

void *mal_heap_try_realloc_raw_profiled(
    MalHeap *heap, void *ptr, usize new_size, u8 profile_family
) {
    if (ptr == nullptr) {
        return mal_heap_try_alloc_raw_profiled(heap, new_size, profile_family);
    }
    // Recover the current cell's byte capacity (size-class cell size for an in-block
    // cell, recorded payload size for a LOS record) to decide whether the request
    // still fits and how much content to carry over.
    MalGcLarge *large;
    usize old_size = mal_gc_raw_capacity(heap, ptr, &large);
    if (new_size <= old_size) {
        return ptr; // fits the current cell already (grow within slack, or a shrink)
    }
    if (large != nullptr) {
        // LOS records have no managed identity; libc can grow or remap them without
        // copying the payload. Capture links before realloc can release the record.
        if (large->kind != MAL_GC_BLOCK_RAW) abort();
        usize offset = mal_gc_large_data_offset();
        if (new_size > SIZE_MAX - offset) return nullptr;
#if MAL_PERF_STATS
        if (heap->fail_next_raw_allocation) {
            heap->fail_next_raw_allocation = false;
            return nullptr;
        }
#endif
        MalGcLarge *previous = large->prev;
        MalGcLarge *next = large->next;
        MalGcLarge *grown = realloc(large, offset + new_size);
        if (grown == nullptr) return nullptr;
        grown->size = new_size;
        if (previous != nullptr) previous->next = grown;
        else heap->raw_large = grown;
        if (next != nullptr) next->prev = grown;
        heap->bytes_allocated += new_size;
        mal_heap_maybe_trigger_gc(heap);
        mal_heap_profile_allocation(
            heap, new_size, new_size, MAL_PROFILE_ALLOCATION_RAW_PAYLOAD,
            (MalProfileAllocationFamily) profile_family, MAL_PROFILE_OBJECT_TYPE_NONE);
        return (u8 *) grown + offset;
    }
    // A size-classed cell cannot grow in place; copy into a larger cell or LOS.
    void *fresh = mal_heap_try_alloc_raw_profiled(heap, new_size, profile_family);
    if (fresh == nullptr) return nullptr;
    memcpy(fresh, ptr, old_size); // old_size < new_size, so the copy stays in bounds
    gc_free_raw(heap, ptr);
    return fresh;
}
