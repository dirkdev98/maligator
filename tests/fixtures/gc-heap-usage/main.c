#include <stdio.h>

#include "gc.h"
#include "heap.h"

typedef struct TestCell {
    MalHeapHeader header;
    u64 value;
} TestCell;

static void finalize_cell(MalHeapHeader *cell) {
    (void) cell;
}

int main(void) {
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
        usage.raw_free_cell_bytes != initial.raw_free_cell_bytes ||
        usage.recycled_block_bytes != initial.recycled_block_bytes + 32768 ||
        usage.chunk_mapped_bytes != after_first.chunk_mapped_bytes ||
        usage.unclaimed_chunk_bytes != after_first.unclaimed_chunk_bytes) return 7;

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
    puts("gc-heap-usage PASS");
    return 0;
}
