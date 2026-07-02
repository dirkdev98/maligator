#include "object.h"

void mal_object_init(MalHeap *heap, MalObject *object, MalHeapType type, MalObject *prototype) {
    (void) heap;

    mal_heap_header_init(&object->header, type);
    object->shape = mal_shape_empty();
    object->slots = nullptr;
    // Overflow/dictionary table is allocated lazily: a fresh object is empty
    // (shaped), and only index/symbol keys or dictionary transitions create it.
    object->overflow = nullptr;
    object->prototype = prototype;
    object->extensible = true;
    object->fast_elements_proto = false;
    object->is_raw_json = false;
    object->immutable_prototype = false;
    object->watched_method_proto = false;
}

MalObject *mal_object_new(MalHeap *heap, MalObject *prototype) {
    MalObject *object = mal_heap_alloc(heap, sizeof(MalObject), MAL_HEAP_OBJECT);
    mal_object_init(heap, object, MAL_HEAP_OBJECT, prototype);
    return object;
}
