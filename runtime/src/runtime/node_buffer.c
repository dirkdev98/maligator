// Portions derived from Node.js lib/buffer.js, src/node_buffer.cc (MIT); see THIRD_PARTY_NOTICES.md.
#include "node_buffer.h"

#if MAL_NODE

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "array_object.h"
#include "array_buffer_object.h"
#include "base64.h"
#include "builtin_bigint.h"
#include "builtin_data_view.h"
#include "checked_size.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "heap_bigint.h"
#include "hex.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "scalar_bits.h"
#include "secure_scrub.h"
#include "utf8.h"
#include "typed_array_object.h"
#include "value.h"
#include "value_ops.h"
#include "vm_ops.h"

#define MAL_BUFFER_VISIBLE \
    (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE)
/* ArrayBuffer byte lengths are u32 and allocation caps them at INT32_MAX. */
#define MAL_BUFFER_MAX_LENGTH INT32_MAX
#define MAL_BUFFER_INSPECT_MAX_BYTES 50u

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
    MalStringIterator iterator;
    MalStringSegment segment;
    mal_string_iterator_init(&iterator, string, 0, mal_string_length(string));
    u32 accumulator = 0;
    i32 sextets = 0;
    usize written = 0;
    while (mal_string_iterator_next(&iterator, &segment)) {
        for (usize i = 0; i < segment.length; i++) {
            c16 unit = mal_string_segment_code_unit_at(&segment, i);
            if (unit == '=') goto done;
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
                if (bytes != nullptr) memcpy(bytes + written, block, copy);
                written += copy;
                if (written == capacity) goto done;
                accumulator = 0;
                sextets = 0;
            }
        }
    }
done:
    mal_string_iterator_dispose(&iterator);
    if (sextets == 2) {
        if (written < capacity) {
            if (bytes != nullptr) bytes[written] = (byte) ((accumulator >> 4) & 0xff);
            written++;
        }
    } else if (sextets == 3) {
        if (written < capacity) {
            if (bytes != nullptr) bytes[written] = (byte) ((accumulator >> 10) & 0xff);
            written++;
        }
        if (written < capacity) {
            if (bytes != nullptr) bytes[written] = (byte) ((accumulator >> 2) & 0xff);
            written++;
        }
    }
    return written;
}

static usize mal_buffer_write_string(
    const MalString *string, MalBufferEncoding encoding,
    byte *output, usize capacity
) {
    if (encoding == MAL_BUFFER_UTF8) {
        usize written;
        mal_string_utf8_encode_into(string, output, capacity, nullptr, &written);
        return written;
    }
    if (encoding == MAL_BUFFER_BASE64 || encoding == MAL_BUFFER_BASE64URL) {
        return mal_buffer_decode_base64_into(string, output, capacity);
    }
    MalStringIterator iterator;
    MalStringSegment segment;
    mal_string_iterator_init(&iterator, string, 0, mal_string_length(string));
    usize written = 0;
    i32 high = -1;
    while (written < capacity && mal_string_iterator_next(&iterator, &segment)) {
        if (segment.latin1 &&
            (encoding == MAL_BUFFER_LATIN1 || encoding == MAL_BUFFER_ASCII)) {
            usize count = segment.length < capacity - written ? segment.length : capacity - written;
            if (output != nullptr) memcpy(output + written, segment.latin1_units, count);
            written += count;
            continue;
        }
        for (usize i = 0; i < segment.length && written < capacity; i++) {
            c16 unit = mal_string_segment_code_unit_at(&segment, i);
            if (encoding == MAL_BUFFER_HEX) {
                i32 digit = mal_hex_decode_digit(unit);
                if (digit < 0) goto done;
                if (high < 0) {
                    high = digit;
                } else {
                    if (output != nullptr) output[written] = (byte) ((high << 4) | digit);
                    written++;
                    high = -1;
                }
            } else if (encoding == MAL_BUFFER_UTF16LE) {
                if (capacity - written < 2) goto done;
                if (output != nullptr) {
                    output[written] = (byte) unit;
                    output[written + 1] = (byte) (unit >> 8);
                }
                written += 2;
            } else {
                // Node's ascii and latin1 encoders both retain the low eight bits.
                if (output != nullptr) output[written] = (byte) (unit & 0xff);
                written++;
            }
        }
    }
done:
    mal_string_iterator_dispose(&iterator);
    return written;
}

static byte *mal_buffer_encode_string(
    const MalString *string, MalBufferEncoding encoding, usize *length_out
) {
    if (encoding == MAL_BUFFER_UTF8) {
        usize capacity;
        *length_out = 0;
        if (!mal_checked_size_multiply(mal_string_length(string),
                string->latin1 ? 2 : 3, SIZE_MAX, &capacity)) return nullptr;
        byte *bytes = malloc(capacity == 0 ? 1 : capacity);
        if (bytes != nullptr) {
            mal_string_utf8_encode_into(string, bytes, capacity, nullptr, length_out);
            if (*length_out != capacity) {
                byte *trimmed = realloc(bytes, *length_out == 0 ? 1 : *length_out);
                if (trimmed == nullptr) {
                    free(bytes);
                    *length_out = 0;
                    return nullptr;
                }
                bytes = trimmed;
            }
        }
        return bytes;
    }
    usize length = mal_string_length(string);
    usize capacity = encoding == MAL_BUFFER_UTF16LE ? length * 2
        : encoding == MAL_BUFFER_HEX ? length / 2
        : encoding == MAL_BUFFER_BASE64 || encoding == MAL_BUFFER_BASE64URL ? length / 4 * 3 + 3
        : length;
    byte *bytes = malloc(capacity == 0 ? 1 : capacity);
    if (bytes == nullptr) {
        *length_out = 0;
        return nullptr;
    }
    *length_out = mal_buffer_write_string(string, encoding, bytes, capacity);
    return bytes;
}

static usize mal_buffer_encoded_string_length(
    const MalString *string, MalBufferEncoding encoding
) {
    usize length = mal_string_length(string);
    if (encoding == MAL_BUFFER_UTF8) return mal_string_utf8_length(string);
    if (encoding == MAL_BUFFER_UTF16LE) return length * 2;
    if (encoding == MAL_BUFFER_HEX || encoding == MAL_BUFFER_BASE64 || encoding == MAL_BUFFER_BASE64URL) {
        return mal_buffer_write_string(string, encoding, nullptr, SIZE_MAX);
    }
    return length;
}

static MalValue mal_buffer_string_from_bytes(
    MalVm *vm, const byte *bytes, usize length, MalBufferEncoding encoding
) {
    if (encoding == MAL_BUFFER_UTF8) {
        MalUtf8DecodeStatus status;
        MalString *string = mal_string_from_utf8_report(
            &vm->heap, bytes, length, nullptr, &status);
        if (string == nullptr) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                status == MAL_UTF8_DECODE_LENGTH_OVERFLOW
                    ? "Invalid string length" : "Buffer string allocation failed");
            return mal_value_new_undefined();
        }
        return mal_value_from_string(string);
    }
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
    if (encoding == MAL_BUFFER_LATIN1) {
        return mal_value_from_string(mal_string_new_latin1_copy(&vm->heap, (const u8 *) bytes, length));
    }
    if (encoding == MAL_BUFFER_ASCII) {
        u8 inline_units[MAL_STRING_INLINE_LATIN1_CODE_UNITS];
        u8 *units = output_length <= MAL_STRING_INLINE_LATIN1_CODE_UNITS
            ? inline_units : mal_heap_alloc_raw_profiled(
                &vm->heap, output_length, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
        for (usize i = 0; i < output_length; i++) units[i] = (u8) bytes[i] & 0x7f;
        MalString *result = units == inline_units
            ? mal_string_new_latin1_copy(&vm->heap, units, output_length)
            : mal_string_new_latin1_owned(&vm->heap, units, output_length);
        return mal_value_from_string(result);
    }
    c16 inline_units[MAL_STRING_INLINE_CODE_UNITS];
    c16 *units = output_length <= MAL_STRING_INLINE_CODE_UNITS
        ? inline_units : mal_heap_alloc_raw_profiled(
            &vm->heap, sizeof(c16) * output_length, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    for (usize i = 0; i < output_length; i++) {
        units[i] = (c16) ((u8) bytes[i * 2] | ((u16) (u8) bytes[i * 2 + 1] << 8));
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
    if (!mal_node_validate_number(vm, value, "size")) return false;
    f64 number = mal_ops_number_as_f64(value);
    if (isnan(number) || number < 0 || number > MAL_BUFFER_MAX_LENGTH) {
        char range[64];
        snprintf(range, sizeof range, ">= 0 && <= %d", MAL_BUFFER_MAX_LENGTH);
        mal_node_throw_out_of_range(vm, "size", range, value);
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

static MalValue mal_buffer_is_encoding(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee) {
    (void) receiver; (void) callee;
    if (!mal_value_is_undefined(new_target)) {
        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(
                vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
            return mal_value_new_undefined();
        }
        return mal_value_from_object(mal_object_new(&vm->heap, prototype));
    }
    return mal_value_new_boolean(argc > 0 && mal_node_buffer_encoding_is_known(args[0]));
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

/* Node 26's methods work on any Uint8Array receiver, not only Buffers. */
static MalTypedArrayObject *mal_buffer_receiver(MalVm *vm, MalValue value) {
    if (!mal_value_is_typed_array_object(value) ||
        mal_value_to_typed_array_object(value)->kind != MAL_TA_UINT8) {
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

// Buffer views may alias a SharedArrayBuffer (Buffer.from(sab)); every byte
// access below goes through these so concurrent agents never race plain C.
static bool mal_buffer_view_shared(const MalTypedArrayObject *array) {
    return array->buffer->shared_memory != nullptr;
}

static void mal_buffer_view_read(
    MalTypedArrayObject *array, u32 offset, byte *dst, usize length) {
    if (length == 0) return;
    mal_typed_array_copy_bytes(
        dst, false, mal_buffer_view_data(array) + offset,
        mal_buffer_view_shared(array), length);
}

static void mal_buffer_view_write(
    MalTypedArrayObject *array, u32 offset, const byte *src, usize length) {
    mal_typed_array_copy_bytes(
        mal_buffer_view_data(array) + offset, mal_buffer_view_shared(array),
        src, false, length);
}

/* Stable bytes for in-place readers; a shared view yields a private snapshot in *owned. */
static const byte *mal_buffer_view_private(
    MalTypedArrayObject *array, u32 offset, usize length, byte **owned) {
    *owned = nullptr;
    const byte *data = mal_buffer_view_data(array);
    if (data == nullptr || length == 0) return nullptr;
    if (!mal_buffer_view_shared(array)) return data + offset;
    *owned = malloc(length);
    if (*owned == nullptr) return nullptr;
    mal_shared_bytes_read(*owned, data + offset, length);
    return *owned;
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

static MalValue mal_buffer_throw_code(
    MalVm *vm, MalIntrinsic prototype, const byte *message, const byte *code
) {
    mal_vm_throw_error(vm, prototype, message);
    MalValue roots[] = {
        vm->completion.value,
        mal_value_from_string(mal_intrinsic_ascii(vm, code)),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), "code", roots[1],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue mal_buffer_invalid_type(MalVm *vm, MalValue input, const byte *message) {
    if (mal_value_is_object(input) || mal_value_is_callable(input)) {
        MalValue received[] = { input, mal_value_new_undefined() };
        MalRootSpan received_root;
        mal_gc_root(&received_root, received, countof(received));
        // Node's error formatting observes constructor/name accessors before throwing.
        bool callable = mal_value_is_callable(input);
        received[1] = mal_vm_op_load_property(vm, received[0], mal_value_from_string(
            mal_intrinsic_ascii(vm, callable ? "name" : "constructor")));
        if (!callable && vm->completion.kind != MAL_COMPLETION_THROW
            && !mal_value_is_nil(received[1])) {
            received[1] = mal_vm_op_load_property(vm, received[1], mal_value_from_string(
                mal_intrinsic_ascii(vm, "name")));
        }
        if (callable && vm->completion.kind != MAL_COMPLETION_THROW) {
            MalString *name;
            mal_vm_to_string(vm, received[1], &name);
        }
        mal_gc_unroot(&received_root);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    }
    return mal_buffer_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        message, "ERR_INVALID_ARG_TYPE");
}

static MalValue mal_buffer_validate_text(MalVm *vm, MalValue input, bool utf8) {
    const byte *data;
    u32 length;
    bool shared;
    if (mal_value_is_array_buffer_object(input)) {
        MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(input);
        if (mal_array_buffer_object_is_detached(buffer)) {
            return mal_buffer_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                "Cannot validate on a detached buffer", "ERR_INVALID_STATE");
        }
        length = mal_array_buffer_object_byte_length(buffer);
        data = buffer->data;
        shared = buffer->shared_memory != nullptr;
    } else if (mal_value_is_typed_array_object(input)) {
        MalTypedArrayObject *view = mal_value_to_typed_array_object(input);
        length = mal_typed_array_object_byte_length(view);
        data = length == 0 ? nullptr : mal_buffer_view_data(view);
        shared = mal_buffer_view_shared(view);
    } else {
        return mal_buffer_invalid_type(vm, input,
            "The input argument must be an ArrayBuffer, Buffer, or TypedArray");
    }
    if (length == 0) return mal_value_new_boolean(true);
    byte *snapshot = nullptr;
    if (shared) {
        snapshot = malloc(length);
        if (snapshot == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        mal_shared_bytes_read(snapshot, data, length);
        data = snapshot;
    }
    bool valid = true;
    if (utf8) {
        valid = mal_utf8_is_valid(data, length);
    } else {
        for (u32 index = 0; index < length; index++) {
            if ((u8) data[index] >= 0x80) {
                valid = false;
                break;
            }
        }
    }
    free(snapshot);
    return mal_value_new_boolean(valid);
}

static bool mal_buffer_copy_index(MalVm *vm, MalValue value, f64 *out) {
    if (!mal_ops_is_number(value)) {
        mal_buffer_invalid_type(vm, value,
            "The offset or length argument must be a number");
        return false;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || number < 0 || trunc(number) != number
        || number > 9007199254740991.0) {
        mal_buffer_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "The offset or length argument must be a nonnegative safe integer",
            "ERR_OUT_OF_RANGE");
        return false;
    }
    *out = number;
    return true;
}

static MalValue mal_buffer_copy_bytes_from(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver;
    if (!mal_value_is_undefined(new_target)) {
        MalObject *prototype;
        if (!mal_vm_get_prototype_from_constructor(
                vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
            return mal_value_new_undefined();
        }
    }
    MalValue roots[] = {
        argc > 0 ? args[0] : mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    if (!mal_value_is_typed_array_object(roots[0])) {
        mal_buffer_invalid_type(vm, roots[0], "The view argument must be a TypedArray");
        goto failed;
    }
    MalTypedArrayObject *input = mal_value_to_typed_array_object(roots[0]);
    u32 view_length = mal_typed_array_object_length(input);
    u32 start = 0, end = view_length;
    if (view_length == 0) goto empty;
    if (argc > 1 && !mal_value_is_undefined(args[1])) {
        f64 offset;
        if (!mal_buffer_copy_index(vm, args[1], &offset)) goto failed;
        if (offset >= view_length) goto empty;
        start = (u32) offset;
    }
    if (argc > 2 && !mal_value_is_undefined(args[2])) {
        f64 length;
        if (!mal_buffer_copy_index(vm, args[2], &length)) goto failed;
        f64 requested_end = start + length;
        end = requested_end < view_length ? (u32) requested_end : view_length;
    }
    if (end <= start) goto empty;
    u32 element_size = mal_typed_array_element_size(input->kind);
    u32 byte_length = (end - start) * element_size;
    roots[1] = mal_buffer_new_uninitialized(
        vm, mal_buffer_prototype_from_callee(callee), byte_length);
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto failed;
    mal_buffer_view_read(input, start * element_size,
        mal_buffer_view_data(mal_value_to_typed_array_object(roots[1])), byte_length);
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
 empty:
    result = mal_buffer_new(vm, mal_buffer_prototype_from_callee(callee), 0);
    mal_gc_unroot(&root);
    return result;
 failed:
    mal_gc_unroot(&root);
    return mal_value_new_undefined();
}

static MalValue mal_buffer_validate_text_call(
    MalVm *vm, MalValue input, MalValue new_target, bool utf8
) {
    if (mal_value_is_undefined(new_target)) return mal_buffer_validate_text(vm, input, utf8);
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
        return mal_value_new_undefined();
    }
    MalValue instance = mal_value_from_object(mal_object_new(&vm->heap, prototype));
    MalRootSpan root;
    mal_gc_root(&root, &instance, 1);
    (void) mal_buffer_validate_text(vm, input, utf8);
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : instance;
}

typedef enum MalTranscodeEncoding {
    MAL_TRANSCODE_UNSUPPORTED, MAL_TRANSCODE_ASCII, MAL_TRANSCODE_LATIN1, MAL_TRANSCODE_UCS2,
    MAL_TRANSCODE_UTF8,
} MalTranscodeEncoding;

// ICU UErrorCode values that Node reports as errno.
#define MAL_U_ILLEGAL_ARGUMENT_ERROR 1
#define MAL_U_INVALID_CHAR_FOUND 10

/* lib/buffer.js normalizeEncoding, limited to the encodings node_i18n.cc transcodes. */
static MalTranscodeEncoding mal_transcode_encoding(MalValue value) {
    if (mal_value_is_nil(value)) return MAL_TRANSCODE_UTF8;
    if (!mal_value_is_string(value)) return MAL_TRANSCODE_UNSUPPORTED;
    MalString *string = mal_value_to_string(value);
    usize length = mal_string_length(string);
    const c16 *units = mal_string_code_units(string);
    char lower[16];
    if (length >= sizeof lower) return MAL_TRANSCODE_UNSUPPORTED;
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        if (unit >= 0x80) return MAL_TRANSCODE_UNSUPPORTED;
        lower[i] = (char) (unit >= 'A' && unit <= 'Z' ? unit + 32 : unit);
    }
    lower[length] = '\0';
    if (strcmp(lower, "utf8") == 0 || strcmp(lower, "utf-8") == 0) return MAL_TRANSCODE_UTF8;
    if (strcmp(lower, "ucs2") == 0 || strcmp(lower, "ucs-2") == 0 || strcmp(lower, "utf16le") == 0
        || strcmp(lower, "utf-16le") == 0) {
        return MAL_TRANSCODE_UCS2;
    }
    if (strcmp(lower, "latin1") == 0 || strcmp(lower, "binary") == 0) return MAL_TRANSCODE_LATIN1;
    if (strcmp(lower, "ascii") == 0) return MAL_TRANSCODE_ASCII;
    return MAL_TRANSCODE_UNSUPPORTED;
}

/* Next code point of `bytes`; invalid input yields U+FFFD per maximal subpart, or -1 when strict. */
static i32 mal_transcode_utf8_next(const u8 *bytes, usize length, usize *offset, bool strict) {
    u8 lead = bytes[*offset];
    if (lead < 0x80) {
        (*offset)++;
        return lead;
    }
    u32 need = lead >= 0xC2 && lead <= 0xDF ? 1 : lead >= 0xE0 && lead <= 0xEF ? 2
        : lead >= 0xF0 && lead <= 0xF4 ? 3 : 0;
    u32 code = need == 1 ? lead & 0x1F : need == 2 ? lead & 0x0F : lead & 0x07;
    usize position = *offset + 1;
    for (u32 i = 0; i < need; i++, position++) {
        u8 lower = 0x80, upper = 0xBF;
        if (i == 0 && lead == 0xE0) lower = 0xA0;
        if (i == 0 && lead == 0xED) upper = 0x9F;
        if (i == 0 && lead == 0xF0) lower = 0x90;
        if (i == 0 && lead == 0xF4) upper = 0x8F;
        if (position >= length || bytes[position] < lower || bytes[position] > upper) {
            *offset = position;
            return strict ? -1 : 0xFFFD;
        }
        code = (code << 6) | (bytes[position] & 0x3F);
    }
    *offset = need == 0 ? *offset + 1 : position;
    if (need == 0) return strict ? -1 : 0xFFFD;
    return (i32) code;
}

static void mal_transcode_put(u8 *out, usize *used, MalTranscodeEncoding to, u32 code) {
    switch (to) {
    case MAL_TRANSCODE_ASCII:
        out[(*used)++] = code < 0x80 ? (u8) code : '?';
        return;
    case MAL_TRANSCODE_LATIN1:
        out[(*used)++] = code < 0x100 ? (u8) code : '?';
        return;
    case MAL_TRANSCODE_UCS2:
        if (code >= 0x10000) {
            u32 high = 0xD800 + ((code - 0x10000) >> 10), low = 0xDC00 + ((code - 0x10000) & 0x3FF);
            out[(*used)++] = (u8) high;
            out[(*used)++] = (u8) (high >> 8);
            out[(*used)++] = (u8) low;
            out[(*used)++] = (u8) (low >> 8);
        } else {
            out[(*used)++] = (u8) code;
            out[(*used)++] = (u8) (code >> 8);
        }
        return;
    case MAL_TRANSCODE_UTF8:
        if (code < 0x80) {
            out[(*used)++] = (u8) code;
        } else if (code < 0x800) {
            out[(*used)++] = (u8) (0xC0 | (code >> 6));
            out[(*used)++] = (u8) (0x80 | (code & 0x3F));
        } else if (code < 0x10000) {
            out[(*used)++] = (u8) (0xE0 | (code >> 12));
            out[(*used)++] = (u8) (0x80 | ((code >> 6) & 0x3F));
            out[(*used)++] = (u8) (0x80 | (code & 0x3F));
        } else {
            out[(*used)++] = (u8) (0xF0 | (code >> 18));
            out[(*used)++] = (u8) (0x80 | ((code >> 12) & 0x3F));
            out[(*used)++] = (u8) (0x80 | ((code >> 6) & 0x3F));
            out[(*used)++] = (u8) (0x80 | (code & 0x3F));
        }
        return;
    case MAL_TRANSCODE_UNSUPPORTED:
        return;
    }
}

/* node_i18n.cc Transcode: ASCII/Latin-1 to UCS-2 widen bytes, UTF-8 to UCS-2 and UCS-2 to
 * UTF-8 are strict, and every other pair converts with ICU substitution ('?' for unmappable
 * output, U+FFFD for invalid input). Returns the ICU error code, or 0. */
static int mal_transcode(const u8 *bytes, usize length, MalTranscodeEncoding from, MalTranscodeEncoding to,
    u8 **out, usize *out_length) {
    if (from == MAL_TRANSCODE_UNSUPPORTED || to == MAL_TRANSCODE_UNSUPPORTED) return MAL_U_ILLEGAL_ARGUMENT_ERROR;
    if (from == MAL_TRANSCODE_UCS2 && to == MAL_TRANSCODE_UTF8 && length % 2 != 0) return MAL_U_INVALID_CHAR_FOUND;
    *out = malloc(length * 4 + 4);
    if (*out == nullptr) return -1;
    usize used = 0;
    usize offset = 0;
    while (offset < length) {
        i32 code;
        if (from == MAL_TRANSCODE_LATIN1 || (from == MAL_TRANSCODE_ASCII && to == MAL_TRANSCODE_UCS2)) {
            code = bytes[offset++];
        } else if (from == MAL_TRANSCODE_ASCII) {
            code = bytes[offset] < 0x80 ? bytes[offset] : 0xFFFD;
            offset++;
        } else if (from == MAL_TRANSCODE_UTF8) {
            code = mal_transcode_utf8_next(bytes, length, &offset, to == MAL_TRANSCODE_UCS2);
        } else {
            if (offset + 1 >= length) break;
            u32 unit = (u32) bytes[offset] | ((u32) bytes[offset + 1] << 8);
            offset += 2;
            code = (i32) unit;
            if (unit >= 0xD800 && unit <= 0xDBFF && offset + 1 < length) {
                u32 next = (u32) bytes[offset] | ((u32) bytes[offset + 1] << 8);
                if (next >= 0xDC00 && next <= 0xDFFF) {
                    code = (i32) (0x10000 + ((unit - 0xD800) << 10) + (next - 0xDC00));
                    offset += 2;
                }
            }
            if (code >= 0xD800 && code <= 0xDFFF) {
                if (to == MAL_TRANSCODE_UTF8) code = -1;
                else if (to != MAL_TRANSCODE_UCS2) code = '?';
            }
        }
        if (code < 0) {
            free(*out);
            *out = nullptr;
            return MAL_U_INVALID_CHAR_FOUND;
        }
        if (to == MAL_TRANSCODE_UCS2 && code >= 0xD800 && code <= 0xDFFF) {
            (*out)[used++] = (u8) code;
            (*out)[used++] = (u8) (code >> 8);
        } else {
            mal_transcode_put(*out, &used, to, (u32) code);
        }
    }
    *out_length = used;
    return 0;
}

/* lib/internal/blob.js resolveObjectURL. The runtime has no URL.createObjectURL, so no
 * "blob:nodedata:" id is ever registered and every URL resolves to undefined. */
static MalValue mal_buffer_resolve_object_url(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) self; (void) new_target; (void) callee;
    MalString *url;
    (void) mal_vm_to_string(vm, argc > 0 ? args[0] : mal_value_new_undefined(), &url);
    return mal_value_new_undefined();
}

/* lib/buffer.js transcode over node_i18n.cc. */
static MalValue mal_buffer_transcode(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) self; (void) new_target; (void) callee;
    MalValue source = argc > 0 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_typed_array_object(source) || mal_value_to_typed_array_object(source)->kind != MAL_TA_UINT8) {
        mal_node_throw_invalid_arg_type(vm, "source", "an instance of Buffer or Uint8Array", source);
        return mal_value_new_undefined();
    }
    MalTypedArrayObject *array = mal_value_to_typed_array_object(source);
    usize length = mal_typed_array_object_is_out_of_bounds(array) ? 0 : mal_typed_array_object_length(array);
    if (length == 0) return mal_node_buffer_from_owned_bytes(vm, nullptr, 0);
    MalTranscodeEncoding from = mal_transcode_encoding(argc > 1 ? args[1] : mal_value_new_undefined());
    MalTranscodeEncoding to = mal_transcode_encoding(argc > 2 ? args[2] : mal_value_new_undefined());
    u8 *input = malloc(length);
    if (input == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    mal_buffer_view_read(array, 0, (byte *) input, length);
    u8 *output = nullptr;
    usize output_length = 0;
    int status = mal_transcode(input, length, from, to, &output, &output_length);
    free(input);
    if (status < 0) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    if (status > 0) {
        const char *code = status == MAL_U_ILLEGAL_ARGUMENT_ERROR ? "U_ILLEGAL_ARGUMENT_ERROR" : "U_INVALID_CHAR_FOUND";
        char message[96];
        snprintf(message, sizeof message, "Unable to transcode Buffer [%s]", code);
        mal_node_throw_code(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, message, code);
        MalValue error = vm->completion.value;
        if (mal_value_is_object(error)) {
            MalRootSpan root;
            mal_gc_root(&root, &error, 1);
            mal_intrinsic_define_data(vm, mal_value_to_object(error), (const byte *) "errno",
                mal_value_from_i32(status), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
            vm->completion.value = error;
            mal_gc_unroot(&root);
        }
        return mal_value_new_undefined();
    }
    return mal_node_buffer_from_owned_bytes(vm, (byte *) output, output_length);
}

static MalValue mal_buffer_is_ascii(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) self; (void) callee;
    return mal_buffer_validate_text_call(
        vm, argc > 0 ? args[0] : mal_value_new_undefined(), new_target, false);
}

static MalValue mal_buffer_is_utf8(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) self; (void) callee;
    return mal_buffer_validate_text_call(
        vm, argc > 0 ? args[0] : mal_value_new_undefined(), new_target, true);
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

static MalValue mal_buffer_compare_views(
    MalVm *vm, MalTypedArrayObject *left, u32 left_start, u32 left_length,
    MalTypedArrayObject *right, u32 right_start, u32 right_length
) {
    byte *left_owned;
    byte *right_owned;
    const byte *left_data = mal_buffer_view_private(left, left_start, left_length, &left_owned);
    const byte *right_data = mal_buffer_view_private(right, right_start, right_length, &right_owned);
    if ((left_length > 0 && left_data == nullptr) || (right_length > 0 && right_data == nullptr)) {
        free(left_owned);
        free(right_owned);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    i32 compared = mal_buffer_compare_bytes(left_data, left_length, right_data, right_length);
    free(left_owned);
    free(right_owned);
    return mal_value_from_i32(compared);
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
    return mal_buffer_compare_views(
        vm, left, 0, mal_typed_array_object_length(left),
        right, 0, mal_typed_array_object_length(right));
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
    u32 list_length;
    MalArrayObject *dense_list = nullptr;
    if (mal_value_is_array_object(list)) {
        MalArrayObject *array = mal_value_to_array_object(list);
        list_length = mal_array_object_length(array);
        if (list_length > INT32_MAX) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                               "The Buffer size is invalid");
            return mal_value_new_undefined();
        }
        if (array->dense_count >= list_length) {
            bool complete = true;
            for (u32 i = 0; i < list_length; i++) {
                if (!mal_array_object_dense_has(array, i)) {
                    complete = false;
                    break;
                }
            }
            if (complete) dense_list = array;
        }
    } else {
        MalValue length_value;
        if (!mal_vm_get_property(
                vm, list, mal_intrinsic_string_key(vm, "length"),
                &length_value)) {
            return mal_value_new_undefined();
        }
        if (!mal_buffer_to_size(vm, length_value, &list_length)) {
            return mal_value_new_undefined();
        }
    }
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
            if (dense_list != nullptr) {
                (void) mal_array_object_dense_get(dense_list, i, &item);
            } else {
                MalKey key = mal_key_index(i);
                if (!mal_vm_get_property(vm, list, key, &item)) {
                    return mal_value_new_undefined();
                }
            }
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
        if (dense_list != nullptr) {
            (void) mal_array_object_dense_get(dense_list, i, &item);
        } else {
            MalKey key = mal_key_index(i);
            if (!mal_vm_get_property(vm, list, key, &item)) goto concat_error;
        }
        MalTypedArrayObject *view = mal_buffer_byte_view(vm, item);
        if (view == nullptr) goto concat_error;
        u32 available = mal_typed_array_object_length(view);
        u32 copy = available < total - written ? available : (u32) total - written;
        if (copy > 0) {
            mal_typed_array_copy_bytes(output->buffer->data + written, false,
                                       mal_buffer_view_data(view),
                                       mal_buffer_view_shared(view), copy);
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
    byte *owned;
    const byte *data = mal_buffer_view_private(array, start, end - start, &owned);
    if (end > start && data == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue result = mal_buffer_string_from_bytes(vm, data, end - start, encoding);
    free(owned);
    return result;
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
    if (left_length != right_length) return mal_value_new_boolean(false);
    MalValue compared = mal_buffer_compare_views(
        vm, left, 0, left_length, right, 0, right_length);
    if (mal_value_is_undefined(compared)) return compared;
    return mal_value_new_boolean(mal_value_to_i32(compared) == 0);
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
    return mal_buffer_compare_views(
        vm, source, source_start, source_end - source_start,
        target, target_start, target_end - target_start);
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
    if (output == nullptr || !mal_buffer_view_shared(array)) {
        usize written = mal_buffer_write_string(
            mal_value_to_string(args[0]), encoding, output, max_length);
        return mal_value_from_i32((i32) written);
    }
    byte *staged = malloc(max_length == 0 ? 1 : max_length);
    if (staged == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    usize written = mal_buffer_write_string(
        mal_value_to_string(args[0]), encoding, staged, max_length);
    mal_buffer_view_write(array, offset, staged, written);
    free(staged);
    return mal_value_from_i32((i32) written);
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
        mal_typed_array_copy_bytes(
            mal_buffer_view_data(target) + target_start, mal_buffer_view_shared(target),
            mal_buffer_view_data(source) + source_start, mal_buffer_view_shared(source), count);
    }
    return mal_value_from_u32(count);
}

typedef enum MalBufferNumberKind {
    MAL_BUFFER_NUMBER_UINT,
    MAL_BUFFER_NUMBER_INT,
    MAL_BUFFER_NUMBER_FLOAT,
    MAL_BUFFER_NUMBER_BIG_UINT,
    MAL_BUFFER_NUMBER_BIG_INT,
} MalBufferNumberKind;

/* A numeric accessor's slot-1 descriptor; width 0 takes the byteLength argument. */
#define MAL_BUFFER_ACCESS(kind, width, little) \
    ((i32) ((kind) | ((width) << 4) | ((little) ? 0x100 : 0)))
#define MAL_BUFFER_ACCESS_KIND(access) ((MalBufferNumberKind) ((access) & 0xf))
#define MAL_BUFFER_ACCESS_WIDTH(access) ((u32) (((access) >> 4) & 0xf))
#define MAL_BUFFER_ACCESS_LITTLE(access) (((access) & 0x100) != 0)

/* lib/buffer.js boundsError: `last` is the largest valid index, negative when nothing fits. */
static void mal_buffer_bounds_error(MalVm *vm, MalValue value, i64 last, const char *name) {
    if (!mal_ops_is_number(value)) {
        mal_node_validate_number(vm, value, name == nullptr ? "offset" : name);
        return;
    }
    f64 number = mal_ops_number_as_f64(value);
    if (floor(number) != number) {
        mal_node_throw_out_of_range(vm, name == nullptr ? "offset" : name, "an integer", value);
        return;
    }
    if (last < 0) {
        mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Attempt to access memory outside buffer bounds", "ERR_BUFFER_OUT_OF_BOUNDS");
        return;
    }
    char range[64];
    snprintf(range, sizeof range, ">= %d and <= %lld", name == nullptr ? 0 : 1, (long long) last);
    mal_node_throw_out_of_range(vm, name == nullptr ? "offset" : name, range, value);
}

static bool mal_buffer_access_offset(
    MalVm *vm, MalValue value, u32 length, u32 width, u32 *out) {
    if (mal_value_is_int32(value)) {
        i32 offset = mal_value_to_i32(value);
        if (offset >= 0 && (u32) offset <= length && width <= length - (u32) offset) {
            *out = (u32) offset;
            return true;
        }
    }
    if (!mal_node_validate_number(vm, value, "offset")) return false;
    f64 number = mal_ops_number_as_f64(value);
    if (number >= 0 && trunc(number) == number && number + width <= length) {
        *out = (u32) number;
        return true;
    }
    mal_buffer_bounds_error(vm, value, (i64) length - width, nullptr);
    return false;
}

static bool mal_buffer_access_byte_length(MalVm *vm, MalValue value, u32 *out) {
    if (mal_ops_is_number(value)) {
        f64 number = mal_ops_number_as_f64(value);
        if (number >= 1 && number <= 6 && trunc(number) == number) {
            *out = (u32) number;
            return true;
        }
    }
    mal_buffer_bounds_error(vm, value, 6, "byteLength");
    return false;
}

static i32 mal_buffer_access_descriptor(MalValue callee) {
    return mal_value_to_i32(mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 1));
}

static MalValue mal_buffer_read_number(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    i32 access = mal_buffer_access_descriptor(callee);
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    MalValue offset_value = argc > 0 ? args[0] : mal_value_new_undefined();
    u32 width = MAL_BUFFER_ACCESS_WIDTH(access);
    if (width == 0) {
        if (mal_value_is_undefined(offset_value)) {
            mal_node_validate_number(vm, offset_value, "offset");
            return mal_value_new_undefined();
        }
        if (!mal_buffer_access_byte_length(
                vm, argc > 1 ? args[1] : mal_value_new_undefined(), &width)) {
            return mal_value_new_undefined();
        }
    } else if (mal_value_is_undefined(offset_value)) {
        offset_value = mal_value_from_i32(0);
    }
    u32 offset;
    if (!mal_buffer_access_offset(
            vm, offset_value, mal_typed_array_object_length(array), width, &offset)) {
        return mal_value_new_undefined();
    }
    byte data[8];
    mal_buffer_view_read(array, offset, data, width);
    bool little = MAL_BUFFER_ACCESS_LITTLE(access);
    u64 bits = 0;
    for (u32 i = 0; i < width; i++) bits = (bits << 8) | (u8) data[little ? width - 1 - i : i];
    switch (MAL_BUFFER_ACCESS_KIND(access)) {
        case MAL_BUFFER_NUMBER_UINT:
            return width <= 4 ? mal_value_from_u32((u32) bits) : mal_value_from_f64((f64) bits);
        case MAL_BUFFER_NUMBER_INT: {
            u32 shift = 64 - width * 8;
            i64 value = (i64) (bits << shift) >> shift;
            return width <= 4 ? mal_value_from_i32((i32) value) : mal_value_from_f64((f64) value);
        }
        case MAL_BUFFER_NUMBER_FLOAT:
            return mal_value_from_f64(width == 4
                ? (f64) mal_scalar_f32_from_bits((u32) bits) : mal_scalar_f64_from_bits(bits));
        case MAL_BUFFER_NUMBER_BIG_UINT:
            return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) bits));
        case MAL_BUFFER_NUMBER_BIG_INT:
            return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) (i64) bits));
    }
    return mal_value_new_undefined();
}

/* lib/buffer.js checkInt's range phrase; its byteLength is width - 1, so only widths
 * above four use the power form. */
static void mal_buffer_int_range(bool is_signed, u32 width, bool bigint, char *out, usize capacity) {
    u32 bits = width * 8;
    if (bigint) {
        if (is_signed) snprintf(out, capacity, ">= -(2n ** %un) and < 2n ** %un", bits - 1, bits - 1);
        else snprintf(out, capacity, ">= 0n and < 2n ** %un", bits);
    } else if (width > 4) {
        if (is_signed) snprintf(out, capacity, ">= -(2 ** %u) and < 2 ** %u", bits - 1, bits - 1);
        else snprintf(out, capacity, ">= 0 and < 2 ** %u", bits);
    } else if (is_signed) {
        snprintf(out, capacity, ">= %lld and <= %lld",
            -(1LL << (bits - 1)), (1LL << (bits - 1)) - 1);
    } else {
        snprintf(out, capacity, ">= 0 and <= %llu", (1ULL << bits) - 1);
    }
}

static MalValue mal_buffer_write_number(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    i32 access = mal_buffer_access_descriptor(callee);
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue offset_value = argc > 1 ? args[1] : mal_value_new_undefined();
    u32 width = MAL_BUFFER_ACCESS_WIDTH(access);
    if (width == 0) {
        if (!mal_buffer_access_byte_length(
                vm, argc > 2 ? args[2] : mal_value_new_undefined(), &width)) {
            return mal_value_new_undefined();
        }
    } else if (mal_value_is_undefined(offset_value)) {
        offset_value = mal_value_from_i32(0);
    }
    MalBufferNumberKind kind = MAL_BUFFER_ACCESS_KIND(access);
    u32 offset;
    u64 bits;
    char range[96];
    if (kind == MAL_BUFFER_NUMBER_BIG_UINT || kind == MAL_BUFFER_NUMBER_BIG_INT) {
        bool is_signed = kind == MAL_BUFFER_NUMBER_BIG_INT;
        bool out_of_range = false;
        if (mal_value_is_bigint(value)) {
            i128 number = mal_bigint_value(mal_value_to_bigint(value));
            out_of_range = is_signed
                ? number < -((i128) 1 << 63) || number >= ((i128) 1 << 63)
                : number < 0 || number >= ((i128) 1 << 64);
        } else if (mal_ops_is_number(value)) {
            f64 number = mal_ops_number_as_f64(value);
            out_of_range = is_signed
                ? number < -9223372036854775808.0 || number >= 9223372036854775808.0
                : number < 0 || number >= 18446744073709551616.0;
        }
        if (out_of_range) {
            mal_buffer_int_range(is_signed, 8, true, range, sizeof range);
            mal_node_throw_out_of_range(vm, "value", range, value);
            return mal_value_new_undefined();
        }
        if (!mal_buffer_access_offset(
                vm, offset_value, mal_typed_array_object_length(array), 8, &offset)) {
            return mal_value_new_undefined();
        }
        if (!mal_value_is_bigint(value)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Cannot mix BigInt and other types, use explicit conversions");
            return mal_value_new_undefined();
        }
        bits = (u64) mal_bigint_value(mal_value_to_bigint(value));
    } else {
        f64 number;
        if (!mal_buffer_to_number(vm, value, &number)) return mal_value_new_undefined();
        MalValue coerced = mal_value_from_f64(number);
        u32 length = mal_typed_array_object_length(array);
        if (kind == MAL_BUFFER_NUMBER_FLOAT) {
            if (!mal_buffer_access_offset(vm, offset_value, length, width, &offset)) {
                return mal_value_new_undefined();
            }
            bits = width == 4 ? mal_scalar_f32_to_bits((f32) number) : mal_scalar_f64_to_bits(number);
        } else {
            bool is_signed = kind == MAL_BUFFER_NUMBER_INT;
            // writeU_Int8 validates the offset's type before the value; wider writes after.
            if (width == 1 && !mal_node_validate_number(vm, offset_value, "offset")) {
                return mal_value_new_undefined();
            }
            u32 value_bits = width * 8;
            f64 max = is_signed ? ldexp(1, (i32) value_bits - 1) - 1 : ldexp(1, (i32) value_bits) - 1;
            f64 min = is_signed ? -ldexp(1, (i32) value_bits - 1) : 0;
            if (number > max || number < min) {
                mal_buffer_int_range(is_signed, width, false, range, sizeof range);
                mal_node_throw_out_of_range(vm, "value", range, coerced);
                return mal_value_new_undefined();
            }
            if (!mal_buffer_access_offset(vm, offset_value, length, width, &offset)) {
                return mal_value_new_undefined();
            }
            bits = mal_ops_number_to_uint32(number);
            if (width > 4) {
                bits |= (u64) mal_ops_number_to_uint32(floor(number * 0x1p-32)) << 32;
            }
        }
    }
    byte data[8];
    bool little = MAL_BUFFER_ACCESS_LITTLE(access);
    for (u32 i = 0; i < width; i++) {
        data[little ? i : width - 1 - i] = (byte) (bits >> (i * 8));
    }
    mal_buffer_view_write(array, offset, data, width);
    return mal_value_from_u32(offset + width);
}

static bool mal_buffer_named_encoding(
    MalVm *vm, MalValue value, MalBufferEncoding *out, bool *known) {
    *known = true;
    if (mal_value_is_undefined(value)) {
        *out = MAL_BUFFER_UTF8;
        return true;
    }
    if (mal_value_is_string(value) && mal_buffer_encoding_named(mal_value_to_string(value), out)) {
        return true;
    }
    *known = false;
    return true;
}

static void mal_buffer_throw_unknown_encoding(MalVm *vm, MalValue encoding) {
    MalString *text;
    if (!mal_vm_to_string(vm, encoding, &text)) return;
    usize length = 0;
    byte *utf8 = mal_string_to_utf8(text, &length);
    char message[320];
    snprintf(message, sizeof message, "Unknown encoding: %.*s",
        (int) (length > 256 ? 256 : length), utf8 == nullptr ? "" : (const char *) utf8);
    free(utf8);
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_UNKNOWN_ENCODING");
}

static void mal_buffer_throw_invalid_fill(MalVm *vm, MalValue value) {
    char received[320];
    if (mal_value_is_string(value)) {
        MalString *string = mal_value_to_string(value);
        usize length = 0;
        byte *utf8 = mal_string_to_utf8(string, &length);
        snprintf(received, sizeof received, "'%.*s'",
            (int) (length > 256 ? 256 : length), utf8 == nullptr ? "" : (const char *) utf8);
        free(utf8);
    } else {
        snprintf(received, sizeof received, "<Buffer >");
    }
    char message[400];
    snprintf(message, sizeof message, "The argument 'value' is invalid. Received %s", received);
    mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, message, "ERR_INVALID_ARG_VALUE");
}

static void mal_buffer_fill_bytes(
    MalTypedArrayObject *array, u32 start, u32 end, const byte *pattern, usize pattern_length) {
    byte *data = mal_buffer_view_data(array);
    if (!mal_buffer_view_shared(array)) {
        if (pattern_length == 1) {
            memset(data + start, pattern[0], end - start);
            return;
        }
        usize filled = pattern_length < end - start ? pattern_length : end - start;
        memcpy(data + start, pattern, filled);
        while (start + filled < end) {
            usize copy = filled < end - start - filled ? filled : end - start - filled;
            memcpy(data + start + filled, data + start, copy);
            filled += copy;
        }
        return;
    }
    for (u32 index = start; index < end;) {
        usize copy = pattern_length < end - index ? pattern_length : end - index;
        mal_buffer_view_write(array, index, pattern, copy);
        index += (u32) copy;
    }
}

static MalValue mal_buffer_fill(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt; (void) callee;
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    MalValue value = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue offset_value = argc > 1 ? args[1] : mal_value_new_undefined();
    MalValue end_value = argc > 2 ? args[2] : mal_value_new_undefined();
    MalValue encoding_value = argc > 3 ? args[3] : mal_value_new_undefined();
    u32 length = mal_typed_array_object_length(array);
    MalBufferEncoding encoding = MAL_BUFFER_UTF8;
    bool numeric = !mal_value_is_string(value) && !mal_value_is_typed_array_object(value);
    byte single = 0;
    if (mal_value_is_string(value)) {
        if (mal_value_is_undefined(offset_value) || mal_value_is_string(offset_value)) {
            encoding_value = offset_value;
            offset_value = mal_value_from_i32(0);
            end_value = mal_value_from_u32(length);
        } else if (mal_value_is_string(end_value)) {
            encoding_value = end_value;
            end_value = mal_value_from_u32(length);
        }
        bool known;
        mal_buffer_named_encoding(vm, encoding_value, &encoding, &known);
        if (!known) {
            if (!mal_value_is_string(encoding_value)) {
                mal_node_throw_invalid_arg_type(vm, "encoding", "of type string", encoding_value);
            } else {
                mal_buffer_throw_unknown_encoding(vm, encoding_value);
            }
            return mal_value_new_undefined();
        }
        MalString *string = mal_value_to_string(value);
        usize string_length = mal_string_length(string);
        if (string_length == 0) {
            numeric = true;
        } else if (string_length == 1) {
            c16 unit = mal_string_code_unit_at(string, 0);
            if ((encoding == MAL_BUFFER_UTF8 && unit < 128) || encoding == MAL_BUFFER_LATIN1) {
                numeric = true;
                single = (byte) unit;
            }
        }
    }
    u32 start = 0;
    u32 end = length;
    if (!mal_value_is_undefined(offset_value)) {
        f64 number;
        if (!mal_node_validate_integer(vm, offset_value, "offset", 0, 9007199254740991.0, &number)) {
            return mal_value_new_undefined();
        }
        if (!mal_value_is_undefined(end_value)) {
            f64 end_number;
            if (!mal_node_validate_integer(vm, end_value, "end", 0, length, &end_number)) {
                return mal_value_new_undefined();
            }
            end = (u32) end_number;
        }
        if (number >= end) return self;
        start = (u32) number;
    }
    if (numeric) {
        if (!mal_value_is_string(value) && !mal_value_is_typed_array_object(value)) {
            f64 number;
            if (!mal_buffer_to_number(vm, value, &number)) return mal_value_new_undefined();
            single = (byte) mal_ops_number_to_uint32(number);
        }
        mal_buffer_fill_bytes(array, start, end, &single, 1);
        return self;
    }
    byte *owned = nullptr;
    const byte *pattern;
    usize pattern_length;
    if (mal_value_is_string(value)) {
        owned = mal_buffer_encode_string(mal_value_to_string(value), encoding, &pattern_length);
        if (owned == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        pattern = owned;
    } else {
        MalTypedArrayObject *source = mal_value_to_typed_array_object(value);
        pattern_length = mal_typed_array_object_is_out_of_bounds(source)
            ? 0 : mal_typed_array_object_byte_length(source);
        pattern = mal_buffer_view_private(source, 0, pattern_length, &owned);
        if (pattern_length > 0 && pattern == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
    }
    if (pattern_length == 0) {
        free(owned);
        mal_buffer_throw_invalid_fill(vm, value);
        return mal_value_new_undefined();
    }
    mal_buffer_fill_bytes(array, start, end, pattern, pattern_length);
    free(owned);
    return self;
}

/* src/node_buffer.cc IndexOfOffset: the search start, or -1 when nothing can match. */
static i64 mal_buffer_index_of_offset(i64 length, i64 offset, i64 needle_length, bool forward) {
    if (offset < 0) {
        if (offset + length >= 0) return length + offset;
        return forward || needle_length == 0 ? 0 : -1;
    }
    if (offset + needle_length <= length) return offset;
    if (needle_length == 0) return length;
    return forward ? -1 : length - 1;
}

static i64 mal_buffer_search(
    const byte *haystack, usize haystack_length, const byte *needle, usize needle_length,
    usize start, bool forward, usize unit) {
    if (needle_length > haystack_length) return -1;
    usize last = haystack_length - needle_length;
    if (unit == 2) {
        last &= ~(usize) 1;
        start &= ~(usize) 1;
    }
    if (forward) {
        for (usize index = start; index <= last; index += unit) {
            if (unit == 1) {
                const byte *found = memchr(haystack + index, needle[0], last - index + 1);
                if (found == nullptr) return -1;
                index = (usize) (found - haystack);
            }
            if (memcmp(haystack + index, needle, needle_length) == 0) return (i64) index;
        }
        return -1;
    }
    for (usize index = start < last ? start : last;; index -= unit) {
        if (haystack[index] == needle[0] && memcmp(haystack + index, needle, needle_length) == 0) {
            return (i64) index;
        }
        if (index < unit) return -1;
    }
}

static bool mal_buffer_index_of_impl(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, bool forward, i64 *result) {
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return false;
    MalValue needle = argc > 0 ? args[0] : mal_value_new_undefined();
    MalValue offset_value = argc > 1 ? args[1] : mal_value_new_undefined();
    MalValue encoding_value = argc > 2 ? args[2] : mal_value_new_undefined();
    if (mal_value_is_string(offset_value)) {
        encoding_value = offset_value;
        offset_value = mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    f64 offset_number = NAN;
    if (!mal_value_is_undefined(offset_value) && !mal_buffer_to_number(vm, offset_value, &offset_number)) {
        return false;
    }
    if (offset_number > 2147483647.0) offset_number = 2147483647.0;
    if (offset_number < -2147483648.0) offset_number = -2147483648.0;
    if (isnan(offset_number)) offset_number = forward ? 0 : length;
    i64 offset = (i64) trunc(offset_number);

    byte *owned = nullptr;
    const byte *needle_bytes;
    usize needle_length;
    usize unit = 1;
    byte number_needle;
    if (mal_ops_is_number(needle)) {
        number_needle = (byte) mal_ops_number_to_uint32(mal_ops_number_as_f64(needle));
        needle_bytes = &number_needle;
        needle_length = 1;
    } else {
        MalBufferEncoding encoding;
        bool known;
        mal_buffer_named_encoding(vm, encoding_value, &encoding, &known);
        if (mal_value_is_string(needle)) {
            if (!known) {
                mal_buffer_throw_unknown_encoding(vm, encoding_value);
                return false;
            }
            owned = mal_buffer_encode_string(mal_value_to_string(needle), encoding, &needle_length);
            if (owned == nullptr) {
                mal_vm_throw_allocation_error(vm);
                return false;
            }
            needle_bytes = owned;
        } else if (mal_value_is_typed_array_object(needle)
            && mal_value_to_typed_array_object(needle)->kind == MAL_TA_UINT8) {
            if (!known) encoding = MAL_BUFFER_UTF8;
            MalTypedArrayObject *view = mal_value_to_typed_array_object(needle);
            needle_length = mal_typed_array_object_length(view);
            needle_bytes = mal_buffer_view_private(view, 0, needle_length, &owned);
        } else {
            mal_node_throw_invalid_arg_type(vm, "value",
                "one of type number or string or an instance of Buffer or Uint8Array", needle);
            return false;
        }
        if (encoding == MAL_BUFFER_UTF16LE) unit = 2;
    }
    i64 start = mal_buffer_index_of_offset(length, offset, (i64) needle_length, forward);
    if (needle_length == 0) {
        free(owned);
        *result = start;
        return true;
    }
    // Node 26.12 starts a forward UTF-16 string search at the next code unit, not the previous.
    if (unit == 2 && forward && mal_value_is_string(needle) && (start & 1) != 0) start++;
    *result = -1;
    if (length == 0 || start < 0 || (forward && (i64) needle_length + start > length)
        || needle_length > length || (unit == 2 && (length < 2 || needle_length < 2))) {
        free(owned);
        return true;
    }
    byte *haystack_owned;
    const byte *haystack = mal_buffer_view_private(array, 0, length, &haystack_owned);
    if (haystack == nullptr) {
        free(owned);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    usize haystack_length = unit == 2 ? length & ~(u32) 1 : length;
    *result = mal_buffer_search(haystack, haystack_length, needle_bytes,
        unit == 2 ? needle_length & ~(usize) 1 : needle_length, (usize) start, forward, unit);
    free(haystack_owned);
    free(owned);
    return true;
}

static MalValue mal_buffer_index_of(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt; (void) callee;
    i64 result;
    if (!mal_buffer_index_of_impl(vm, self, args, argc, true, &result)) return mal_value_new_undefined();
    return mal_value_from_f64((f64) result);
}

static MalValue mal_buffer_last_index_of(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt; (void) callee;
    i64 result;
    if (!mal_buffer_index_of_impl(vm, self, args, argc, false, &result)) return mal_value_new_undefined();
    return mal_value_from_f64((f64) result);
}

static MalValue mal_buffer_includes(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt; (void) callee;
    i64 result;
    if (!mal_buffer_index_of_impl(vm, self, args, argc, true, &result)) return mal_value_new_undefined();
    return mal_value_new_boolean(result != -1);
}

static MalValue mal_buffer_swap(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) args; (void) argc; (void) nt;
    u32 width = (u32) mal_value_to_i32(mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 1));
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    u32 length = mal_typed_array_object_length(array);
    if (length % width != 0) {
        char message[64];
        snprintf(message, sizeof message, "Buffer size must be a multiple of %u-bits", width * 8);
        mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, message, "ERR_INVALID_BUFFER_SIZE");
        return mal_value_new_undefined();
    }
    byte chunk[8];
    for (u32 index = 0; index < length; index += width) {
        mal_buffer_view_read(array, index, chunk, width);
        for (u32 i = 0; i < width / 2; i++) {
            byte swapped = chunk[i];
            chunk[i] = chunk[width - 1 - i];
            chunk[width - 1 - i] = swapped;
        }
        mal_buffer_view_write(array, index, chunk, width);
    }
    return self;
}

static MalValue mal_buffer_to_json(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    u32 length = mal_typed_array_object_length(array);
    MalValue roots[] = {self, mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalArrayObject *data = mal_array_object_new_reserved(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE]), length);
    roots[1] = mal_value_from_array_object(data);
    for (u32 index = 0; index < length; index++) {
        byte value;
        mal_buffer_view_read(mal_value_to_typed_array_object(roots[0]), index, &value, 1);
        mal_array_object_store(data, mal_key_index(index), mal_value_from_i32((u8) value));
    }
    roots[2] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *result = mal_value_to_object(roots[2]);
    mal_intrinsic_define_data(vm, result, "type",
        mal_value_from_string(mal_intrinsic_ascii(vm, "Buffer")), MAL_BUFFER_VISIBLE);
    mal_intrinsic_define_data(vm, result, "data", roots[1], MAL_BUFFER_VISIBLE);
    mal_gc_unroot(&root);
    return roots[2];
}

static MalBufferEncoding mal_buffer_slot_encoding(MalValue callee) {
    return (MalBufferEncoding) mal_value_to_i32(mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 1));
}

static MalValue mal_buffer_encoding_slice(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    u32 length = mal_typed_array_object_length(array);
    u32 start, end;
    if (!mal_buffer_clamped(vm, argc > 0 ? args[0] : mal_value_new_undefined(), length, 0, &start)
        || !mal_buffer_clamped(vm, argc > 1 ? args[1] : mal_value_new_undefined(), length, length, &end)) {
        return mal_value_new_undefined();
    }
    if (end < start) end = start;
    byte *owned;
    const byte *data = mal_buffer_view_private(array, start, end - start, &owned);
    if (end > start && data == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue result = mal_buffer_string_from_bytes(vm, data, end - start, mal_buffer_slot_encoding(callee));
    free(owned);
    return result;
}

static bool mal_buffer_write_index(MalVm *vm, MalValue value, u64 fallback, u64 *out) {
    if (mal_value_is_undefined(value)) {
        *out = fallback;
        return true;
    }
    f64 number;
    if (!mal_buffer_to_integer(vm, value, &number)) return false;
    if (number < 0) {
        mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Index out of range", "ERR_OUT_OF_RANGE");
        return false;
    }
    *out = number > (f64) UINT32_MAX ? UINT32_MAX : (u64) number;
    return true;
}

static MalValue mal_buffer_encoding_write(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) nt;
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    if (argc < 1 || !mal_value_is_string(args[0])) {
        mal_node_throw_code(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "argument must be a string",
            "ERR_INVALID_ARG_TYPE");
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    u64 offset, max_length;
    if (!mal_buffer_write_index(vm, argc > 1 ? args[1] : mal_value_new_undefined(), 0, &offset)) {
        return mal_value_new_undefined();
    }
    if (offset > length) {
        mal_node_throw_code(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "\"offset\" is outside of buffer bounds", "ERR_BUFFER_OUT_OF_BOUNDS");
        return mal_value_new_undefined();
    }
    if (!mal_buffer_write_index(vm, argc > 2 ? args[2] : mal_value_new_undefined(),
            length - offset, &max_length)) {
        return mal_value_new_undefined();
    }
    if (max_length > length - offset) max_length = length - offset;
    if (max_length == 0) return mal_value_from_i32(0);
    MalBufferEncoding encoding = mal_buffer_slot_encoding(callee);
    byte *data = mal_buffer_view_data(array) + offset;
    if (!mal_buffer_view_shared(array)) {
        return mal_value_from_u32((u32) mal_buffer_write_string(
            mal_value_to_string(args[0]), encoding, data, (usize) max_length));
    }
    byte *staged = malloc((usize) max_length);
    if (staged == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    usize written = mal_buffer_write_string(mal_value_to_string(args[0]), encoding, staged, (usize) max_length);
    mal_buffer_view_write(array, (u32) offset, staged, written);
    free(staged);
    return mal_value_from_u32((u32) written);
}

static bool mal_buffer_is_node_buffer(MalVm *vm, MalValue value) {
    if (!mal_value_is_object(value)) return false;
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_PROTOTYPE]);
    for (MalObject *object = mal_object_prototype(mal_value_to_object(value)); object != nullptr;
         object = mal_object_prototype(object)) {
        if (object == prototype) return true;
    }
    return false;
}

static MalValue mal_buffer_parent(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) args; (void) argc; (void) nt; (void) callee;
    if (!mal_value_is_typed_array_object(self) || !mal_buffer_is_node_buffer(vm, self)) {
        return mal_value_new_undefined();
    }
    return mal_value_from_array_buffer_object(mal_value_to_typed_array_object(self)->buffer);
}

static MalValue mal_buffer_offset_getter(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) args; (void) argc; (void) nt; (void) callee;
    if (!mal_value_is_typed_array_object(self) || !mal_buffer_is_node_buffer(vm, self)) {
        return mal_value_new_undefined();
    }
    MalTypedArrayObject *array = mal_value_to_typed_array_object(self);
    return mal_value_from_u32(mal_typed_array_object_is_out_of_bounds(array) ? 0 : array->byte_offset);
}

static MalValue mal_buffer_inspect(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) args; (void) argc; (void) nt; (void) callee;
    MalTypedArrayObject *array = mal_buffer_receiver(vm, self);
    if (array == nullptr) return mal_value_new_undefined();
    u32 length = mal_typed_array_object_length(array);
    u32 shown = length < MAL_BUFFER_INSPECT_MAX_BYTES ? length : MAL_BUFFER_INSPECT_MAX_BYTES;
    char text[MAL_BUFFER_INSPECT_MAX_BYTES * 3 + 64];
    usize written = (usize) snprintf(text, sizeof text, "<Buffer");
    static const char digits[] = "0123456789abcdef";
    for (u32 index = 0; index < shown; index++) {
        byte value;
        mal_buffer_view_read(array, index, &value, 1);
        text[written++] = ' ';
        text[written++] = digits[(u8) value >> 4];
        text[written++] = digits[(u8) value & 15];
    }
    if (length > shown) {
        u32 remaining = length - shown;
        written += (usize) snprintf(text + written, sizeof text - written,
            " ... %u more byte%s", remaining, remaining > 1 ? "s" : "");
    }
    if (shown == 0) text[written++] = ' ';
    text[written++] = '>';
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, (const byte *) text, written));
}

static MalValue mal_buffer_of(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee
) {
    (void) self; (void) nt;
    MalValue result = mal_buffer_new_uninitialized(
        vm, mal_buffer_prototype_from_callee(callee), (u32) argc);
    if (mal_value_is_undefined(result)) return result;
    MalRootSpan root;
    mal_gc_root(&root, &result, 1);
    for (i32 index = 0; index < argc; index++) {
        mal_typed_array_object_set(vm, mal_value_to_typed_array_object(result), (u32) index, args[index]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&root);
            return mal_value_new_undefined();
        }
    }
    mal_gc_unroot(&root);
    return result;
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

static void mal_buffer_define_regular_method(
    MalVm *vm, MalObject *object, const byte *name, i32 length,
    MalNativeFunctionCallback callback, MalValue buffer_prototype
) {
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalNativeFunctionObject *function = mal_buffer_method(vm, name, length, callback, buffer_prototype);
    roots[0] = mal_value_from_native_function_object(function);
    mal_native_function_object_set_constructor(function);
    mal_native_function_object_set_handles_new_target_prototype(function);
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_data(vm, (MalObject *) function, "prototype", roots[1], MAL_PROPERTY_WRITABLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), "constructor", roots[0],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, object, name, roots[0],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
}

static void mal_buffer_define_slot_method(
    MalVm *vm, MalObject *object, const byte *name, i32 length,
    MalNativeFunctionCallback callback, MalValue prototype, i32 descriptor
) {
    MalValue slots[] = {prototype, mal_value_from_i32(descriptor)};
    MalValue value = mal_value_from_native_function_object(
        mal_native_function_object_new_with_slots_arity(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, name), length, callback, slots, countof(slots)));
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    mal_intrinsic_define_data(vm, object, name, value, MAL_BUFFER_VISIBLE);
    mal_gc_unroot(&root);
}

/* Node installs these aliases as the same function objects, not copies. */
static void mal_buffer_alias(MalVm *vm, MalObject *object, const char *name, const char *alias) {
    MalPropertyLookup found = mal_object_get_own(object, mal_intrinsic_string_key(vm, (const byte *) name));
    if (!found.present) return;
    mal_intrinsic_define_data(vm, object, (const byte *) alias, found.desc.value, MAL_BUFFER_VISIBLE);
}

static void mal_buffer_install_exports(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    MalValue constructor, MalValue module_default
) {
    MalObject *global_this = mal_value_to_object(
        vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_intrinsic_define_data(vm, global_this, "Buffer", constructor,
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_node_module_publish(vm, "node:buffer", slots, count, module_default);
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
    MalValue roots[7] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));

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
    mal_buffer_define_regular_method(vm, (MalObject *) constructor, "isEncoding", 1,
                                    mal_buffer_is_encoding, roots[0]);
    mal_buffer_define_regular_method(vm, (MalObject *) constructor, "copyBytesFrom", 3,
                                    mal_buffer_copy_bytes_from, roots[0]);
    mal_buffer_define_method(vm, (MalObject *) constructor, "byteLength", 1,
                             mal_buffer_byte_length, roots[0]);
    mal_buffer_define_method(vm, (MalObject *) constructor, "concat", 1, mal_buffer_concat,
                             roots[0]);
    mal_buffer_define_method(vm, (MalObject *) constructor, "compare", 2, mal_buffer_compare,
                             roots[0]);

    mal_buffer_define_method(vm, prototype, "toString", 0, mal_buffer_to_string, roots[0]);
    mal_buffer_alias(vm, prototype, "toString", "toLocaleString");
    mal_buffer_define_method(vm, prototype, "equals", 1, mal_buffer_equals, roots[0]);
    mal_buffer_define_method(vm, prototype, "compare", 1, mal_buffer_prototype_compare,
                             roots[0]);
    mal_buffer_define_method(vm, prototype, "slice", 2, mal_buffer_slice, roots[0]);
    mal_buffer_define_method(vm, prototype, "subarray", 2, mal_buffer_subarray, roots[0]);
    mal_buffer_define_method(vm, prototype, "write", 1, mal_buffer_write, roots[0]);
    mal_buffer_define_method(vm, prototype, "copy", 1, mal_buffer_copy, roots[0]);
    mal_buffer_define_method(vm, prototype, "fill", 4, mal_buffer_fill, roots[0]);
    mal_buffer_define_method(vm, prototype, "indexOf", 3, mal_buffer_index_of, roots[0]);
    mal_buffer_define_method(vm, prototype, "lastIndexOf", 3, mal_buffer_last_index_of, roots[0]);
    mal_buffer_define_method(vm, prototype, "includes", 3, mal_buffer_includes, roots[0]);
    mal_buffer_define_method(vm, prototype, "toJSON", 0, mal_buffer_to_json, roots[0]);
    mal_buffer_define_method(vm, prototype, "inspect", 2, mal_buffer_inspect, roots[0]);
    {
        MalPropertyLookup inspect = mal_object_get_own(
            prototype, mal_intrinsic_string_key(vm, (const byte *) "inspect"));
        MalValue symbol = mal_node_inspect_custom_symbol(vm);
        MalPropertyDesc desc = mal_intrinsic_data_desc(inspect.desc.value, MAL_BUFFER_VISIBLE);
        mal_object_define_own(prototype, mal_key_from_value(symbol), &desc);
    }
    mal_buffer_define_slot_method(vm, prototype, "swap16", 0, mal_buffer_swap, roots[0], 2);
    mal_buffer_define_slot_method(vm, prototype, "swap32", 0, mal_buffer_swap, roots[0], 4);
    mal_buffer_define_slot_method(vm, prototype, "swap64", 0, mal_buffer_swap, roots[0], 8);
    static const struct {
        const char *name;
        MalBufferEncoding encoding;
    } encodings[] = {
        {"utf8", MAL_BUFFER_UTF8}, {"latin1", MAL_BUFFER_LATIN1}, {"ascii", MAL_BUFFER_ASCII},
        {"hex", MAL_BUFFER_HEX}, {"base64", MAL_BUFFER_BASE64},
        {"base64url", MAL_BUFFER_BASE64URL}, {"ucs2", MAL_BUFFER_UTF16LE},
    };
    for (usize i = 0; i < countof(encodings); i++) {
        char name[24];
        snprintf(name, sizeof name, "%sSlice", encodings[i].name);
        mal_buffer_define_slot_method(vm, prototype, (const byte *) name, 2,
            mal_buffer_encoding_slice, roots[0], (i32) encodings[i].encoding);
        snprintf(name, sizeof name, "%sWrite", encodings[i].name);
        mal_buffer_define_slot_method(vm, prototype, (const byte *) name, 3,
            mal_buffer_encoding_write, roots[0], (i32) encodings[i].encoding);
    }
    static const struct {
        const char *name;
        const char *alias;
        i32 access;
    } accessors[] = {
        {"UInt8", "Uint8", MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_UINT, 1, true)},
        {"Int8", nullptr, MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_INT, 1, true)},
        {"UInt16LE", "Uint16LE", MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_UINT, 2, true)},
        {"UInt16BE", "Uint16BE", MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_UINT, 2, false)},
        {"Int16LE", nullptr, MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_INT, 2, true)},
        {"Int16BE", nullptr, MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_INT, 2, false)},
        {"UInt32LE", "Uint32LE", MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_UINT, 4, true)},
        {"UInt32BE", "Uint32BE", MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_UINT, 4, false)},
        {"Int32LE", nullptr, MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_INT, 4, true)},
        {"Int32BE", nullptr, MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_INT, 4, false)},
        {"FloatLE", nullptr, MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_FLOAT, 4, true)},
        {"FloatBE", nullptr, MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_FLOAT, 4, false)},
        {"DoubleLE", nullptr, MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_FLOAT, 8, true)},
        {"DoubleBE", nullptr, MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_FLOAT, 8, false)},
        {"BigUInt64LE", "BigUint64LE", MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_BIG_UINT, 8, true)},
        {"BigUInt64BE", "BigUint64BE", MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_BIG_UINT, 8, false)},
        {"BigInt64LE", nullptr, MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_BIG_INT, 8, true)},
        {"BigInt64BE", nullptr, MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_BIG_INT, 8, false)},
        {"UIntLE", "UintLE", MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_UINT, 0, true)},
        {"UIntBE", "UintBE", MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_UINT, 0, false)},
        {"IntLE", nullptr, MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_INT, 0, true)},
        {"IntBE", nullptr, MAL_BUFFER_ACCESS(MAL_BUFFER_NUMBER_INT, 0, false)},
    };
    for (usize i = 0; i < countof(accessors); i++) {
        bool variable = MAL_BUFFER_ACCESS_WIDTH(accessors[i].access) == 0;
        for (usize write = 0; write < 2; write++) {
            char name[32];
            snprintf(name, sizeof name, "%s%s", write ? "write" : "read", accessors[i].name);
            mal_buffer_define_slot_method(vm, prototype, (const byte *) name,
                (i32) write + (variable ? 2 : 0),
                write ? mal_buffer_write_number : mal_buffer_read_number,
                roots[0], accessors[i].access);
            if (accessors[i].alias != nullptr) {
                char alias[32];
                snprintf(alias, sizeof alias, "%s%s", write ? "write" : "read", accessors[i].alias);
                mal_buffer_alias(vm, prototype, name, alias);
            }
        }
    }
    mal_intrinsic_define_accessor_n(vm, prototype, mal_intrinsic_string_key(vm, "parent"),
        (const byte *) "get", 0, mal_buffer_parent, nullptr, 0, nullptr, MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_accessor_n(vm, prototype, mal_intrinsic_string_key(vm, "offset"),
        (const byte *) "get", 0, mal_buffer_offset_getter, nullptr, 0, nullptr,
        MAL_PROPERTY_ENUMERABLE);
    mal_buffer_define_method(vm, (MalObject *) constructor, "of", 0, mal_buffer_of, roots[0]);
    mal_buffer_define_method(vm, (MalObject *) constructor, "allocUnsafeSlow", 1,
                             mal_buffer_alloc_unsafe, roots[0]);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, "poolSize", mal_value_from_i32(65536),
        MAL_BUFFER_VISIBLE);

    MalObject *module_default = mal_intrinsic_new_object(vm);
    roots[2] = mal_value_from_object(module_default);
    mal_intrinsic_define_data(vm, module_default, "Buffer", roots[1],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                                  MAL_PROPERTY_CONFIGURABLE);
    roots[3] = mal_value_from_object(mal_intrinsic_new_object(vm));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[3]),
        "MAX_LENGTH", mal_value_from_i32(MAL_BUFFER_MAX_LENGTH), MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[3]),
        "MAX_STRING_LENGTH", mal_value_from_f64((f64) MAL_STRING_MAX_CODE_UNITS),
        MAL_PROPERTY_ENUMERABLE);
    mal_intrinsic_define_data(vm, module_default, "constants", roots[3],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
            MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, module_default, "kMaxLength",
        mal_value_from_i32(MAL_BUFFER_MAX_LENGTH), MAL_BUFFER_VISIBLE);
    mal_intrinsic_define_data(vm, module_default, "kStringMaxLength",
        mal_value_from_f64((f64) MAL_STRING_MAX_CODE_UNITS), MAL_BUFFER_VISIBLE);
    mal_intrinsic_define_data(vm, module_default, "INSPECT_MAX_BYTES",
        mal_value_from_i32((i32) MAL_BUFFER_INSPECT_MAX_BYTES), MAL_BUFFER_VISIBLE);
    static const char *const globals[] = {"atob", "btoa", "Blob", "File"};
    MalObject *global_object = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    for (usize i = 0; i < countof(globals); i++) {
        MalPropertyLookup found = mal_object_get_own(
            global_object, mal_intrinsic_string_key(vm, (const byte *) globals[i]));
        if (found.present && (found.desc.flags & MAL_PROPERTY_ACCESSOR) == 0) {
            mal_intrinsic_define_data(vm, module_default, (const byte *) globals[i],
                found.desc.value, MAL_BUFFER_VISIBLE);
        }
    }
    roots[4] = mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "isAscii"), 1, mal_buffer_is_ascii));
    roots[5] = mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "isUtf8"), 1, mal_buffer_is_utf8));
    for (usize index = 4; index <= 5; index++) {
        MalNativeFunctionObject *function = mal_value_to_native_function_object(roots[index]);
        mal_native_function_object_set_constructor(function);
        mal_native_function_object_set_handles_new_target_prototype(function);
        roots[6] = mal_value_from_object(mal_intrinsic_new_object(vm));
        mal_intrinsic_define_data(vm, (MalObject *) function, "prototype", roots[6],
            MAL_PROPERTY_WRITABLE);
        mal_intrinsic_define_data(vm, mal_value_to_object(roots[6]), "constructor", roots[index],
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    }
    mal_intrinsic_define_data(vm, module_default, "isAscii", roots[4],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, module_default, "isUtf8", roots[5],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    roots[6] = mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "transcode"), 3, mal_buffer_transcode));
    mal_intrinsic_define_data(vm, module_default, "transcode", roots[6],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    roots[6] = mal_value_from_native_function_object(mal_native_function_object_new_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "resolveObjectURL"), 1, mal_buffer_resolve_object_url));
    mal_intrinsic_define_data(vm, module_default, "resolveObjectURL", roots[6],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);

    vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_CONSTRUCTOR] = roots[1];
    vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_PROTOTYPE] = roots[0];
    vm->intrinsics[MAL_INTRINSIC_NODE_BUFFER_MODULE] = roots[2];
    mal_buffer_install_exports(vm, slots, count, roots[1], roots[2]);
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
