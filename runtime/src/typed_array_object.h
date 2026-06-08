#pragma once

#include "./defaults.h"
#include "array_buffer_object.h"
#include "object.h"
#include "value.h"

typedef struct MalVm MalVm;

/**
 * The element type of a typed array view. Ordering is reused as the index into
 * the per-kind metadata tables (size / name / content type).
 */
typedef enum MalTypedArrayKind {
    MAL_TA_INT8,
    MAL_TA_UINT8,
    MAL_TA_UINT8_CLAMPED,
    MAL_TA_INT16,
    MAL_TA_UINT16,
    MAL_TA_INT32,
    MAL_TA_UINT32,
    MAL_TA_FLOAT32,
    MAL_TA_FLOAT64,
    MAL_TA_BIGINT64,
    MAL_TA_BIGUINT64,
    MAL_TA_KIND_COUNT,
} MalTypedArrayKind;

typedef struct MalTypedArrayObject {
    MalObject object;
    MalArrayBufferObject *buffer;
    MalTypedArrayKind kind;
    u32 byte_offset;
    // Element count for a fixed-length view; ignored when length_tracking.
    u32 length;
    // Auto-length view that tracks a resizable buffer's current size.
    bool length_tracking;
} MalTypedArrayObject;

MalTypedArrayObject *mal_typed_array_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalArrayBufferObject *buffer,
    MalTypedArrayKind kind,
    u32 byte_offset,
    u32 length,
    bool length_tracking
);

/** Bytes per element for a kind. */
u32 mal_typed_array_element_size(MalTypedArrayKind kind);

/** Whether a kind holds BigInt elements (BigInt64Array / BigUint64Array). */
bool mal_typed_array_is_bigint(MalTypedArrayKind kind);

/** The constructor name for a kind, e.g. "Int8Array". */
const byte *mal_typed_array_name(MalTypedArrayKind kind);

/**
 * The view's current element count, honoring detach, length-tracking over a
 * resizable buffer, and a fixed view that has gone out of bounds after shrink.
 */
u32 mal_typed_array_object_length(const MalTypedArrayObject *array);

/** The view's current byte length (length * element size). */
u32 mal_typed_array_object_byte_length(const MalTypedArrayObject *array);

/**
 * Read element `index`. Out-of-bounds (or detached) reads return undefined.
 */
MalValue mal_typed_array_object_get(MalVm *vm, MalTypedArrayObject *array, u32 index);

/**
 * Write element `index` from `value`. The value is coerced first (ToNumber for
 * numeric kinds, ToBigInt for BigInt kinds) — which may throw — and only then
 * bounds-checked; out-of-bounds writes are silently dropped.
 */
void mal_typed_array_object_set(MalVm *vm, MalTypedArrayObject *array, u32 index, MalValue value);
