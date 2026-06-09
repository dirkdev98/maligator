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
    heap->tail = heap;
}

void mal_heap_free(MalHeap *heap) {
    // Each next-pool MalHeap node is embedded in this pool's buffer, so free the
    // rest of the chain (which reads those nodes) before releasing the buffer
    // that hosts them.
    if (heap->next_heap != nullptr) {
        mal_heap_free(heap->next_heap);
        heap->next_heap = nullptr;
    }

    free(heap->ptr);
    heap->ptr = nullptr;
    heap->capacity = 0;
    heap->next_ptr = nullptr;
    heap->tail = nullptr;
}

/**
 * Append a fresh pool after the current tail and make it the new tail. The new
 * pool's MalHeap node is embedded at the old tail's bump pointer (room is always
 * kept in reserve for it); its data buffer is a separate allocation.
 */
static void mal_heap_grow(MalHeap *root, usize capacity) {
    if (capacity == 0) {
        capacity = MAL_DEFAULT_HEAP_SIZE;
    }

    MalHeap *tail = root->tail;
    tail->next_heap = tail->next_ptr;
    tail->next_ptr += MAL_HEAP_ALIGN(MalHeap);

    mal_heap_init(tail->next_heap, capacity);
    root->tail = tail->next_heap;
}

/**
 * O(1) bump allocation: serve from the tail pool, growing the chain only when
 * the tail is full. The tail always keeps MAL_HEAP_ALIGN(MalHeap) bytes in
 * reserve to host the next pool's embedded node.
 */
static void *mal_heap_alloc_aligned(MalHeap *root, usize alloc_size) {
    size aligned_alloc_size = MAL_HEAP_ALIGN_SIZE(alloc_size, void*);
    MalHeap *tail = root->tail;

    size available_capacity =
        tail->capacity - (tail->next_ptr - tail->ptr) - MAL_HEAP_ALIGN(MalHeap);

    if (available_capacity < aligned_alloc_size) {
        // Size the new pool to fit this allocation plus the embedded-node
        // reserve, so the retry below always succeeds without growing again.
        usize needed = aligned_alloc_size + MAL_HEAP_ALIGN(MalHeap);
        mal_heap_grow(root, needed > MAL_DEFAULT_HEAP_SIZE ? needed : MAL_DEFAULT_HEAP_SIZE);
        tail = root->tail;
    }

    void *ptr = tail->next_ptr;
    tail->next_ptr += aligned_alloc_size;

    return ptr;
}

void mal_heap_header_init(MalHeapHeader *header, MalHeapType type) {
    // TODO: at some point we can add GC tracking here.
    header->type = type;
    header->storage = MAL_HEAP_STORAGE_DYNAMIC;
}

void *mal_heap_alloc(MalHeap *heap, usize alloc_size, MalHeapType type) {
    void *ptr = mal_heap_alloc_aligned(heap, alloc_size);
    mal_heap_header_init(ptr, type);

    return ptr;
}

void *mal_heap_alloc_raw(MalHeap *heap, usize alloc_size) {
    return mal_heap_alloc_aligned(heap, alloc_size);
}
