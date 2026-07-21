#include "builtin_uri.h"

#include <stdlib.h>

#include "function_object.h"
#include "heap_string.h"
#include "hex.h"
#include "u16_buffer.h"
#include "utf16.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"

// A growable UTF-16 code-unit buffer used to build encode/decode results.
typedef struct MalUriBuffer {
    MalVm *vm;
    union {
        MalU16Buffer output;
        struct {
            c16 *data;
            usize length;
            usize capacity;
            MalU16BufferStatus status;
        };
    };
} MalUriBuffer;

static bool mal_uri_buffer_push(MalUriBuffer *buffer, c16 unit) {
    if (mal_u16_buffer_push(&buffer->output, unit) != MAL_U16_BUFFER_OK) {
        mal_vm_throw_error(
            buffer->vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return false;
    }
    return true;
}

static const byte mal_uri_hex_digits[] = "0123456789ABCDEF";

// Append the percent-escape of a single UTF-8 octet: "%XX" with uppercase hex.
static bool mal_uri_buffer_push_octet(MalUriBuffer *buffer, u8 octet) {
    return mal_uri_buffer_push(buffer, '%') &&
        mal_uri_buffer_push(buffer, (c16) mal_uri_hex_digits[(octet >> 4) & 0x0F]) &&
        mal_uri_buffer_push(buffer, (c16) mal_uri_hex_digits[octet & 0x0F]);
}

// The unreserved characters (ECMA-262 uriUnescaped) common to every set.
static bool mal_uri_is_unreserved(c16 c) {
    return (c >= 'A' && c <= 'Z') ||
        (c >= 'a' && c <= 'z') ||
        (c >= '0' && c <= '9') ||
        c == '-' || c == '_' || c == '.' || c == '!' || c == '~' ||
        c == '*' || c == '\'' || c == '(' || c == ')';
}

// uriReserved + "#": the characters encodeURI leaves untouched on top of the
// unreserved set.
static bool mal_uri_is_reserved_or_hash(c16 c) {
    return c == ';' || c == '/' || c == '?' || c == ':' || c == '@' ||
        c == '&' || c == '=' || c == '+' || c == '$' || c == ',' ||
        c == '#';
}

// The unescapedSet for encodeURI.
static bool mal_uri_encode_uri_unescaped(c16 c) {
    return mal_uri_is_unreserved(c) || mal_uri_is_reserved_or_hash(c);
}

// The unescapedSet for encodeURIComponent (unreserved only).
static bool mal_uri_encode_component_unescaped(c16 c) {
    return mal_uri_is_unreserved(c);
}

// The reservedSet for decodeURI: uriReserved + "#". Escapes of these are kept
// verbatim. decodeURIComponent uses an empty reserved set.
static bool mal_uri_decode_uri_reserved(c16 c) {
    return mal_uri_is_reserved_or_hash(c);
}

static MalValue mal_uri_buffer_to_string(MalVm *vm, MalUriBuffer *buffer) {
    return mal_value_from_string(mal_u16_buffer_finish(&vm->heap, &buffer->output));
}

// Convert two hex code units (already known to be present) into a byte. Returns
// false when either unit is not a hexadecimal digit.
static bool mal_uri_hex_pair(c16 high, c16 low, u8 *out) {
    i32 high_value = mal_hex_decode_digit(high);
    i32 low_value = mal_hex_decode_digit(low);
    if (high_value < 0 || low_value < 0) return false;
    *out = (u8) ((high_value << 4) | low_value);
    return true;
}

// ECMA-262 Encode(string, unescapedSet) operating on UTF-16 code units.
static MalValue mal_uri_encode(MalVm *vm, MalString *string, bool (*unescaped)(c16)) {
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    MalUriBuffer buffer = { .vm = vm };

    for (usize k = 0; k < length; k++) {
        c16 c = units[k];
        if (unescaped(c)) {
            if (!mal_uri_buffer_push(&buffer, c)) {
                free(buffer.data);
                return mal_value_new_undefined();
            }
            continue;
        }

        u32 code_point;
        usize width;
        if (!mal_utf16_read_scalar(units, length, k, &code_point, &width)) {
            free(buffer.data);
            mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
            return mal_value_new_undefined();
        }
        k += width - 1;

        // UTF-8 encode the code point and percent-escape each octet.
        if (code_point <= 0x7F) {
            if (!mal_uri_buffer_push_octet(&buffer, (u8) code_point)) {
                free(buffer.data);
                return mal_value_new_undefined();
            }
        } else if (code_point <= 0x7FF) {
            if (!mal_uri_buffer_push_octet(&buffer, (u8) (0xC0 | (code_point >> 6))) ||
                !mal_uri_buffer_push_octet(&buffer, (u8) (0x80 | (code_point & 0x3F)))) {
                free(buffer.data);
                return mal_value_new_undefined();
            }
        } else if (code_point <= 0xFFFF) {
            if (!mal_uri_buffer_push_octet(&buffer, (u8) (0xE0 | (code_point >> 12))) ||
                !mal_uri_buffer_push_octet(&buffer, (u8) (0x80 | ((code_point >> 6) & 0x3F))) ||
                !mal_uri_buffer_push_octet(&buffer, (u8) (0x80 | (code_point & 0x3F)))) {
                free(buffer.data);
                return mal_value_new_undefined();
            }
        } else {
            if (!mal_uri_buffer_push_octet(&buffer, (u8) (0xF0 | (code_point >> 18))) ||
                !mal_uri_buffer_push_octet(&buffer, (u8) (0x80 | ((code_point >> 12) & 0x3F))) ||
                !mal_uri_buffer_push_octet(&buffer, (u8) (0x80 | ((code_point >> 6) & 0x3F))) ||
                !mal_uri_buffer_push_octet(&buffer, (u8) (0x80 | (code_point & 0x3F)))) {
                free(buffer.data);
                return mal_value_new_undefined();
            }
        }
    }

    return mal_uri_buffer_to_string(vm, &buffer);
}

// ECMA-262 Decode(string, reservedSet) operating on UTF-16 code units.
static MalValue mal_uri_decode(MalVm *vm, MalString *string, bool (*reserved)(c16)) {
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    MalUriBuffer buffer = { .vm = vm };

    for (usize k = 0; k < length; k++) {
        c16 c = units[k];
        if (c != '%') {
            if (!mal_uri_buffer_push(&buffer, c)) {
                free(buffer.data);
                return mal_value_new_undefined();
            }
            continue;
        }

        usize start = k;
        // Need "%XX": two hex digits must follow.
        u8 octet;
        if (k + 2 >= length) {
            free(buffer.data);
            mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
            return mal_value_new_undefined();
        }
        if (!mal_uri_hex_pair(units[k + 1], units[k + 2], &octet)) {
            free(buffer.data);
            mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
            return mal_value_new_undefined();
        }
        k += 2;

        if (octet < 0x80) {
            c16 decoded = (c16) octet;
            if (reserved(decoded)) {
                // Keep the original escape verbatim (decodeURI reserved set).
                for (usize i = start; i <= k; i++) {
                    if (!mal_uri_buffer_push(&buffer, units[i])) {
                        free(buffer.data);
                        return mal_value_new_undefined();
                    }
                }
            } else {
                if (!mal_uri_buffer_push(&buffer, decoded)) {
                    free(buffer.data);
                    return mal_value_new_undefined();
                }
            }
            continue;
        }

        // Multi-byte UTF-8 sequence: count the leading one bits to find n.
        i32 n;
        if ((octet & 0xE0) == 0xC0) {
            n = 2;
        } else if ((octet & 0xF0) == 0xE0) {
            n = 3;
        } else if ((octet & 0xF8) == 0xF0) {
            n = 4;
        } else {
            free(buffer.data);
            mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
            return mal_value_new_undefined();
        }

        u32 code_point;
        switch (n) {
            case 2:
                code_point = (u32) (octet & 0x1F);
                break;
            case 3:
                code_point = (u32) (octet & 0x0F);
                break;
            default:
                code_point = (u32) (octet & 0x07);
                break;
        }

        // Read the n-1 continuation octets, each as a "%XX" escape.
        for (i32 j = 1; j < n; j++) {
            if (k + 1 >= length || units[k + 1] != '%') {
                free(buffer.data);
                mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
                return mal_value_new_undefined();
            }
            if (k + 3 > length) {
                free(buffer.data);
                mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
                return mal_value_new_undefined();
            }
            u8 continuation;
            if (!mal_uri_hex_pair(units[k + 2], units[k + 3], &continuation)) {
                free(buffer.data);
                mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
                return mal_value_new_undefined();
            }
            if ((continuation & 0xC0) != 0x80) {
                free(buffer.data);
                mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
                return mal_value_new_undefined();
            }
            code_point = (code_point << 6) | (u32) (continuation & 0x3F);
            k += 3;
        }

        // Reject overlong encodings, surrogates and out-of-range code points.
        bool overlong =
            (n == 2 && code_point < 0x80) ||
            (n == 3 && code_point < 0x800) ||
            (n == 4 && code_point < 0x10000);
        if (overlong ||
            (code_point >= 0xD800 && code_point <= 0xDFFF) ||
            code_point > 0x10FFFF) {
            free(buffer.data);
            mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
            return mal_value_new_undefined();
        }

        if (code_point <= 0xFFFF) {
            if (!mal_uri_buffer_push(&buffer, (c16) code_point)) {
                free(buffer.data);
                return mal_value_new_undefined();
            }
        } else {
            c16 pair[2];
            mal_utf16_emit_pair(code_point, pair);
            if (!mal_uri_buffer_push(&buffer, pair[0]) ||
                !mal_uri_buffer_push(&buffer, pair[1])) {
                free(buffer.data);
                return mal_value_new_undefined();
            }
        }
    }

    return mal_uri_buffer_to_string(vm, &buffer);
}

// ToString(arg) guarding against Symbol (which has no string coercion). Returns
// false with a pending TypeError when the argument is a Symbol.
static bool mal_uri_to_string(MalVm *vm, const MalValue *args, i32 arg_count, MalString **out) {
    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_symbol(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol to a string");
        return false;
    }
    *out = mal_ops_to_string(&vm->heap, value);
    return true;
}

static MalValue mal_builtin_decode_uri(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) {
        return mal_value_new_undefined();
    }
    return mal_uri_decode(vm, string, mal_uri_decode_uri_reserved);
}

static bool mal_uri_no_reserved(c16 c) {
    (void) c;
    return false;
}

static MalValue mal_builtin_decode_uri_component(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) {
        return mal_value_new_undefined();
    }
    return mal_uri_decode(vm, string, mal_uri_no_reserved);
}

static MalValue mal_builtin_encode_uri(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) {
        return mal_value_new_undefined();
    }
    return mal_uri_encode(vm, string, mal_uri_encode_uri_unescaped);
}

static MalValue mal_builtin_encode_uri_component(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) {
        return mal_value_new_undefined();
    }
    return mal_uri_encode(vm, string, mal_uri_encode_component_unescaped);
}

static MalValue mal_uri_make_function(MalVm *vm, const byte *name, MalNativeFunctionCallback callback) {
    MalNativeFunctionObject *function = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, name),
        1,
        callback
    );
    return mal_value_from_native_function_object(function);
}

void mal_builtin_uri_install(MalVm *vm) {
    vm->intrinsics[MAL_INTRINSIC_DECODE_URI] = mal_uri_make_function(vm, "decodeURI", mal_builtin_decode_uri);
    vm->intrinsics[MAL_INTRINSIC_DECODE_URI_COMPONENT] = mal_uri_make_function(vm, "decodeURIComponent", mal_builtin_decode_uri_component);
    vm->intrinsics[MAL_INTRINSIC_ENCODE_URI] = mal_uri_make_function(vm, "encodeURI", mal_builtin_encode_uri);
    vm->intrinsics[MAL_INTRINSIC_ENCODE_URI_COMPONENT] = mal_uri_make_function(vm, "encodeURIComponent", mal_builtin_encode_uri_component);
}
