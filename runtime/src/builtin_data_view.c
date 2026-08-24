#include "builtin_data_view.h"

#include <stdio.h>

#include "array_buffer_object.h"
#include "builtin_bigint.h"
#include "endian.h"
#include "float16.h"
#include "heap_bigint.h"
#include "object_ops.h"
#include "scalar_bits.h"
#include "typed_array_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// DataView is the only consumer of this layout, so it lives here. The header
// must come first (the value boxing casts to MalHeapHeader *).
typedef struct MalDataViewObject {
    MalObject object;
    MalArrayBufferObject *buffer;
    u32 byte_offset;
    u32 byte_length;
    bool length_tracking;
} MalDataViewObject;

static u32 mal_data_view_current_length(const MalDataViewObject *view);
static bool mal_data_view_is_out_of_bounds(const MalDataViewObject *view);
static bool mal_data_view_extent(
    const MalDataViewObject *view, u32 *byte_length);

MalArrayBufferObject *mal_data_view_object_buffer(const MalDataViewObject *view) {
    return view->buffer;
}

u32 mal_data_view_object_byte_offset(const MalDataViewObject *view) {
    return view->byte_offset;
}

u32 mal_data_view_object_byte_length(const MalDataViewObject *view) {
    return mal_data_view_current_length(view);
}

MalDataViewObject *mal_data_view_object_new(
    MalHeap *heap, MalObject *prototype, MalArrayBufferObject *buffer,
    u32 byte_offset, u32 byte_length, bool length_tracking) {
    MalDataViewObject *view = mal_heap_alloc(
        heap, sizeof(MalDataViewObject), MAL_HEAP_DATA_VIEW_OBJECT);
    mal_object_init(heap, &view->object, MAL_HEAP_DATA_VIEW_OBJECT, prototype);
    view->buffer = buffer;
    view->byte_offset = byte_offset;
    view->byte_length = byte_length;
    view->length_tracking = length_tracking;
    return view;
}

MalBufferSourceSpanStatus mal_buffer_source_span(
    MalValue value, MalBufferSourceSpan *out) {
    *out = (MalBufferSourceSpan) {0};

    MalArrayBufferObject *buffer;
    u32 byte_offset = 0;
    usize byte_length;
    if (mal_value_is_array_buffer_object(value)) {
        buffer = mal_value_to_array_buffer_object(value);
        if (buffer->detached) {
            return MAL_BUFFER_SOURCE_SPAN_DETACHED;
        }
        byte_length = buffer->byte_length;
    } else if (mal_value_is_typed_array_object(value)) {
        MalTypedArrayObject *array = mal_value_to_typed_array_object(value);
        buffer = array->buffer;
        if (buffer == nullptr || buffer->detached) {
            return MAL_BUFFER_SOURCE_SPAN_DETACHED;
        }
        if (mal_typed_array_object_is_out_of_bounds(array)) {
            return MAL_BUFFER_SOURCE_SPAN_OUT_OF_BOUNDS;
        }
        byte_offset = array->byte_offset;
        byte_length = mal_typed_array_object_byte_length(array);
    } else if (mal_value_is_data_view_object(value)) {
        MalDataViewObject *view = mal_value_to_data_view_object(value);
        buffer = view->buffer;
        if (buffer == nullptr || buffer->detached) {
            return MAL_BUFFER_SOURCE_SPAN_DETACHED;
        }
        u32 current_length;
        if (!mal_data_view_extent(view, &current_length)) {
            return MAL_BUFFER_SOURCE_SPAN_OUT_OF_BOUNDS;
        }
        byte_offset = view->byte_offset;
        byte_length = current_length;
    } else {
        return MAL_BUFFER_SOURCE_SPAN_NOT_BUFFER_SOURCE;
    }

    out->data = byte_length == 0 ? nullptr : buffer->data + byte_offset;
    out->length = byte_length;
    out->resizable = buffer->resizable;
    return MAL_BUFFER_SOURCE_SPAN_OK;
}

typedef enum MalDataViewType {
    DV_INT8,
    DV_UINT8,
    DV_INT16,
    DV_UINT16,
    DV_INT32,
    DV_UINT32,
    DV_FLOAT16,
    DV_FLOAT32,
    DV_FLOAT64,
    DV_BIGINT64,
    DV_BIGUINT64,
} MalDataViewType;

static u32 mal_data_view_type_size(MalDataViewType type) {
    switch (type) {
        case DV_INT8:
        case DV_UINT8:
            return 1;
        case DV_INT16:
        case DV_UINT16:
        case DV_FLOAT16:
            return 2;
        case DV_INT32:
        case DV_UINT32:
        case DV_FLOAT32:
            return 4;
        default:
            return 8;
    }
}

static bool mal_data_view_extent(
    const MalDataViewObject *view, u32 *byte_length) {
    if (view->buffer->detached) {
        *byte_length = 0;
        return false;
    }
    if (view->length_tracking) {
        if (view->byte_offset > view->buffer->byte_length) {
            *byte_length = 0;
            return false;
        }
        *byte_length = view->buffer->byte_length - view->byte_offset;
        return true;
    }
    // A fixed view goes out of bounds if a resizable buffer shrank under it.
    if ((u64) view->byte_offset + view->byte_length > view->buffer->byte_length) {
        *byte_length = 0;
        return false;
    }
    *byte_length = view->byte_length;
    return true;
}

static u32 mal_data_view_current_length(const MalDataViewObject *view) {
    u32 byte_length;
    mal_data_view_extent(view, &byte_length);
    return byte_length;
}

// Spec IsViewOutOfBounds: a detached buffer, a length-tracking view whose offset
// now exceeds the (shrunk) buffer, or a fixed view whose offset+length no longer
// fits the buffer. Used to raise TypeError (distinct from the in-bounds RangeError)
// when a resizable buffer shrinks under the view.
static bool mal_data_view_is_out_of_bounds(const MalDataViewObject *view) {
    u32 byte_length;
    return !mal_data_view_extent(view, &byte_length);
}

static MalDataViewObject *mal_data_view_this(MalVm *vm, MalValue this_value) {
    if (!mal_value_is_data_view_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not a DataView");
        return nullptr;
    }
    return mal_value_to_data_view_object(this_value);
}

// Spec ToIndex: ToNumber (running full ToPrimitive / @@toPrimitive / valueOf →
// toString, and throwing TypeError on Symbol/BigInt) → ToIntegerOrInfinity →
// RangeError when negative or above 2^53-1. `undefined` is treated as 0 by the
// callers that pass it (matching the spec's optional-argument handling).
static bool mal_data_view_to_index(MalVm *vm, MalValue value, u64 *out) {
    f64 number;
    if (mal_ops_is_number(value)) {
        number = mal_ops_number_as_f64(value);
    } else if (!mal_vm_to_number(vm, value, &number)) {
        return false;
    }
    number = mal_ops_number_to_integer_or_infinity(number);
    if (number < 0 || number > MAL_NUMBER_MAX_SAFE_INTEGER) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid DataView offset/length");
        return false;
    }
    *out = (u64) number;
    return true;
}

static MalValue mal_builtin_data_view_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Constructor DataView requires 'new'");
        return mal_value_new_undefined();
    }
    if (arg_count < 1 || !mal_value_is_array_buffer_object(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "First argument to DataView must be an ArrayBuffer");
        return mal_value_new_undefined();
    }

    MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(args[0]);

    // Spec order: ToIndex(byteOffset), then ToIndex(byteLength) if present, then
    // the detached check, then the bounds checks. ToIndex runs user coercion, so
    // both conversions must happen before any buffer state is inspected.
    u64 byte_offset = 0;
    if (arg_count >= 2 && !mal_data_view_to_index(vm, args[1], &byte_offset)) {
        return mal_value_new_undefined();
    }
    bool has_length = arg_count >= 3 && !mal_value_is_undefined(args[2]);
    u64 requested_length = 0;
    if (has_length && !mal_data_view_to_index(vm, args[2], &requested_length)) {
        return mal_value_new_undefined();
    }

    if (buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot construct DataView over a detached ArrayBuffer");
        return mal_value_new_undefined();
    }
    if (byte_offset > buffer->byte_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Start offset is outside the bounds of the buffer");
        return mal_value_new_undefined();
    }
    if (has_length && byte_offset + requested_length > buffer->byte_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid DataView length");
        return mal_value_new_undefined();
    }

    // OrdinaryCreateFromConstructor reads NewTarget.prototype, which can run a
    // user getter that detaches or resizes the buffer. The spec re-validates the
    // detached state and the offset/length bounds against the post-access buffer
    // length before installing the view.
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_DATA_VIEW_PROTOTYPE, &prototype)) {
        return mal_value_new_undefined();
    }

    if (buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot construct DataView over a detached ArrayBuffer");
        return mal_value_new_undefined();
    }
    if (byte_offset > buffer->byte_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Start offset is outside the bounds of the buffer");
        return mal_value_new_undefined();
    }

    bool length_tracking = false;
    u32 byte_length = 0;
    if (!has_length) {
        if (buffer->resizable) {
            length_tracking = true;
        } else {
            byte_length = buffer->byte_length - (u32) byte_offset;
        }
    } else {
        if (byte_offset + requested_length > buffer->byte_length) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid DataView length");
            return mal_value_new_undefined();
        }
        byte_length = (u32) requested_length;
    }

    return mal_value_from_data_view_object(mal_data_view_object_new(
        &vm->heap, prototype, buffer, (u32) byte_offset, byte_length,
        length_tracking));
}

static u16 mal_data_view_load_u16(const byte *at, bool little_endian) {
    return little_endian ? mal_load_u16_le(at) : mal_load_u16_be(at);
}

static u32 mal_data_view_load_u32(const byte *at, bool little_endian) {
    return little_endian ? mal_load_u32_le(at) : mal_load_u32_be(at);
}

static u64 mal_data_view_load_u64(const byte *at, bool little_endian) {
    return little_endian ? mal_load_u64_le(at) : mal_load_u64_be(at);
}

static void mal_data_view_store_u16(byte *at, u16 bits, bool little_endian) {
    if (little_endian) {
        mal_store_u16_le(at, bits);
    } else {
        mal_store_u16_be(at, bits);
    }
}

static void mal_data_view_store_u32(byte *at, u32 bits, bool little_endian) {
    if (little_endian) {
        mal_store_u32_le(at, bits);
    } else {
        mal_store_u32_be(at, bits);
    }
}

static void mal_data_view_store_u64(byte *at, u64 bits, bool little_endian) {
    if (little_endian) {
        mal_store_u64_le(at, bits);
    } else {
        mal_store_u64_be(at, bits);
    }
}

static MalValue mal_data_view_get(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalDataViewType type) {
    MalDataViewObject *view = mal_data_view_this(vm, this_value);
    if (view == nullptr) {
        return mal_value_new_undefined();
    }

    u64 index;
    if (!mal_data_view_to_index(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &index)) {
        return mal_value_new_undefined();
    }
    bool little_endian = arg_count >= 2 && mal_value_is_truthy(args[1]);
    u32 size = mal_data_view_type_size(type);

    u32 current_length;
    if (!mal_data_view_extent(view, &current_length)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "DataView is out of bounds of its ArrayBuffer");
        return mal_value_new_undefined();
    }
    if (index + size > current_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Offset is outside the bounds of the DataView");
        return mal_value_new_undefined();
    }

    const byte *at = view->buffer->data + view->byte_offset + index;

    switch (type) {
        case DV_INT8:
            return mal_value_from_i32(mal_scalar_i8_from_bits(
                mal_scalar_load_native_u8(at)));
        case DV_UINT8:
            return mal_value_from_i32(mal_scalar_load_native_u8(at));
        case DV_INT16:
            return mal_value_from_i32(mal_scalar_i16_from_bits(
                mal_data_view_load_u16(at, little_endian)));
        case DV_UINT16:
            return mal_value_from_i32(mal_data_view_load_u16(at, little_endian));
        case DV_INT32:
            return mal_value_from_i32(mal_scalar_i32_from_bits(
                mal_data_view_load_u32(at, little_endian)));
        case DV_UINT32: {
            u32 v = mal_data_view_load_u32(at, little_endian);
            return v <= INT32_MAX ? mal_value_from_i32((i32) v) : mal_ops_number_value((f64) v);
        }
        case DV_FLOAT16:
            return mal_value_from_f64_convert_nan(mal_float16_bits_to_f64(
                mal_data_view_load_u16(at, little_endian)));
        case DV_FLOAT32:
            return mal_value_from_f64_convert_nan((f64) mal_scalar_f32_from_bits(
                mal_data_view_load_u32(at, little_endian)));
        case DV_FLOAT64:
            return mal_value_from_f64_convert_nan(mal_scalar_f64_from_bits(
                mal_data_view_load_u64(at, little_endian)));
        case DV_BIGINT64:
            return mal_value_from_bigint(mal_bigint_new(
                &vm->heap,
                (i128) mal_scalar_i64_from_bits(
                    mal_data_view_load_u64(at, little_endian))));
        case DV_BIGUINT64:
            return mal_value_from_bigint(mal_bigint_new(
                &vm->heap,
                (i128) (u128) mal_data_view_load_u64(at, little_endian)));
    }
    return mal_value_new_undefined();
}

static MalValue mal_data_view_set(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalDataViewType type) {
    MalDataViewObject *view = mal_data_view_this(vm, this_value);
    if (view == nullptr) {
        return mal_value_new_undefined();
    }
    if (view->buffer->immutable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot write to an immutable buffer");
        return mal_value_new_undefined();
    }

    u64 index;
    if (!mal_data_view_to_index(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &index)) {
        return mal_value_new_undefined();
    }
    MalValue value = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    bool little_endian = arg_count >= 3 && mal_value_is_truthy(args[2]);
    u32 size = mal_data_view_type_size(type);

    // Value coercion (ToBigInt / ToNumber, both running user side effects) happens
    // after ToIndex(byteOffset) but before the detached and bounds checks.
    u64 bits = 0;
    if (type == DV_BIGINT64 || type == DV_BIGUINT64) {
        i128 big;
        if (!mal_bigint_to_bigint(vm, value, &big)) {
            return mal_value_new_undefined();
        }
        bits = (u64) (u128) big;
    } else {
        f64 number;
        if (mal_ops_is_number(value)) {
            number = mal_ops_number_as_f64(value);
        } else if (!mal_vm_to_number(vm, value, &number)) {
            return mal_value_new_undefined();
        }
        switch (type) {
            case DV_INT8:
            case DV_UINT8:
                bits = mal_ops_number_to_uint_width(number, 8);
                break;
            case DV_INT16:
            case DV_UINT16:
                bits = mal_ops_number_to_uint_width(number, 16);
                break;
            case DV_INT32:
            case DV_UINT32:
                bits = mal_ops_number_to_uint32(number);
                break;
            case DV_FLOAT16:
                // NumberToRawBytes uses the shared canonical binary16 NaN.
                bits = mal_float16_f64_to_bits(number);
                break;
            case DV_FLOAT32: {
                f32 v = (f32) number;
                bits = mal_scalar_f32_to_bits(v);
                break;
            }
            case DV_FLOAT64:
                bits = mal_scalar_f64_to_bits(number);
                break;
            default:
                break;
        }
    }

    u32 current_length;
    if (!mal_data_view_extent(view, &current_length)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "DataView is out of bounds of its ArrayBuffer");
        return mal_value_new_undefined();
    }
    if (index + size > current_length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Offset is outside the bounds of the DataView");
        return mal_value_new_undefined();
    }

    byte *at = view->buffer->data + view->byte_offset + index;
    switch (size) {
        case 1:
            mal_scalar_store_native_u8(at, (u8) bits);
            break;
        case 2:
            mal_data_view_store_u16(at, (u16) bits, little_endian);
            break;
        case 4:
            mal_data_view_store_u32(at, (u32) bits, little_endian);
            break;
        case 8:
            mal_data_view_store_u64(at, bits, little_endian);
            break;
    }
    return mal_value_new_undefined();
}

#define MAL_DV_GET(fn_name, type_value) \
    static MalValue fn_name(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) new_target; \
        return mal_data_view_get(vm, this_value, args, arg_count, type_value); \
    }
#define MAL_DV_SET(fn_name, type_value) \
    static MalValue fn_name(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) new_target; \
        return mal_data_view_set(vm, this_value, args, arg_count, type_value); \
    }

MAL_DV_GET(mal_dv_get_int8, DV_INT8)
MAL_DV_GET(mal_dv_get_uint8, DV_UINT8)
MAL_DV_GET(mal_dv_get_int16, DV_INT16)
MAL_DV_GET(mal_dv_get_uint16, DV_UINT16)
MAL_DV_GET(mal_dv_get_int32, DV_INT32)
MAL_DV_GET(mal_dv_get_uint32, DV_UINT32)
MAL_DV_GET(mal_dv_get_float16, DV_FLOAT16)
MAL_DV_GET(mal_dv_get_float32, DV_FLOAT32)
MAL_DV_GET(mal_dv_get_float64, DV_FLOAT64)
MAL_DV_GET(mal_dv_get_bigint64, DV_BIGINT64)
MAL_DV_GET(mal_dv_get_biguint64, DV_BIGUINT64)
MAL_DV_SET(mal_dv_set_int8, DV_INT8)
MAL_DV_SET(mal_dv_set_uint8, DV_UINT8)
MAL_DV_SET(mal_dv_set_int16, DV_INT16)
MAL_DV_SET(mal_dv_set_uint16, DV_UINT16)
MAL_DV_SET(mal_dv_set_int32, DV_INT32)
MAL_DV_SET(mal_dv_set_uint32, DV_UINT32)
MAL_DV_SET(mal_dv_set_float16, DV_FLOAT16)
MAL_DV_SET(mal_dv_set_float32, DV_FLOAT32)
MAL_DV_SET(mal_dv_set_float64, DV_FLOAT64)
MAL_DV_SET(mal_dv_set_bigint64, DV_BIGINT64)
MAL_DV_SET(mal_dv_set_biguint64, DV_BIGUINT64)

static MalValue mal_dv_get_buffer(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalDataViewObject *view = mal_data_view_this(vm, this_value);
    return view == nullptr ? mal_value_new_undefined() : mal_value_from_array_buffer_object(view->buffer);
}

static MalValue mal_dv_get_byte_length(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalDataViewObject *view = mal_data_view_this(vm, this_value);
    if (view == nullptr) {
        return mal_value_new_undefined();
    }
    u32 byte_length;
    if (!mal_data_view_extent(view, &byte_length)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot read byteLength of an out-of-bounds view");
        return mal_value_new_undefined();
    }
    return mal_value_from_i32((i32) byte_length);
}

static MalValue mal_dv_get_byte_offset(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalDataViewObject *view = mal_data_view_this(vm, this_value);
    if (view == nullptr) {
        return mal_value_new_undefined();
    }
    if (mal_data_view_is_out_of_bounds(view)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot read byteOffset of an out-of-bounds view");
        return mal_value_new_undefined();
    }
    return mal_value_from_i32((i32) view->byte_offset);
}

static void mal_dv_define_getter(MalVm *vm, MalObject *object, const byte *name, MalNativeFunctionCallback getter) {
    // Built-in accessor functions get "get " prepended to the property name.
    byte getter_name[64];
    snprintf((char *) getter_name, sizeof getter_name, "get %s", (const char *) name);
    mal_intrinsic_define_getter(
        vm, object, name, getter_name, getter, MAL_PROPERTY_CONFIGURABLE);
}

void mal_builtin_data_view_install(MalVm *vm) {
    MalObject *object_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);

    MalObject *prototype = mal_object_new(&vm->heap, object_prototype);
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "DataView"), 1, mal_builtin_data_view_constructor);
    vm->intrinsics[MAL_INTRINSIC_DATA_VIEW_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_DATA_VIEW_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_DATA_VIEW_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_DATA_VIEW_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_dv_define_getter(vm, prototype, "buffer", mal_dv_get_buffer);
    mal_dv_define_getter(vm, prototype, "byteLength", mal_dv_get_byte_length);
    mal_dv_define_getter(vm, prototype, "byteOffset", mal_dv_get_byte_offset);

    mal_intrinsic_define_method_n(vm, prototype, "getInt8", 1, mal_dv_get_int8);
    mal_intrinsic_define_method_n(vm, prototype, "getUint8", 1, mal_dv_get_uint8);
    mal_intrinsic_define_method_n(vm, prototype, "getInt16", 1, mal_dv_get_int16);
    mal_intrinsic_define_method_n(vm, prototype, "getUint16", 1, mal_dv_get_uint16);
    mal_intrinsic_define_method_n(vm, prototype, "getInt32", 1, mal_dv_get_int32);
    mal_intrinsic_define_method_n(vm, prototype, "getUint32", 1, mal_dv_get_uint32);
    mal_intrinsic_define_method_n(vm, prototype, "getFloat16", 1, mal_dv_get_float16);
    mal_intrinsic_define_method_n(vm, prototype, "getFloat32", 1, mal_dv_get_float32);
    mal_intrinsic_define_method_n(vm, prototype, "getFloat64", 1, mal_dv_get_float64);
    mal_intrinsic_define_method_n(vm, prototype, "getBigInt64", 1, mal_dv_get_bigint64);
    mal_intrinsic_define_method_n(vm, prototype, "getBigUint64", 1, mal_dv_get_biguint64);
    mal_intrinsic_define_method_n(vm, prototype, "setInt8", 2, mal_dv_set_int8);
    mal_intrinsic_define_method_n(vm, prototype, "setUint8", 2, mal_dv_set_uint8);
    mal_intrinsic_define_method_n(vm, prototype, "setInt16", 2, mal_dv_set_int16);
    mal_intrinsic_define_method_n(vm, prototype, "setUint16", 2, mal_dv_set_uint16);
    mal_intrinsic_define_method_n(vm, prototype, "setInt32", 2, mal_dv_set_int32);
    mal_intrinsic_define_method_n(vm, prototype, "setUint32", 2, mal_dv_set_uint32);
    mal_intrinsic_define_method_n(vm, prototype, "setFloat16", 2, mal_dv_set_float16);
    mal_intrinsic_define_method_n(vm, prototype, "setFloat32", 2, mal_dv_set_float32);
    mal_intrinsic_define_method_n(vm, prototype, "setFloat64", 2, mal_dv_set_float64);
    mal_intrinsic_define_method_n(vm, prototype, "setBigInt64", 2, mal_dv_set_bigint64);
    mal_intrinsic_define_method_n(vm, prototype, "setBigUint64", 2, mal_dv_set_biguint64);

    MalPropertyDesc tag = mal_intrinsic_data_desc(mal_value_from_string(mal_intrinsic_ascii(vm, "DataView")), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag);
}
