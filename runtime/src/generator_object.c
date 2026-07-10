#include "./generator_object.h"

#include "heap.h"

MalGeneratorObject *mal_generator_object_new(MalHeap *heap, MalObject *prototype) {
    MalGeneratorObject *generator = mal_heap_alloc(heap, sizeof(MalGeneratorObject), MAL_HEAP_GENERATOR_OBJECT);
    mal_object_init(heap, &generator->object, MAL_HEAP_GENERATOR_OBJECT, prototype);

    // The suspendable frame is only populated on the first suspend (a
    // generator's GENERATOR_START, an async function's first await). Until then
    // the collector still traces gen->frame unconditionally, and a
    // never-resumed generator's finalizer frees frame.registers/arguments/
    // with_objects — both would read stale cell bytes without this. Zero-init so
    // an unpopulated frame traces as empty (function/registers null) and
    // finalizes as free(nullptr).
    generator->frame = (MalVmFrame) {
        .function = nullptr,
        .registers = nullptr,
        .arguments = nullptr,
        .argument_count = 0,
        .with_objects = nullptr,
        .with_count = 0,
        .env = nullptr,
        .this_value = mal_value_new_undefined(),
        .arguments_object = mal_value_new_undefined(),
        .callee = mal_value_new_undefined(),
        .new_target = mal_value_new_undefined(),
    };

    generator->state = MAL_GENERATOR_SUSPENDED_START;
    generator->resume_value_register = -1;
    generator->resume_mode_register = -1;
    generator->yielded_value = mal_value_new_undefined();
    generator->is_async = false;
    generator->async_resolve = mal_value_new_undefined();
    generator->async_reject = mal_value_new_undefined();
    generator->awaited_by = nullptr;
    generator->is_async_generator = false;
    generator->agen_running = false;
    generator->agen_queue_head = nullptr;
    generator->agen_queue_tail = nullptr;

    return generator;
}
