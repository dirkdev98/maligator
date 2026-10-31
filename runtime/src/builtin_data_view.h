#pragma once

#include "./defaults.h"
#include "array_buffer_object.h"
#include "endian.h"
#include "function_object.h"
#include "intrinsics.h"
#include "scalar_bits.h"
#include "value.h"
#include "value_ops.h"

// Compiled code reads views inline, so the layout is shared. The object header must
// come first (the value boxing casts to MalHeapHeader *).
struct MalDataViewObject {
    MalObject object;
    MalObjectStorage object_storage;
    MalArrayBufferObject *buffer;
    u32 byte_offset;
    u32 byte_length;
    bool length_tracking;
};

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
    /** The ArrayBuffer that owns `data`. */
    MalArrayBufferObject *buffer;
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

/** The DataView accessors compiled code performs inline, in the compiler's guarded order. */
typedef enum MalDataViewAccessor {
    MAL_DATA_VIEW_GET_INT8,
    MAL_DATA_VIEW_GET_UINT8,
    MAL_DATA_VIEW_GET_INT16,
    MAL_DATA_VIEW_GET_UINT16,
    MAL_DATA_VIEW_GET_INT32,
    MAL_DATA_VIEW_GET_UINT32,
    MAL_DATA_VIEW_GET_FLOAT32,
    MAL_DATA_VIEW_GET_FLOAT64,
    MAL_DATA_VIEW_SET_INT8,
    MAL_DATA_VIEW_SET_UINT8,
    MAL_DATA_VIEW_SET_INT16,
    MAL_DATA_VIEW_SET_UINT16,
    MAL_DATA_VIEW_SET_INT32,
    MAL_DATA_VIEW_SET_UINT32,
    MAL_DATA_VIEW_SET_FLOAT32,
    MAL_DATA_VIEW_SET_FLOAT64,
    MAL_DATA_VIEW_ACCESSOR_COUNT,
} MalDataViewAccessor;

/** Each accessor's callback, which identifies a loaded method as the primordial one. */
extern const MalNativeFunctionCallback mal_data_view_accessor_callbacks[MAL_DATA_VIEW_ACCESSOR_COUNT];

static inline __attribute__((always_inline)) bool mal_data_view_accessor_is(
    MalValue callee, MalDataViewAccessor accessor
) {
    return mal_value_is_heap_type(callee, MAL_HEAP_NATIVE_FUNCTION_OBJECT) &&
        ((const MalNativeFunctionObject *) mal_value_to_heap(callee))->callback ==
            mal_data_view_accessor_callbacks[accessor];
}

/**
 * The bytes an access of `size` at `index` covers, for a fixed view over an attached,
 * unshared buffer it lies inside. Null leaves the access, and every error it might
 * raise, to the builtin; so do non-integral indices, which ToIndex would truncate.
 */
static inline __attribute__((always_inline)) byte *mal_data_view_try_bytes(
    MalValue view_value, f64 index, u32 size, bool write
) {
    if (!mal_value_is_heap_type(view_value, MAL_HEAP_DATA_VIEW_OBJECT)) return nullptr;
    const MalDataViewObject *view = (const MalDataViewObject *) mal_value_to_heap(view_value);
    const MalArrayBufferObject *buffer = view->buffer;
    if (view->length_tracking || buffer->detached || buffer->shared_memory != nullptr ||
        (write && buffer->immutable) || !(index >= 0 && index <= (f64) UINT32_MAX)) {
        return nullptr;
    }
    u32 offset = (u32) index;
    // A resizable buffer can shrink below a fixed view.
    if ((f64) offset != index || (u64) offset + size > view->byte_length ||
        (u64) view->byte_offset + view->byte_length > buffer->byte_length) {
        return nullptr;
    }
    return buffer->data + view->byte_offset + offset;
}

static inline __attribute__((always_inline)) f64 mal_data_view_read(
    const byte *at, MalDataViewAccessor accessor, bool little_endian
) {
    switch (accessor) {
        case MAL_DATA_VIEW_GET_INT8:
            return mal_scalar_i8_from_bits(mal_scalar_load_native_u8(at));
        case MAL_DATA_VIEW_GET_UINT8:
            return mal_scalar_load_native_u8(at);
        case MAL_DATA_VIEW_GET_INT16:
            return mal_scalar_i16_from_bits(
                little_endian ? mal_load_u16_le(at) : mal_load_u16_be(at));
        case MAL_DATA_VIEW_GET_UINT16:
            return little_endian ? mal_load_u16_le(at) : mal_load_u16_be(at);
        case MAL_DATA_VIEW_GET_INT32:
            return mal_scalar_i32_from_bits(
                little_endian ? mal_load_u32_le(at) : mal_load_u32_be(at));
        case MAL_DATA_VIEW_GET_UINT32:
            return little_endian ? mal_load_u32_le(at) : mal_load_u32_be(at);
        case MAL_DATA_VIEW_GET_FLOAT32:
            return mal_scalar_f32_from_bits(
                little_endian ? mal_load_u32_le(at) : mal_load_u32_be(at));
        default:
            return mal_scalar_f64_from_bits(
                little_endian ? mal_load_u64_le(at) : mal_load_u64_be(at));
    }
}

static inline __attribute__((always_inline)) void mal_data_view_write(
    byte *at, MalDataViewAccessor accessor, f64 number, bool little_endian
) {
    if (accessor == MAL_DATA_VIEW_SET_FLOAT64) {
        u64 bits = mal_scalar_f64_to_bits(number);
        if (little_endian) mal_store_u64_le(at, bits);
        else mal_store_u64_be(at, bits);
        return;
    }
    u32 bits;
    if (accessor == MAL_DATA_VIEW_SET_FLOAT32) {
        bits = mal_scalar_f32_to_bits((f32) number);
    } else if (number >= INT32_MIN && number <= INT32_MAX && (f64) (i32) number == number) {
        // Every integer setter keeps the low bits of the ToInt32 image.
        bits = (u32) (i32) number;
    } else {
        bits = (u32) mal_ops_number_to_uint_width(number, 32);
    }
    switch (accessor) {
        case MAL_DATA_VIEW_SET_INT8:
        case MAL_DATA_VIEW_SET_UINT8:
            mal_scalar_store_native_u8(at, (u8) bits);
            return;
        case MAL_DATA_VIEW_SET_INT16:
        case MAL_DATA_VIEW_SET_UINT16:
            if (little_endian) mal_store_u16_le(at, (u16) bits);
            else mal_store_u16_be(at, (u16) bits);
            return;
        default:
            if (little_endian) mal_store_u32_le(at, bits);
            else mal_store_u32_be(at, bits);
            return;
    }
}
