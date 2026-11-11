#include "./heap.h"

#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#if !defined(__wasi__)
#include <pthread.h>
#endif

#include "./gc.h"
#include "./gc_process.h"
#include "./array_buffer_object.h"
#include "./array_object.h"
#include "./function_object.h"
#include "./heap_string.h"
#include "./iterator_object.h"
#include "./object.h"
#include "./perf_stats.h"
#include "./profile.h"
#include "./shape.h"

static _Atomic(u64) g_next_heap_identity = 1;

#if defined(__wasi__)
bool mal_heap_every_dead_cell_finalizes = false;
#else
_Atomic bool mal_heap_every_dead_cell_finalizes = false;
#endif

static inline bool mal_heap_finalizes_every_dead_cell(const MalHeap *heap) {
#if defined(__wasi__)
    return heap->finalize_every_dead_cell || mal_heap_every_dead_cell_finalizes;
#else
    return heap->finalize_every_dead_cell ||
        atomic_load_explicit(&mal_heap_every_dead_cell_finalizes, memory_order_relaxed);
#endif
}
/* Each pinned mutator binds header initialization to its own heap's major color. */

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
    if (heap->bytes_allocated >= heap->next_gc_at) mal_isolate_request_poll(mal_isolate_locals());
}

void mal_heap_charge_external(MalHeap *heap, usize bytes) {
    mal_gc_process_charge(bytes);
    heap->bytes_allocated += bytes;
    mal_heap_maybe_trigger_gc(heap);
}

#define MAL_GC_CHUNK_SIZE (2u * 1024u * 1024u)

typedef enum MalGcBlockKind {
    MAL_GC_BLOCK_CELL,
    MAL_GC_BLOCK_RAW,
} MalGcBlockKind;

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
    u8 finalized; /* teardown already ran its finalizer */
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

/* Cell starts per size class, by alignment unit within a block. */
static u64 g_class_cell_starts[MAL_GC_NUM_SIZE_CLASSES][MAL_GC_BLOCK_WORDS];
/* Concurrent isolates may allocate first at the same time; the table is published once. */
static _Atomic bool g_tables_ready = false;

static void mal_gc_build_tables(void) {
    for (usize size_class = 0; size_class < MAL_GC_NUM_SIZE_CLASSES; size_class++) {
        u32 cell_size = g_class_cell_size[size_class];
        if (mal_heap_size_class(cell_size) != size_class) abort();
        for (usize offset = mal_gc_cell_data_offset(); offset + cell_size <= MAL_GC_BLOCK_SIZE;
            offset += cell_size) {
            usize unit = offset / MAL_GC_CELL_ALIGN;
            g_class_cell_starts[size_class][unit / 64] |= UINT64_C(1) << (unit % 64);
        }
    }
    atomic_store_explicit(&g_tables_ready, true, memory_order_release);
}

static void mal_gc_ensure_tables(void) {
    if (atomic_load_explicit(&g_tables_ready, memory_order_acquire)) return;
#if defined(__wasi__)
    mal_gc_build_tables();
#else
    static pthread_once_t once = PTHREAD_ONCE_INIT;
    if (pthread_once(&once, mal_gc_build_tables) != 0) abort();
#endif
}

usize mal_heap_allocation_charge(usize alloc_size) {
    usize size = alloc_size == 0 ? 1 : alloc_size;
    if (size > MAL_GC_LARGE_THRESHOLD) {
        return size;
    }
    return g_class_cell_size[mal_heap_size_class(size)];
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
        uptr *bases = realloc(heap->chunk_bases, next_capacity * sizeof(uptr));
        if (bases == nullptr) {
            return false;
        }
        heap->chunk_bases = bases;
        heap->chunk_capacity = next_capacity;
    }

    uptr base = (uptr) chunk->base;
    usize low = 0;
    usize high = heap->chunk_count;
    while (low < high) {
        usize middle = low + (high - low) / 2;
        if (heap->chunk_bases[middle] < base) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    memmove(&heap->chunk_index[low + 1], &heap->chunk_index[low],
        (heap->chunk_count - low) * sizeof(MalGcChunk *));
    memmove(&heap->chunk_bases[low + 1], &heap->chunk_bases[low],
        (heap->chunk_count - low) * sizeof(uptr));
    heap->chunk_index[low] = chunk;
    heap->chunk_bases[low] = base;
    heap->chunk_count++;
    return true;
}

static MalGcChunk *mal_gc_new_chunk(MalHeap *heap) {
#if MAL_PERF_STATS
    if (heap->fail_next_chunk_allocation) {
        heap->fail_next_chunk_allocation = false;
        return nullptr;
    }
#endif
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
    heap->current_usage.chunk_mapped_bytes += mmap_size;
    mal_gc_process_charge(mmap_size);
    return chunk;
}

static void mal_gc_trim_empty_raw_blocks(MalHeap *heap);

static void mal_gc_raw_partial_unlink(MalHeap *heap, MalGcBlock *block) {
    if (!block->on_partial) return;
    if (block->prev_free != nullptr) block->prev_free->next_free = block->next_free;
    else heap->raw_partial[block->size_class] = block->next_free;
    if (block->next_free != nullptr) block->next_free->prev_free = block->prev_free;
    block->next_free = nullptr;
    block->prev_free = nullptr;
    block->on_partial = 0;
}

#if !defined(__wasi__)
static int mal_gc_advise_block_payload(MalGcBlock *block, int advice);
#endif

static MalGcBlock *mal_gc_new_block(MalHeap *heap, u16 size_class, u8 kind) {
    MalGcChunk *chunk = nullptr;
    if (heap->free_blocks == nullptr) {
        chunk = heap->chunks;
        if (chunk == nullptr || chunk->next_block >= chunk->block_count) {
            chunk = mal_gc_new_chunk(heap);
            if (chunk == nullptr) {
                // Idle reserves must not turn recoverable allocation pressure into OOM.
                mal_gc_trim_empty_raw_blocks(heap);
                if (heap->free_blocks == nullptr) return nullptr;
            }
        }
    }
    MalGcBlock *recycled = heap->free_blocks;
    u8 *block_base;
    u64 sweep_epoch;
    if (recycled != nullptr) {
        heap->free_blocks = recycled->next_free;
        block_base = (u8 *) recycled;
        sweep_epoch = recycled->sweep_epoch;
#if defined(__APPLE__) && defined(MADV_FREE_REUSABLE) && defined(MADV_FREE_REUSE)
        // Reused payload is charged as active before any allocator writes reach it.
        mal_gc_advise_block_payload(recycled, MADV_FREE_REUSE);
#endif
    } else {
        block_base = (u8 *) chunk->base + chunk->next_block * MAL_GC_BLOCK_SIZE;
        chunk->next_block++;
        sweep_epoch = chunk->sweep_epoch;
    }

    MalGcBlock *block = (MalGcBlock *) block_base;
    block->kind = kind;
    block->on_young = 0;
    block->recycled = 0;
    block->on_partial = 0;
    block->size_class = size_class;
    block->scan_word = 0;
    block->cell_size = g_class_cell_size[size_class];
    block->live = 0;
    block->young_count = 0;
    block->sweep_epoch = sweep_epoch;
    block->free_list = nullptr;
    block->next_free = nullptr;
    block->prev_free = nullptr;
    block->next_young = nullptr;
    block->bump = block_base + mal_gc_cell_data_offset();
    block->limit = block_base + MAL_GC_BLOCK_SIZE;
    memset(block->young_cells, 0, sizeof(block->young_cells));
    memset(block->finalizable, 0, sizeof(block->finalizable));
    if (kind == MAL_GC_BLOCK_CELL) {
        memcpy(block->free_cells, g_class_cell_starts[size_class], sizeof(block->free_cells));
    } else {
        memset(block->free_cells, 0, sizeof(block->free_cells));
    }
    return block;
}

static void mal_gc_clear_young_blocks(MalHeap *heap) {
    MalGcBlock *block = heap->young_blocks;
    heap->young_blocks = nullptr;
    while (block != nullptr) {
        MalGcBlock *next = block->next_young;
        block->on_young = 0;
        block->next_young = nullptr;
        block->young_count = 0;
        memset(block->young_cells, 0, sizeof(block->young_cells));
        block = next;
    }
}

static void mal_gc_cell_block_available(MalHeap *heap, MalGcBlock *block) {
    if (block->on_partial) return;
    block->on_partial = 1;
    block->next_free = heap->cell_avail[block->size_class];
    heap->cell_avail[block->size_class] = block;
}

/* A major rebuilds the lists from its sweep; blocks it recycles must not stay linked. */
static void mal_gc_clear_cell_avail(MalHeap *heap) {
    for (usize size_class = 0; size_class < MAL_GC_NUM_SIZE_CLASSES; size_class++) {
        MalGcBlock *block = heap->cell_avail[size_class];
        heap->cell_avail[size_class] = nullptr;
        while (block != nullptr) {
            MalGcBlock *next = block->next_free;
            block->on_partial = 0;
            block->next_free = nullptr;
            block = next;
        }
    }
}

/* Freed cells reuse lowest addresses first, so each class rescans its current block. */
static void mal_gc_rescan_current_blocks(MalHeap *heap) {
    for (usize size_class = 0; size_class < MAL_GC_NUM_SIZE_CLASSES; size_class++) {
        if (heap->cell_blocks[size_class] != nullptr) heap->cell_blocks[size_class]->scan_word = 0;
    }
}

static void mal_gc_untrack_young_large(MalHeap *heap, MalGcLarge *rec) {
    if (rec->young_prev != nullptr) {
        rec->young_prev->young_next = rec->young_next;
    } else if (heap->young_large == rec) {
        heap->young_large = rec->young_next;
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

/* Whether a dead cell owns storage by its type and current state. Block cells carry
 * the answer in their finalizable bit; large cells and the verifier ask here. */
static bool mal_heap_dead_cell_finalizes(const MalHeap *heap, const MalHeapHeader *cell) {
    if (mal_heap_finalizes_every_dead_cell(heap) || mal_heap_type_finalizes_at_birth(cell->type)) {
        return true;
    }
    switch (cell->type) {
        case MAL_HEAP_OBJECT:
        case MAL_HEAP_FUNCTION_OBJECT:
            return mal_object_finalizes((const MalObject *) cell);
        case MAL_HEAP_ARRAY_OBJECT: {
            const MalArrayObject *array = (const MalArrayObject *) cell;
            return (array->elements != nullptr && !mal_array_object_elements_inline(array)) ||
                mal_object_finalizes(&array->object);
        }
        case MAL_HEAP_STRING: {
            MalStringStorage storage = ((const MalString *) cell)->storage;
            return storage == MAL_STRING_STORAGE_OWNED ||
                storage == MAL_STRING_STORAGE_PREPARED_UTF8 ||
                storage == MAL_STRING_STORAGE_BUILDER;
        }
        case MAL_HEAP_ITERATOR_OBJECT: {
            const MalIteratorObject *iterator = (const MalIteratorObject *) cell;
            return iterator->collection_pinned || mal_object_finalizes(&iterator->object);
        }
        case MAL_HEAP_NATIVE_FUNCTION_OBJECT: {
            const MalNativeFunctionObject *function = (const MalNativeFunctionObject *) cell;
            return (function->slots != nullptr && !function->slots_inline) ||
                mal_object_finalizes(&function->object);
        }
        case MAL_HEAP_ARRAY_BUFFER_OBJECT: {
            const MalArrayBufferObject *buffer = (const MalArrayBufferObject *) cell;
            return mal_array_buffer_object_owns_storage(buffer) ||
                mal_object_finalizes(&buffer->object);
        }
        default:
            return false;
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
    if (mal_heap_dead_cell_finalizes(heap, header)) finalize(header);
    if (heap->current_usage.managed_owned_bytes < rec->size ||
        heap->current_usage.managed_large_bytes < rec->size) abort();
    heap->current_usage.managed_owned_bytes -= rec->size;
    heap->current_usage.managed_large_bytes -= rec->size;
    mal_gc_process_release(mal_gc_large_data_offset() + rec->size);
    free(rec);
    return false;
}

/* A black cell behind the sweep cursor needs immediate survivor accounting. */
static inline void mal_gc_count_black(MalHeap *heap, MalGcBlock *block, u8 kind, usize size) {
    if (kind == MAL_GC_BLOCK_CELL && heap->black_alloc) {
        heap->black_alloc_bytes += size;
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
#if !defined(__wasi__)
    if (kind == MAL_GC_BLOCK_CELL) memset((u8 *) rec + offset, 0, size);
#endif
    rec->size = size;
    rec->kind = kind;
    rec->accounted = 0;
    rec->finalized = 0;
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
    if (kind == MAL_GC_BLOCK_CELL) {
        heap->current_usage.managed_owned_bytes += size;
        heap->current_usage.managed_large_bytes += size;
    } else {
        heap->current_usage.raw_owned_bytes += size;
    }
    mal_gc_process_charge(offset + size);
    mal_gc_count_black(heap, nullptr, kind, size);
    mal_heap_maybe_trigger_gc(heap);
    return (u8 *) rec + offset;
}

/* Charge and enroll one word of free cells, then hand them to the class cursor.
 * Accounting that depends on the collector's state is settled here and undone for
 * unused cells by mal_heap_retire_cursors, which runs before that state changes. */
static void mal_gc_claim_word(MalHeap *heap, MalGcBlock *block, usize word, u64 bits) {
    block->free_cells[word] = 0;
    u32 cell_size = block->cell_size;
    u32 count = (u32) __builtin_popcountll(bits);
    usize bytes = (usize) count * cell_size;
    if (!heap->black_alloc) {
        block->young_cells[word] |= bits;
        block->young_count += count;
        if (!block->on_young) {
            block->on_young = 1;
            block->next_young = heap->young_blocks;
            heap->young_blocks = block;
        }
    } else {
        heap->black_alloc_bytes += bytes;
        if (heap->sweeping && block->sweep_epoch == heap->sweep_epoch) {
            heap->sweep_live_bytes += bytes;
            block->live += count;
        }
    }
    heap->bytes_allocated += bytes;
    heap->current_usage.managed_owned_bytes += bytes;
    heap->cell_cursors[block->size_class] = (MalHeapCellCursor) {
        .bits = bits, .block = block, .word_offset = word * 64 * MAL_GC_CELL_ALIGN};
    mal_heap_maybe_trigger_gc(heap);
}

void mal_heap_retire_cursors(MalHeap *heap) {
    for (usize size_class = 0; size_class < MAL_GC_NUM_SIZE_CLASSES; size_class++) {
        MalHeapCellCursor *cursor = &heap->cell_cursors[size_class];
        u64 rest = cursor->bits;
        if (rest == 0) continue;
        cursor->bits = 0;
        MalGcBlock *block = cursor->block;
        usize word = cursor->word_offset / (64 * MAL_GC_CELL_ALIGN);
        u32 count = (u32) __builtin_popcountll(rest);
        usize bytes = (usize) count * block->cell_size;
        block->free_cells[word] |= rest;
        block->finalizable[word] &= ~rest;
        if (!heap->black_alloc) {
            block->young_cells[word] &= ~rest;
            block->young_count -= count;
        } else {
            heap->black_alloc_bytes -= bytes;
            if (heap->sweeping && block->sweep_epoch == heap->sweep_epoch) {
                heap->sweep_live_bytes -= bytes;
                block->live -= count;
            }
        }
        // `bytes_allocated` stays monotonic; the unused claim only advances the trigger.
        heap->current_usage.managed_owned_bytes -= bytes;
        if (block->scan_word > word) block->scan_word = (u16) word;
    }
}

static bool mal_gc_refill_cells(MalHeap *heap, u32 size_class) {
    MalGcBlock *block = heap->cell_blocks[size_class];
    for (;;) {
        if (block != nullptr) {
            for (usize word = block->scan_word; word < MAL_GC_BLOCK_WORDS; word++) {
                u64 bits = block->free_cells[word];
                if (bits != 0) {
                    block->scan_word = (u16) (word + 1);
                    mal_gc_claim_word(heap, block, word, bits);
                    return true;
                }
            }
            block->scan_word = MAL_GC_BLOCK_WORDS;
        }
        block = heap->cell_avail[size_class];
        if (block != nullptr) {
            heap->cell_avail[size_class] = block->next_free;
            block->next_free = nullptr;
            block->on_partial = 0;
            block->scan_word = 0;
        } else {
            block = mal_gc_new_block(heap, (u16) size_class, MAL_GC_BLOCK_CELL);
            if (block == nullptr) return false;
        }
        heap->cell_blocks[size_class] = block;
    }
}

/* A managed cell with an initialized header and zeroed payload, or nullptr when memory
 * is exhausted. */
static MalHeapHeader *mal_gc_alloc_cell(MalHeap *heap, usize size, MalHeapType type) {
    if (size == 0) size = 1;
    if (size > MAL_GC_LARGE_THRESHOLD) {
        MalHeapHeader *cell = mal_gc_alloc_large(heap, size, MAL_GC_BLOCK_CELL);
        if (cell == nullptr) return nullptr;
        cell->type = type;
        cell->storage = MAL_HEAP_STORAGE_DYNAMIC;
#if defined(__wasi__)
        cell->mark = heap->alloc_mark;
#else
        atomic_store_explicit(&cell->mark, heap->alloc_mark, memory_order_relaxed);
#endif
        cell->dirty = MAL_REMEMBERED_CLEAN;
        return cell;
    }
    u32 size_class = mal_heap_size_class(size);
    MalHeapCellCursor *cursor = &heap->cell_cursors[size_class];
    if (cursor->bits == 0 && !mal_gc_refill_cells(heap, size_class)) return nullptr;
    u64 bits = cursor->bits;
    cursor->bits = bits & (bits - 1);
    MalHeapHeader *cell = mal_heap_block_cell_at(
        cursor->block, cursor->word_offset + (usize) __builtin_ctzll(bits) * MAL_GC_CELL_ALIGN);
    mal_heap_cell_init(heap, cell, type, g_class_cell_size[size_class]);
    return cell;
}

/* RAW cells carry their free link at offset 0; both lists are empty until something is
 * reclaimed, so an uncollected run is still pure bump allocation. */
static inline __attribute__((always_inline)) void *mal_gc_alloc_raw_in_class(
    MalHeap *heap, u16 size_class
) {
    if (heap->raw_partial[size_class] != nullptr) {
        MalGcBlock *partial = heap->raw_partial[size_class];
        void *cell = partial->free_list;
        partial->free_list = *(void **) cell;
        partial->live++;
        if (partial->free_list == nullptr) {
            mal_gc_raw_partial_unlink(heap, partial);
        }
        heap->bytes_allocated += g_class_cell_size[size_class];
        heap->current_usage.raw_owned_bytes += g_class_cell_size[size_class];
        mal_heap_maybe_trigger_gc(heap);
        return cell;
    }

    MalGcBlock *block = heap->raw_blocks[size_class];
    if (block == nullptr || block->bump + block->cell_size > block->limit) return nullptr;

    void *cell = block->bump;
    block->bump += block->cell_size;
    block->live++; // per-block live count drives empty-block reclamation
    heap->bytes_allocated += block->cell_size;
    heap->current_usage.raw_owned_bytes += block->cell_size;
    mal_heap_maybe_trigger_gc(heap);
    return cell;
}

static __attribute__((noinline)) void *mal_gc_alloc_raw_slow(MalHeap *heap, usize size) {
    if (size == 0) {
        size = 1;
    }
    if (size > MAL_GC_LARGE_THRESHOLD) {
        return mal_gc_alloc_large(heap, size, MAL_GC_BLOCK_RAW);
    }
    u16 size_class = (u16) mal_heap_size_class(size);
    void *cell = mal_gc_alloc_raw_in_class(heap, size_class);
    if (cell != nullptr) return cell;
    MalGcBlock *block = mal_gc_new_block(heap, size_class, MAL_GC_BLOCK_RAW);
    if (block == nullptr) return nullptr;
    heap->raw_blocks[size_class] = block;
    return mal_gc_alloc_raw_in_class(heap, size_class);
}

/* Reclaimed cells and the current block's bump serve nearly every RAW allocation
 * without a call; block refills and large buffers go out of line. */
static inline __attribute__((always_inline)) void *mal_gc_alloc_raw(MalHeap *heap, usize size) {
    if (size - 1 < MAL_GC_LARGE_THRESHOLD) {
        void *cell = mal_gc_alloc_raw_in_class(heap, (u16) mal_heap_size_class(size));
        if (cell != nullptr) return cell;
    }
    return mal_gc_alloc_raw_slow(heap, size);
}

void mal_heap_init(MalHeap *heap, usize capacity) {
    (void) capacity; // the block allocator sizes itself; capacity is now advisory
    mal_gc_ensure_tables();
    heap->chunks = nullptr;
    heap->raw_lookup_chunk = nullptr;
    heap->chunk_index = nullptr;
    heap->chunk_bases = nullptr;
    heap->chunk_count = 0;
    heap->chunk_capacity = 0;
    heap->large = nullptr;
    heap->raw_large = nullptr;
    heap->young_large = nullptr;
    heap->mark_color = 0;
    heap->black_alloc = false;
    heap->alloc_mark = 0;
    heap->black_alloc_bytes = 0;
    memset(heap->cell_cursors, 0, sizeof(heap->cell_cursors));
    memset(heap->cell_blocks, 0, sizeof(heap->cell_blocks));
    memset(heap->raw_blocks, 0, sizeof(heap->raw_blocks));
    memset(heap->cell_avail, 0, sizeof(heap->cell_avail));
    memset(heap->raw_partial, 0, sizeof(heap->raw_partial));
    heap->free_blocks = nullptr;
    heap->young_blocks = nullptr;
    heap->bytes_allocated = 0;
    heap->current_usage = (MalHeapCurrentUsage) {0};
    heap->next_gc_at = (usize) -1;
    heap->poison_on_free = false;
    heap->finalize_every_dead_cell = true;
    heap->live_bytes = 0;
    heap->gc_stats = false;
    heap->minor_cells_inspected = 0;
    heap->minor_blocks_inspected = 0;
    mal_shape_heap_init(heap);
    heap->native_function_length_key = nullptr;
    heap->native_function_name_key = nullptr;
    memset(heap->function_metadata_shapes, 0, sizeof(heap->function_metadata_shapes));
    memset(heap->for_in_silent_prototypes, 0, sizeof(heap->for_in_silent_prototypes));
    memset(heap->fixed_constructor_prototypes, 0, sizeof(heap->fixed_constructor_prototypes));
    memset(heap->json_plain_shapes, 0, sizeof(heap->json_plain_shapes));
    memset(heap->json_plain_prototypes, 0, sizeof(heap->json_plain_prototypes));
    heap->json_plain_prototype_next = 0;
    heap->fixed_constructor_next = 0;
    heap->for_in_silent_next = 0;
    do {
        heap->identity = atomic_fetch_add(&g_next_heap_identity, 1);
    } while (heap->identity == 0);
    heap->epoch = 0;
	heap->fail_next_cell_allocation = false;
#if MAL_PERF_STATS
    heap->fail_next_raw_allocation = false;
    heap->fail_next_chunk_allocation = false;
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
        mal_gc_process_release(chunk->mmap_size);
        free(chunk);
        chunk = next;
    }
    free(heap->chunk_index);
    free(heap->chunk_bases);
    MalGcLarge *large = heap->large;
    while (large != nullptr) {
        MalGcLarge *next = large->next;
        mal_gc_process_release(mal_gc_large_data_offset() + large->size);
        free(large);
        large = next;
    }
    large = heap->raw_large;
    while (large != nullptr) {
        MalGcLarge *next = large->next;
        mal_gc_process_release(mal_gc_large_data_offset() + large->size);
        free(large);
        large = next;
    }
    heap->chunks = nullptr;
    heap->raw_lookup_chunk = nullptr;
    heap->chunk_index = nullptr;
    heap->chunk_bases = nullptr;
    heap->chunk_count = 0;
    heap->chunk_capacity = 0;
    heap->large = nullptr;
    heap->raw_large = nullptr;
    heap->young_large = nullptr;
    heap->sweep_large = nullptr;
    memset(heap->cell_cursors, 0, sizeof(heap->cell_cursors));
    memset(heap->cell_blocks, 0, sizeof(heap->cell_blocks));
    memset(heap->raw_blocks, 0, sizeof(heap->raw_blocks));
    memset(heap->cell_avail, 0, sizeof(heap->cell_avail));
    memset(heap->raw_partial, 0, sizeof(heap->raw_partial));
    heap->free_blocks = nullptr; // the blocks themselves are freed via the chunks above
    heap->young_blocks = nullptr;
    heap->bytes_allocated = 0;
    heap->current_usage = (MalHeapCurrentUsage) {0};
    heap->next_gc_at = (usize) -1;
    heap->poison_on_free = false;
    heap->finalize_every_dead_cell = true;
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
            } else {
                const u64 *starts = g_class_cell_starts[block->size_class];
                for (usize word = 0; word < MAL_GC_BLOCK_WORDS; word++) {
                    usize allocated =
                        (usize) __builtin_popcountll(starts[word] & ~block->free_cells[word]);
                    usize free = (usize) __builtin_popcountll(block->free_cells[word]);
                    usage.managed_owned_bytes += allocated * block->cell_size;
                    usage.managed_free_cell_bytes += free * block->cell_size;
                }
            }
        }
    }
    for (const MalGcLarge *large = heap->raw_large; large != nullptr; large = large->next) {
        usage.raw_owned_bytes += large->size;
    }
    for (const MalGcLarge *large = heap->large; large != nullptr; large = large->next) {
        usage.managed_owned_bytes += large->size;
        usage.managed_large_bytes += large->size;
    }
    for (usize size_class = 0; size_class < MAL_GC_NUM_SIZE_CLASSES; ++size_class) {
        // Claimed cells are out of the bitmap but not yet handed out.
        usize claimed = (usize) __builtin_popcountll(heap->cell_cursors[size_class].bits) *
            g_class_cell_size[size_class];
        usage.managed_owned_bytes -= claimed;
        usage.managed_free_cell_bytes += claimed;
        const MalGcBlock *raw_block = heap->raw_blocks[size_class];
        if (raw_block != nullptr) {
            if (raw_block->live == 0) usage.raw_warm_block_bytes += MAL_GC_BLOCK_SIZE;
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

MalHeapCurrentUsage mal_heap_current_usage(const MalHeap *heap) {
    MalHeapCurrentUsage usage = heap->current_usage;
    // Claims charge whole bitmap words; cells still in a cursor are not handed out.
    for (usize size_class = 0; size_class < MAL_GC_NUM_SIZE_CLASSES; size_class++) {
        usage.managed_owned_bytes -= (usize) __builtin_popcountll(heap->cell_cursors[size_class].bits) *
            g_class_cell_size[size_class];
    }
    return usage;
}

void mal_heap_array_buffer_acquire(MalHeap *heap, usize bytes) {
    if (bytes > SIZE_MAX - heap->current_usage.array_buffer_bytes) abort();
    heap->current_usage.array_buffer_bytes += bytes;
}

void mal_heap_array_buffer_release(MalHeap *heap, usize bytes) {
    if (bytes > heap->current_usage.array_buffer_bytes) abort();
    heap->current_usage.array_buffer_bytes -= bytes;
}

void mal_heap_header_init_detached(MalHeapHeader *header, MalHeapType type) {
    header->type = type;
    header->storage = MAL_HEAP_STORAGE_DYNAMIC;
#if defined(__wasi__)
    header->mark = 0;
#else
    atomic_store_explicit(&header->mark, 0, memory_order_relaxed);
#endif
    header->dirty = 0;
}

static void mal_heap_update_alloc_mark(MalHeap *heap) {
    heap->alloc_mark = heap->mark_color | (heap->black_alloc ? MAL_MARK_OLD : 0);
}

void mal_heap_begin_major(MalHeap *heap) {
    mal_heap_retire_cursors(heap);
    heap->mark_color ^= MAL_MARK_COLOR;
    mal_heap_update_alloc_mark(heap);
}

void mal_heap_set_black_alloc(MalHeap *heap, bool black_alloc) {
    mal_heap_retire_cursors(heap);
    heap->black_alloc = black_alloc;
    mal_heap_update_alloc_mark(heap);
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
#if MAL_PRIMORDIALS_LOCKED
        case MAL_HEAP_PROMISE_ALL_STATE:
#endif
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
        case MAL_HEAP_FFI_HANDLE_OBJECT:
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

void *mal_heap_try_alloc_slow(MalHeap *heap, usize alloc_size, MalHeapType type) {
    if (heap->fail_next_cell_allocation) {
        heap->fail_next_cell_allocation = false;
        return nullptr;
    }
    MalHeapHeader *cell = mal_gc_alloc_cell(heap, alloc_size, type);
    if (cell != nullptr) {
        mal_heap_profile_allocation(
            heap, alloc_size, mal_heap_allocation_charge(alloc_size),
            MAL_PROFILE_ALLOCATION_MANAGED_CELL, mal_profile_family_for_heap_type(type),
            (u8) type);
    }
    return cell;
}

void *mal_heap_alloc_slow(MalHeap *heap, usize alloc_size, MalHeapType type) {
    MalHeapHeader *cell = mal_gc_alloc_cell(heap, alloc_size, type);
    if (cell == nullptr) abort();
    mal_heap_profile_allocation(
        heap, alloc_size, mal_heap_allocation_charge(alloc_size),
        MAL_PROFILE_ALLOCATION_MANAGED_CELL, mal_profile_family_for_heap_type(type),
        (u8) type);
    return cell;
}

void *mal_heap_alloc_raw(MalHeap *heap, usize alloc_size) {
    return mal_heap_alloc_raw_profiled(
        heap, alloc_size, MAL_PROFILE_ALLOCATION_FAMILY_UNKNOWN);
}

void *mal_heap_alloc_raw_profiled(MalHeap *heap, usize alloc_size, u8 profile_family) {
    void *ptr = mal_gc_alloc_raw(heap, alloc_size);
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
    void *ptr = mal_gc_alloc_raw(heap, alloc_size);
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
        if (heap->chunk_bases[middle] <= address) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }
    if (low > 0 && address - heap->chunk_bases[low - 1] < MAL_GC_CHUNK_SIZE) {
        heap->raw_lookup_chunk = heap->chunk_index[low - 1];
        return true;
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

#ifdef MADV_FREE
#define MAL_GC_MADV_DISCARD MADV_FREE
#else
#define MAL_GC_MADV_DISCARD MADV_DONTNEED
#endif

#if !defined(__wasi__)
static int mal_gc_advise_block_payload(MalGcBlock *block, int advice) {
    usize page = mal_gc_page_size();
    uptr start = ((uptr) block + mal_gc_cell_data_offset() + (page - 1)) & ~(uptr) (page - 1);
    uptr end = (uptr) block + MAL_GC_BLOCK_SIZE;
    return end > start ? madvise((void *) start, (usize) (end - start), advice) : 0;
}
#endif

/* Preserve the header and free-list metadata; only complete payload pages can
 * become undefined. Darwin's reusable advice also removes idle payload from
 * physical-footprint accounting, paired with REUSE before the next payload write. */
static void mal_gc_recycle_block(MalHeap *heap, MalGcBlock *block) {
#if !defined(__wasi__)
#if defined(__APPLE__) && defined(MADV_FREE_REUSABLE) && defined(MADV_FREE_REUSE)
    if (mal_gc_advise_block_payload(block, MADV_FREE_REUSABLE) != 0)
#endif
        mal_gc_advise_block_payload(block, MAL_GC_MADV_DISCARD);
#endif
    block->bump = (u8 *) block + mal_gc_cell_data_offset();
    block->free_list = nullptr;
    block->recycled = 1;
    block->next_free = heap->free_blocks;
    heap->free_blocks = block;
}

static void mal_gc_trim_empty_raw_blocks(MalHeap *heap) {
    for (usize size_class = 0; size_class < MAL_GC_NUM_SIZE_CLASSES; size_class++) {
        MalGcBlock *block = heap->raw_blocks[size_class];
        if (block == nullptr || block->live != 0) continue;
        heap->raw_blocks[size_class] = nullptr;
        mal_gc_raw_partial_unlink(heap, block);
        mal_gc_recycle_block(heap, block);
    }
}

/* Stomp a reclaimed cell's payload with a recognizable pattern. 0xDF bytes decode, as
 * a NaN-boxed MalValue, to a non-finite double far from any valid pointer or int, so a
 * use-after-free read fails loudly instead of silently aliasing. */
static inline void mal_gc_poison_cell(u8 *cell, u32 cell_size, usize start) {
    if (cell_size > start) {
        memset(cell + start, 0xDF, cell_size - start);
    }
}

/* Finalize the owners among one word's dead cells and return them all to the bitmap.
 * Verification also proves no dead cell without the finalizable bit owned anything. */
static void mal_heap_settle_dead(
    MalHeap *heap, MalGcBlock *block, usize word, u64 dead, MalHeapFinalizeFn finalize
) {
    u64 owners = mal_heap_finalizes_every_dead_cell(heap) ? dead : dead & block->finalizable[word];
    if (heap->poison_on_free) {
        for (u64 rest = dead & ~owners; rest != 0; rest &= rest - 1) {
            MalHeapHeader *cell =
                mal_heap_block_cell(block, word * 64 + (usize) __builtin_ctzll(rest));
            if (mal_heap_dead_cell_finalizes(heap, cell)) {
                fprintf(stderr, "[gc verify] dead cell type=%d owns storage but never "
                    "reported mal_heap_cell_needs_finalizer\n", cell->type);
                abort();
            }
        }
    }
    for (; owners != 0; owners &= owners - 1) {
        finalize(mal_heap_block_cell(block, word * 64 + (usize) __builtin_ctzll(owners)));
    }
    if (heap->poison_on_free) {
        for (u64 rest = dead; rest != 0; rest &= rest - 1) {
            mal_gc_poison_cell((u8 *) mal_heap_block_cell(block, word * 64 + (usize) __builtin_ctzll(rest)),
                block->cell_size, sizeof(MalHeapHeader));
        }
    }
    block->finalizable[word] &= ~dead;
    block->free_cells[word] |= dead;
}

/* Sweep one managed block after a major mark: unmarked allocated cells die, survivors
 * become old, and a block with no survivor returns its pages to the OS. Shared by the
 * full and incremental sweeps. */
static void mal_heap_sweep_block(
    MalHeap *heap, MalGcBlock *block, MalHeapFinalizeFn finalize, usize *live_bytes
) {
    if (block->kind != MAL_GC_BLOCK_CELL || block->recycled) {
        return;
    }
    const u64 *starts = g_class_cell_starts[block->size_class];
    usize block_live = 0;
    usize dead_count = 0;
    bool any_free = false;
    for (usize word = 0; word < MAL_GC_BLOCK_WORDS; word++) {
        u64 allocated = starts[word] & ~block->free_cells[word];
        u64 dead = 0;
            for (u64 rest = allocated; rest != 0; rest &= rest - 1) {
            u32 bit = (u32) __builtin_ctzll(rest);
            MalHeapHeader *header = mal_heap_block_cell(block, word * 64 + bit);
            u8 mark = mal_heap_sweep_mark_load(header);
            if (mal_heap_mark_is_current(mark, heap->mark_color)) {
                // Marking has completed before the mutator owns sweep.
                mal_heap_sweep_mark_store(header, mark | MAL_MARK_OLD);
                block_live++;
            } else {
                dead |= UINT64_C(1) << bit;
            }
        }
        if (dead != 0) {
            mal_heap_settle_dead(heap, block, word, dead, finalize);
            dead_count += (usize) __builtin_popcountll(dead);
        }
        any_free |= block->free_cells[word] != 0;
    }
    usize freed = dead_count * block->cell_size;
    if (heap->current_usage.managed_owned_bytes < freed) abort();
    heap->current_usage.managed_owned_bytes -= freed;
    block->live = (u32) block_live;
    *live_bytes += block_live * block->cell_size;
    if (block_live == 0) {
        mal_gc_recycle_block(heap, block);
        if (heap->cell_blocks[block->size_class] == block) {
            heap->cell_blocks[block->size_class] = nullptr;
        }
    } else if (any_free) {
        mal_gc_cell_block_available(heap, block);
    }
}

void mal_heap_sweep(MalHeap *heap, MalHeapFinalizeFn finalize) {
    mal_heap_retire_cursors(heap);
    // A cell may be freed (below) and its address later reused, so any identity cache
    // keyed on a raw cell pointer is only valid within one epoch (see MalHeap.epoch).
    heap->epoch++;
    mal_perf_collection_epoch(heap->epoch);
    mal_gc_clear_young_blocks(heap);
    mal_gc_clear_young_large(heap);
    mal_gc_clear_cell_avail(heap);
    usize live_bytes = 0;

    for (MalGcChunk *chunk = heap->chunks; chunk != nullptr; chunk = chunk->next) {
        for (usize block_index = 0; block_index < chunk->next_block; ++block_index) {
            MalGcBlock *block = (MalGcBlock *) ((u8 *) chunk->base + block_index * MAL_GC_BLOCK_SIZE);
            mal_heap_sweep_block(heap, block, finalize, &live_bytes);
        }
    }

    MalGcLarge *large = heap->large;
    while (large != nullptr) {
        MalGcLarge *next = large->next;
        if (mal_gc_sweep_large(heap, large, finalize, true)) live_bytes += large->size;
        large = next;
    }

    heap->live_bytes = live_bytes;
    mal_gc_trim_empty_raw_blocks(heap);
    mal_gc_rescan_current_blocks(heap);
}

void mal_heap_sweep_minor(MalHeap *heap, MalHeapFinalizeFn finalize) {
    mal_heap_retire_cursors(heap);
    heap->epoch++;
    mal_perf_collection_epoch(heap->epoch);
    MalGcBlock *block = heap->young_blocks;
    heap->young_blocks = nullptr;
    while (block != nullptr) {
        MalGcBlock *next = block->next_young;
        block->on_young = 0;
        block->next_young = nullptr;
        // Marking cleared each survivor's young bit, so the bits left are the dead.
        usize dead_count = 0;
        for (usize word = 0; word < MAL_GC_BLOCK_WORDS; word++) {
            u64 dead = block->young_cells[word];
            if (dead == 0) continue;
            block->young_cells[word] = 0;
            mal_heap_settle_dead(heap, block, word, dead, finalize);
            dead_count += (usize) __builtin_popcountll(dead);
        }
        usize young = block->young_count;
        block->young_count = 0;
        if (heap->gc_stats) {
            heap->minor_blocks_inspected++;
            heap->minor_cells_inspected += young;
        }
        if (dead_count > young) abort();
        usize freed = dead_count * block->cell_size;
        if (heap->current_usage.managed_owned_bytes < freed) abort();
        heap->current_usage.managed_owned_bytes -= freed;
        usize survivors = young - dead_count;
        heap->live_bytes += survivors * block->cell_size;
        block->live += (u32) survivors;
        if (dead_count != 0) mal_gc_cell_block_available(heap, block);
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
    mal_gc_rescan_current_blocks(heap);
}

void mal_heap_sweep_begin(MalHeap *heap) {
    mal_heap_retire_cursors(heap);
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
    // Swept blocks rejoin the lists as the cursor passes them.
    mal_gc_clear_cell_avail(heap);
    // Black allocations during sweep are already OLD and accounted for by the
    // sweep cursor or the claim, so they need no minor enrollment.
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
    mal_heap_retire_cursors(heap);
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
            mal_heap_sweep_block(heap, block, finalize, &heap->sweep_live_bytes);
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
    mal_gc_trim_empty_raw_blocks(heap);
    mal_gc_rescan_current_blocks(heap);
    heap->sweeping = false;
    return true;
}

void mal_heap_walk_cells(MalHeap *heap, MalHeapFinalizeFn visit) {
    mal_heap_retire_cursors(heap);
    for (MalGcChunk *chunk = heap->chunks; chunk != nullptr; chunk = chunk->next) {
        for (usize block_index = 0; block_index < chunk->next_block; ++block_index) {
            MalGcBlock *block = (MalGcBlock *) ((u8 *) chunk->base + block_index * MAL_GC_BLOCK_SIZE);
            if (block->kind != MAL_GC_BLOCK_CELL || block->recycled) {
                continue;
            }
            const u64 *starts = g_class_cell_starts[block->size_class];
            for (usize word = 0; word < MAL_GC_BLOCK_WORDS; word++) {
                            for (u64 rest = starts[word] & ~block->free_cells[word]; rest != 0;
                    rest &= rest - 1) {
                    visit(mal_heap_block_cell(block, word * 64 + (usize) __builtin_ctzll(rest)));
                }
            }
        }
    }
    for (MalGcLarge *large = heap->large; large != nullptr; large = large->next) {
        visit((MalHeapHeader *) ((u8 *) large + mal_gc_large_data_offset()));
    }
}

void mal_heap_finalize_all(MalHeap *heap, MalHeapFinalizeFn finalize) {
    mal_heap_retire_cursors(heap);
    for (MalGcChunk *chunk = heap->chunks; chunk != nullptr; chunk = chunk->next) {
        for (usize block_index = 0; block_index < chunk->next_block; ++block_index) {
            MalGcBlock *block = (MalGcBlock *) ((u8 *) chunk->base + block_index * MAL_GC_BLOCK_SIZE);
            if (block->kind != MAL_GC_BLOCK_CELL || block->recycled) {
                continue;
            }
            const u64 *starts = g_class_cell_starts[block->size_class];
            for (usize word = 0; word < MAL_GC_BLOCK_WORDS; word++) {
                u64 allocated = starts[word] & ~block->free_cells[word];
                            for (u64 rest = allocated; rest != 0; rest &= rest - 1) {
                    finalize(mal_heap_block_cell(block, word * 64 + (usize) __builtin_ctzll(rest)));
                }
                block->free_cells[word] |= allocated;
                block->finalizable[word] = 0;
                block->young_cells[word] = 0;
            }
        }
    }
    for (MalGcLarge *large = heap->large; large != nullptr; large = large->next) {
        if (large->finalized) continue;
        large->finalized = 1;
        finalize((MalHeapHeader *) ((u8 *) large + mal_gc_large_data_offset()));
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
        MalGcBlock *block = (MalGcBlock *) ((uptr) ptr & ~(uptr) (MAL_GC_BLOCK_SIZE - 1));
        if (heap->current_usage.raw_owned_bytes < block->cell_size) abort();
        heap->current_usage.raw_owned_bytes -= block->cell_size;
        block->live--;
        if (block->live == 0 && heap->raw_blocks[block->size_class] != block) {
            mal_gc_raw_partial_unlink(heap, block);
            mal_gc_recycle_block(heap, block);
            return;
        }
        // Only the current block can stay empty; free-list reuse precedes bump growth.
        if (heap->poison_on_free) mal_gc_poison_cell(ptr, block->cell_size, sizeof(void *));
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
    if (heap->current_usage.raw_owned_bytes < target->size) abort();
    heap->current_usage.raw_owned_bytes -= target->size;
    mal_gc_unlink_large(&heap->raw_large, target);
    mal_gc_process_release(mal_gc_large_data_offset() + target->size);
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
        heap->current_usage.raw_owned_bytes += new_size - old_size;
        mal_gc_process_charge(new_size - old_size);
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

#if !defined(__wasi__)
struct MalHeapLargeRange {
    uptr start;
    uptr end;
};

static int mal_heap_large_range_compare(const void *left, const void *right) {
    uptr a = ((const MalHeapLargeRange *) left)->start;
    uptr b = ((const MalHeapLargeRange *) right)->start;
    return a < b ? -1 : a > b ? 1 : 0;
}

void mal_heap_cell_index_init(MalHeap *heap, MalHeapCellIndex *index) {
    mal_heap_retire_cursors(heap);
    index->heap = heap;
    index->chunk_low = heap->chunk_count == 0 ? 0 : heap->chunk_bases[0];
    index->chunk_high = heap->chunk_count == 0
        ? 0 : heap->chunk_bases[heap->chunk_count - 1] + MAL_GC_CHUNK_SIZE;
    usize count = 0;
    for (const MalGcLarge *large = heap->large; large != nullptr; large = large->next) count++;
    index->large = count == 0 ? nullptr : malloc(count * sizeof(MalHeapLargeRange));
    if (count != 0 && index->large == nullptr) abort();
    index->large_count = count;
    usize next = 0;
    for (const MalGcLarge *large = heap->large; large != nullptr; large = large->next) {
        uptr start = (uptr) large + mal_gc_large_data_offset();
        index->large[next++] = (MalHeapLargeRange) {.start = start, .end = start + large->size};
    }
    if (count > 1) qsort(index->large, count, sizeof(MalHeapLargeRange), mal_heap_large_range_compare);
}

void mal_heap_cell_index_free(MalHeapCellIndex *index) {
    free(index->large);
    index->large = nullptr;
    index->large_count = 0;
}

MalHeapHeader *mal_heap_cell_index_find(const MalHeapCellIndex *index, uptr address) {
    const MalHeap *heap = index->heap;
    if (address >= index->chunk_low && address < index->chunk_high) {
        usize low = 0;
        usize high = heap->chunk_count;
        while (low < high) {
            usize middle = low + (high - low) / 2;
            if (heap->chunk_bases[middle] <= address) low = middle + 1;
            else high = middle;
        }
        if (low > 0 && address - heap->chunk_bases[low - 1] < MAL_GC_CHUNK_SIZE) {
            const MalGcChunk *chunk = heap->chunk_index[low - 1];
            usize block_index = (address - (uptr) chunk->base) / MAL_GC_BLOCK_SIZE;
            if (block_index >= chunk->next_block) return nullptr;
            const MalGcBlock *block =
                (const MalGcBlock *) ((u8 *) chunk->base + block_index * MAL_GC_BLOCK_SIZE);
            if (block->kind != MAL_GC_BLOCK_CELL || block->recycled) return nullptr;
            uptr data = (uptr) block + mal_gc_cell_data_offset();
            if (address < data) return nullptr;
            uptr cell = data + (address - data) / block->cell_size * block->cell_size;
            if (cell + block->cell_size > (uptr) block + MAL_GC_BLOCK_SIZE) return nullptr;
            usize unit = (cell - (uptr) block) / MAL_GC_CELL_ALIGN;
            if ((block->free_cells[unit / 64] >> (unit % 64)) & 1) return nullptr;
            return (MalHeapHeader *) cell;
        }
    }
    usize low = 0;
    usize high = index->large_count;
    while (low < high) {
        usize middle = low + (high - low) / 2;
        if (index->large[middle].start <= address) low = middle + 1;
        else high = middle;
    }
    if (low == 0 || address >= index->large[low - 1].end) return nullptr;
    return (MalHeapHeader *) index->large[low - 1].start;
}
#endif
