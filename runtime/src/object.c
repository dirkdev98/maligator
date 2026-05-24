#include "object.h"

void mal_object_init(MalHeap *heap, MalObject *object, MalHeapType type, MalObject *prototype) {
    (void) heap;

    mal_heap_header_init(&object->header, type);
    object->properties = mal_table_new(MAL_TABLE_MODE_OBJECT);
    object->prototype = prototype;
    object->extensible = true;
}

MalObject *mal_object_new(MalHeap *heap, MalObject *prototype) {
    MalObject *object = mal_heap_alloc(heap, sizeof(MalObject), MAL_HEAP_OBJECT);
    mal_object_init(heap, object, MAL_HEAP_OBJECT, prototype);
    return object;
}
