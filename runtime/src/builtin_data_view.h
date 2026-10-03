#pragma once

#include "./defaults.h"
#include "intrinsics.h"
#include "value.h"

/**
 * Install the DataView constructor and DataView.prototype.
 */
void mal_builtin_data_view_install(MalVm *vm);

/**
 * The ArrayBuffer a DataView reads through ([[ViewedArrayBuffer]]). Exposed so
 * the collector can trace the view -> buffer edge without seeing the struct.
 */
MalArrayBufferObject *mal_data_view_object_buffer(const MalDataViewObject *view);
u32 mal_data_view_object_byte_offset(const MalDataViewObject *view);
u32 mal_data_view_object_byte_length(const MalDataViewObject *view);
bool mal_data_view_object_length_tracking(const MalDataViewObject *view);
/** IsViewOutOfBounds, including detachment. */
bool mal_data_view_object_is_out_of_bounds(const MalDataViewObject *view);
MalDataViewObject *mal_data_view_object_new(
    MalHeap *heap, MalObject *prototype, MalArrayBufferObject *buffer,
    u32 byte_offset, u32 byte_length, bool length_tracking);

typedef enum MalBufferSourceSpanStatus {
    MAL_BUFFER_SOURCE_SPAN_OK,
    MAL_BUFFER_SOURCE_SPAN_NOT_BUFFER_SOURCE,
    MAL_BUFFER_SOURCE_SPAN_DETACHED,
    MAL_BUFFER_SOURCE_SPAN_OUT_OF_BOUNDS,
} MalBufferSourceSpanStatus;

typedef struct MalBufferSourceSpan {
    byte *data;
    usize length;
    bool resizable;
    // SharedArrayBuffer bytes: other agents may write concurrently, so `data`
    // must only be accessed through the mal_buffer_source_span_* copy helpers.
    bool shared;
} MalBufferSourceSpan;

/** Copy span bytes [offset, offset + length) into private memory. */
void mal_buffer_source_span_read(
    const MalBufferSourceSpan *span, usize offset, byte *dst, usize length);
/** Copy private bytes into the span at `offset`. */
void mal_buffer_source_span_write(
    const MalBufferSourceSpan *span, usize offset, const byte *src, usize length);
/**
 * Stable input for C APIs that read in place (hashing, syscalls, inflate,
 * bind): the span's own bytes when unshared, else a private malloc snapshot
 * returned in *owned for the caller to free. Null for an empty span or when
 * the snapshot allocation fails (length > 0).
 */
const byte *mal_buffer_source_span_private(
    const MalBufferSourceSpan *span, byte **owned);

/**
 * Resolve the current bytes of an ArrayBuffer, TypedArray, or DataView without
 * exposing view layouts. OK may describe an empty span with null data. Detached
 * and out-of-bounds are structural outcomes; callers decide whether either is
 * empty input or an error. The span is a snapshot and must be resolved again
 * after user code that can detach or resize its backing store.
 */
MalBufferSourceSpanStatus mal_buffer_source_span(
    MalValue value, MalBufferSourceSpan *out);
