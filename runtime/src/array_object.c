#include "array_object.h"

void mal_array_object_init(MalHeap *heap, MalArrayObject *array, MalObject *prototype) {
    mal_object_init(heap, &array->object, MAL_HEAP_ARRAY_OBJECT, prototype);
    array->length = 0;
}

MalArrayObject *mal_array_object_new(MalHeap *heap, MalObject *prototype) {
    MalArrayObject *array = mal_heap_alloc(heap, sizeof(MalArrayObject), MAL_HEAP_ARRAY_OBJECT);
    mal_array_object_init(heap, array, prototype);

    return array;
}

u32 mal_array_object_length(const MalArrayObject *array) {
    return array->length;
}

void mal_array_object_set_length(MalArrayObject *array, u32 length) {
    array->length = length;
}
