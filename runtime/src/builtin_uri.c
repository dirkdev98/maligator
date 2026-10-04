#include "builtin_uri.h"

#include <stdlib.h>
#include <string.h>

#include "checked_size.h"
#include "function_object.h"
#include "gc.h"
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

/** Output storage in the narrowest encoding the sizing pass established. */
typedef struct MalUriOutput {
    void *data;
    usize offset;
    bool wide;
} MalUriOutput;

static bool mal_uri_output_alloc(MalVm *vm, MalUriOutput *output, usize length, bool wide) {
    usize bytes;
    if (!mal_checked_size_multiply(wide ? sizeof(c16) : sizeof(u8), length, SIZE_MAX, &bytes)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return false;
    }
    *output = (MalUriOutput) {.data = mal_heap_try_alloc_raw(&vm->heap, bytes), .wide = wide};
    if (output->data == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    return true;
}

static inline void mal_uri_output_push(MalUriOutput *output, c16 unit) {
    if (output->wide) ((c16 *) output->data)[output->offset++] = unit;
    else ((u8 *) output->data)[output->offset++] = (u8) unit;
}

static MalValue mal_uri_output_finish(MalVm *vm, MalUriOutput *output, usize length) {
    if (output->offset != length) abort();
    return mal_value_from_string(output->wide
        ? mal_string_new_owned(&vm->heap, output->data, length)
        : mal_string_new_latin1_owned(&vm->heap, output->data, length));
}

static inline bool mal_uri_encode_unescaped(c16 c, bool component) {
    return mal_uri_is_unreserved(c) || (!component && mal_uri_is_reserved_or_hash(c));
}

static inline void mal_uri_write_octet(MalUriOutput *output, u8 octet) {
    mal_uri_output_push(output, '%');
    mal_uri_output_push(output, (c16) mal_uri_hex_digits[(octet >> 4) & 0x0F]);
    mal_uri_output_push(output, (c16) mal_uri_hex_digits[octet & 0x0F]);
}

static inline c16 mal_uri_unit(const MalStringSegment *units, usize index) {
    return mal_string_segment_code_unit_at(units, index);
}

/** Latin-1 input has no surrogates, so each unit is its own scalar. */
static inline bool mal_uri_read_scalar(
    const MalStringSegment *units, usize index, u32 *code_point, usize *width
) {
    if (units->latin1) {
        *code_point = units->latin1_units[index];
        *width = 1;
        return true;
    }
    return mal_utf16_read_scalar(units->utf16_units, units->length, index, code_point, width);
}

/** Root `string` while flattening a rope; its storage stays valid until return. */
static MalStringSegment mal_uri_input(MalString *string, MalRootSpan *root, MalValue *slot) {
    *slot = mal_value_from_string(string);
    mal_gc_root(root, slot, 1);
    return mal_string_flat_segment(string);
}

// ECMA-262 Encode(string, unescapedSet), with a validation/size pass followed
// by one exact heap allocation. The overwhelmingly common unchanged path
// returns the already-coerced string without allocating. Encoded output is
// always ASCII, so it is built in compact storage.
MalValue mal_builtin_uri_encode_known(MalVm *vm, MalString *string, bool component) {
    MalValue slot;
    MalRootSpan root;
    MalStringSegment units = mal_uri_input(string, &root, &slot);
    usize length = units.length;
    usize result_length = length;
    bool changed = false;
    MalValue result = mal_value_new_undefined();

    for (usize k = 0; k < length; k++) {
        c16 c = mal_uri_unit(&units, k);
        if (mal_uri_encode_unescaped(c, component)) {
            continue;
        }

        u32 code_point;
        usize width;
        if (!mal_uri_read_scalar(&units, k, &code_point, &width)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
            goto done;
        }
        k += width - 1;
        usize utf8_length = code_point <= 0x7F
            ? 1
            : code_point <= 0x7FF ? 2 : code_point <= 0xFFFF ? 3 : 4;
        if (!mal_uri_result_length_add(
                vm, &result_length, utf8_length * 3 - width)) {
            goto done;
        }
        changed = true;
    }

    if (!changed) {
        result = slot;
        goto done;
    }
    MalUriOutput output;
    if (!mal_uri_output_alloc(vm, &output, result_length, false)) goto done;
    for (usize k = 0; k < length; k++) {
        c16 c = mal_uri_unit(&units, k);
        if (mal_uri_encode_unescaped(c, component)) {
            mal_uri_output_push(&output, c);
            continue;
        }
        u32 code_point;
        usize width;
        if (!mal_uri_read_scalar(&units, k, &code_point, &width)) abort();
        k += width - 1;
        if (code_point <= 0x7F) {
            mal_uri_write_octet(&output, (u8) code_point);
        } else if (code_point <= 0x7FF) {
            mal_uri_write_octet(&output, (u8) (0xC0 | (code_point >> 6)));
            mal_uri_write_octet(&output, (u8) (0x80 | (code_point & 0x3F)));
        } else if (code_point <= 0xFFFF) {
            mal_uri_write_octet(&output, (u8) (0xE0 | (code_point >> 12)));
            mal_uri_write_octet(&output, (u8) (0x80 | ((code_point >> 6) & 0x3F)));
            mal_uri_write_octet(&output, (u8) (0x80 | (code_point & 0x3F)));
        } else {
            mal_uri_write_octet(&output, (u8) (0xF0 | (code_point >> 18)));
            mal_uri_write_octet(&output, (u8) (0x80 | ((code_point >> 12) & 0x3F)));
            mal_uri_write_octet(&output, (u8) (0x80 | ((code_point >> 6) & 0x3F)));
            mal_uri_write_octet(&output, (u8) (0x80 | (code_point & 0x3F)));
        }
    }
    result = mal_uri_output_finish(vm, &output, result_length);
done:
    mal_gc_unroot(&root);
    return result;
}

typedef struct MalUriDecodedEscape {
    usize end;
    u32 code_point;
    bool preserved;
} MalUriDecodedEscape;

static bool mal_uri_hex_pair_at(const MalStringSegment *units, usize index, u8 *out) {
    return mal_uri_hex_pair(mal_uri_unit(units, index), mal_uri_unit(units, index + 1), out);
}

/** Parse one percent-encoded UTF-8 scalar. This is intentionally allocation-
 * free so the sizing pass rejects malformed input before allocating output. */
static bool mal_uri_decode_escape(
    const MalStringSegment *units,
    usize start,
    bool preserve_reserved,
    MalUriDecodedEscape *out
) {
    usize length = units->length;
    if (start + 2 >= length) return false;
    u8 first;
    if (!mal_uri_hex_pair_at(units, start + 1, &first)) return false;
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
        if (position + 2 >= length || mal_uri_unit(units, position) != '%') return false;
        u8 continuation;
        if (!mal_uri_hex_pair_at(units, position + 1, &continuation) ||
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
MalValue mal_builtin_uri_decode_known(MalVm *vm, MalString *string, bool preserve_reserved) {
    MalValue slot;
    MalRootSpan root;
    MalStringSegment units = mal_uri_input(string, &root, &slot);
    usize length = units.length;
    usize result_length = length;
    bool changed = false;
    // Copied UTF-16 units and decoded scalars decide the output encoding.
    u32 widest = 0;
    MalValue result = mal_value_new_undefined();

    for (usize k = 0; k < length; k++) {
        c16 unit = mal_uri_unit(&units, k);
        if (unit != '%') {
            widest |= unit;
            continue;
        }
        MalUriDecodedEscape decoded;
        if (!mal_uri_decode_escape(&units, k, preserve_reserved, &decoded)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_URI_ERROR_PROTOTYPE, "URI malformed");
            goto done;
        }
        if (!decoded.preserved) {
            usize consumed = decoded.end - k + 1;
            usize appended = decoded.code_point <= 0xFFFF ? 1 : 2;
            result_length -= consumed - appended;
            widest |= decoded.code_point;
            changed = true;
        }
        k = decoded.end;
    }

    if (!changed) {
        result = slot;
        goto done;
    }
    MalUriOutput output;
    if (!mal_uri_output_alloc(vm, &output, result_length, widest > 0xFF)) goto done;
    for (usize k = 0; k < length; k++) {
        c16 unit = mal_uri_unit(&units, k);
        if (unit != '%') {
            mal_uri_output_push(&output, unit);
            continue;
        }
        MalUriDecodedEscape decoded;
        if (!mal_uri_decode_escape(&units, k, preserve_reserved, &decoded)) abort();
        if (decoded.preserved) {
            for (usize i = k; i <= decoded.end; i++) mal_uri_output_push(&output, mal_uri_unit(&units, i));
        } else if (decoded.code_point <= 0xFFFF) {
            mal_uri_output_push(&output, (c16) decoded.code_point);
        } else {
            c16 pair[2];
            mal_utf16_emit_pair(decoded.code_point, pair);
            mal_uri_output_push(&output, pair[0]);
            mal_uri_output_push(&output, pair[1]);
        }
        k = decoded.end;
    }
    result = mal_uri_output_finish(vm, &output, result_length);
done:
    mal_gc_unroot(&root);
    return result;
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
    return mal_builtin_uri_decode_known(vm, string, true);
}

static MalValue mal_builtin_decode_uri_component(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) {
        return mal_value_new_undefined();
    }
    return mal_builtin_uri_decode_known(vm, string, false);
}

static MalValue mal_builtin_encode_uri(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) {
        return mal_value_new_undefined();
    }
    return mal_builtin_uri_encode_known(vm, string, false);
}

static MalValue mal_builtin_encode_uri_component(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) {
        return mal_value_new_undefined();
    }
    return mal_builtin_uri_encode_known(vm, string, true);
}

static bool mal_uri_escape_unescaped(c16 c) {
    return (c >= 'A' && c <= 'Z') ||
        (c >= 'a' && c <= 'z') ||
        (c >= '0' && c <= '9') ||
        c == '@' || c == '*' || c == '_' || c == '+' || c == '-' ||
        c == '.' || c == '/';
}

MalValue mal_builtin_uri_escape_known(MalVm *vm, MalString *string) {
    MalValue slot;
    MalRootSpan root;
    MalStringSegment units = mal_uri_input(string, &root, &slot);
    usize length = units.length;
    usize result_length = length;
    bool changed = false;
    MalValue result = mal_value_new_undefined();
    for (usize i = 0; i < length; i++) {
        c16 unit = mal_uri_unit(&units, i);
        usize width = mal_uri_escape_unescaped(unit) ? 1 : unit < 256 ? 3 : 6;
        if (width > 1 &&
            !mal_uri_result_length_add(vm, &result_length, width - 1)) {
            goto done;
        }
        changed |= width != 1;
    }
    if (!changed) {
        result = slot;
        goto done;
    }
    MalUriOutput output;
    if (!mal_uri_output_alloc(vm, &output, result_length, false)) goto done;
    for (usize i = 0; i < length; i++) {
        c16 unit = mal_uri_unit(&units, i);
        if (mal_uri_escape_unescaped(unit)) {
            mal_uri_output_push(&output, unit);
        } else if (unit < 256) {
            mal_uri_write_octet(&output, (u8) unit);
        } else {
            mal_uri_output_push(&output, '%');
            mal_uri_output_push(&output, 'u');
            mal_uri_output_push(&output, (c16) mal_uri_hex_digits[(unit >> 12) & 0x0F]);
            mal_uri_output_push(&output, (c16) mal_uri_hex_digits[(unit >> 8) & 0x0F]);
            mal_uri_output_push(&output, (c16) mal_uri_hex_digits[(unit >> 4) & 0x0F]);
            mal_uri_output_push(&output, (c16) mal_uri_hex_digits[unit & 0x0F]);
        }
    }
    result = mal_uri_output_finish(vm, &output, result_length);
done:
    mal_gc_unroot(&root);
    return result;
}

static bool mal_uri_hex_quad(const MalStringSegment *units, usize index, c16 *out) {
    i32 a = mal_hex_decode_digit(mal_uri_unit(units, index));
    i32 b = mal_hex_decode_digit(mal_uri_unit(units, index + 1));
    i32 c = mal_hex_decode_digit(mal_uri_unit(units, index + 2));
    i32 d = mal_hex_decode_digit(mal_uri_unit(units, index + 3));
    if (a < 0 || b < 0 || c < 0 || d < 0) return false;
    *out = (c16) ((a << 12) | (b << 8) | (c << 4) | d);
    return true;
}

/** Width of an escape starting at `index` (1 when the unit is literal). */
static usize mal_uri_unescape_at(const MalStringSegment *units, usize index, c16 *out) {
    usize length = units->length;
    c16 unit = mal_uri_unit(units, index);
    u8 octet;
    if (unit == '%' && index + 5 < length && mal_uri_unit(units, index + 1) == 'u' &&
        mal_uri_hex_quad(units, index + 2, out)) {
        return 6;
    }
    if (unit == '%' && index + 2 < length && mal_uri_hex_pair_at(units, index + 1, &octet)) {
        *out = octet;
        return 3;
    }
    *out = unit;
    return 1;
}

MalValue mal_builtin_uri_unescape_known(MalVm *vm, MalString *string) {
    MalValue slot;
    MalRootSpan root;
    MalStringSegment units = mal_uri_input(string, &root, &slot);
    usize length = units.length;
    usize result_length = length;
    bool changed = false;
    u32 widest = 0;
    MalValue result = mal_value_new_undefined();
    for (usize i = 0; i < length;) {
        c16 decoded;
        usize width = mal_uri_unescape_at(&units, i, &decoded);
        widest |= decoded;
        result_length -= width - 1;
        changed |= width != 1;
        i += width;
    }
    if (!changed) {
        result = slot;
        goto done;
    }
    MalUriOutput output;
    if (!mal_uri_output_alloc(vm, &output, result_length, widest > 0xFF)) goto done;
    for (usize i = 0; i < length;) {
        c16 decoded;
        i += mal_uri_unescape_at(&units, i, &decoded);
        mal_uri_output_push(&output, decoded);
    }
    result = mal_uri_output_finish(vm, &output, result_length);
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue mal_builtin_escape(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) return mal_value_new_undefined();
    return mal_builtin_uri_escape_known(vm, string);
}

static MalValue mal_builtin_unescape(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string;
    if (!mal_uri_to_string(vm, args, arg_count, &string)) return mal_value_new_undefined();
    return mal_builtin_uri_unescape_known(vm, string);
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

#include "generated/known_native_builtin_uri_c.inc"
