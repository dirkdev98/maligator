#pragma once

#include "./defaults.h"
#include "object.h"

/**
 * ArrayBuffer / SharedArrayBuffer backing store.
 *
 * No GC: `data` is a plain malloc allocation released only by detach/transfer
 * or the GC sweep, both through mal_array_buffer_object_release_store.
 */
typedef struct MalArrayBufferObject {
    MalObject object;
    byte *data;
    u32 byte_length;
    // For resizable/growable buffers; equals byte_length for fixed buffers.
    // Also the allocated capacity of `data`, which is what a scrub must cover.
    u32 max_byte_length;
    bool resizable;
    bool detached;
    // SharedArrayBuffer (growable, never detached).
    bool shared;
    // Immutable ArrayBuffer (transferToImmutable/sliceToImmutable result): fixed
    // length, contents never change. Stands in for [[ArrayBufferIsImmutable]].
    bool immutable;
    // The store holds key material, a derived tag, or keyed digest state, so it
    // is scrubbed before release rather than plain-freed — otherwise a secret
    // outlives its object in freed memory until the allocator reuses the block.
    // Set by the sensitive constructors below; a caller-owned input buffer is
    // never marked, because its bytes remain the user's.
    bool sensitive;
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

/**
 * Allocate a zero-filled, fixed-length backing store for secret-bearing bytes
 * (key material, a derived tag, keyed digest state). Identical to
 * mal_array_buffer_object_new otherwise; `data` is null when the allocation
 * failed, which the caller must check.
 */
MalArrayBufferObject *mal_array_buffer_object_new_sensitive(
    MalHeap *heap, MalObject *prototype, u32 byte_length
);

/**
 * Adopt a malloc-compatible allocation as a fixed-length backing store;
 * ownership transfers, including on the paths that release it. `data` may be
 * null only when `byte_length` is zero. `sensitive` selects the
 * scrub-before-release contract; pass false for ordinary bytes.
 */
MalArrayBufferObject *mal_array_buffer_object_adopt(
    MalHeap *heap, MalObject *prototype, byte *data, u32 byte_length, bool sensitive
);

u32 mal_array_buffer_object_byte_length(const MalArrayBufferObject *buffer);
bool mal_array_buffer_object_is_detached(const MalArrayBufferObject *buffer);

/**
 * Release the backing store, scrubbing it first when the buffer is sensitive.
 * The single free path: detach/transfer and the GC sweep both come through
 * here, so neither can release a secret-bearing store unscrubbed. Idempotent,
 * and does not itself mark the buffer detached.
 */
void mal_array_buffer_object_release_store(MalArrayBufferObject *buffer);

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

/**
 * Test seam. Invoked from mal_array_buffer_object_release_store with the store
 * still mapped, after any scrub and immediately before free(), so a driver can
 * prove a sensitive store was cleared on the exact path that released it — an
 * assertion that is impossible to make once the block is back with the
 * allocator. Null (the default) disables it. Not thread-safe; set it before the
 * isolate runs.
 */
typedef void (*MalArrayBufferReleaseObserver)(
    const MalArrayBufferObject *buffer, const byte *data, u32 capacity
);
void mal_array_buffer_object_set_release_observer(MalArrayBufferReleaseObserver observer);
