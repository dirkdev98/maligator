#include "./generator_object.h"

#include "heap.h"

MalGeneratorObject *mal_generator_object_new(MalHeap *heap, MalObject *prototype) {
    MalGeneratorObject *generator = mal_heap_alloc(heap, sizeof(MalGeneratorObject), MAL_HEAP_GENERATOR_OBJECT);
    mal_object_init(heap, &generator->object, MAL_HEAP_GENERATOR_OBJECT, prototype);

    generator->state = MAL_GENERATOR_SUSPENDED_START;
    generator->resume_value_register = -1;
    generator->resume_mode_register = -1;
    generator->yielded_value = mal_value_new_undefined();

    return generator;
}
