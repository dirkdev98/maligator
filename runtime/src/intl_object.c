#include "./intl_object.h"

void mal_intl_object_init(MalHeap *heap, MalIntlObject *intl, MalObject *prototype, MalIntlKind kind, void *handle, MalValue data) {
    mal_object_init(heap, &intl->object, MAL_HEAP_INTL_OBJECT, prototype);
    intl->kind = kind;
    intl->handle = handle;
    intl->data = data;
    intl->bound = mal_value_new_undefined();
}

MalIntlObject *mal_intl_object_new(MalHeap *heap, MalObject *prototype, MalIntlKind kind, void *handle, MalValue data) {
    MalIntlObject *intl = mal_heap_alloc(heap, sizeof(MalIntlObject), MAL_HEAP_INTL_OBJECT);
    mal_intl_object_init(heap, intl, prototype, kind, handle, data);
    return intl;
}
