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

/**
 * Outcome of resolving a DataView's live byte span. DETACHED and OUT_OF_BOUNDS
 * are kept distinct because they map to different observable behavior in
 * BufferSource consumers: a detached view reads as empty, whereas a view left
 * out of bounds by a resizable buffer shrinking under it (spec IsViewOutOfBounds)
 * is unreadable and callers raise a TypeError.
 */
typedef enum MalDataViewSpanStatus {
    MAL_DATA_VIEW_SPAN_OK,
    MAL_DATA_VIEW_SPAN_DETACHED,
    MAL_DATA_VIEW_SPAN_RESIZABLE,
    MAL_DATA_VIEW_SPAN_OUT_OF_BOUNDS,
} MalDataViewSpanStatus;

/**
 * Resolve the bytes a DataView currently reads through, honoring the live
 * detached/resizable state. On OK, *out and *out_len describe the byteOffset-based
 * subrange (*out_len may be 0). On DETACHED or OUT_OF_BOUNDS, *out is null and
 * *out_len is 0. Exposes only the span so consumers need not see the layout.
 */
MalDataViewSpanStatus mal_data_view_object_span(
    const MalDataViewObject *view, const byte **out, usize *out_len);
