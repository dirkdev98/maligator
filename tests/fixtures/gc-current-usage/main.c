#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "gc.h"
#include "heap.h"

typedef struct TestCell {
    MalHeapHeader header;
    u64 value;
} TestCell;

static MalHeap *owner;
static usize walked_buffer_bytes;

static void count_buffer(MalHeapHeader *header) {
    if ((header->mark & MAL_MARK_FREE) != 0 ||
        header->type != MAL_HEAP_ARRAY_BUFFER_OBJECT) return;
    MalArrayBufferObject *buffer = (MalArrayBufferObject *) header;
    if (buffer->shared_memory == nullptr && buffer->data != nullptr) {
        walked_buffer_bytes += buffer->allocation_capacity;
    }
}

static bool matches_walk(MalHeap *heap) {
    MalHeapUsage walked = mal_heap_usage(heap);
    MalHeapCurrentUsage current = mal_heap_current_usage(heap);
    walked_buffer_bytes = 0;
    mal_heap_walk_cells(heap, count_buffer);
    if (current.managed_owned_bytes == walked.managed_owned_bytes &&
        current.raw_owned_bytes == walked.raw_owned_bytes &&
        current.managed_large_bytes == walked.managed_large_bytes &&
        current.chunk_mapped_bytes == walked.chunk_mapped_bytes &&
        current.array_buffer_bytes == walked_buffer_bytes) return true;
    fprintf(stderr, "current usage mismatch: managed=%zu/%zu raw=%zu/%zu large=%zu/%zu chunk=%zu/%zu buffer=%zu/%zu\n",
        current.managed_owned_bytes, walked.managed_owned_bytes,
        current.raw_owned_bytes, walked.raw_owned_bytes,
        current.managed_large_bytes, walked.managed_large_bytes,
        current.chunk_mapped_bytes, walked.chunk_mapped_bytes,
        current.array_buffer_bytes, walked_buffer_bytes);
    return false;
}

static void finalize_cell(MalHeapHeader *header) {
    if (header->type == MAL_HEAP_ARRAY_BUFFER_OBJECT) {
        mal_array_buffer_object_release_store(owner, (MalArrayBufferObject *) header);
    }
}

#define CHECK(condition) do { if (!(condition)) return __LINE__; } while (0)

static int exercise(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);
    heap.poison_on_free = getenv("MAL_GC_VERIFY") != nullptr;
    owner = &heap;
    CHECK(matches_walk(&heap));

    void *raw = mal_heap_alloc_raw(&heap, 64);
    void *large_raw = mal_heap_alloc_raw(&heap, 20000);
    CHECK(matches_walk(&heap));
    large_raw = gc_realloc_raw(&heap, large_raw, 30000);
    CHECK(matches_walk(&heap));
    gc_free_raw(&heap, raw);
    CHECK(matches_walk(&heap));
    raw = mal_heap_alloc_raw(&heap, 64);
    CHECK(matches_walk(&heap));
    gc_free_raw(&heap, raw);
    gc_free_raw(&heap, large_raw);
    CHECK(matches_walk(&heap));

    TestCell *first = mal_heap_alloc(&heap, sizeof(TestCell), MAL_HEAP_BIGINT);
    mal_heap_alloc(&heap, sizeof(TestCell), MAL_HEAP_BIGINT);
    CHECK(matches_walk(&heap));
    mal_heap_begin_major(&heap);
    first->header.mark = heap.mark_color | MAL_MARK_OLD;
    mal_heap_sweep(&heap, finalize_cell);
    CHECK(matches_walk(&heap));
    TestCell *reused = mal_heap_alloc(&heap, sizeof(TestCell), MAL_HEAP_BIGINT);
    CHECK(matches_walk(&heap));
    reused->header.mark = heap.mark_color | MAL_MARK_OLD;
    mal_heap_alloc(&heap, sizeof(TestCell), MAL_HEAP_BIGINT);
    CHECK(matches_walk(&heap));
    mal_heap_sweep_minor(&heap, finalize_cell);
    CHECK(matches_walk(&heap));
    mal_heap_alloc(&heap, 10000, MAL_HEAP_BIGINT);
    CHECK(matches_walk(&heap));
    mal_heap_begin_major(&heap);
    first->header.mark = heap.mark_color | MAL_MARK_OLD;
    reused->header.mark = heap.mark_color | MAL_MARK_OLD;
    mal_heap_sweep_begin(&heap);
    mal_gc_black_alloc = true;
    TestCell *black = mal_heap_alloc(&heap, sizeof(TestCell), MAL_HEAP_BIGINT);
    CHECK(mal_heap_mark_is_current(black->header.mark, heap.mark_color));
    CHECK(matches_walk(&heap));
    while (!mal_heap_sweep_step(&heap, finalize_cell, 1)) CHECK(matches_walk(&heap));
    mal_gc_black_alloc = false;
    CHECK(matches_walk(&heap));

    MalArrayBufferObject *buffer = mal_array_buffer_object_new(
        &heap, nullptr, 64, 128, true, false);
    CHECK(buffer->data != nullptr && matches_walk(&heap));
    CHECK(mal_array_buffer_object_resize(buffer, 16));
    CHECK(matches_walk(&heap));
    MalArrayBufferObject *moved = mal_array_buffer_object_move_store(
        &heap, nullptr, buffer, 8, 8, false, false);
    CHECK(buffer->detached && moved->allocation_capacity == 128 && matches_walk(&heap));
    mal_array_buffer_object_detach(&heap, moved);
    CHECK(matches_walk(&heap));

    byte *adopted_data = malloc(256);
    CHECK(adopted_data != nullptr);
    memset(adopted_data, 0x53, 256);
    MalArrayBufferObject *adopted = mal_array_buffer_object_adopt(
        &heap, nullptr, adopted_data, 256, false);
    CHECK(matches_walk(&heap));
    mal_array_buffer_object_detach(&heap, adopted);
    CHECK(matches_walk(&heap));
    MalArrayBufferObject *finalized = mal_array_buffer_object_new(
        &heap, nullptr, 512, 512, false, false);
    CHECK(finalized->data != nullptr && matches_walk(&heap));
    mal_heap_begin_major(&heap);
    mal_heap_sweep(&heap, finalize_cell);
    CHECK(matches_walk(&heap));

    mal_heap_free(&heap);
    MalHeapCurrentUsage empty = mal_heap_current_usage(&heap);
    CHECK(empty.managed_owned_bytes == 0 && empty.raw_owned_bytes == 0 &&
        empty.managed_large_bytes == 0 && empty.chunk_mapped_bytes == 0 &&
        empty.array_buffer_bytes == 0);
    return 0;
}

int main(void) {
    int result = exercise();
    if (result != 0) {
        fprintf(stderr, "gc-current-usage failed at line %d\n", result);
        return 1;
    }
    puts("gc-current-usage PASS");
    return 0;
}
