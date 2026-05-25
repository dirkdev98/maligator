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

/**
 * Linkup a new heap with the given capacity. Pass in 0 to use the default capacity.
 */
static void mal_heap_grow(MalHeap *heap, usize alloc_size) {
    if (alloc_size == 0) {
        alloc_size = MAL_DEFAULT_HEAP_SIZE;
    }

    if (heap->next_heap) {
        mal_heap_grow(heap->next_heap, alloc_size);
        return;
    }

    // When allocating new stuff, we have to make sure that we keep enough space reserved for the next MalHeap*
    heap->next_heap = heap->next_ptr;
    heap->next_ptr += MAL_HEAP_ALIGN(MalHeap);

    mal_heap_init(heap->next_heap, alloc_size);
}

static void *mal_heap_alloc_aligned(MalHeap *heap, usize alloc_size) {
    size available_capacity = heap->capacity - (heap->next_ptr - heap->ptr);

    if (heap->next_heap == nullptr) {
        // Make sure that we reserve enough space for the next MalHeap.
        available_capacity = available_capacity - MAL_HEAP_ALIGN(MalHeap);
    }

    // Make sure that we align things properly.
    size aligned_alloc_size = MAL_HEAP_ALIGN_SIZE(alloc_size, void*);

    // Pretty inefficient all around, but I guess that it works for now.
    if (available_capacity < aligned_alloc_size) {
        if (heap->next_heap != nullptr) {
            return mal_heap_alloc_aligned(heap->next_heap, alloc_size);
        }

        mal_heap_grow(heap, alloc_size > MAL_DEFAULT_HEAP_SIZE ? alloc_size : MAL_DEFAULT_HEAP_SIZE);
        return mal_heap_alloc_aligned(heap->next_heap, alloc_size);
    }

    void *ptr = heap->next_ptr;
    heap->next_ptr += aligned_alloc_size;

    return ptr;
}

void mal_heap_header_init(MalHeapHeader *header, MalHeapType type) {
    // TODO: at some point we can add GC tracking here.
    header->type = type;
}

void *mal_heap_alloc(MalHeap *heap, usize alloc_size, MalHeapType type) {
    void *ptr = mal_heap_alloc_aligned(heap, alloc_size);
    mal_heap_header_init(ptr, type);

    return ptr;
}

void *mal_heap_alloc_raw(MalHeap *heap, usize alloc_size) {
    return mal_heap_alloc_aligned(heap, alloc_size);
}
