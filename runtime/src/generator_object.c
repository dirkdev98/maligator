#include "./generator_object.h"

#include <stdlib.h>

#include "gc.h"
#include "heap.h"

static MalGeneratorObject *mal_generator_object_alloc(
    MalHeap *heap, MalObject *prototype, bool with_async_data) {
    usize alloc_size = sizeof(MalGeneratorObject) +
        (with_async_data ? sizeof(MalGeneratorAsyncData) : 0);
    MalGeneratorObject *generator = mal_heap_alloc(
        heap, alloc_size, MAL_HEAP_GENERATOR_OBJECT);
    mal_object_init(heap, &generator->object, MAL_HEAP_GENERATOR_OBJECT, prototype);

    // The suspendable frame is only populated on the first suspend (a
    // generator's GENERATOR_START, an async function's first await). Until then
    // the collector still traces gen->frame unconditionally, and a
    // never-resumed generator's finalizer frees frame.registers/arguments,
    // which would read stale cell bytes without this. Zero-init so
    // an unpopulated frame traces as empty (function/registers null) and
    // finalizes as free(nullptr).
    generator->frame = (MalVmFrame) {
        .function = nullptr,
        .registers = nullptr,
        .arguments = nullptr,
        .argument_count = 0,
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
    generator->async_data = nullptr;
    generator->is_async_generator = false;
    generator->agen_running = false;
    generator->terminal_yield_pending = false;

    if (with_async_data) {
        generator->async_data = (MalGeneratorAsyncData *) (generator + 1);
        *generator->async_data = (MalGeneratorAsyncData) {
            .promise = mal_value_new_undefined(),
            .awaited_by = nullptr,
            .queue_head = nullptr,
            .queue_tail = nullptr,
        };
    }

    return generator;
}

MalGeneratorObject *mal_generator_object_new(MalHeap *heap, MalObject *prototype) {
    return mal_generator_object_alloc(heap, prototype, false);
}

MalGeneratorObject *mal_generator_object_new_async(
    MalHeap *heap, MalObject *prototype, bool is_async_generator) {
    MalGeneratorObject *generator = mal_generator_object_alloc(heap, prototype, true);
    generator->is_async = true;
    generator->is_async_generator = is_async_generator;
    return generator;
}

void mal_generator_release_frame(MalVm *vm, MalGeneratorObject *generator) {
    MalVmFrame *frame = &generator->frame;
    if (mal_gc_marking_active && frame->function != nullptr) {
        // Runtime eval may have reallocated the live function table since this
        // suspended/compiled frame last resumed. Refresh before SATB reads its
        // register count; the index remains the stable frame identity.
        frame->function = &vm->live_definition.functions[frame->function_index];
        mal_gc_satb_shade_frame(frame);
    }
    mal_vm_release_coroutine_buffer(vm, frame->registers);
    mal_vm_release_coroutine_buffer(vm, frame->arguments);
    frame->registers = nullptr;
    frame->arguments = nullptr;
    frame->argument_count = 0;
}
