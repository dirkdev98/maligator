#include "./iterator_object.h"

void mal_iterator_object_init(
    MalHeap *heap,
    MalIteratorObject *iterator,
    MalObject *prototype,
    MalIteratorKind kind,
    MalValue target
) {
    mal_object_init(heap, &iterator->object, MAL_HEAP_ITERATOR_OBJECT, prototype);
    iterator->kind = kind;
    iterator->target = target;
    iterator->index = 0;
    iterator->done = false;
}

MalIteratorObject *mal_iterator_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalIteratorKind kind,
    MalValue target
) {
    MalIteratorObject *iterator = mal_heap_alloc(heap, sizeof(MalIteratorObject), MAL_HEAP_ITERATOR_OBJECT);
    mal_iterator_object_init(heap, iterator, prototype, kind, target);

    return iterator;
}
