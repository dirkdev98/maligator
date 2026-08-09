#include "temporal_object.h"

MalTemporalObject *mal_temporal_object_new(
    MalHeap *heap, MalObject *prototype, MalTemporalKind kind, void *handle
) {
    MalTemporalObject *temporal =
        mal_heap_alloc(heap, sizeof(MalTemporalObject), MAL_HEAP_TEMPORAL_OBJECT);
    mal_object_init(heap, &temporal->object, MAL_HEAP_TEMPORAL_OBJECT, prototype);
    temporal->handle = handle;
    temporal->kind = kind;
    return temporal;
}

