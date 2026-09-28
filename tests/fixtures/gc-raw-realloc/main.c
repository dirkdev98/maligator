#include <stdio.h>
#include <string.h>

#include "gc.h"
#include "heap.h"

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            printf("%s:%d CHECK FAIL: %s\n", __func__, __LINE__, #condition); \
            return false; \
        } \
    } while (0)

static bool all_bytes(const u8 *bytes, usize size, u8 value) {
    for (usize index = 0; index < size; index++) {
        if (bytes[index] != value) return false;
    }
    return true;
}

static bool grows_block_storage_into_large_storage(MalHeap *heap) {
    u8 *bytes = gc_realloc_raw(heap, nullptr, 80);
    memset(bytes, 0x39, 80);
    usize charged = heap->bytes_allocated;
    CHECK(gc_realloc_raw(heap, bytes, 64) == bytes);
    CHECK(gc_realloc_raw(heap, bytes, 80) == bytes);
    CHECK(heap->bytes_allocated == charged);
    bytes = gc_realloc_raw(heap, bytes, 20000);
    CHECK(all_bytes(bytes, 80, 0x39));
    CHECK(heap->bytes_allocated == charged + 20000);
    CHECK(mal_heap_usage(heap).raw_owned_bytes == 20000);
    memset(bytes, 0x71, 20000);

    heap->next_gc_at = heap->bytes_allocated + 25000;
    mal_gc_poll = false;
    bytes = gc_realloc_raw(heap, bytes, 30000);
    CHECK(all_bytes(bytes, 20000, 0x71));
    CHECK(mal_gc_poll);
    CHECK(heap->bytes_allocated == charged + 20000 + 30000);
    CHECK(mal_heap_usage(heap).raw_owned_bytes == 30000);
    charged = heap->bytes_allocated;
    CHECK(gc_realloc_raw(heap, bytes, 0) == bytes);
    CHECK(gc_realloc_raw(heap, bytes, 29000) == bytes);
    CHECK(heap->bytes_allocated == charged);
    CHECK(mal_heap_usage(heap).raw_owned_bytes == 30000);
    gc_free_raw(heap, bytes);
    CHECK(mal_heap_usage(heap).raw_owned_bytes == 0);
    heap->next_gc_at = SIZE_MAX;
    mal_gc_poll = false;
    return true;
}

static bool grows_and_frees_head_middle_and_tail_records(MalHeap *heap) {
    enum { count = 17 };
    u8 *buffers[count];
    usize sizes[count];
    usize owned = 0;
    for (usize index = 0; index < count; index++) {
        sizes[index] = 10000 + index * 4096;
        buffers[index] = mal_heap_alloc_raw(heap, sizes[index]);
        memset(buffers[index], (u8) (index + 1), sizes[index]);
        owned += sizes[index];
    }
    for (usize round = 0; round < 3; round++) {
        for (usize index = 0; index < count; index++) {
            usize chosen = (index * 7 + round) % count;
            usize grown = sizes[chosen] * 2 + 17;
            usize charged = heap->bytes_allocated;
            buffers[chosen] = gc_realloc_raw(heap, buffers[chosen], grown);
            CHECK(all_bytes(buffers[chosen], sizes[chosen], (u8) (chosen + 1)));
            CHECK(heap->bytes_allocated == charged + grown);
            memset(buffers[chosen] + sizes[chosen], (u8) (chosen + 1), grown - sizes[chosen]);
            owned += grown - sizes[chosen];
            sizes[chosen] = grown;
            CHECK(mal_heap_usage(heap).raw_owned_bytes == owned);
        }
    }
    for (usize index = 0; index < count; index++) {
        usize chosen = (index * 5) % count;
        CHECK(all_bytes(buffers[chosen], sizes[chosen], (u8) (chosen + 1)));
        gc_free_raw(heap, buffers[chosen]);
        owned -= sizes[chosen];
        CHECK(mal_heap_usage(heap).raw_owned_bytes == owned);
    }
    CHECK(heap->raw_large == nullptr);
    return true;
}

static bool heap_shutdown_owns_grown_records(MalHeap *heap) {
    u8 *first = mal_heap_alloc_raw(heap, 16384);
    u8 *second = mal_heap_alloc_raw(heap, 32768);
    memset(first, 0x18, 16384);
    memset(second, 0xa9, 32768);
    first = gc_realloc_raw(heap, first, 1024 * 1024);
    second = gc_realloc_raw(heap, second, 2 * 1024 * 1024);
    CHECK(all_bytes(first, 16384, 0x18));
    CHECK(all_bytes(second, 32768, 0xa9));
    CHECK(mal_heap_usage(heap).raw_owned_bytes == 3 * 1024 * 1024);
    return true;
}

int main(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);
    bool passed = grows_block_storage_into_large_storage(&heap)
        && grows_and_frees_head_middle_and_tail_records(&heap)
        && heap_shutdown_owns_grown_records(&heap);
    mal_heap_free(&heap);
    if (!passed) return 1;
    puts("gc-raw-realloc PASS");
    return 0;
}
