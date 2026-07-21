#include "typed_array_object.h"

#include <math.h>

#include "builtin_bigint.h"
#include "heap_bigint.h"
#include "object_ops.h"
#include "scalar_bits.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static const u32 mal_typed_array_sizes[MAL_TA_KIND_COUNT] = {
    [MAL_TA_INT8] = 1,
    [MAL_TA_UINT8] = 1,
    [MAL_TA_UINT8_CLAMPED] = 1,
    [MAL_TA_INT16] = 2,
    [MAL_TA_UINT16] = 2,
    [MAL_TA_INT32] = 4,
    [MAL_TA_UINT32] = 4,
    [MAL_TA_FLOAT32] = 4,
    [MAL_TA_FLOAT64] = 8,
    [MAL_TA_BIGINT64] = 8,
    [MAL_TA_BIGUINT64] = 8,
};

static const byte *const mal_typed_array_names[MAL_TA_KIND_COUNT] = {
    [MAL_TA_INT8] = "Int8Array",
    [MAL_TA_UINT8] = "Uint8Array",
    [MAL_TA_UINT8_CLAMPED] = "Uint8ClampedArray",
    [MAL_TA_INT16] = "Int16Array",
    [MAL_TA_UINT16] = "Uint16Array",
    [MAL_TA_INT32] = "Int32Array",
    [MAL_TA_UINT32] = "Uint32Array",
    [MAL_TA_FLOAT32] = "Float32Array",
    [MAL_TA_FLOAT64] = "Float64Array",
    [MAL_TA_BIGINT64] = "BigInt64Array",
    [MAL_TA_BIGUINT64] = "BigUint64Array",
};

u32 mal_typed_array_element_size(MalTypedArrayKind kind) {
    return mal_typed_array_sizes[kind];
}

bool mal_typed_array_is_bigint(MalTypedArrayKind kind) {
    return kind == MAL_TA_BIGINT64 || kind == MAL_TA_BIGUINT64;
}

const byte *mal_typed_array_name(MalTypedArrayKind kind) {
    return mal_typed_array_names[kind];
}

MalTypedArrayObject *mal_typed_array_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalArrayBufferObject *buffer,
    MalTypedArrayKind kind,
    u32 byte_offset,
    u32 length,
    bool length_tracking
) {
    MalTypedArrayObject *array = mal_heap_alloc(heap, sizeof(MalTypedArrayObject), MAL_HEAP_TYPED_ARRAY_OBJECT);
    mal_object_init(heap, &array->object, MAL_HEAP_TYPED_ARRAY_OBJECT, prototype);
    array->buffer = buffer;
    array->kind = kind;
    array->byte_offset = byte_offset;
    array->length = length;
    array->length_tracking = length_tracking;
    array->is_buffer = false;

    return array;
}

u32 mal_typed_array_object_length(const MalTypedArrayObject *array) {
    MalArrayBufferObject *buffer = array->buffer;
    if (buffer == nullptr || buffer->detached) {
        return 0;
    }

    u32 size = mal_typed_array_sizes[array->kind];
    if (array->length_tracking) {
        if (array->byte_offset > buffer->byte_length) {
            return 0;
        }
        return (buffer->byte_length - array->byte_offset) / size;
    }

    // A fixed-length view goes out of bounds if a resizable buffer shrank below
    // the view's extent.
    u64 end = (u64) array->byte_offset + (u64) array->length * size;
    if (end > buffer->byte_length) {
        return 0;
    }
    return array->length;
}

bool mal_typed_array_object_is_out_of_bounds(const MalTypedArrayObject *array) {
    MalArrayBufferObject *buffer = array->buffer;
    if (buffer == nullptr || buffer->detached) {
        return true;
    }
    if (array->length_tracking) {
        // A length-tracking view is out of bounds only once its offset passes the
        // (possibly shrunk) buffer end; otherwise it tracks the remaining bytes.
        return array->byte_offset > buffer->byte_length;
    }
    u64 end = (u64) array->byte_offset + (u64) array->length * mal_typed_array_sizes[array->kind];
    return end > buffer->byte_length;
}

u32 mal_typed_array_object_byte_length(const MalTypedArrayObject *array) {
    return mal_typed_array_object_length(array) * mal_typed_array_sizes[array->kind];
}

// ToUint8Clamp: clamp to [0, 255] with round-half-to-even.
static u8 mal_typed_array_to_uint8_clamp(f64 number) {
    if (isnan(number) || number <= 0) {
        return 0;
    }
    if (number >= 255) {
        return 255;
    }
    f64 rounded = floor(number);
    f64 diff = number - rounded;
    if (diff > 0.5 || (diff == 0.5 && ((u64) rounded) % 2 == 1)) {
        rounded += 1;
    }
    return (u8) rounded;
}

MalValue mal_typed_array_object_get(MalVm *vm, MalTypedArrayObject *array, u32 index) {
    if (index >= mal_typed_array_object_length(array)) {
        return mal_value_new_undefined();
    }

    byte *at = array->buffer->data + array->byte_offset + (usize) index * mal_typed_array_sizes[array->kind];

    switch (array->kind) {
        case MAL_TA_INT8:
            return mal_value_from_i32(mal_scalar_i8_from_bits(
                mal_scalar_load_native_u8(at)));
        case MAL_TA_UINT8:
        case MAL_TA_UINT8_CLAMPED:
            return mal_value_from_i32(mal_scalar_load_native_u8(at));
        case MAL_TA_INT16:
            return mal_value_from_i32(mal_scalar_i16_from_bits(
                mal_scalar_load_native_u16(at)));
        case MAL_TA_UINT16:
            return mal_value_from_i32(mal_scalar_load_native_u16(at));
        case MAL_TA_INT32:
            return mal_value_from_i32(mal_scalar_i32_from_bits(
                mal_scalar_load_native_u32(at)));
        case MAL_TA_UINT32: {
            u32 value = mal_scalar_load_native_u32(at);
            return value <= INT32_MAX ? mal_value_from_i32((i32) value) : mal_ops_number_value((f64) value);
        }
        case MAL_TA_FLOAT32:
            return mal_value_from_f64_convert_nan((f64) mal_scalar_f32_from_bits(
                mal_scalar_load_native_u32(at)));
        case MAL_TA_FLOAT64:
            return mal_value_from_f64_convert_nan(mal_scalar_f64_from_bits(
                mal_scalar_load_native_u64(at)));
        case MAL_TA_BIGINT64:
            return mal_value_from_bigint(mal_bigint_new(
                &vm->heap,
                (i128) mal_scalar_i64_from_bits(
                    mal_scalar_load_native_u64(at))));
        case MAL_TA_BIGUINT64:
            return mal_value_from_bigint(mal_bigint_new(
                &vm->heap,
                (i128) (u128) mal_scalar_load_native_u64(at)));
        default:
            return mal_value_new_undefined();
    }
}

void mal_typed_array_object_set(MalVm *vm, MalTypedArrayObject *array, u32 index, MalValue value) {
    u32 size = mal_typed_array_sizes[array->kind];

    // Coercion runs (and may throw) before the bounds check, as specced.
    u64 bits = 0;
    if (mal_typed_array_is_bigint(array->kind)) {
        i128 big;
        if (!mal_bigint_to_bigint(vm, value, &big)) {
            return;
        }
        bits = (u64) (u128) big;
    } else {
        // ToNumber runs full ToPrimitive(number) for objects (valueOf/toString
        // or @@toPrimitive) and throws on BigInt/Symbol, exactly once, before
        // the bounds check — per IntegerIndexedElementSet.
        f64 number;
        if (!mal_vm_to_number(vm, value, &number)) {
            return;
        }
        switch (array->kind) {
            case MAL_TA_INT8:
            case MAL_TA_UINT8:
                bits = mal_ops_number_to_uint_width(number, 8);
                break;
            case MAL_TA_UINT8_CLAMPED:
                bits = mal_typed_array_to_uint8_clamp(number);
                break;
            case MAL_TA_INT16:
            case MAL_TA_UINT16:
                bits = mal_ops_number_to_uint_width(number, 16);
                break;
            case MAL_TA_INT32:
            case MAL_TA_UINT32:
                bits = mal_ops_number_to_uint32(number);
                break;
            case MAL_TA_FLOAT32: {
                f32 v = (f32) number;
                bits = mal_scalar_f32_to_bits(v);
                break;
            }
            case MAL_TA_FLOAT64:
                bits = mal_scalar_f64_to_bits(number);
                break;
            default:
                return;
        }
    }

    if (index >= mal_typed_array_object_length(array)) {
        return;
    }

    byte *at = array->buffer->data + array->byte_offset + (usize) index * size;
    switch (size) {
        case 1:
            mal_scalar_store_native_u8(at, (u8) bits);
            break;
        case 2:
            mal_scalar_store_native_u16(at, (u16) bits);
            break;
        case 4:
            mal_scalar_store_native_u32(at, (u32) bits);
            break;
        case 8:
            mal_scalar_store_native_u64(at, bits);
            break;
    }
}
