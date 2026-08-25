#include "builtin_uri.h"

#include <stdlib.h>
#include <string.h>

#include "checked_size.h"
#include "function_object.h"
#include "heap_string.h"
#include "hex.h"
#include "utf16.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static const byte mal_uri_hex_digits[] = "0123456789ABCDEF";

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

// Convert two hex code units (already known to be present) into a byte. Returns
// false when either unit is not a hexadecimal digit.
static bool mal_uri_hex_pair(c16 high, c16 low, u8 *out) {
    i32 high_value = mal_hex_decode_digit(high);
    i32 low_value = mal_hex_decode_digit(low);
    if (high_value < 0 || low_value < 0) return false;
    *out = (u8) ((high_value << 4) | low_value);
    return true;
}

static bool mal_uri_result_length_add(MalVm *vm, usize *length, usize extra) {
    usize result;
    if (!mal_checked_size_add(*length, extra, MAL_STRING_MAX_CODE_UNITS, &result)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return false;
    }
    *length = result;
    return true;
}

static c16 *mal_uri_result_alloc(MalVm *vm, usize length) {
    usize bytes;
    if (!mal_checked_size_multiply(sizeof(c16), length, SIZE_MAX, &bytes)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return nullptr;
    }
    c16 *result = mal_heap_try_alloc_raw(&vm->heap, bytes);
    if (result == nullptr) {
        mal_vm_throw_allocation_error(vm);
    }
    return result;
}

static inline bool mal_uri_encode_unescaped(c16 c, bool component) {
    return mal_uri_is_unreserved(c) || (!component && mal_uri_is_reserved_or_hash(c));
}

static inline void mal_uri_write_octet(c16 *output, usize *offset, u8 octet) {
    output[(*offset)++] = '%';
    output[(*offset)++] = (c16) mal_uri_hex_digits[(octet >> 4) & 0x0F];
    output[(*offset)++] = (c16) mal_uri_hex_digits[octet & 0x0F];
}

// ECMA-262 Encode(string, unescapedSet), with a validation/size pass followed
// by one exact heap allocation. The overwhelmingly common unchanged path
// returns the already-coerced string without allocating.
static MalValue mal_uri_encode(MalVm *vm, MalString *string, bool component) {
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    usize result_length = length;
    bool changed = false;

    for (usize k = 0; k < length; k++) {
        c16 c = units[k];
        if (mal_uri_encode_unescaped(c, component)) {
            continue;
        }

        u32 code_point;
        usize width;
        if (!mal_utf16_read_scalar(units, length, k, &code_point, &width)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
            return mal_value_new_undefined();
        }
        k += width - 1;
        usize utf8_length = code_point <= 0x7F
            ? 1
            : code_point <= 0x7FF ? 2 : code_point <= 0xFFFF ? 3 : 4;
        if (!mal_uri_result_length_add(
                vm, &result_length, utf8_length * 3 - width)) {
            return mal_value_new_undefined();
        }
        changed = true;
    }

    if (!changed) {
        return mal_value_from_string(string);
    }
    c16 *output = mal_uri_result_alloc(vm, result_length);
    if (output == nullptr) {
        return mal_value_new_undefined();
    }
    usize offset = 0;
    for (usize k = 0; k < length; k++) {
        c16 c = units[k];
        if (mal_uri_encode_unescaped(c, component)) {
            output[offset++] = c;
            continue;
        }
        u32 code_point;
        usize width;
        if (!mal_utf16_read_scalar(units, length, k, &code_point, &width)) abort();
        k += width - 1;
        if (code_point <= 0x7F) {
            mal_uri_write_octet(output, &offset, (u8) code_point);
        } else if (code_point <= 0x7FF) {
            mal_uri_write_octet(output, &offset, (u8) (0xC0 | (code_point >> 6)));
            mal_uri_write_octet(output, &offset, (u8) (0x80 | (code_point & 0x3F)));
        } else if (code_point <= 0xFFFF) {
            mal_uri_write_octet(output, &offset, (u8) (0xE0 | (code_point >> 12)));
            mal_uri_write_octet(output, &offset, (u8) (0x80 | ((code_point >> 6) & 0x3F)));
            mal_uri_write_octet(output, &offset, (u8) (0x80 | (code_point & 0x3F)));
        } else {
            mal_uri_write_octet(output, &offset, (u8) (0xF0 | (code_point >> 18)));
            mal_uri_write_octet(output, &offset, (u8) (0x80 | ((code_point >> 12) & 0x3F)));
            mal_uri_write_octet(output, &offset, (u8) (0x80 | ((code_point >> 6) & 0x3F)));
            mal_uri_write_octet(output, &offset, (u8) (0x80 | (code_point & 0x3F)));
        }
    }
    return mal_value_from_string(mal_string_new_owned(&vm->heap, output, result_length));
}

typedef struct MalUriDecodedEscape {
    usize end;
    u32 code_point;
    bool preserved;
} MalUriDecodedEscape;

/** Parse one percent-encoded UTF-8 scalar. This is intentionally allocation-
 * free so the sizing pass rejects malformed input before allocating output. */
static bool mal_uri_decode_escape(
    const c16 *units,
    usize length,
    usize start,
    bool preserve_reserved,
    MalUriDecodedEscape *out
) {
    if (start + 2 >= length) return false;
    u8 first;
    if (!mal_uri_hex_pair(units[start + 1], units[start + 2], &first)) return false;
    if (first < 0x80) {
        *out = (MalUriDecodedEscape) {
            .end = start + 2,
            .code_point = first,
            .preserved = preserve_reserved && mal_uri_is_reserved_or_hash((c16) first),
        };
        return true;
    }

    i32 count;
    u32 code_point;
    if ((first & 0xE0) == 0xC0) {
        count = 2;
        code_point = (u32) (first & 0x1F);
    } else if ((first & 0xF0) == 0xE0) {
        count = 3;
        code_point = (u32) (first & 0x0F);
    } else if ((first & 0xF8) == 0xF0) {
        count = 4;
        code_point = (u32) (first & 0x07);
    } else {
        return false;
    }

    usize position = start + 3;
    for (i32 index = 1; index < count; index++) {
        if (position + 2 >= length || units[position] != '%') return false;
        u8 continuation;
        if (!mal_uri_hex_pair(units[position + 1], units[position + 2], &continuation) ||
            (continuation & 0xC0) != 0x80) {
            return false;
        }
        code_point = (code_point << 6) | (u32) (continuation & 0x3F);
        position += 3;
    }

    bool overlong =
        (count == 2 && code_point < 0x80) ||
        (count == 3 && code_point < 0x800) ||
        (count == 4 && code_point < 0x10000);
    if (overlong ||
        (code_point >= 0xD800 && code_point <= 0xDFFF) ||
        code_point > 0x10FFFF) {
        return false;
    }
    *out = (MalUriDecodedEscape) {
        .end = position - 1,
        .code_point = code_point,
        .preserved = false,
    };
    return true;
}

// ECMA-262 Decode(string, reservedSet), using an exact two-pass result. Inputs
// without percent escapes return the existing string immediately.
static MalValue mal_uri_decode(MalVm *vm, MalString *string, bool preserve_reserved) {
    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    usize result_length = length;
    bool changed = false;

    for (usize k = 0; k < length; k++) {
        if (units[k] != '%') {
            continue;
        }
        MalUriDecodedEscape decoded;
        if (!mal_uri_decode_escape(units, length, k, preserve_reserved, &decoded)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
            return mal_value_new_undefined();
        }
        if (!decoded.preserved) {
            usize consumed = decoded.end - k + 1;
            usize appended = decoded.code_point <= 0xFFFF ? 1 : 2;
            result_length -= consumed - appended;
            changed = true;
        }
        k = decoded.end;
    }

    if (!changed) {
        return mal_value_from_string(string);
    }
    c16 *output = mal_uri_result_alloc(vm, result_length);
    if (output == nullptr) {
        return mal_value_new_undefined();
    }
    usize offset = 0;
    for (usize k = 0; k < length; k++) {
        if (units[k] != '%') {
            output[offset++] = units[k];
            continue;
        }
        MalUriDecodedEscape decoded;
        if (!mal_uri_decode_escape(units, length, k, preserve_reserved, &decoded)) abort();
        if (decoded.preserved) {
            usize count = decoded.end - k + 1;
            memcpy(output + offset, units + k, sizeof(c16) * count);
            offset += count;
        } else if (decoded.code_point <= 0xFFFF) {
            output[offset++] = (c16) decoded.code_point;
        } else {
            mal_utf16_emit_pair(decoded.code_point, output + offset);
            offset += 2;
        }
        k = decoded.end;
    }
    return mal_value_from_string(mal_string_new_owned(&vm->heap, output, result_length));
}

// Full ToString(arg), including object ToPrimitive and abrupt completion.
static bool mal_uri_to_string(MalVm *vm, const MalValue *args, i32 arg_count, MalString **out) {
    MalValue value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    return mal_vm_to_string(vm, value, out);
}

static MalValue mal_builtin_decode_uri(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) {
        return mal_value_new_undefined();
    }
    return mal_uri_decode(vm, string, true);
}

static MalValue mal_builtin_decode_uri_component(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) {
        return mal_value_new_undefined();
    }
    return mal_uri_decode(vm, string, false);
}

static MalValue mal_builtin_encode_uri(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) {
        return mal_value_new_undefined();
    }
    return mal_uri_encode(vm, string, false);
}

static MalValue mal_builtin_encode_uri_component(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) {
        return mal_value_new_undefined();
    }
    return mal_uri_encode(vm, string, true);
}

static bool mal_uri_escape_unescaped(c16 c) {
    return (c >= 'A' && c <= 'Z') ||
        (c >= 'a' && c <= 'z') ||
        (c >= '0' && c <= '9') ||
        c == '@' || c == '*' || c == '_' || c == '+' || c == '-' ||
        c == '.' || c == '/';
}

/** Annex B escape(string), operating on UTF-16 code units rather than scalars. */
static MalValue mal_builtin_escape(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) {
        return mal_value_new_undefined();
    }

    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    usize result_length = length;
    bool changed = false;
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        usize width = mal_uri_escape_unescaped(unit) ? 1 : unit < 256 ? 3 : 6;
        if (width > 1 &&
            !mal_uri_result_length_add(vm, &result_length, width - 1)) {
            return mal_value_new_undefined();
        }
        changed |= width != 1;
    }
    if (!changed) {
        return mal_value_from_string(string);
    }
    c16 *output = mal_uri_result_alloc(vm, result_length);
    if (output == nullptr) {
        return mal_value_new_undefined();
    }
    usize offset = 0;
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        if (mal_uri_escape_unescaped(unit)) {
            output[offset++] = unit;
        } else if (unit < 256) {
            mal_uri_write_octet(output, &offset, (u8) unit);
        } else {
            output[offset++] = '%';
            output[offset++] = 'u';
            output[offset++] = mal_uri_hex_digits[(unit >> 12) & 0x0F];
            output[offset++] = mal_uri_hex_digits[(unit >> 8) & 0x0F];
            output[offset++] = mal_uri_hex_digits[(unit >> 4) & 0x0F];
            output[offset++] = mal_uri_hex_digits[unit & 0x0F];
        }
    }
    return mal_value_from_string(mal_string_new_owned(&vm->heap, output, result_length));
}

static bool mal_uri_hex_quad(const c16 *units, c16 *out) {
    i32 a = mal_hex_decode_digit(units[0]);
    i32 b = mal_hex_decode_digit(units[1]);
    i32 c = mal_hex_decode_digit(units[2]);
    i32 d = mal_hex_decode_digit(units[3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) return false;
    *out = (c16) ((a << 12) | (b << 8) | (c << 4) | d);
    return true;
}

/** Annex B unescape(string); malformed escapes are copied verbatim. */
static MalValue mal_builtin_unescape(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) {
        return mal_value_new_undefined();
    }

    const c16 *units = mal_string_code_units(string);
    usize length = mal_string_length(string);
    usize result_length = 0;
    bool changed = false;
    for (usize i = 0; i < length; i++) {
        c16 decoded;
        u8 octet;
        if (units[i] == '%' && i + 5 < length && units[i + 1] == 'u' &&
            mal_uri_hex_quad(units + i + 2, &decoded)) {
            i += 5;
            changed = true;
        } else if (units[i] == '%' && i + 2 < length &&
                   mal_uri_hex_pair(units[i + 1], units[i + 2], &octet)) {
            i += 2;
            changed = true;
        }
        if (!mal_uri_result_length_add(vm, &result_length, 1)) {
            return mal_value_new_undefined();
        }
    }
    if (!changed) {
        return mal_value_from_string(string);
    }
    c16 *output = mal_uri_result_alloc(vm, result_length);
    if (output == nullptr) {
        return mal_value_new_undefined();
    }
    usize offset = 0;
    for (usize i = 0; i < length; i++) {
        c16 decoded;
        u8 octet;
        if (units[i] == '%' && i + 5 < length && units[i + 1] == 'u' &&
            mal_uri_hex_quad(units + i + 2, &decoded)) {
            output[offset++] = decoded;
            i += 5;
        } else if (units[i] == '%' && i + 2 < length &&
                   mal_uri_hex_pair(units[i + 1], units[i + 2], &octet)) {
            output[offset++] = octet;
            i += 2;
        } else {
            output[offset++] = units[i];
        }
    }
    return mal_value_from_string(mal_string_new_owned(&vm->heap, output, result_length));
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

void mal_builtin_uri_install_legacy_globals(MalVm *vm, MalObject *global_this) {
    u8 flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(
        vm, global_this, "escape", mal_uri_make_function(vm, "escape", mal_builtin_escape), flags);
    mal_intrinsic_define_data(
        vm, global_this, "unescape", mal_uri_make_function(vm, "unescape", mal_builtin_unescape), flags);
}
