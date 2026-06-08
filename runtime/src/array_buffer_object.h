#pragma once

#include "./defaults.h"
#include "object.h"

/**
 * ArrayBuffer / SharedArrayBuffer backing store.
 *
 * No GC: `data` is a plain malloc allocation freed only on detach/transfer.
 */
typedef struct MalArrayBufferObject {
    MalObject object;
    byte *data;
    u32 byte_length;
    // For resizable/growable buffers; equals byte_length for fixed buffers.
    u32 max_byte_length;
    bool resizable;
    bool detached;
    // SharedArrayBuffer (growable, never detached).
    bool shared;
} MalArrayBufferObject;

/**
 * Allocate a new ArrayBuffer with a zero-filled backing store. When resizable,
 * the store is allocated at max_byte_length up front so resize never moves it.
 */
MalArrayBufferObject *mal_array_buffer_object_new(
    MalHeap *heap,
    MalObject *prototype,
    u32 byte_length,
    u32 max_byte_length,
    bool resizable,
    bool shared
);

u32 mal_array_buffer_object_byte_length(const MalArrayBufferObject *buffer);
bool mal_array_buffer_object_is_detached(const MalArrayBufferObject *buffer);

/**
 * Detach the buffer: drop and free its backing store. Idempotent.
 */
void mal_array_buffer_object_detach(MalArrayBufferObject *buffer);

/**
 * Resize a resizable buffer to new_byte_length (<= max_byte_length). Growth
 * zero-fills; shrink keeps the same allocation. Returns false if not resizable
 * or the request exceeds the maximum.
 */
bool mal_array_buffer_object_resize(MalArrayBufferObject *buffer, u32 new_byte_length);
