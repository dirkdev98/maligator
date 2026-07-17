#include "typed_array_object.h"

#include <math.h>
#include <string.h>

#include "builtin_bigint.h"
#include "heap_bigint.h"
#include "object_ops.h"
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

// Reduce a finite Number to its low `bytes*8` bits (spec ToInt8/16/32 family).
static u64 mal_typed_array_to_uint_modular(f64 number, u32 bytes) {
    if (!isfinite(number) || number == 0) {
        return 0;
    }
    f64 truncated = trunc(number);
    f64 modulus = pow(2.0, (f64) (bytes * 8));
    f64 remainder = fmod(truncated, modulus);
    if (remainder < 0) {
        remainder += modulus;
    }
    return (u64) remainder;
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
        case MAL_TA_INT8: {
            i8 value;
            memcpy(&value, at, 1);
            return mal_value_from_i32(value);
        }
        case MAL_TA_UINT8:
        case MAL_TA_UINT8_CLAMPED: {
            u8 value;
            memcpy(&value, at, 1);
            return mal_value_from_i32(value);
        }
        case MAL_TA_INT16: {
            i16 value;
            memcpy(&value, at, 2);
            return mal_value_from_i32(value);
        }
        case MAL_TA_UINT16: {
            u16 value;
            memcpy(&value, at, 2);
            return mal_value_from_i32(value);
        }
        case MAL_TA_INT32: {
            i32 value;
            memcpy(&value, at, 4);
            return mal_value_from_i32(value);
        }
        case MAL_TA_UINT32: {
            u32 value;
            memcpy(&value, at, 4);
            return value <= INT32_MAX ? mal_value_from_i32((i32) value) : mal_ops_number_value((f64) value);
        }
        case MAL_TA_FLOAT32: {
            f32 value;
            memcpy(&value, at, 4);
            return mal_value_from_f64_convert_nan((f64) value);
        }
        case MAL_TA_FLOAT64: {
            f64 value;
            memcpy(&value, at, 8);
            return mal_value_from_f64_convert_nan(value);
        }
        case MAL_TA_BIGINT64: {
            i64 value;
            memcpy(&value, at, 8);
            return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) value));
        }
        case MAL_TA_BIGUINT64: {
            u64 value;
            memcpy(&value, at, 8);
            return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) (u128) value));
        }
        default:
            return mal_value_new_undefined();
    }
}

void mal_typed_array_object_set(MalVm *vm, MalTypedArrayObject *array, u32 index, MalValue value) {
    u32 size = mal_typed_array_sizes[array->kind];

    // Coercion runs (and may throw) before the bounds check, as specced.
    byte bytes[8];
    if (mal_typed_array_is_bigint(array->kind)) {
        i128 big;
        if (!mal_bigint_to_bigint(vm, value, &big)) {
            return;
        }
        if (array->kind == MAL_TA_BIGINT64) {
            i64 v = (i64) big;
            memcpy(bytes, &v, 8);
        } else {
            u64 v = (u64) big;
            memcpy(bytes, &v, 8);
        }
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
            case MAL_TA_UINT8: {
                u8 v = (u8) mal_typed_array_to_uint_modular(number, 1);
                memcpy(bytes, &v, 1);
                break;
            }
            case MAL_TA_UINT8_CLAMPED: {
                u8 v = mal_typed_array_to_uint8_clamp(number);
                memcpy(bytes, &v, 1);
                break;
            }
            case MAL_TA_INT16:
            case MAL_TA_UINT16: {
                u16 v = (u16) mal_typed_array_to_uint_modular(number, 2);
                memcpy(bytes, &v, 2);
                break;
            }
            case MAL_TA_INT32:
            case MAL_TA_UINT32: {
                u32 v = (u32) mal_typed_array_to_uint_modular(number, 4);
                memcpy(bytes, &v, 4);
                break;
            }
            case MAL_TA_FLOAT32: {
                f32 v = (f32) number;
                memcpy(bytes, &v, 4);
                break;
            }
            case MAL_TA_FLOAT64: {
                memcpy(bytes, &number, 8);
                break;
            }
            default:
                return;
        }
    }

    if (index >= mal_typed_array_object_length(array)) {
        return;
    }

    byte *at = array->buffer->data + array->byte_offset + (usize) index * size;
    memcpy(at, bytes, size);
}
