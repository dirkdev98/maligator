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
} MalBufferSourceSpan;

/**
 * Resolve the current bytes of an ArrayBuffer, TypedArray, or DataView without
 * exposing view layouts. OK may describe an empty span with null data. Detached
 * and out-of-bounds are structural outcomes; callers decide whether either is
 * empty input or an error. The span is a snapshot and must be resolved again
 * after user code that can detach or resize its backing store.
 */
MalBufferSourceSpanStatus mal_buffer_source_span(
    MalValue value, MalBufferSourceSpan *out);
