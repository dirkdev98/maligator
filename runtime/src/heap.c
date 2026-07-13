#include "./heap.h"

#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#include "./gc.h"

/* Request an auto-collection once the heap has grown to the trigger. The poll is
 * honored at the next safepoint; mal_gc_next_at is SIZE_MAX when auto-collection
 * is off (stress mode, MAL_GC_OFF, or before mal_gc_init), so this never fires. */
static inline void mal_heap_maybe_trigger_gc(const MalHeap *heap) {
    if (heap->bytes_allocated >= mal_gc_next_at) {
        mal_gc_poll = true;
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
    u8 age;         /* generational age (Phase 5); 0 for now */
    u8 recycled;    /* on the heap free-block list: fully swept, pages madvised away,
                     * bump reset. The sweep skips it (so it is not re-recycled) until
                     * mal_gc_new_block reclaims it. */
    u8 on_partial;  /* RAW only: block is currently on heap->raw_partial[size_class]
                     * (has reclaimable free cells). Guards double-linking and tells
                     * gc_free_raw whether to unlink when the block empties. */
    u16 size_class; /* index into g_class_cell_size */
    u32 cell_size;  /* bytes per cell in this block */
    u32 live;       /* RAW only: cells handed out and not yet freed. Reaches 0 when the
                     * block is fully empty, the trigger to recycle it to the OS. */
    u8 *bump;       /* next unallocated byte */
    u8 *limit;      /* one past the last usable byte (block_base + BLOCK_SIZE) */
    void *free_list; /* reclaimed cells (Phase 3 sweep / gc_free_raw); intrusive */
    /* Intrusive links: heap->free_blocks (recycled, singly linked via next_free) OR
     * heap->raw_partial[size_class] (RAW partial blocks, doubly linked). A block is
     * on at most one list at a time, so the two uses never overlap. */
    struct MalGcBlock *next_free;
    struct MalGcBlock *prev_free;
};

struct MalGcChunk {
    void *base;          /* BLOCK_SIZE-aligned, CHUNK_SIZE usable bytes */
    void *mmap_base;     /* original mmap address (for munmap) */
    usize mmap_size;     /* original mmap length */
    usize next_block;    /* index of the next unused block in this chunk */
    usize block_count;   /* CHUNK_SIZE / BLOCK_SIZE */
    struct MalGcChunk *next;
};

struct MalGcLarge {
    struct MalGcLarge *next;
    usize size; /* payload bytes */
    u8 kind;    /* MalGcBlockKind */
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

static MalGcChunk *mal_gc_new_chunk(MalHeap *heap) {
    void *mmap_base;
    usize mmap_size;
    void *base = mal_gc_aligned_mmap(MAL_GC_CHUNK_SIZE, MAL_GC_BLOCK_SIZE, &mmap_base, &mmap_size);
    if (base == nullptr) {
        abort(); // out of address space; the runtime has no OOM recovery path
    }
    MalGcChunk *chunk = malloc(sizeof(MalGcChunk));
    if (chunk == nullptr) {
        abort();
    }
    chunk->base = base;
    chunk->mmap_base = mmap_base;
    chunk->mmap_size = mmap_size;
    chunk->block_count = MAL_GC_CHUNK_SIZE / MAL_GC_BLOCK_SIZE;
    chunk->next_block = 0;
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
    if (recycled != nullptr) {
        heap->free_blocks = recycled->next_free;
        block_base = (u8 *) recycled;
    } else {
        MalGcChunk *chunk = heap->chunks;
        if (chunk == nullptr || chunk->next_block >= chunk->block_count) {
            chunk = mal_gc_new_chunk(heap);
        }
        block_base = (u8 *) chunk->base + chunk->next_block * MAL_GC_BLOCK_SIZE;
        chunk->next_block++;
    }

    MalGcBlock *block = (MalGcBlock *) block_base;
    block->kind = kind;
    block->age = 0;
    block->recycled = 0;
    block->on_partial = 0;
    block->size_class = size_class;
    block->cell_size = g_class_cell_size[size_class];
    block->live = 0;
    block->free_list = nullptr;
    block->next_free = nullptr;
    block->prev_free = nullptr;
    block->bump = block_base + mal_gc_cell_data_offset();
    block->limit = block_base + MAL_GC_BLOCK_SIZE;
    return block;
}

/* Count bytes born BLACK (over-tenured) when black allocation is active — a CELL
 * cell created during a concurrent cycle. Folds to nothing off-concurrent. */
#if MAL_GC_CONCURRENT
static inline void mal_gc_count_black(u8 kind, usize size) {
    if (kind == MAL_GC_BLOCK_CELL && mal_gc_black_alloc) {
        mal_gc_black_alloc_bytes += size;
    }
}
#else
#define mal_gc_count_black(kind, size) ((void) 0)
#endif

static void *mal_gc_alloc_large(MalHeap *heap, usize size, u8 kind) {
    MalGcLarge *rec = malloc(mal_gc_large_data_offset() + size);
    if (rec == nullptr) {
        abort();
    }
    rec->size = size;
    rec->kind = kind;
    rec->next = heap->large;
    heap->large = rec;
    heap->bytes_allocated += size;
    mal_gc_count_black(kind, size);
    mal_heap_maybe_trigger_gc(heap);
    return (u8 *) rec + mal_gc_large_data_offset();
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
        heap->bytes_allocated += g_class_cell_size[size_class];
        mal_gc_count_black(kind, g_class_cell_size[size_class]);
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
        *current = block;
    }

    void *cell = block->bump;
    block->bump += block->cell_size;
    if (kind == MAL_GC_BLOCK_RAW) {
        block->live++; // per-block live count drives empty-block reclamation
    }
    heap->bytes_allocated += block->cell_size;
    mal_gc_count_black(kind, block->cell_size);
    mal_heap_maybe_trigger_gc(heap);
    return cell;
}

void mal_heap_init(MalHeap *heap, usize capacity) {
    (void) capacity; // the block allocator sizes itself; capacity is now advisory
    mal_gc_ensure_tables();
    heap->chunks = nullptr;
    heap->large = nullptr;
    memset(heap->cell_blocks, 0, sizeof(heap->cell_blocks));
    memset(heap->raw_blocks, 0, sizeof(heap->raw_blocks));
    memset(heap->cell_free, 0, sizeof(heap->cell_free));
    memset(heap->raw_partial, 0, sizeof(heap->raw_partial));
    heap->free_blocks = nullptr;
    heap->bytes_allocated = 0;
    heap->live_bytes = 0;
#if MAL_GC_CONCURRENT
    heap->sweep_chunk = nullptr;
    heap->sweep_block = 0;
    heap->sweep_live_bytes = 0;
    heap->sweeping = false;
#endif
#if MAL_REALMS
    // Set once the VM creates its initial realm (mal_realm_switch). Null until then,
    // and no function object is allocated before that point.
    heap->current_realm = nullptr;
#endif
}

void mal_heap_free(MalHeap *heap) {
    MalGcChunk *chunk = heap->chunks;
    while (chunk != nullptr) {
        MalGcChunk *next = chunk->next;
        munmap(chunk->mmap_base, chunk->mmap_size);
        free(chunk);
        chunk = next;
    }
    MalGcLarge *large = heap->large;
    while (large != nullptr) {
        MalGcLarge *next = large->next;
        free(large);
        large = next;
    }
    heap->chunks = nullptr;
    heap->large = nullptr;
    memset(heap->cell_blocks, 0, sizeof(heap->cell_blocks));
    memset(heap->raw_blocks, 0, sizeof(heap->raw_blocks));
    memset(heap->cell_free, 0, sizeof(heap->cell_free));
    memset(heap->raw_partial, 0, sizeof(heap->raw_partial));
    heap->free_blocks = nullptr; // the blocks themselves are freed via the chunks above
    heap->bytes_allocated = 0;
    heap->live_bytes = 0;
}

void mal_heap_header_init(MalHeapHeader *header, MalHeapType type) {
    header->type = type;
    header->storage = MAL_HEAP_STORAGE_DYNAMIC;
    // A fresh cell is young (WHITE) — unless black allocation is active (a cell
    // created during a concurrent cycle is born BLACK so it is not swept this
    // cycle). mal_gc_black_alloc folds to a compile-time 0 off-concurrent, so the
    // ternary collapses to MAL_MARK_WHITE and this stays behaviour-identical.
    header->mark = mal_gc_black_alloc ? MAL_MARK_BLACK : MAL_MARK_WHITE;
#if MAL_GC_GENERATIONAL
    header->dirty = 0; // not on the remembered set
#endif
}

MalHeapType mal_heap_header_type(const MalHeapHeader *header) {
    return header->type;
}

void *mal_heap_alloc(MalHeap *heap, usize alloc_size, MalHeapType type) {
    void *ptr = mal_gc_alloc(heap, alloc_size, MAL_GC_BLOCK_CELL);
    mal_heap_header_init(ptr, type);
    return ptr;
}

void *mal_heap_alloc_raw(MalHeap *heap, usize alloc_size) {
    return mal_gc_alloc(heap, alloc_size, MAL_GC_BLOCK_RAW);
}

static bool mal_gc_ptr_in_chunks(const MalHeap *heap, const void *ptr) {
    for (const MalGcChunk *chunk = heap->chunks; chunk != nullptr; chunk = chunk->next) {
        const u8 *base = (const u8 *) chunk->base;
        if ((const u8 *) ptr >= base && (const u8 *) ptr < base + MAL_GC_CHUNK_SIZE) {
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
    usize page = mal_gc_page_size();
    uptr madv_start =
        ((uptr) block_base + mal_gc_cell_data_offset() + (page - 1)) & ~(uptr) (page - 1);
    uptr madv_end = (uptr) block_base + MAL_GC_BLOCK_SIZE;
    if (madv_end > madv_start) {
        madvise((void *) madv_start, (usize) (madv_end - madv_start), MAL_GC_MADV_REUSE);
    }
    block->bump = block_base + mal_gc_cell_data_offset(); // pristine: no live cells
    block->free_list = nullptr;
    block->recycled = 1;
    block->next_free = heap->free_blocks;
    heap->free_blocks = block;
}

bool mal_heap_poison_on_free = false;

bool mal_heap_sweep_sticky = false;

/* Stomp a reclaimed cell's payload past the free-list link with a recognizable
 * pattern (debug aid; see mal_heap_poison_on_free). 0xDF bytes decode, as a
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
        if (header->mark == MAL_MARK_BLACK) {
            // Survived. A normal (full) sweep resets it to WHITE for the next cycle;
            // a sticky sweep (generational minor, or a gen major after its WHITE
            // pre-pass, or the concurrent cycle) leaves it BLACK so it counts as old
            // next cycle and the minor mark skips re-tracing it.
            if (!mal_heap_sweep_sticky) {
                header->mark = MAL_MARK_WHITE;
            }
            *live_bytes += block->cell_size;
            block_live++;
            continue;
        }
        if (header->mark == MAL_MARK_WHITE) {
            // Unreached: dead. Finalize (frees its owned side allocations), then
            // tombstone so a later sweep does not finalize it again.
            finalize(header);
            header->mark = MAL_MARK_FREE;
            if (mal_heap_poison_on_free) {
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
    usize data_offset = mal_gc_cell_data_offset();
    usize free_offset = mal_gc_free_next_offset();

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

    heap->live_bytes = live_bytes;
}

#if MAL_GC_CONCURRENT
void mal_heap_sweep_begin(MalHeap *heap) {
    // Bump the epoch BEFORE any reclaimed cell can be handed back out (the ABA
    // guard for identity caches — see MalHeap.epoch). Clear the reclaimed-cell free
    // lists; the incremental step re-populates them per block as it sweeps. During
    // the gap the allocator carves fresh blocks (whose cells are black-allocated).
    heap->epoch++;
    memset(heap->cell_free, 0, sizeof(heap->cell_free));
    // Walk only the chunks that exist NOW: chunks prepended during the sweep sit
    // ahead of this cursor in the (newest-first) list, hold only black-allocated
    // mid-cycle cells, and so are never garbage this cycle. The head chunk's
    // block count is bounded (a full chunk triggers a fresh prepended head), so the
    // walk terminates even as the mutator allocates.
    heap->sweep_chunk = heap->chunks;
    heap->sweep_block = 0;
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
            if (block->kind != MAL_GC_BLOCK_CELL || block->recycled) {
                continue; // RAW / already-recycled: no work, no budget
            }
            mal_heap_sweep_block(heap, block, finalize, data_offset, free_offset, &heap->sweep_live_bytes);
            swept++;
        }
        heap->sweep_chunk = chunk->next;
        heap->sweep_block = 0;
    }
    // Cursor exhausted: the whole heap is swept.
    heap->live_bytes = heap->sweep_live_bytes;
    heap->sweeping = false;
    return true;
}
#endif

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
    MalGcLarge **link = &heap->large;
    while (*link != nullptr) {
        if (*link == target) {
            *link = target->next;
            free(target);
            return;
        }
        link = &(*link)->next;
    }
}

void *gc_realloc_raw(MalHeap *heap, void *ptr, usize new_size) {
    if (ptr == nullptr) {
        return mal_heap_alloc_raw(heap, new_size);
    }
    // Recover the current cell's byte capacity (size-class cell size for an in-block
    // cell, recorded payload size for a LOS record) to decide whether the request
    // still fits and how much content to carry over.
    usize old_size;
    if (mal_gc_ptr_in_chunks(heap, ptr)) {
        MalGcBlock *block = (MalGcBlock *) ((uptr) ptr & ~(uptr) (MAL_GC_BLOCK_SIZE - 1));
        old_size = block->cell_size;
    } else {
        MalGcLarge *rec = (MalGcLarge *) ((u8 *) ptr - mal_gc_large_data_offset());
        old_size = rec->size;
    }
    if (new_size <= old_size) {
        return ptr; // fits the current cell already (grow within slack, or a shrink)
    }
    // Outgrew the cell: RAW has no in-place grow, so alloc-new / copy / free-old.
    void *fresh = mal_heap_alloc_raw(heap, new_size);
    memcpy(fresh, ptr, old_size); // old_size < new_size, so the copy stays in bounds
    gc_free_raw(heap, ptr);
    return fresh;
}
