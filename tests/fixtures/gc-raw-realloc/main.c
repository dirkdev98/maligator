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

#if MAL_PERF_STATS
static bool failures_preserve_warm_and_owned_buffers(MalHeap *heap) {
    u8 *buffer = mal_heap_alloc_raw(heap, 64);
    gc_free_raw(heap, buffer);
    usize charged = heap->bytes_allocated;
    heap->fail_next_raw_allocation = true;
    CHECK(mal_heap_try_alloc_raw(heap, 64) == nullptr);
    CHECK(!heap->fail_next_raw_allocation && heap->bytes_allocated == charged);
    CHECK(mal_heap_usage(heap).raw_warm_block_bytes == 32768);
    buffer = mal_heap_try_alloc_raw(heap, 64);
    CHECK(buffer != nullptr);
    memset(buffer, 0x4b, 64);
    charged = heap->bytes_allocated;
    heap->fail_next_raw_allocation = true;
    CHECK(mal_heap_try_realloc_raw_profiled(heap, buffer, 128, 0) == nullptr);
    CHECK(!heap->fail_next_raw_allocation && heap->bytes_allocated == charged);
    CHECK(mal_heap_usage(heap).raw_owned_bytes == 64 && all_bytes(buffer, 64, 0x4b));
    heap->fail_next_raw_allocation = true;
    CHECK(mal_heap_try_realloc_raw_profiled(heap, buffer, 48, 0) == buffer);
    CHECK(heap->fail_next_raw_allocation);
    CHECK(mal_heap_try_realloc_raw_profiled(heap, buffer, 10000, 0) == nullptr);
    CHECK(!heap->fail_next_raw_allocation && all_bytes(buffer, 64, 0x4b));
    gc_free_raw(heap, buffer);
    return true;
}

static bool chunk_pressure_consumes_reserve_once(MalHeap *heap) {
    void *warm = mal_heap_alloc_raw(heap, 64);
    gc_free_raw(heap, warm);
    u8 *buffers[256];
    usize count = 0;
    while (mal_heap_usage(heap).unclaimed_chunk_bytes != 0) {
        CHECK(count < countof(buffers));
        buffers[count] = mal_heap_alloc_raw(heap, 8192);
        memset(buffers[count], (u8) count, 8192);
        count++;
    }
    CHECK(heap->chunk_count == 1 && mal_heap_usage(heap).raw_warm_block_bytes == 32768);
    heap->fail_next_chunk_allocation = true;
    do {
        CHECK(count < countof(buffers));
        usize charged = heap->bytes_allocated;
        buffers[count] = mal_heap_try_alloc_raw(heap, 8192);
        CHECK(buffers[count] != nullptr && heap->bytes_allocated == charged + 8192);
        memset(buffers[count], (u8) count, 8192);
        count++;
    } while (heap->fail_next_chunk_allocation);
    CHECK(heap->chunk_count == 1 && mal_heap_usage(heap).raw_warm_block_bytes == 0);
    CHECK(mal_heap_usage(heap).raw_owned_bytes == count * 8192);

    heap->fail_next_chunk_allocation = true;
    while (true) {
        CHECK(count < countof(buffers));
        usize charged = heap->bytes_allocated;
        u8 *buffer = mal_heap_try_alloc_raw(heap, 8192);
        if (buffer == nullptr) {
            CHECK(!heap->fail_next_chunk_allocation && heap->bytes_allocated == charged);
            break;
        }
        CHECK(heap->fail_next_chunk_allocation);
        buffers[count] = buffer;
        memset(buffers[count], (u8) count, 8192);
        count++;
    }
    CHECK(heap->chunk_count == 1 && mal_heap_usage(heap).raw_owned_bytes == count * 8192);
    for (usize i = 0; i < count; i++) CHECK(all_bytes(buffers[i], 8192, (u8) i));
    u8 *recovered = mal_heap_try_alloc_raw(heap, 8192);
    CHECK(recovered != nullptr && heap->chunk_count == 2);
    gc_free_raw(heap, recovered);
    for (usize i = 0; i < count; i++) gc_free_raw(heap, buffers[i]);
    CHECK(mal_heap_usage(heap).raw_owned_bytes == 0);
    CHECK(mal_heap_usage(heap).raw_warm_block_bytes == 32768);
    return true;
}
#endif

int main(void) {
    MalHeap heap;
    mal_heap_init(&heap, 0);
    bool passed = grows_block_storage_into_large_storage(&heap)
        && grows_and_frees_head_middle_and_tail_records(&heap)
        && heap_shutdown_owns_grown_records(&heap);
    mal_heap_free(&heap);
#if MAL_PERF_STATS
    mal_heap_init(&heap, 0);
    passed = passed && failures_preserve_warm_and_owned_buffers(&heap);
    mal_heap_free(&heap);
    mal_heap_init(&heap, 0);
    passed = passed && chunk_pressure_consumes_reserve_once(&heap);
    mal_heap_free(&heap);
#endif
    if (!passed) return 1;
    puts("gc-raw-realloc PASS");
    return 0;
}
