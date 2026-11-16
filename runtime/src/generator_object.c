#include "./generator_object.h"

#include <stdlib.h>

#include "gc.h"
#include "heap.h"

static MalGeneratorObject *mal_generator_object_alloc(
    MalHeap *heap, MalObject *prototype, bool with_async_data) {
    usize alloc_size = sizeof(MalGeneratorObject) +
        (with_async_data ? sizeof(MalGeneratorAsyncData) : 0);
    // Every traced field is initialized before publication or another allocation.
    MalGeneratorObject *generator = mal_heap_alloc_uninitialized(
        heap, alloc_size, MAL_HEAP_GENERATOR_OBJECT);
    mal_object_init(heap, &generator->object, MAL_HEAP_GENERATOR_OBJECT, prototype);

    // An unpopulated frame must trace and finalize without reading stale cell bytes.
    generator->activation.frame = (MalVmFrame) {
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

    generator->activation.state = MAL_GENERATOR_SUSPENDED_START;
    generator->activation.resume_value_register = -1;
    generator->activation.resume_mode_register = -1;
    generator->activation.yielded_value = mal_value_new_undefined();
    generator->activation.async_data = nullptr;
    generator->activation.is_async_generator = false;
    generator->activation.agen_running = false;
    generator->activation.terminal_yield_pending = false;
    generator->activation.yielded_result = false;

    if (with_async_data) {
        generator->activation.async_data = (MalGeneratorAsyncData *) (generator + 1);
        *generator->activation.async_data = (MalGeneratorAsyncData) {
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
    MalHeap *heap, MalObject *prototype) {
    MalGeneratorObject *generator = mal_generator_object_alloc(heap, prototype, true);
    generator->activation.is_async_generator = true;
    return generator;
}

void mal_generator_release_frame(MalVm *vm, MalGeneratorObject *generator) {
    MalVmFrame *frame = &generator->activation.frame;
    if (mal_gc_marking_active && frame->function != nullptr) {
        // Runtime eval may have reallocated the live function table since this
        // suspended/compiled frame last resumed. Refresh before SATB reads its
        // register count; the index remains the stable frame identity.
        frame->function = &vm->live_runtime_image.functions[frame->function_index];
        mal_gc_satb_shade_frame(frame);
    }
    mal_vm_release_shaded_coroutine_buffer(vm, frame->registers);
    mal_vm_release_shaded_coroutine_buffer(vm, frame->arguments);
    frame->registers = nullptr;
    frame->arguments = nullptr;
    frame->argument_count = 0;
}
