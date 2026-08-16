#include "array_buffer_object.h"

#include <stdlib.h>
#include <string.h>

#include "object_ops.h"
#include "profile.h"
#include "secure_scrub.h"

static MalArrayBufferReleaseObserver g_release_observer;

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
    if (buffer->data != nullptr) {
        mal_profile_native_allocation(
            heap, capacity, MAL_PROFILE_ALLOCATION_FAMILY_BUFFER);
    }
    buffer->byte_length = byte_length;
    buffer->max_byte_length = resizable ? max_byte_length : byte_length;
    buffer->resizable = resizable;
    buffer->detached = false;
    buffer->shared = shared;
    buffer->immutable = false;
    buffer->sensitive = false;

    return buffer;
}

MalArrayBufferObject *mal_array_buffer_object_new_sensitive(
    MalHeap *heap, MalObject *prototype, u32 byte_length
) {
    MalArrayBufferObject *buffer =
        mal_array_buffer_object_new(heap, prototype, byte_length, byte_length, false, false);
    buffer->sensitive = true;
    return buffer;
}

MalArrayBufferObject *mal_array_buffer_object_adopt(
    MalHeap *heap, MalObject *prototype, byte *data, u32 byte_length, bool sensitive
) {
    // Allocated empty so the constructor's calloc is skipped, then handed the
    // caller's block: byte_length and max_byte_length both describe it, which is
    // what release_store scrubs.
    MalArrayBufferObject *buffer =
        mal_array_buffer_object_new(heap, prototype, 0, 0, false, false);
    buffer->data = data;
    buffer->byte_length = byte_length;
    buffer->max_byte_length = byte_length;
    buffer->sensitive = sensitive;
    return buffer;
}

u32 mal_array_buffer_object_byte_length(const MalArrayBufferObject *buffer) {
    return buffer->byte_length;
}

bool mal_array_buffer_object_is_detached(const MalArrayBufferObject *buffer) {
    return buffer->detached;
}

void mal_array_buffer_object_release_store(MalArrayBufferObject *buffer) {
    if (buffer->data == nullptr) {
        return;
    }
    if (buffer->sensitive) {
        // The whole allocation, not byte_length: a shrunken resizable store
        // still holds the bytes past its current length.
        mal_secure_scrub(buffer->data, buffer->max_byte_length);
    }
    if (g_release_observer != nullptr) {
        g_release_observer(buffer, buffer->data, buffer->max_byte_length);
    }
    free(buffer->data);
    buffer->data = nullptr;
}

void mal_array_buffer_object_detach(MalArrayBufferObject *buffer) {
    if (buffer->detached) {
        return;
    }
    mal_array_buffer_object_release_store(buffer);
    buffer->byte_length = 0;
    buffer->detached = true;
}

void mal_array_buffer_object_set_release_observer(MalArrayBufferReleaseObserver observer) {
    g_release_observer = observer;
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
