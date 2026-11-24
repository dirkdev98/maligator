#include "node_byte_array.h"

#include <math.h>

#include "intrinsics.h"
#include "scalar_bits.h"
#include "value_ops.h"
#include "vm_ops.h"

static f64 mal_byte_array_span_number_at(
    const MalTypedArraySpan *span, u32 index
) {
    u64 bits = mal_typed_array_span_load_bits(span, index);
    switch (span->kind) {
        case MAL_TA_INT8:
            return mal_scalar_i8_from_bits((u8) bits);
        case MAL_TA_UINT8:
        case MAL_TA_UINT8_CLAMPED:
            return (u8) bits;
        case MAL_TA_INT16:
            return mal_scalar_i16_from_bits((u16) bits);
        case MAL_TA_UINT16:
            return (u16) bits;
        case MAL_TA_INT32:
            return mal_scalar_i32_from_bits((u32) bits);
        case MAL_TA_UINT32:
            return (u32) bits;
        case MAL_TA_FLOAT32:
            return (f64) mal_scalar_f32_from_bits((u32) bits);
        case MAL_TA_FLOAT64:
            return mal_scalar_f64_from_bits(bits);
        default:
            return 0;
    }
}

static bool mal_byte_array_copy_typed_array(
    MalVm *vm, MalTypedArrayObject *output, MalTypedArrayObject *input,
    u32 length
) {
    if (length == 0) {
        return true;
    }
    MalTypedArraySpan output_span, input_span;
    if (!mal_typed_array_object_span(output, &output_span) ||
        !mal_typed_array_object_span(input, &input_span)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Cannot create a Buffer from an invalid view");
        return false;
    }
    if (input_span.element_size == 1) {
        mal_typed_array_copy_bytes(output_span.data, output_span.shared,
                                   input_span.data, input_span.shared, length);
        return true;
    }
    if (mal_typed_array_is_bigint(input_span.kind)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Cannot convert a BigInt typed array to Buffer");
        return false;
    }
    for (u32 index = 0; index < length; index++) {
        output_span.data[index] = (byte) mal_ops_number_to_uint_width(
            mal_byte_array_span_number_at(&input_span, index), 8);
    }
    return true;
}

MalValue mal_node_byte_array_from_array_like(
    MalVm *vm, MalObject *prototype, MalValue source, bool is_buffer
) {
    if (mal_value_is_typed_array_object(source)) {
        MalTypedArrayObject *input = mal_value_to_typed_array_object(source);
        if (mal_typed_array_object_is_out_of_bounds(input)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Cannot create a Buffer from an invalid view");
            return mal_value_new_undefined();
        }
        u32 length = mal_typed_array_object_length(input);
        MalValue result = mal_byte_array_allocate(vm, prototype, length, false, is_buffer);
        if (mal_value_is_undefined(result)) return result;
        MalRootSpan root;
        mal_gc_root(&root, &result, 1);
        MalTypedArrayObject *output = mal_value_to_typed_array_object(result);
        if (!mal_byte_array_copy_typed_array(vm, output, input, length)) {
            mal_gc_unroot(&root);
            return mal_value_new_undefined();
        }
        mal_gc_unroot(&root);
        return result;
    }

    if (mal_value_is_data_view_object(source)) {
        return mal_byte_array_allocate(vm, prototype, 0, true, is_buffer);
    }

    if (mal_value_is_object(source)) {
        MalValue length_value;
        if (!mal_vm_get_property(vm, source, mal_intrinsic_string_key(vm, "length"),
                                 &length_value)) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_undefined(length_value)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The first argument must be a string, ArrayBuffer, or array-like object");
            return mal_value_new_undefined();
        }
        f64 number;
        if (mal_ops_is_number(length_value)) number = mal_ops_number_as_f64(length_value);
        else if (!mal_vm_to_number(vm, length_value, &number)) return mal_value_new_undefined();
        number = mal_ops_number_to_integer_or_infinity(number);
        if (number < 0) number = 0;
        if (!isfinite(number) || number > INT32_MAX) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Buffer is too large");
            return mal_value_new_undefined();
        }
        u32 length = (u32) number;
        MalValue result = mal_byte_array_allocate(vm, prototype, length, false, is_buffer);
        if (mal_value_is_undefined(result)) return result;
        MalValue roots[2] = {result, mal_value_new_undefined()};
        MalRootSpan root;
        mal_gc_root(&root, roots, 2);
        mal_gc_native_rooted_begin(vm);
        MalTypedArrayObject *output = mal_value_to_typed_array_object(roots[0]);
        for (u32 i = 0; i < length; i++) {
            MalKey key = mal_key_index(i);
            if (!mal_vm_get_property(vm, source, key, &roots[1])) {
                mal_gc_native_rooted_end(vm);
                mal_gc_unroot(&root);
                return mal_value_new_undefined();
            }
            mal_typed_array_object_set(vm, output, i, roots[1]);
            if (vm->completion.kind != MAL_COMPLETION_NORMAL) {
                mal_gc_native_rooted_end(vm);
                mal_gc_unroot(&root);
                return mal_value_new_undefined();
            }
        }
        mal_gc_native_rooted_end(vm);
        mal_gc_unroot(&root);
        return roots[0];
    }

    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                       "The first argument must be a string, ArrayBuffer, or array-like object");
    return mal_value_new_undefined();
}

static MalValue mal_node_fetch_body_chunk(MalVm *vm, MalValue source, MalValue encoding) {
    (void) encoding;
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]);
    if (mal_value_is_string(source)) {
        usize length;
        byte *bytes = mal_byte_array_encode_utf8(mal_value_to_string(source), &length);
        return mal_byte_array_adopt_encoded(vm, prototype, bytes, length, false);
    }
    if (mal_value_is_array_buffer_object(source)) {
        MalArrayBufferObject *backing = mal_value_to_array_buffer_object(source);
        if (backing->detached) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Cannot create a Buffer from a detached ArrayBuffer");
            return mal_value_new_undefined();
        }
        return mal_byte_array_view(vm, prototype, backing, 0, backing->byte_length, false);
    }
    return mal_node_byte_array_from_array_like(vm, prototype, source, false);
}

void mal_host_install_node_fetch_body_bytes(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch
) {
    (void) slots;
    (void) count;
    (void) launch;
    if (vm->node_body_chunk_converter == nullptr)
        vm->node_body_chunk_converter = mal_node_fetch_body_chunk;
}
