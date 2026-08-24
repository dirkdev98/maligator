#include "node_buffer.h"

#if MAL_NODE

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "array_buffer_object.h"
#include "base64.h"
#include "builtin_bigint.h"
#include "builtin_data_view.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "heap_bigint.h"
#include "hex.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "scalar_bits.h"
#include "secure_scrub.h"
#include "utf8.h"
#include "typed_array_object.h"
#include "value.h"
#include "value_ops.h"
#include "vm_ops.h"

typedef enum MalBufferEncoding {
    MAL_BUFFER_UTF8,
    MAL_BUFFER_LATIN1,
    MAL_BUFFER_ASCII,
    MAL_BUFFER_HEX,
    MAL_BUFFER_BASE64,
    MAL_BUFFER_BASE64URL,
    MAL_BUFFER_UTF16LE,
} MalBufferEncoding;

static bool mal_buffer_ascii_equal_ci(const MalString *string, const char *ascii) {
    return mal_string_equals_ascii_ci(string, ascii);
}

/* Name-only lookup, with no VM and no throwing, so callers that must *observe*
 * "not a known encoding" (rather than turn it into an error) can. */
static bool mal_buffer_encoding_named(const MalString *string, MalBufferEncoding *out) {
    if (mal_buffer_ascii_equal_ci(string, "utf8") ||
        mal_buffer_ascii_equal_ci(string, "utf-8")) {
        *out = MAL_BUFFER_UTF8;
    } else if (mal_buffer_ascii_equal_ci(string, "latin1") ||
               mal_buffer_ascii_equal_ci(string, "binary")) {
        *out = MAL_BUFFER_LATIN1;
    } else if (mal_buffer_ascii_equal_ci(string, "ascii")) {
        *out = MAL_BUFFER_ASCII;
    } else if (mal_buffer_ascii_equal_ci(string, "hex")) {
        *out = MAL_BUFFER_HEX;
    } else if (mal_buffer_ascii_equal_ci(string, "base64")) {
        *out = MAL_BUFFER_BASE64;
    } else if (mal_buffer_ascii_equal_ci(string, "base64url")) {
        *out = MAL_BUFFER_BASE64URL;
    } else if (mal_buffer_ascii_equal_ci(string, "ucs2") ||
               mal_buffer_ascii_equal_ci(string, "ucs-2") ||
               mal_buffer_ascii_equal_ci(string, "utf16le") ||
               mal_buffer_ascii_equal_ci(string, "utf-16le")) {
        *out = MAL_BUFFER_UTF16LE;
    } else {
        return false;
    }
    return true;
}

static bool mal_buffer_encoding(
    MalVm *vm, MalValue value, MalBufferEncoding fallback,
    bool fallback_non_string, bool fallback_unknown, MalBufferEncoding *out
) {
    if (mal_value_is_undefined(value)) {
        *out = fallback;
        return true;
    }
    if (!mal_value_is_string(value)) {
        if (fallback_non_string) {
            *out = fallback;
            return true;
        }
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The encoding argument must be a string");
        return false;
    }
    if (!mal_buffer_encoding_named(mal_value_to_string(value), out)) {
        if (fallback_unknown) {
            *out = fallback;
            return true;
        }
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Unknown Buffer encoding");
        return false;
    }
    return true;
}

/* Node's Buffer decoder is deliberately forgiving: both alphabets are accepted,
 * whitespace and unrelated characters are ignored, and an incomplete final
 * quartet contributes all complete bytes. */
static usize mal_buffer_decode_base64_into(
    const MalString *string, byte *bytes, usize capacity
) {
    if (capacity == 0) return 0;
    usize length = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    u32 accumulator = 0;
    i32 sextets = 0;
    usize written = 0;
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        if (unit == '=') break;
        i32 digit = mal_base64_decode_digit(unit, MAL_BASE64_ALPHABET_EITHER);
        if (digit < 0) continue;
        accumulator = (accumulator << 6) | (u32) digit;
        sextets++;
        if (sextets == 4) {
            byte block[3] = {
                (byte) (accumulator >> 16),
                (byte) (accumulator >> 8),
                (byte) accumulator,
            };
            usize copy = capacity - written < 3 ? capacity - written : 3;
            memcpy(bytes + written, block, copy);
            written += copy;
            if (written == capacity) return written;
            accumulator = 0;
            sextets = 0;
        }
    }
    if (sextets == 2) {
        if (written < capacity) {
            bytes[written++] = (byte) ((accumulator >> 4) & 0xff);
        }
    } else if (sextets == 3) {
        if (written < capacity) {
            bytes[written++] = (byte) ((accumulator >> 10) & 0xff);
        }
        if (written < capacity) {
            bytes[written++] = (byte) ((accumulator >> 2) & 0xff);
        }
    }
    return written;
}

static byte *mal_buffer_decode_base64(const MalString *string, usize *length_out) {
    usize capacity = mal_string_length(string) / 4 * 3 + 3;
    byte *bytes = malloc(capacity);
    if (bytes == nullptr) {
        *length_out = 0;
        return nullptr;
    }
    *length_out = mal_buffer_decode_base64_into(string, bytes, capacity);
    return bytes;
}

static usize mal_buffer_write_string(
    const MalString *string, MalBufferEncoding encoding,
    byte *output, usize capacity
) {
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    if (encoding == MAL_BUFFER_UTF8) {
        usize written;
        mal_utf8_encode_into(
            units, length, output, capacity, nullptr, &written);
        return written;
    }
    if (encoding == MAL_BUFFER_BASE64 || encoding == MAL_BUFFER_BASE64URL) {
        return mal_buffer_decode_base64_into(string, output, capacity);
    }
    if (encoding == MAL_BUFFER_HEX) {
        usize written = 0;
        while (written < capacity && written * 2 + 1 < length) {
            i32 high = mal_hex_decode_digit(units[written * 2]);
            i32 low = mal_hex_decode_digit(units[written * 2 + 1]);
            if (high < 0 || low < 0) break;
            output[written++] = (byte) ((high << 4) | low);
        }
        return written;
    }
    if (encoding == MAL_BUFFER_UTF16LE) {
        usize read = 0;
        usize written = 0;
        while (read < length && capacity - written >= 2) {
            c16 unit = units[read++];
            output[written++] = (byte) unit;
            output[written++] = (byte) (unit >> 8);
        }
        return written;
    }

    usize written = length < capacity ? length : capacity;
    for (usize i = 0; i < written; i++) {
        output[i] = (byte) (units[i] & 0xff);
    }
    return written;
}

static byte *mal_buffer_encode_string(
    const MalString *string, MalBufferEncoding encoding, usize *length_out
) {
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    if (encoding == MAL_BUFFER_UTF8) {
        return mal_string_to_utf8(string, length_out);
    }
    if (encoding == MAL_BUFFER_BASE64 || encoding == MAL_BUFFER_BASE64URL) {
        return mal_buffer_decode_base64(string, length_out);
    }
    if (encoding == MAL_BUFFER_HEX) {
        byte *bytes = malloc(length / 2 + 1);
        if (bytes == nullptr) {
            *length_out = 0;
            return nullptr;
        }
        usize written = 0;
        while (written * 2 + 1 < length) {
            i32 high = mal_hex_decode_digit(units[written * 2]);
            i32 low = mal_hex_decode_digit(units[written * 2 + 1]);
            if (high < 0 || low < 0) break;
            bytes[written++] = (byte) ((high << 4) | low);
        }
        *length_out = written;
        return bytes;
    }
    if (encoding == MAL_BUFFER_UTF16LE) {
        byte *bytes = malloc(length * 2 + 1);
        if (bytes == nullptr) {
            *length_out = 0;
            return nullptr;
        }
        for (usize i = 0; i < length; i++) {
            bytes[i * 2] = (byte) units[i];
            bytes[i * 2 + 1] = (byte) (units[i] >> 8);
        }
        *length_out = length * 2;
        return bytes;
    }

    byte *bytes = malloc(length == 0 ? 1 : length);
    if (bytes == nullptr) {
        *length_out = 0;
        return nullptr;
    }
    for (usize i = 0; i < length; i++) {
        // Node's ascii and latin1 encoders both retain the low eight bits.
        bytes[i] = (byte) (units[i] & 0xff);
    }
    *length_out = length;
    return bytes;
}

static usize mal_buffer_encoded_string_length(
    const MalString *string, MalBufferEncoding encoding
) {
    usize length = mal_string_length(string);
    if (encoding == MAL_BUFFER_UTF8) {
        return mal_string_utf8_length(string);
    }
    if (encoding == MAL_BUFFER_UTF16LE) {
        return length * 2;
    }
    const c16 *units = mal_string_code_units(string);
    if (encoding == MAL_BUFFER_HEX) {
        usize written = 0;
        while (written * 2 + 1 < length &&
            mal_hex_decode_digit(units[written * 2]) >= 0 &&
            mal_hex_decode_digit(units[written * 2 + 1]) >= 0) {
            written++;
        }
        return written;
    }
    if (encoding == MAL_BUFFER_BASE64 ||
        encoding == MAL_BUFFER_BASE64URL) {
        usize sextets = 0;
        for (usize index = 0; index < length; index++) {
            if (units[index] == '=') break;
            if (mal_base64_decode_digit(
                    units[index], MAL_BASE64_ALPHABET_EITHER) >= 0) {
                sextets++;
            }
        }
        return sextets / 4 * 3 +
            (sextets % 4 == 2 ? 1 : sextets % 4 == 3 ? 2 : 0);
    }
    return length;
}

static MalValue mal_buffer_string_from_bytes(
    MalVm *vm, const byte *bytes, usize length, MalBufferEncoding encoding
) {
    usize output_length = length;
    if (encoding == MAL_BUFFER_HEX) {
        if (!mal_hex_encoded_length(
                length, MAL_STRING_MAX_CODE_UNITS, &output_length)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Invalid string length");
            return mal_value_new_undefined();
        }
    } else if (encoding == MAL_BUFFER_BASE64 || encoding == MAL_BUFFER_BASE64URL) {
        if (!mal_base64_encoded_length(
                length, encoding == MAL_BUFFER_BASE64,
                MAL_STRING_MAX_CODE_UNITS, &output_length)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Invalid string length");
            return mal_value_new_undefined();
        }
    } else if (encoding == MAL_BUFFER_UTF16LE) {
        output_length = length / 2;
    } else if (length > MAL_STRING_MAX_CODE_UNITS) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Invalid string length");
        return mal_value_new_undefined();
    }
    if (output_length > MAL_STRING_MAX_CODE_UNITS) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Invalid string length");
        return mal_value_new_undefined();
    }
    if (encoding == MAL_BUFFER_UTF8) {
        MalString *string = mal_string_from_utf8(&vm->heap, bytes, length);
        if (string == nullptr) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Buffer string allocation failed");
            return mal_value_new_undefined();
        }
        return mal_value_from_string(string);
    }
    if (encoding == MAL_BUFFER_HEX) {
        return mal_value_from_string(
            mal_hex_encode_string(&vm->heap, bytes, length));
    }
    if (encoding == MAL_BUFFER_BASE64 || encoding == MAL_BUFFER_BASE64URL) {
        bool padding = encoding == MAL_BUFFER_BASE64;
        return mal_value_from_string(mal_base64_encode_string(
            &vm->heap, bytes, length,
            encoding == MAL_BUFFER_BASE64URL
                ? MAL_BASE64_ALPHABET_URL
                : MAL_BASE64_ALPHABET_STANDARD,
            padding));
    }
    c16 inline_units[MAL_STRING_INLINE_CODE_UNITS];
    c16 *units = output_length <= MAL_STRING_INLINE_CODE_UNITS
        ? inline_units
        : mal_heap_alloc_raw_profiled(
            &vm->heap, sizeof(c16) * output_length,
            MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    if (encoding == MAL_BUFFER_UTF16LE) {
        for (usize i = 0; i < output_length; i++) {
            units[i] = (c16) ((u8) bytes[i * 2] | ((u16) (u8) bytes[i * 2 + 1] << 8));
        }
    } else {
        for (usize i = 0; i < length; i++) {
            units[i] = encoding == MAL_BUFFER_ASCII
                ? (u8) bytes[i] & 0x7f
                : (u8) bytes[i];
        }
    }
    MalString *result = units == inline_units
        ? mal_string_new_copy(&vm->heap, units, output_length)
        : mal_string_new_owned(&vm->heap, units, output_length);
    return mal_value_from_string(result);
}

static bool mal_buffer_to_number(MalVm *vm, MalValue value, f64 *out) {
    if (mal_ops_is_number(value)) {
        *out = mal_ops_number_as_f64(value);
        return true;
    }
    return mal_vm_to_number(vm, value, out);
}

static bool mal_buffer_to_integer(MalVm *vm, MalValue value, f64 *out) {
    if (!mal_buffer_to_number(vm, value, out)) return false;
    *out = mal_ops_number_to_integer_or_infinity(*out);
    return true;
}

static bool mal_buffer_to_size(MalVm *vm, MalValue value, u32 *out) {
    f64 number;
    if (!mal_buffer_to_integer(vm, value, &number)) return false;
    if (number < 0 || !isfinite(number) || number > INT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "The Buffer size is invalid");
        return false;
    }
    *out = (u32) number;
    return true;
}

static bool mal_buffer_offset(
    MalVm *vm, MalValue value, u32 length, u32 width, u32 *out
) {
    f64 number;
    if (!mal_buffer_to_number(vm, value, &number)) return false;
    if (!isfinite(number) || number < 0 || trunc(number) != number ||
        number > length || width > length - (u32) number) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Buffer offset is out of range");
        return false;
    }
    *out = (u32) number;
    return true;
}

static bool mal_buffer_allocation_size(MalVm *vm, MalValue value, u32 *out) {
    if (!mal_ops_is_number(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The Buffer size must be a number");
        return false;
    }
    f64 number = mal_ops_to_number(value);
    if (isnan(number) || number < 0 || !isfinite(number) || number > INT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "The Buffer size is invalid");
        return false;
    }
    *out = (u32) trunc(number);
    return true;
}

static bool mal_buffer_relative(
    MalVm *vm, MalValue value, u32 length, u32 fallback, u32 *out
) {
    if (mal_value_is_undefined(value)) {
        *out = fallback;
        return true;
    }
    f64 number;
    if (!mal_buffer_to_integer(vm, value, &number)) return false;
    if (number < 0) number += length;
    if (number < 0) number = 0;
    if (number > length) number = length;
    *out = (u32) number;
    return true;
}

static bool mal_buffer_clamped(
    MalVm *vm, MalValue value, u32 length, u32 fallback, u32 *out
) {
    if (mal_value_is_undefined(value)) {
        *out = fallback;
        return true;
    }
    f64 number;
    if (!mal_buffer_to_integer(vm, value, &number)) return false;
    if (number < 0) number = 0;
    if (number > length) number = length;
    *out = (u32) number;
    return true;
}

static bool mal_buffer_range_index(
    MalVm *vm, MalValue value, u32 length, u32 fallback, u32 *out
) {
    if (mal_value_is_undefined(value)) {
        *out = fallback;
        return true;
    }
    f64 number;
    if (!mal_buffer_to_number(vm, value, &number)) return false;
    if (!isfinite(number) || number < 0 || trunc(number) != number || number > length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Buffer range is out of bounds");
        return false;
    }
    *out = (u32) number;
    return true;
}

static MalObject *mal_buffer_prototype_from_callee(MalValue callee) {
    MalNativeFunctionObject *function = mal_value_to_native_function_object(callee);
    return mal_value_to_object(mal_native_function_object_get_slot(function, 0));
}

static MalValue mal_buffer_new_view(
    MalVm *vm, MalObject *prototype, MalArrayBufferObject *backing, u32 offset, u32 length
) {
    MalTypedArrayObject *array = mal_typed_array_object_new(
        &vm->heap, prototype, backing, MAL_TA_UINT8, offset, length, false);
    array->is_buffer = true;
    return mal_value_from_typed_array_object(array);
}

static MalValue mal_buffer_new_impl(
    MalVm *vm, MalObject *prototype, u32 length, bool initialize
) {
    MalObject *backing_prototype = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    MalArrayBufferObject *buffer = initialize
        ? mal_array_buffer_object_new(
            &vm->heap, backing_prototype,
            length, length, false, false)
        : mal_array_buffer_object_new_uninitialized(
            &vm->heap, backing_prototype,
            length, length, false, false);
    MalValue backing = mal_value_from_array_buffer_object(buffer);
    MalRootSpan root;
    mal_gc_root(&root, &backing, 1);
    if (length > 0 && mal_value_to_array_buffer_object(backing)->data == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Buffer allocation failed");
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    MalValue result = mal_buffer_new_view(
        vm, prototype, mal_value_to_array_buffer_object(backing), 0, length);
    mal_gc_unroot(&root);
    return result;
}

static MalValue mal_buffer_new(MalVm *vm, MalObject *prototype, u32 length) {
    return mal_buffer_new_impl(vm, prototype, length, true);
}

static MalValue mal_buffer_new_uninitialized(
    MalVm *vm, MalObject *prototype, u32 length
) {
    return mal_buffer_new_impl(vm, prototype, length, false);
}

static MalValue mal_buffer_adopt_bytes(
    MalVm *vm, MalObject *prototype, byte *bytes, usize length, bool sensitive
) {
    if (length > INT32_MAX || (length > 0 && bytes == nullptr)) {
        if (sensitive) mal_secure_scrub(bytes, length);
        free(bytes);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Buffer allocation failed");
        return mal_value_new_undefined();
    }
    if (length == 0) {
        free(bytes);
        bytes = nullptr;
    }
    MalArrayBufferObject *backing = mal_array_buffer_object_adopt(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        bytes, (u32) length, sensitive);
    MalValue root_value = mal_value_from_array_buffer_object(backing);
    MalRootSpan root;
    mal_gc_root(&root, &root_value, 1);
    MalValue result = mal_buffer_new_view(
        vm, prototype, backing, 0, (u32) length);
    mal_gc_unroot(&root);
    return result;
}

static MalValue mal_node_buffer_adopt_bytes(
    MalVm *vm, byte *bytes, usize length, bool sensitive
) {
    if (length > INT32_MAX || (length > 0 && bytes == nullptr)) {
        if (sensitive) mal_secure_scrub(bytes, length);
        free(bytes);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Buffer allocation failed");
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(
            vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_CONSTRUCTOR])) {
        mal_host_install_node_buffer(vm, nullptr, 0, nullptr);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            // Ownership is consumed on failure too, and these bytes never
            // reached JavaScript, so a secret allocation is cleared here.
            if (sensitive) mal_secure_scrub(bytes, length);
            free(bytes);
            return mal_value_new_undefined();
        }
    }

    return mal_buffer_adopt_bytes(
        vm,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_PROTOTYPE]),
        bytes, length, sensitive);
}

MalValue mal_node_buffer_from_owned_bytes(MalVm *vm, byte *bytes, usize length) {
    return mal_node_buffer_adopt_bytes(vm, bytes, length, false);
}

MalValue mal_node_buffer_from_owned_secret_bytes(MalVm *vm, byte *bytes, usize length) {
    return mal_node_buffer_adopt_bytes(vm, bytes, length, true);
}

static MalValue mal_node_buffer_encode(
    MalVm *vm, const byte *bytes, usize length, MalValue encoding,
    bool throw_on_unknown, bool sensitive
) {
    if (mal_value_is_undefined(encoding)) {
        byte *owned = length == 0 ? nullptr : malloc(length);
        if (length > 0 && owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        if (length > 0) memcpy(owned, bytes, length);
        return mal_node_buffer_adopt_bytes(vm, owned, length, sensitive);
    }
    MalBufferEncoding resolved;
    if (!mal_value_is_string(encoding)
        || !mal_buffer_encoding_named(mal_value_to_string(encoding), &resolved)) {
        if (throw_on_unknown) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Unknown Buffer encoding");
            return mal_value_new_undefined();
        }
        // Node's ParseEncoding falls back to BUFFER, so digest() returns the raw
        // bytes for an unrecognized (or non-string) encoding rather than throwing.
        return mal_node_buffer_encode(
            vm, bytes, length, mal_value_new_undefined(), false, sensitive);
    }
    return mal_buffer_string_from_bytes(vm, bytes, length, resolved);
}

MalValue mal_node_buffer_encode_bytes(
    MalVm *vm, const byte *bytes, usize length, MalValue encoding,
    bool throw_on_unknown
) {
    return mal_node_buffer_encode(vm, bytes, length, encoding, throw_on_unknown, false);
}

MalValue mal_node_buffer_encode_secret_bytes(
    MalVm *vm, const byte *bytes, usize length, MalValue encoding,
    bool throw_on_unknown
) {
    return mal_node_buffer_encode(vm, bytes, length, encoding, throw_on_unknown, true);
}

bool mal_node_buffer_encoding_is_known(MalValue encoding) {
    MalBufferEncoding resolved;
    return mal_value_is_string(encoding)
        && mal_buffer_encoding_named(mal_value_to_string(encoding), &resolved);
}

byte *mal_node_buffer_decode_string(
    MalVm *vm, MalValue string, MalValue encoding, usize *length_out
) {
    MalBufferEncoding resolved;
    // update(data, encoding) never throws for an unknown encoding: Node hashes
    // the string's UTF-8 form instead.
    (void) mal_buffer_encoding(vm, encoding, MAL_BUFFER_UTF8, true, true, &resolved);
    return mal_buffer_encode_string(mal_value_to_string(string), resolved, length_out);
}

static MalTypedArrayObject *mal_buffer_receiver(MalVm *vm, MalValue value) {
    if (!mal_value_is_typed_array_object(value) ||
        !mal_value_to_typed_array_object(value)->is_buffer) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Buffer method called on incompatible receiver");
        return nullptr;
    }
    MalTypedArrayObject *array = mal_value_to_typed_array_object(value);
    if (mal_typed_array_object_is_out_of_bounds(array)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Buffer is detached or out of bounds");
        return nullptr;
    }
    return array;
}

static byte *mal_buffer_view_data(MalTypedArrayObject *array) {
    return array->buffer->data == nullptr
        ? nullptr
        : array->buffer->data + array->byte_offset;
}

static MalTypedArrayObject *mal_buffer_byte_view(MalVm *vm, MalValue value) {
    if (!mal_value_is_typed_array_object(value) ||
        mal_value_to_typed_array_object(value)->kind != MAL_TA_UINT8 ||
        mal_typed_array_object_is_out_of_bounds(mal_value_to_typed_array_object(value))) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "The argument must be a Buffer or Uint8Array");
        return nullptr;
    }
    return mal_value_to_typed_array_object(value);
}

static f64 mal_buffer_span_number_at(
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

static bool mal_buffer_copy_typed_array(
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
        memcpy(output_span.data, input_span.data, length);
        return true;
    }
    if (mal_typed_array_is_bigint(input_span.kind)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Cannot convert a BigInt typed array to Buffer");
        return false;
    }
    for (u32 index = 0; index < length; index++) {
        output_span.data[index] = (byte) mal_ops_number_to_uint_width(
            mal_buffer_span_number_at(&input_span, index), 8);
    }
    return true;
}

static MalValue mal_buffer_from_impl(
    MalVm *vm, MalObject *prototype, const MalValue *args, i32 argc
) {
    MalValue source = argc >= 1 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_string(source)) {
        MalBufferEncoding encoding;
        if (!mal_buffer_encoding(vm, argc >= 2 ? args[1] : mal_value_new_undefined(),
                                 MAL_BUFFER_UTF8, true, false, &encoding)) {
            return mal_value_new_undefined();
        }
        usize length;
        byte *bytes = mal_buffer_encode_string(mal_value_to_string(source), encoding, &length);
        if (bytes == nullptr) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Buffer encoding allocation failed");
            return mal_value_new_undefined();
        }
        if (length > INT32_MAX) {
            free(bytes);
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Buffer is too large");
            return mal_value_new_undefined();
        }
        return mal_buffer_adopt_bytes(vm, prototype, bytes, length, false);
    }

    if (mal_value_is_array_buffer_object(source)) {
        MalArrayBufferObject *backing = mal_value_to_array_buffer_object(source);
        if (backing->detached) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Cannot create a Buffer from a detached ArrayBuffer");
            return mal_value_new_undefined();
        }
        u32 offset = 0;
        if (argc >= 2 && !mal_value_is_undefined(args[1]) &&
            !mal_buffer_to_size(vm, args[1], &offset)) {
            return mal_value_new_undefined();
        }
        if (offset > backing->byte_length) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Buffer offset is outside the ArrayBuffer");
            return mal_value_new_undefined();
        }
        u32 length = backing->byte_length - offset;
        if (argc >= 3 && !mal_value_is_undefined(args[2]) &&
            !mal_buffer_to_size(vm, args[2], &length)) {
            return mal_value_new_undefined();
        }
        if ((u64) offset + length > backing->byte_length) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Buffer length is outside the ArrayBuffer");
            return mal_value_new_undefined();
        }
        return mal_buffer_new_view(vm, prototype, backing, offset, length);
    }

    if (mal_value_is_typed_array_object(source)) {
        MalTypedArrayObject *input = mal_value_to_typed_array_object(source);
        if (mal_typed_array_object_is_out_of_bounds(input)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Cannot create a Buffer from an invalid view");
            return mal_value_new_undefined();
        }
        u32 length = mal_typed_array_object_length(input);
        MalValue result = mal_buffer_new_uninitialized(vm, prototype, length);
        if (mal_value_is_undefined(result)) return result;
        MalRootSpan root;
        mal_gc_root(&root, &result, 1);
        MalTypedArrayObject *output = mal_value_to_typed_array_object(result);
        if (!mal_buffer_copy_typed_array(vm, output, input, length)) {
            mal_gc_unroot(&root);
            return mal_value_new_undefined();
        }
        mal_gc_unroot(&root);
        return result;
    }

    if (mal_value_is_data_view_object(source)) {
        return mal_buffer_new(vm, prototype, 0);
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
        if (!mal_buffer_to_integer(vm, length_value, &number)) return mal_value_new_undefined();
        if (number < 0) number = 0;
        if (!isfinite(number) || number > INT32_MAX) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Buffer is too large");
            return mal_value_new_undefined();
        }
        u32 length = (u32) number;
        MalValue result = mal_buffer_new_uninitialized(vm, prototype, length);
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

static MalValue mal_buffer_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee
) {
    (void) this_value;
    MalValue target = mal_value_is_undefined(new_target) ? callee : new_target;
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, target, MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE, &prototype)) {
        return mal_value_new_undefined();
    }
    if (argc >= 1 && mal_ops_is_number(args[0])) {
        u32 length;
        if (!mal_buffer_allocation_size(vm, args[0], &length)) {
            return mal_value_new_undefined();
        }
        return mal_buffer_new(vm, prototype, length);
    }
    return mal_buffer_from_impl(vm, prototype, args, argc);
}

static MalValue mal_buffer_from(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) self;
    (void) nt;
    if (argc >= 1 && mal_ops_is_number(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Buffer.from does not accept a number");
        return mal_value_new_undefined();
    }
    return mal_buffer_from_impl(vm, mal_buffer_prototype_from_callee(callee), args, argc);
}

static MalValue mal_buffer_alloc_impl(
    MalVm *vm, const MalValue *args, i32 argc, MalValue callee, bool apply_fill
) {
    u32 length;
    if (!mal_buffer_allocation_size(
            vm, argc >= 1 ? args[0] : mal_value_new_undefined(), &length)) {
        return mal_value_new_undefined();
    }
    MalObject *prototype = mal_buffer_prototype_from_callee(callee);
    if (!apply_fill || argc < 2 || mal_value_is_undefined(args[1]) ||
        length == 0) {
        return mal_buffer_new(vm, prototype, length);
    }
    if (mal_ops_is_number(args[1])) {
        f64 number = mal_ops_number_as_f64(args[1]);
        byte fill = !isfinite(number) ? 0 : (byte) (i64) trunc(number);
        MalValue result = mal_buffer_new_uninitialized(
            vm, prototype, length);
        if (mal_value_is_undefined(result)) return result;
        memset(mal_value_to_typed_array_object(result)->buffer->data,
               fill, length);
        return result;
    }
    if (mal_value_is_string(args[1])) {
        MalBufferEncoding encoding;
        if (!mal_buffer_encoding(vm, argc >= 3 ? args[2] : mal_value_new_undefined(),
                                 MAL_BUFFER_UTF8, true, false, &encoding)) {
            return mal_value_new_undefined();
        }
        usize fill_length;
        byte *fill = mal_buffer_encode_string(mal_value_to_string(args[1]), encoding, &fill_length);
        if (fill == nullptr) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "Buffer encoding allocation failed");
            return mal_value_new_undefined();
        }
        if (fill_length == 0) {
            free(fill);
            return mal_buffer_new(vm, prototype, length);
        }

        if (fill_length < length) {
            byte *grown = realloc(fill, length);
            if (grown == nullptr) {
                free(fill);
                mal_vm_throw_allocation_error(vm);
                return mal_value_new_undefined();
            }
            fill = grown;
            usize written = fill_length;
            while (written < length) {
                usize copy = written < length - written
                    ? written : length - written;
                memcpy(fill + written, fill, copy);
                written += copy;
            }
        } else if (fill_length > length) {
            // Shrinking is opportunistic: a failed realloc leaves the original
            // allocation valid, and ArrayBuffer ownership only needs the exposed
            // byte length in order to free a non-sensitive block correctly.
            byte *shrunk = realloc(fill, length);
            if (shrunk != nullptr) {
                fill = shrunk;
            }
        }
        return mal_buffer_adopt_bytes(vm, prototype, fill, length, false);
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                       "The fill argument must be a number or string");
    return mal_value_new_undefined();
}

static MalValue mal_buffer_alloc(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) self;
    (void) nt;
    return mal_buffer_alloc_impl(vm, args, argc, callee, true);
}

static MalValue mal_buffer_alloc_unsafe(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) self;
    (void) nt;
    // MalArrayBufferObject always zero-fills fresh memory; keeping that guarantee is
    // safer than exposing stale native memory through allocUnsafe.
    return mal_buffer_alloc_impl(vm, args, argc, callee, false);
}

static MalValue mal_buffer_is_buffer(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) vm;
    (void) self;
    (void) nt;
    (void) callee;
    MalValue value = argc >= 1 ? args[0] : mal_value_new_undefined();
    return mal_value_new_boolean(mal_value_is_typed_array_object(value) &&
                                 mal_value_to_typed_array_object(value)->is_buffer);
}

static MalValue mal_buffer_byte_length(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) self;
    (void) nt;
    (void) callee;
    MalValue value = argc >= 1 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_string(value)) {
        MalBufferEncoding encoding;
        if (!mal_buffer_encoding(vm, argc >= 2 ? args[1] : mal_value_new_undefined(),
                                 MAL_BUFFER_UTF8, true, true, &encoding)) {
            return mal_value_new_undefined();
        }
        return mal_value_from_f64((f64) mal_buffer_encoded_string_length(
            mal_value_to_string(value), encoding));
    }
    if (mal_value_is_typed_array_object(value)) {
        return mal_value_from_f64((f64) mal_typed_array_object_byte_length(
            mal_value_to_typed_array_object(value)));
    }
    if (mal_value_is_data_view_object(value)) {
        MalBufferSourceSpan span;
        if (mal_buffer_source_span(value, &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Buffer.byteLength received an invalid view");
            return mal_value_new_undefined();
        }
        return mal_value_from_f64((f64) span.length);
    }
    if (mal_value_is_array_buffer_object(value)) {
        return mal_value_from_f64((f64) mal_value_to_array_buffer_object(value)->byte_length);
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                       "Buffer.byteLength requires a string or byte source");
    return mal_value_new_undefined();
}

static i32 mal_buffer_compare_bytes(
    const byte *left, usize left_length, const byte *right, usize right_length
) {
    usize common = left_length < right_length ? left_length : right_length;
    i32 compared = common == 0 ? 0 : memcmp(left, right, common);
    if (compared < 0) return -1;
    if (compared > 0) return 1;
    return left_length < right_length ? -1 : left_length > right_length ? 1 : 0;
}

static MalValue mal_buffer_compare(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) self;
    (void) nt;
    (void) callee;
    MalTypedArrayObject *left = mal_buffer_byte_view(
        vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (left == nullptr) return mal_value_new_undefined();
    MalTypedArrayObject *right = mal_buffer_byte_view(
        vm, argc >= 2 ? args[1] : mal_value_new_undefined());
    if (right == nullptr) return mal_value_new_undefined();
    return mal_value_from_i32(mal_buffer_compare_bytes(
        mal_buffer_view_data(left), mal_typed_array_object_length(left),
        mal_buffer_view_data(right), mal_typed_array_object_length(right)));
}

static MalValue mal_buffer_concat(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) self;
    (void) nt;
    MalValue list = argc >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_object(list)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Buffer.concat requires an array of Buffers");
        return mal_value_new_undefined();
    }
    MalValue length_value;
    if (!mal_vm_get_property(vm, list, mal_intrinsic_string_key(vm, "length"), &length_value)) {
        return mal_value_new_undefined();
    }
    u32 list_length;
    if (!mal_buffer_to_size(vm, length_value, &list_length)) return mal_value_new_undefined();
    u64 total = 0;
    if (argc >= 2 && !mal_value_is_undefined(args[1])) {
        u32 requested;
        if (!mal_ops_is_number(args[1])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "The totalLength argument must be a number");
            return mal_value_new_undefined();
        }
        f64 requested_number = mal_ops_to_number(args[1]);
        if (isnan(requested_number) || !isfinite(requested_number) ||
            requested_number < 0 || trunc(requested_number) != requested_number ||
            requested_number > INT32_MAX) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "The totalLength argument is invalid");
            return mal_value_new_undefined();
        }
        requested = (u32) requested_number;
        total = requested;
    } else {
        for (u32 i = 0; i < list_length; i++) {
            MalValue item;
            MalKey key = mal_key_index(i);
            if (!mal_vm_get_property(vm, list, key, &item)) return mal_value_new_undefined();
            MalTypedArrayObject *view = mal_buffer_byte_view(vm, item);
            if (view == nullptr) return mal_value_new_undefined();
            total += mal_typed_array_object_length(view);
            if (total > INT32_MAX) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Buffer is too large");
                return mal_value_new_undefined();
            }
        }
    }
    MalValue result = mal_buffer_new_uninitialized(
        vm, mal_buffer_prototype_from_callee(callee), (u32) total);
    if (mal_value_is_undefined(result)) return result;
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    mal_gc_native_rooted_begin(vm);
    MalTypedArrayObject *output = mal_value_to_typed_array_object(result);
    u32 written = 0;
    for (u32 i = 0; i < list_length && written < total; i++) {
        MalValue item;
        MalKey key = mal_key_index(i);
        if (!mal_vm_get_property(vm, list, key, &item)) goto concat_error;
        MalTypedArrayObject *view = mal_buffer_byte_view(vm, item);
        if (view == nullptr) goto concat_error;
        u32 available = mal_typed_array_object_length(view);
        u32 copy = available < total - written ? available : (u32) total - written;
        if (copy > 0) {
            memmove(output->buffer->data + written, mal_buffer_view_data(view), copy);
        }
        written += copy;
    }
    if (written < total) {
        memset(output->buffer->data + written, 0, (usize) total - written);
    }
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&root);
    return result;

concat_error:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue mal_buffer_to_string(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    (void) callee;
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    MalBufferEncoding encoding;
    if (!mal_buffer_encoding(vm, argc >= 1 ? args[0] : mal_value_new_undefined(),
                             MAL_BUFFER_UTF8, false, false, &encoding)) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    u32 start;
    u32 end;
    if (!mal_buffer_clamped(vm, argc >= 2 ? args[1] : mal_value_new_undefined(), length, 0,
                            &start) ||
        !mal_buffer_clamped(vm, argc >= 3 ? args[2] : mal_value_new_undefined(), length,
                            length, &end)) {
        return mal_value_new_undefined();
    }
    if (end < start) end = start;
    const byte *data = mal_buffer_view_data(array);
    return mal_buffer_string_from_bytes(
        vm, data == nullptr ? nullptr : data + start, end - start, encoding);
}

static MalValue mal_buffer_equals(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    (void) callee;
    MalTypedArrayObject *left = mal_buffer_receiver(vm, self);
    if (left == nullptr) return mal_value_new_undefined();
    MalTypedArrayObject *right = mal_buffer_byte_view(
        vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (right == nullptr) return mal_value_new_undefined();
    u32 left_length = mal_typed_array_object_length(left);
    u32 right_length = mal_typed_array_object_length(right);
    bool equal = left_length == right_length &&
                  (left_length == 0 || memcmp(mal_buffer_view_data(left),
                                              mal_buffer_view_data(right),
                                              left_length) == 0);
    return mal_value_new_boolean(equal);
}

static MalValue mal_buffer_prototype_compare(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    (void) callee;
    MalTypedArrayObject *source = mal_buffer_receiver(vm, self);
    if (source == nullptr) return mal_value_new_undefined();
    MalTypedArrayObject *target = mal_buffer_byte_view(
        vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (target == nullptr) return mal_value_new_undefined();
    u32 target_length = mal_typed_array_object_length(target);
    u32 source_length = mal_typed_array_object_length(source);
    u32 target_start, target_end, source_start, source_end;
    if (!mal_buffer_range_index(vm, argc >= 2 ? args[1] : mal_value_new_undefined(),
                                target_length, 0, &target_start) ||
        !mal_buffer_range_index(vm, argc >= 3 ? args[2] : mal_value_new_undefined(),
                                target_length, target_length, &target_end) ||
        !mal_buffer_range_index(vm, argc >= 4 ? args[3] : mal_value_new_undefined(),
                                source_length, 0, &source_start) ||
        !mal_buffer_range_index(vm, argc >= 5 ? args[4] : mal_value_new_undefined(),
                                source_length, source_length, &source_end)) {
        return mal_value_new_undefined();
    }
    if (target_end < target_start) target_end = target_start;
    if (source_end < source_start) source_end = source_start;
    const byte *source_data = mal_buffer_view_data(source);
    const byte *target_data = mal_buffer_view_data(target);
    return mal_value_from_i32(mal_buffer_compare_bytes(
        source_data == nullptr ? nullptr : source_data + source_start, source_end - source_start,
        target_data == nullptr ? nullptr : target_data + target_start, target_end - target_start));
}

static MalValue mal_buffer_subarray_impl(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue callee
) {
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    u32 length = mal_typed_array_object_length(array);
    u32 start, end;
    if (!mal_buffer_relative(vm, argc >= 1 ? args[0] : mal_value_new_undefined(), length, 0,
                             &start) ||
        !mal_buffer_relative(vm, argc >= 2 ? args[1] : mal_value_new_undefined(), length,
                             length, &end)) {
        return mal_value_new_undefined();
    }
    if (end < start) end = start;
    return mal_buffer_new_view(vm, mal_buffer_prototype_from_callee(callee), array->buffer,
                               array->byte_offset + start, end - start);
}

static MalValue mal_buffer_subarray(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    return mal_buffer_subarray_impl(vm, self, args, argc, callee);
}

static MalValue mal_buffer_slice(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    // Unlike Uint8Array.prototype.slice, Node's legacy Buffer.slice is a shared view.
    return mal_buffer_subarray_impl(vm, self, args, argc, callee);
}

static MalValue mal_buffer_write(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    (void) callee;
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    if (argc < 1 || !mal_value_is_string(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Buffer.write requires a string");
        return mal_value_new_undefined();
    }
    u32 array_length = mal_typed_array_object_length(array);
    u32 offset = 0;
    u32 max_length = array_length;
    MalValue encoding_value = mal_value_new_undefined();
    if (argc >= 2 && mal_value_is_string(args[1])) {
        encoding_value = args[1];
    } else {
        if (argc >= 2 && !mal_value_is_undefined(args[1]) &&
            !mal_buffer_offset(vm, args[1], array_length, 0, &offset)) {
            return mal_value_new_undefined();
        }
        if (offset > array_length) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Buffer write offset is invalid");
            return mal_value_new_undefined();
        }
        max_length = array_length - offset;
        if (argc >= 3 && mal_value_is_string(args[2])) {
            encoding_value = args[2];
        } else {
            if (argc >= 3 && !mal_value_is_undefined(args[2]) &&
                !mal_buffer_offset(vm, args[2], array_length - offset, 0, &max_length)) {
                return mal_value_new_undefined();
            }
            if (argc >= 4) encoding_value = args[3];
        }
    }
    MalBufferEncoding encoding;
    if (!mal_buffer_encoding(
            vm, encoding_value, MAL_BUFFER_UTF8, false, false, &encoding)) {
        return mal_value_new_undefined();
    }
    byte *data = mal_buffer_view_data(array);
    byte *output = data == nullptr ? nullptr : data + offset;
    usize written = mal_buffer_write_string(
        mal_value_to_string(args[0]), encoding, output, max_length);
    return mal_value_from_i32((i32) written);
}

static MalValue mal_buffer_read_uint16_le(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    (void) callee;
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    u32 offset;
    if (!mal_buffer_offset(vm, argc >= 1 ? args[0] : mal_value_from_i32(0),
                           mal_typed_array_object_length(array), 2, &offset)) {
        return mal_value_new_undefined();
    }
    const byte *data = mal_buffer_view_data(array) + offset;
    return mal_value_from_i32((i32) ((u8) data[0] | ((u16) (u8) data[1] << 8)));
}

static MalValue mal_buffer_read_uint16_be(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    (void) callee;
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    u32 offset;
    if (!mal_buffer_offset(vm, argc >= 1 ? args[0] : mal_value_from_i32(0),
                           mal_typed_array_object_length(array), 2, &offset)) {
        return mal_value_new_undefined();
    }
    const byte *data = mal_buffer_view_data(array) + offset;
    return mal_value_from_i32((i32) (((u16) (u8) data[0] << 8) | (u8) data[1]));
}

static MalValue mal_buffer_read_uint32_be(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    (void) callee;
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    u32 offset;
    if (!mal_buffer_offset(vm, argc >= 1 ? args[0] : mal_value_from_i32(0),
                           mal_typed_array_object_length(array), 4, &offset)) {
        return mal_value_new_undefined();
    }
    const byte *data = mal_buffer_view_data(array) + offset;
    u32 value = ((u32) (u8) data[0] << 24) | ((u32) (u8) data[1] << 16)
        | ((u32) (u8) data[2] << 8) | (u8) data[3];
    return mal_value_from_u32(value);
}

static MalValue mal_buffer_read_int32_be(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    MalValue value = mal_buffer_read_uint32_be(vm, self, args, argc, nt, callee);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    u32 bits = mal_value_is_int32(value)
        ? (u32) mal_value_to_i32(value)
        : (u32) mal_value_to_f64(value);
    return mal_value_from_i32((i32) bits);
}

static MalValue mal_buffer_read_big_int64_be(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    (void) callee;
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    u32 offset;
    if (!mal_buffer_offset(vm, argc >= 1 ? args[0] : mal_value_from_i32(0),
                           mal_typed_array_object_length(array), 8, &offset)) {
        return mal_value_new_undefined();
    }
    const byte *data = mal_buffer_view_data(array) + offset;
    u64 bits = 0;
    for (u32 i = 0; i < 8; i++) bits = (bits << 8) | (u8) data[i];
    i128 value = (i128) bits;
    if ((bits & ((u64) 1 << 63)) != 0) value -= (i128) 1 << 64;
    return mal_value_from_bigint(mal_bigint_new(&vm->heap, value));
}

static MalValue mal_buffer_copy(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    (void) callee;
    MalTypedArrayObject *source = mal_buffer_receiver(vm, self);
    if (source == nullptr) return mal_value_new_undefined();
    MalTypedArrayObject *target = mal_buffer_byte_view(
        vm, argc >= 1 ? args[0] : mal_value_new_undefined());
    if (target == nullptr) return mal_value_new_undefined();
    u32 source_length = mal_typed_array_object_length(source);
    u32 target_length = mal_typed_array_object_length(target);
    u32 target_start;
    u32 source_start;
    u32 source_end;
    if (!mal_buffer_range_index(vm, argc >= 2 ? args[1] : mal_value_new_undefined(),
                                target_length, 0, &target_start)
        || !mal_buffer_range_index(vm, argc >= 3 ? args[2] : mal_value_new_undefined(),
                                   source_length, 0, &source_start)
        || !mal_buffer_clamped(vm, argc >= 4 ? args[3] : mal_value_new_undefined(),
                               source_length, source_length, &source_end)) {
        return mal_value_new_undefined();
    }
    u32 count = source_end > source_start ? source_end - source_start : 0;
    if (count > target_length - target_start) count = target_length - target_start;
    if (count > 0) {
        memmove(mal_buffer_view_data(target) + target_start,
                mal_buffer_view_data(source) + source_start, count);
    }
    return mal_value_from_u32(count);
}

static MalValue mal_buffer_write_uint16_be(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    (void) callee;
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    f64 number;
    if (!mal_buffer_to_number(
            vm, argc >= 1 ? args[0] : mal_value_new_undefined(), &number)) {
        return mal_value_new_undefined();
    }
    if (isnan(number)) number = 0;
    number = trunc(number);
    if (!isfinite(number) || number < 0 || number > UINT16_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Buffer value is out of range");
        return mal_value_new_undefined();
    }
    u32 offset;
    if (!mal_buffer_offset(vm, argc >= 2 ? args[1] : mal_value_from_i32(0),
                           mal_typed_array_object_length(array), 2, &offset)) {
        return mal_value_new_undefined();
    }
    u16 value = (u16) number;
    byte *data = mal_buffer_view_data(array) + offset;
    data[0] = (byte) (value >> 8);
    data[1] = (byte) value;
    return mal_value_from_u32(offset + 2);
}

static MalValue mal_buffer_write_big_int64_be(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    (void) callee;
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    i128 value;
    if (!mal_bigint_to_bigint(
            vm, argc >= 1 ? args[0] : mal_value_new_undefined(), &value)) {
        return mal_value_new_undefined();
    }
    const i128 minimum = -((i128) 1 << 63);
    const i128 maximum = ((i128) 1 << 63) - 1;
    if (value < minimum || value > maximum) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Buffer value is out of range");
        return mal_value_new_undefined();
    }
    u32 offset;
    if (!mal_buffer_offset(vm, argc >= 2 ? args[1] : mal_value_from_i32(0),
                           mal_typed_array_object_length(array), 8, &offset)) {
        return mal_value_new_undefined();
    }
    u64 bits = (u64) value;
    byte *data = mal_buffer_view_data(array) + offset;
    for (u32 i = 0; i < 8; i++) data[i] = (byte) (bits >> ((7 - i) * 8));
    return mal_value_from_u32(offset + 8);
}

static MalValue mal_buffer_write_uint32(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, bool little_endian
) {
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    f64 number;
    if (!mal_buffer_to_number(
            vm, argc >= 1 ? args[0] : mal_value_new_undefined(), &number)) {
        return mal_value_new_undefined();
    }
    if (isnan(number)) number = 0;
    number = trunc(number);
    if (!isfinite(number) || number < 0 || number > UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                           "Buffer value is out of range");
        return mal_value_new_undefined();
    }
    u32 offset;
    if (!mal_buffer_offset(vm, argc >= 2 ? args[1] : mal_value_from_i32(0),
                           mal_typed_array_object_length(array), 4, &offset)) {
        return mal_value_new_undefined();
    }
    u32 value = (u32) number;
    byte *data = mal_buffer_view_data(array) + offset;
    for (u32 i = 0; i < 4; i++) {
        u32 shift = (little_endian ? i : 3 - i) * 8;
        data[i] = (byte) (value >> shift);
    }
    return mal_value_from_i32((i32) offset + 4);
}

static MalValue mal_buffer_write_uint32_le(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    (void) callee;
    return mal_buffer_write_uint32(vm, self, args, argc, true);
}

static MalValue mal_buffer_write_uint32_be(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    (void) callee;
    return mal_buffer_write_uint32(vm, self, args, argc, false);
}

static MalNativeFunctionObject *mal_buffer_method(
    MalVm *vm, const byte *name, i32 length, MalNativeFunctionCallback callback,
    MalValue prototype
) {
    return mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name), length, callback, &prototype, 1);
}

static void mal_buffer_define_method(
    MalVm *vm, MalObject *object, const byte *name, i32 length,
    MalNativeFunctionCallback callback, MalValue prototype
) {
    MalValue value = mal_value_from_native_function_object(
        mal_buffer_method(vm, name, length, callback, prototype));
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_intrinsic_define_data(vm, object, name, value,
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                                  MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
}

static void mal_buffer_install_exports(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    MalValue constructor, MalValue module_default
) {
    MalObject *global_this = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_intrinsic_define_data(vm, global_this, "Buffer", constructor,
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "Buffer") == 0) {
            vm->globals[slots[i].slot] = constructor;
        } else if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = module_default;
        } else if (strcmp(slots[i].name, "constants") == 0) {
            MalValue constants;
            if (mal_vm_get_property(vm, module_default,
                    mal_intrinsic_string_key(vm, "constants"), &constants)) {
                vm->globals[slots[i].slot] = constants;
            }
        }
    }
}

void mal_host_install_node_buffer(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch
) {
    (void) launch;
    MalValue cached = vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_CONSTRUCTOR];
    if (!mal_value_is_undefined(cached)) {
        mal_buffer_install_exports(
            vm, slots, count, cached,
            vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_MODULE]);
        return;
    }
    MalValue roots[4] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 4);

    MalObject *uint8_prototype = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, uint8_prototype);
    roots[0] = mal_value_from_object(prototype);

    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "Buffer"), 3, mal_buffer_constructor);
    mal_native_function_object_set_constructor(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", roots[0],
                              MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", roots[1],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_set_prototype(
        (MalObject *) constructor,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_CONSTRUCTOR]));

    mal_buffer_define_method(vm, (MalObject *) constructor, "from", 1, mal_buffer_from, roots[0]);
    mal_buffer_define_method(vm, (MalObject *) constructor, "alloc", 1, mal_buffer_alloc, roots[0]);
    mal_buffer_define_method(vm, (MalObject *) constructor, "allocUnsafe", 1,
                             mal_buffer_alloc_unsafe, roots[0]);
    mal_buffer_define_method(vm, (MalObject *) constructor, "isBuffer", 1,
                             mal_buffer_is_buffer, roots[0]);
    mal_buffer_define_method(vm, (MalObject *) constructor, "byteLength", 1,
                             mal_buffer_byte_length, roots[0]);
    mal_buffer_define_method(vm, (MalObject *) constructor, "concat", 1, mal_buffer_concat,
                             roots[0]);
    mal_buffer_define_method(vm, (MalObject *) constructor, "compare", 2, mal_buffer_compare,
                             roots[0]);

    mal_buffer_define_method(vm, prototype, "toString", 0, mal_buffer_to_string, roots[0]);
    mal_buffer_define_method(vm, prototype, "equals", 1, mal_buffer_equals, roots[0]);
    mal_buffer_define_method(vm, prototype, "compare", 1, mal_buffer_prototype_compare,
                             roots[0]);
    mal_buffer_define_method(vm, prototype, "slice", 2, mal_buffer_slice, roots[0]);
    mal_buffer_define_method(vm, prototype, "subarray", 2, mal_buffer_subarray, roots[0]);
    mal_buffer_define_method(vm, prototype, "write", 1, mal_buffer_write, roots[0]);
    mal_buffer_define_method(vm, prototype, "copy", 1, mal_buffer_copy, roots[0]);
    mal_buffer_define_method(
        vm, prototype, "readUInt16LE", 1, mal_buffer_read_uint16_le, roots[0]);
    mal_buffer_define_method(
        vm, prototype, "readUInt16BE", 1, mal_buffer_read_uint16_be, roots[0]);
    mal_buffer_define_method(
        vm, prototype, "readUInt32BE", 1, mal_buffer_read_uint32_be, roots[0]);
    mal_buffer_define_method(
        vm, prototype, "readInt32BE", 1, mal_buffer_read_int32_be, roots[0]);
    mal_buffer_define_method(
        vm, prototype, "readBigInt64BE", 1, mal_buffer_read_big_int64_be, roots[0]);
    mal_buffer_define_method(
        vm, prototype, "writeUInt16BE", 2, mal_buffer_write_uint16_be, roots[0]);
    mal_buffer_define_method(
        vm, prototype, "writeUInt32LE", 2, mal_buffer_write_uint32_le, roots[0]);
    mal_buffer_define_method(
        vm, prototype, "writeUInt32BE", 2, mal_buffer_write_uint32_be, roots[0]);
    mal_buffer_define_method(
        vm, prototype, "writeBigInt64BE", 2, mal_buffer_write_big_int64_be, roots[0]);

    MalObject *module_default = mal_intrinsic_new_object(vm);
    roots[2] = mal_value_from_object(module_default);
    mal_intrinsic_define_data(vm, module_default, "Buffer", roots[1],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                                  MAL_PROPERTY_CONFIGURABLE);
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[3]),
        "MAX_STRING_LENGTH", mal_value_from_f64((f64) MAL_STRING_MAX_CODE_UNITS),
        MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, module_default, "constants", roots[3],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
            MAL_PROPERTY_CONFIGURABLE);

    vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_CONSTRUCTOR] = roots[1];
    vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_PROTOTYPE] = roots[0];
    vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_MODULE] = roots[2];
    mal_buffer_install_exports(vm, slots, count, roots[1], roots[2]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
