#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "gc.h"
#include "heap.h"

typedef struct TestCell {
    MalHeapHeader header;
    u64 value;
} TestCell;

static void finalize_cell(MalHeapHeader *cell) {
    (void) cell;
}

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            printf("%s:%d CHECK FAIL: %s\n", __func__, __LINE__, #condition); \
            return false; \
        } \
    } while (0)

static bool warm_classes_charge_and_trim(void) {
    const usize classes[] = {
        16, 32, 48, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 448, 512,
        640, 768, 896, 1024, 1280, 1536, 1792, 2048, 2560, 3072, 3584, 4096,
        5120, 6144, 7168, 8192,
    };
    MalHeap heap;
    mal_heap_init(&heap, 0);
    heap.poison_on_free = getenv("MAL_GC_VERIFY") != nullptr;
    for (usize i = 0; i < countof(classes); i++) {
        usize requested = i == 0 ? 0 : classes[i - 1] + 1;
        CHECK(mal_heap_allocation_charge(requested) == classes[i]);
        u8 *first = mal_heap_alloc_raw(&heap, requested);
        memset(first, 0x51, classes[i]);
        gc_free_raw(&heap, first);
        MalHeapUsage empty = mal_heap_usage(&heap);
        CHECK(empty.raw_owned_bytes == 0);
        CHECK(empty.raw_warm_block_bytes == (i + 1) * 32768);
        usize charged = heap.bytes_allocated;
        heap.next_gc_at = charged + classes[i];
        mal_gc_poll = false;
        u8 *reused = mal_heap_alloc_raw(&heap, classes[i]);
        CHECK(reused == first && mal_gc_poll);
        CHECK(heap.bytes_allocated == charged + classes[i]);
        CHECK(mal_heap_raw_capacity(&heap, reused) == classes[i]);
        CHECK(mal_heap_usage(&heap).raw_owned_bytes == classes[i]);
        CHECK(mal_heap_usage(&heap).raw_warm_block_bytes == i * 32768);
        if (heap.poison_on_free) {
            for (usize j = sizeof(void *); j < classes[i]; j++) CHECK(reused[j] == 0xdf);
        }
        gc_free_raw(&heap, reused);
        heap.next_gc_at = SIZE_MAX;
    }
    CHECK(mal_heap_usage(&heap).raw_warm_block_bytes == 32768 * MAL_GC_NUM_SIZE_CLASSES);
    void *large = mal_heap_alloc_raw(&heap, 8193);
    CHECK(mal_heap_raw_capacity(&heap, large) == 8193);
    gc_free_raw(&heap, large);
    usize charged = heap.bytes_allocated;
    mal_heap_begin_major(&heap);
    mal_heap_sweep(&heap, finalize_cell);
    MalHeapUsage trimmed = mal_heap_usage(&heap);
    CHECK(trimmed.raw_owned_bytes == 0 && trimmed.raw_free_cell_bytes == 0);
    CHECK(trimmed.raw_warm_block_bytes == 0);
    CHECK(trimmed.recycled_block_bytes == 32768 * MAL_GC_NUM_SIZE_CLASSES);
    CHECK(heap.bytes_allocated == charged);
    void *small = mal_heap_alloc_raw(&heap, 96);
    gc_free_raw(&heap, small);
    mal_heap_begin_major(&heap);
    mal_heap_sweep_begin(&heap);
    CHECK(!mal_heap_sweep_step(&heap, finalize_cell, 1));
    CHECK(mal_heap_usage(&heap).raw_warm_block_bytes == 32768);
    CHECK(mal_heap_sweep_step(&heap, finalize_cell, (usize) -1));
    CHECK(mal_heap_usage(&heap).raw_warm_block_bytes == 0);
    CHECK(mal_heap_sweep_step(&heap, finalize_cell, 1));
    CHECK(mal_heap_usage(&heap).recycled_block_bytes == trimmed.recycled_block_bytes);
    mal_heap_free(&heap);
    mal_gc_poll = false;
    return true;
}

static bool partial_neighbors_preserve_live_buffers(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);
    heap.poison_on_free = getenv("MAL_GC_VERIFY") != nullptr;
    u8 *cells[12];
    MalGcBlock *owners[12];
    for (usize i = 0; i < countof(cells); i++) {
        cells[i] = mal_heap_alloc_raw(&heap, 8192);
        owners[i] = heap.raw_blocks[MAL_GC_NUM_SIZE_CLASSES - 1];
        memset(cells[i], (u8) (i + 1), 8192);
    }
    CHECK(owners[0] == owners[2] && owners[3] == owners[5]);
    CHECK(owners[6] == owners[8] && owners[9] == owners[11]);
    CHECK(owners[0] != owners[3] && owners[3] != owners[6] && owners[6] != owners[9]);
    const usize removed[] = {0, 3, 6, 4, 5, 1, 2};
    for (usize i = 0; i < countof(removed); i++) gc_free_raw(&heap, cells[removed[i]]);
    CHECK(mal_heap_usage(&heap).recycled_block_bytes == 2 * 32768);
    u8 *reused = mal_heap_alloc_raw(&heap, 8192);
    CHECK(reused == cells[6]);
    memset(reused, 7, 8192);
    for (usize i = 6; i < countof(cells); i++) {
        for (usize j = 0; j < 8192; j++) CHECK(cells[i][j] == i + 1);
    }
    gc_free_raw(&heap, cells[9]);
    gc_free_raw(&heap, cells[10]);
    gc_free_raw(&heap, cells[11]);
    CHECK(mal_heap_usage(&heap).raw_warm_block_bytes == 32768);
    gc_free_raw(&heap, cells[6]);
    gc_free_raw(&heap, cells[7]);
    gc_free_raw(&heap, cells[8]);
    CHECK(mal_heap_usage(&heap).recycled_block_bytes == 3 * 32768);
    CHECK(mal_heap_usage(&heap).raw_owned_bytes == 0);
    u8 *full_reuse[3];
    for (usize i = 0; i < countof(full_reuse); i++) {
        full_reuse[i] = mal_heap_alloc_raw(&heap, 8192);
        for (usize j = 0; j < i; j++) CHECK(full_reuse[i] != full_reuse[j]);
        memset(full_reuse[i], (u8) (i + 10), 8192);
    }
    for (usize i = 0; i < countof(full_reuse); i++) {
        for (usize j = 0; j < 8192; j++) CHECK(full_reuse[i][j] == i + 10);
        gc_free_raw(&heap, full_reuse[i]);
    }
    CHECK(mal_heap_usage(&heap).raw_warm_block_bytes == 32768);
    mal_heap_free(&heap);
    return true;
}

static int check_usage(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);
    MalHeapUsage initial = mal_heap_usage(&heap);
    usize raw_charge = mal_heap_allocation_charge(4096);
    void *first = mal_heap_alloc_raw(&heap, 4096);
    MalHeapUsage after_first = mal_heap_usage(&heap);
    void *second = mal_heap_alloc_raw(&heap, 4096);
    MalHeapUsage after_second = mal_heap_usage(&heap);
    if (after_first.chunk_mapped_bytes <= initial.chunk_mapped_bytes ||
        after_second.chunk_mapped_bytes != after_first.chunk_mapped_bytes ||
        after_second.unclaimed_chunk_bytes != after_first.unclaimed_chunk_bytes ||
        after_first.bump_free_bytes != after_second.bump_free_bytes + raw_charge) return 1;
    void *large = mal_heap_alloc_raw(&heap, 10000);
    MalHeapUsage usage = mal_heap_usage(&heap);
    if (usage.raw_owned_bytes != initial.raw_owned_bytes + 2 * raw_charge + 10000 ||
        usage.chunk_mapped_bytes != after_first.chunk_mapped_bytes) return 2;

    gc_free_raw(&heap, first);
    usage = mal_heap_usage(&heap);
    if (usage.raw_owned_bytes != initial.raw_owned_bytes + raw_charge + 10000 ||
        usage.raw_free_cell_bytes != initial.raw_free_cell_bytes + raw_charge) return 3;
    first = mal_heap_alloc_raw(&heap, 4096);
    usage = mal_heap_usage(&heap);
    if (usage.raw_owned_bytes != initial.raw_owned_bytes + 2 * raw_charge + 10000 ||
        usage.raw_free_cell_bytes != initial.raw_free_cell_bytes ||
        usage.bump_free_bytes != after_second.bump_free_bytes) return 4;

    large = gc_realloc_raw(&heap, large, 9000);
    if (mal_heap_usage(&heap).raw_owned_bytes !=
        initial.raw_owned_bytes + 2 * raw_charge + 10000) return 5;
    large = gc_realloc_raw(&heap, large, 12000);
    if (mal_heap_usage(&heap).raw_owned_bytes !=
        initial.raw_owned_bytes + 2 * raw_charge + 12000) return 6;
    gc_free_raw(&heap, first);
    gc_free_raw(&heap, second);
    gc_free_raw(&heap, large);
    usage = mal_heap_usage(&heap);
    if (usage.raw_owned_bytes != initial.raw_owned_bytes ||
        usage.raw_free_cell_bytes != initial.raw_free_cell_bytes + 2 * raw_charge ||
        usage.raw_warm_block_bytes != 32768 ||
        usage.recycled_block_bytes != initial.recycled_block_bytes ||
        usage.chunk_mapped_bytes != after_first.chunk_mapped_bytes ||
        usage.unclaimed_chunk_bytes != after_first.unclaimed_chunk_bytes) return 7;

    mal_heap_begin_major(&heap);
    mal_heap_sweep(&heap, finalize_cell);
    usage = mal_heap_usage(&heap);
    if (usage.raw_warm_block_bytes != 0 || usage.raw_free_cell_bytes != 0 ||
        usage.recycled_block_bytes != initial.recycled_block_bytes + 32768) return 13;

    TestCell *live = mal_heap_alloc(&heap, sizeof(TestCell), MAL_HEAP_BIGINT);
    usage = mal_heap_usage(&heap);
    if (usage.recycled_block_bytes != initial.recycled_block_bytes ||
        usage.chunk_mapped_bytes != after_first.chunk_mapped_bytes ||
        usage.unclaimed_chunk_bytes != after_first.unclaimed_chunk_bytes) return 8;
    mal_heap_alloc(&heap, sizeof(TestCell), MAL_HEAP_BIGINT);
    mal_heap_begin_major(&heap);
    live->header.mark = heap.mark_color | MAL_MARK_OLD;
    mal_heap_sweep(&heap, finalize_cell);
    usage = mal_heap_usage(&heap);
    if (usage.managed_free_cell_bytes != mal_heap_allocation_charge(sizeof(TestCell))) return 9;
    mal_heap_begin_major(&heap);
    live->header.mark = heap.mark_color | MAL_MARK_OLD;
    mal_heap_sweep_begin(&heap);
    if (mal_heap_usage(&heap).managed_free_cell_bytes != 0) return 10;
    if (!mal_heap_sweep_step(&heap, finalize_cell, (usize) -1)) return 11;
    if (mal_heap_usage(&heap).managed_free_cell_bytes !=
        mal_heap_allocation_charge(sizeof(TestCell))) return 12;

    mal_heap_free(&heap);
    return 0;
}

int main(void) {
    int result = check_usage();
    if (result != 0) return result;
    if (!warm_classes_charge_and_trim() || !partial_neighbors_preserve_live_buffers()) return 1;
    puts("gc-heap-usage PASS");
    return 0;
}
