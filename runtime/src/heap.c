#include "./heap.h"

#include <stdlib.h>

void mal_heap_init(MalHeap *heap, usize capacity) {
    if (capacity == 0) {
        capacity = MAL_DEFAULT_HEAP_SIZE;
    }
    heap->ptr = malloc(capacity);
    heap->next_ptr = heap->ptr;
    heap->capacity = capacity;
    heap->next_heap = nullptr;
}

void mal_heap_free(MalHeap *heap) {
    free(heap->ptr);

    heap->ptr = nullptr;
    heap->capacity = 0;
    heap->next_ptr = nullptr;

    if (heap->next_heap != nullptr) {
        mal_heap_free(heap->next_heap);
        heap->next_heap = nullptr;
    }
}

void mal_heap_grow(MalHeap *heap, usize alloc_size) {
    if (alloc_size == 0) {
        alloc_size = MAL_DEFAULT_HEAP_SIZE;
    }

    if (heap->next_heap) {
        mal_heap_grow(heap->next_heap, alloc_size);
        return;
    }

    // When allocating new stuff, we have to make sure that we keep enough space reserved for the next MalHeap*
    heap->next_heap = heap->next_ptr;
    heap->next_ptr += 8;

    mal_heap_init(heap->next_heap, alloc_size);
}

// TODO: when allocating find the next heap that can accomodate the alloc.
//   So we might grow dynamically and fill up 'previous' heaps with smaller objects as we go.
