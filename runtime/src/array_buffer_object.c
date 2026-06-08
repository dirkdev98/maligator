#include "array_buffer_object.h"

#include <stdlib.h>
#include <string.h>

#include "object_ops.h"

MalArrayBufferObject *mal_array_buffer_object_new(
    MalHeap *heap,
    MalObject *prototype,
    u32 byte_length,
    u32 max_byte_length,
    bool resizable,
    bool shared
) {
    MalArrayBufferObject *buffer = mal_heap_alloc(heap, sizeof(MalArrayBufferObject), MAL_HEAP_ARRAY_BUFFER_OBJECT);
    mal_object_init(heap, &buffer->object, MAL_HEAP_ARRAY_BUFFER_OBJECT, prototype);

    // Resizable buffers reserve the maximum so the backing store never moves.
    u32 capacity = resizable ? max_byte_length : byte_length;
    buffer->data = capacity > 0 ? calloc(capacity, 1) : nullptr;
    buffer->byte_length = byte_length;
    buffer->max_byte_length = resizable ? max_byte_length : byte_length;
    buffer->resizable = resizable;
    buffer->detached = false;
    buffer->shared = shared;

    return buffer;
}

u32 mal_array_buffer_object_byte_length(const MalArrayBufferObject *buffer) {
    return buffer->byte_length;
}

bool mal_array_buffer_object_is_detached(const MalArrayBufferObject *buffer) {
    return buffer->detached;
}

void mal_array_buffer_object_detach(MalArrayBufferObject *buffer) {
    if (buffer->detached) {
        return;
    }
    free(buffer->data);
    buffer->data = nullptr;
    buffer->byte_length = 0;
    buffer->detached = true;
}

bool mal_array_buffer_object_resize(MalArrayBufferObject *buffer, u32 new_byte_length) {
    if (!buffer->resizable || buffer->detached || new_byte_length > buffer->max_byte_length) {
        return false;
    }

    // The store is pre-sized to max_byte_length; zero any freshly exposed bytes
    // on growth so old contents past the previous length don't leak through.
    if (new_byte_length > buffer->byte_length) {
        memset(buffer->data + buffer->byte_length, 0, new_byte_length - buffer->byte_length);
    }
    buffer->byte_length = new_byte_length;
    return true;
}
