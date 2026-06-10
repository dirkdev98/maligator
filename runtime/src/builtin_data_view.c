#include "builtin_data_view.h"

#include <math.h>
#include <string.h>

#include "array_buffer_object.h"
#include "builtin_bigint.h"
#include "heap_bigint.h"
#include "object_ops.h"
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

typedef enum MalDataViewType {
    DV_INT8,
    DV_UINT8,
    DV_INT16,
    DV_UINT16,
    DV_INT32,
    DV_UINT32,
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
            return 2;
        case DV_INT32:
        case DV_UINT32:
        case DV_FLOAT32:
            return 4;
        default:
            return 8;
    }
}

static u32 mal_data_view_current_length(const MalDataViewObject *view) {
    if (view->buffer->detached) {
        return 0;
    }
    if (view->length_tracking) {
        return view->byte_offset > view->buffer->byte_length ? 0 : view->buffer->byte_length - view->byte_offset;
    }
    // A fixed view goes out of bounds if a resizable buffer shrank under it.
    if ((u64) view->byte_offset + view->byte_length > view->buffer->byte_length) {
        return 0;
    }
    return view->byte_length;
}

static MalDataViewObject *mal_data_view_this(MalVm *vm, MalValue this_value) {
    if (!mal_value_is_data_view_object(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Receiver is not a DataView");
        return nullptr;
    }
    return mal_value_to_data_view_object(this_value);
}

static bool mal_data_view_to_index(MalVm *vm, MalValue value, u32 *out) {
    f64 number = mal_ops_to_number(value);
    if (isnan(number)) {
        number = 0;
    }
    if (number < 0 || isinf(number) || trunc(number) != number || number > 4294967295.0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid DataView offset/length");
        return false;
    }
    *out = (u32) number;
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
    u32 byte_offset = 0;
    if (arg_count >= 2 && !mal_data_view_to_index(vm, args[1], &byte_offset)) {
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
    if (arg_count < 3 || mal_value_is_undefined(args[2])) {
        if (buffer->resizable) {
            length_tracking = true;
        } else {
            byte_length = buffer->byte_length - byte_offset;
        }
    } else {
        if (!mal_data_view_to_index(vm, args[2], &byte_length)) {
            return mal_value_new_undefined();
        }
        if ((u64) byte_offset + byte_length > buffer->byte_length) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid DataView length");
            return mal_value_new_undefined();
        }
    }

    MalValue prototype_value;
    if (!mal_vm_get_property(vm, new_target, mal_intrinsic_string_key(vm, "prototype"), &prototype_value)) {
        return mal_value_new_undefined();
    }
    MalObject *prototype = mal_value_is_object(prototype_value)
        ? mal_value_to_object(prototype_value)
        : mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_DATA_VIEW_PROTOTYPE]);

    MalDataViewObject *view = mal_heap_alloc(&vm->heap, sizeof(MalDataViewObject), MAL_HEAP_DATA_VIEW_OBJECT);
    mal_object_init(&vm->heap, &view->object, MAL_HEAP_DATA_VIEW_OBJECT, prototype);
    view->buffer = buffer;
    view->byte_offset = byte_offset;
    view->byte_length = byte_length;
    view->length_tracking = length_tracking;
    return mal_value_from_data_view_object(view);
}

// Reduce a Number to its low bits for an integer DataView store.
static i64 mal_data_view_to_int(f64 number, f64 modulus) {
    if (!isfinite(number)) {
        return 0;
    }
    return (i64) fmod(trunc(number), modulus);
}

// Reorder `size` bytes between host order and the requested endianness (the host
// is assumed little-endian; big-endian requests reverse the bytes).
static void mal_data_view_order(byte *bytes, u32 size, bool little_endian) {
    if (little_endian) {
        return;
    }
    for (u32 i = 0; i < size / 2; i++) {
        byte tmp = bytes[i];
        bytes[i] = bytes[size - 1 - i];
        bytes[size - 1 - i] = tmp;
    }
}

static MalValue mal_data_view_get(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalDataViewType type) {
    MalDataViewObject *view = mal_data_view_this(vm, this_value);
    if (view == nullptr) {
        return mal_value_new_undefined();
    }

    u32 index;
    if (!mal_data_view_to_index(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &index)) {
        return mal_value_new_undefined();
    }
    bool little_endian = arg_count >= 2 && mal_value_is_truthy(args[1]);
    u32 size = mal_data_view_type_size(type);

    if (view->buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot operate on a detached ArrayBuffer");
        return mal_value_new_undefined();
    }
    if ((u64) index + size > mal_data_view_current_length(view)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Offset is outside the bounds of the DataView");
        return mal_value_new_undefined();
    }

    byte bytes[8];
    memcpy(bytes, view->buffer->data + view->byte_offset + index, size);
    mal_data_view_order(bytes, size, little_endian);

    switch (type) {
        case DV_INT8: {
            i8 v;
            memcpy(&v, bytes, 1);
            return mal_value_from_i32(v);
        }
        case DV_UINT8: {
            u8 v;
            memcpy(&v, bytes, 1);
            return mal_value_from_i32(v);
        }
        case DV_INT16: {
            i16 v;
            memcpy(&v, bytes, 2);
            return mal_value_from_i32(v);
        }
        case DV_UINT16: {
            u16 v;
            memcpy(&v, bytes, 2);
            return mal_value_from_i32(v);
        }
        case DV_INT32: {
            i32 v;
            memcpy(&v, bytes, 4);
            return mal_value_from_i32(v);
        }
        case DV_UINT32: {
            u32 v;
            memcpy(&v, bytes, 4);
            return v <= INT32_MAX ? mal_value_from_i32((i32) v) : mal_ops_number_value((f64) v);
        }
        case DV_FLOAT32: {
            f32 v;
            memcpy(&v, bytes, 4);
            return mal_value_from_f64_convert_nan((f64) v);
        }
        case DV_FLOAT64: {
            f64 v;
            memcpy(&v, bytes, 8);
            return mal_value_from_f64_convert_nan(v);
        }
        case DV_BIGINT64: {
            i64 v;
            memcpy(&v, bytes, 8);
            return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) v));
        }
        case DV_BIGUINT64: {
            u64 v;
            memcpy(&v, bytes, 8);
            return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) (u128) v));
        }
    }
    return mal_value_new_undefined();
}

static MalValue mal_data_view_set(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalDataViewType type) {
    MalDataViewObject *view = mal_data_view_this(vm, this_value);
    if (view == nullptr) {
        return mal_value_new_undefined();
    }

    u32 index;
    if (!mal_data_view_to_index(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &index)) {
        return mal_value_new_undefined();
    }
    MalValue value = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    bool little_endian = arg_count >= 3 && mal_value_is_truthy(args[2]);
    u32 size = mal_data_view_type_size(type);

    // Coercion happens before the bounds check (observable side effects).
    byte bytes[8];
    if (type == DV_BIGINT64 || type == DV_BIGUINT64) {
        i128 big;
        if (!mal_bigint_to_bigint(vm, value, &big)) {
            return mal_value_new_undefined();
        }
        if (type == DV_BIGINT64) {
            i64 v = (i64) big;
            memcpy(bytes, &v, 8);
        } else {
            u64 v = (u64) big;
            memcpy(bytes, &v, 8);
        }
    } else {
        f64 number = mal_ops_to_number(value);
        switch (type) {
            case DV_INT8:
            case DV_UINT8: {
                u8 v = (u8) mal_data_view_to_int(number, 256.0);
                memcpy(bytes, &v, 1);
                break;
            }
            case DV_INT16:
            case DV_UINT16: {
                u16 v = (u16) mal_data_view_to_int(number, 65536.0);
                memcpy(bytes, &v, 2);
                break;
            }
            case DV_INT32:
            case DV_UINT32: {
                u32 v = (u32) mal_data_view_to_int(number, 4294967296.0);
                memcpy(bytes, &v, 4);
                break;
            }
            case DV_FLOAT32: {
                f32 v = (f32) number;
                memcpy(bytes, &v, 4);
                break;
            }
            case DV_FLOAT64:
                memcpy(bytes, &number, 8);
                break;
            default:
                break;
        }
    }

    if (view->buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot operate on a detached ArrayBuffer");
        return mal_value_new_undefined();
    }
    if ((u64) index + size > mal_data_view_current_length(view)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Offset is outside the bounds of the DataView");
        return mal_value_new_undefined();
    }

    mal_data_view_order(bytes, size, little_endian);
    memcpy(view->buffer->data + view->byte_offset + index, bytes, size);
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
    if (view->buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot read byteLength of a detached view");
        return mal_value_new_undefined();
    }
    return mal_value_from_i32((i32) mal_data_view_current_length(view));
}

static MalValue mal_dv_get_byte_offset(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    MalDataViewObject *view = mal_data_view_this(vm, this_value);
    if (view == nullptr) {
        return mal_value_new_undefined();
    }
    if (view->buffer->detached) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot read byteOffset of a detached view");
        return mal_value_new_undefined();
    }
    return mal_value_from_i32((i32) view->byte_offset);
}

static void mal_dv_define_getter(MalVm *vm, MalObject *object, const byte *name, MalNativeFunctionCallback getter) {
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(mal_native_function_object_new(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]), mal_intrinsic_ascii(vm, name), getter)),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(object, mal_intrinsic_string_key(vm, name), &desc);
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
    mal_intrinsic_define_method_n(vm, prototype, "setFloat32", 2, mal_dv_set_float32);
    mal_intrinsic_define_method_n(vm, prototype, "setFloat64", 2, mal_dv_set_float64);
    mal_intrinsic_define_method_n(vm, prototype, "setBigInt64", 2, mal_dv_set_bigint64);
    mal_intrinsic_define_method_n(vm, prototype, "setBigUint64", 2, mal_dv_set_biguint64);

    MalPropertyDesc tag = mal_intrinsic_data_desc(mal_value_from_string(mal_intrinsic_ascii(vm, "DataView")), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(prototype, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag);
}
