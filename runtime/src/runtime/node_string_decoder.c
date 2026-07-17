#include "node_string_decoder.h"

#if MAL_NODE

#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "builtin_data_view.h"
#include "function_object.h"
#include "gc.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "text_encoding.h"
#include "typed_array_object.h"
#include "value.h"
#include "vm_ops.h"

/* DataView keeps its layout private to builtin_data_view.c. Keep this in sync
 * with the runtime crypto adapter until the engine exposes a byte-view helper. */
struct MalDataViewObject {
    MalObject object;
    MalArrayBufferObject *buffer;
    u32 byte_offset;
    u32 byte_length;
    bool length_tracking;
};

typedef enum MalStringDecoderEncoding {
    MAL_SD_UTF8,
    MAL_SD_UTF16LE,
    MAL_SD_LATIN1,
    MAL_SD_ASCII,
    MAL_SD_BASE64,
    MAL_SD_BASE64URL,
    MAL_SD_HEX,
} MalStringDecoderEncoding;

typedef struct MalStringDecoderState {
    MalObject *object;
    MalStringDecoderEncoding encoding;
    u32 pending;
} MalStringDecoderState;

static bool sd_ascii_equal_ci(const MalString *string, const char *ascii) {
    usize length = strlen(ascii);
    if (mal_string_length(string) != length) return false;
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length; i++) {
        c16 unit = units[i];
        if (unit >= 'A' && unit <= 'Z') unit += 'a' - 'A';
        if (unit != (c16) (u8) ascii[i]) return false;
    }
    return true;
}

static bool sd_encoding(
    MalVm *vm, MalValue value, MalStringDecoderEncoding *encoding,
    const char **canonical
) {
    if (mal_value_is_undefined(value) || mal_value_is_null(value)) {
        *encoding = MAL_SD_UTF8;
        *canonical = "utf8";
        return true;
    }
    if (!mal_value_is_string(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Unknown StringDecoder encoding");
        return false;
    }
    MalString *string = mal_value_to_string(value);
    if (mal_string_length(string) == 0 || sd_ascii_equal_ci(string, "utf8") ||
        sd_ascii_equal_ci(string, "utf-8")) {
        *encoding = MAL_SD_UTF8;
        *canonical = "utf8";
    } else if (sd_ascii_equal_ci(string, "utf16le") ||
               sd_ascii_equal_ci(string, "utf-16le") ||
               sd_ascii_equal_ci(string, "ucs2") ||
               sd_ascii_equal_ci(string, "ucs-2")) {
        *encoding = MAL_SD_UTF16LE;
        *canonical = "utf16le";
    } else if (sd_ascii_equal_ci(string, "latin1") ||
               sd_ascii_equal_ci(string, "binary")) {
        *encoding = MAL_SD_LATIN1;
        *canonical = "latin1";
    } else if (sd_ascii_equal_ci(string, "ascii")) {
        *encoding = MAL_SD_ASCII;
        *canonical = "ascii";
    } else if (sd_ascii_equal_ci(string, "base64")) {
        *encoding = MAL_SD_BASE64;
        *canonical = "base64";
    } else if (sd_ascii_equal_ci(string, "base64url")) {
        *encoding = MAL_SD_BASE64URL;
        *canonical = "base64url";
    } else if (sd_ascii_equal_ci(string, "hex")) {
        *encoding = MAL_SD_HEX;
        *canonical = "hex";
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Unknown StringDecoder encoding");
        return false;
    }
    return true;
}

static MalKey sd_state_key(MalValue callee) {
    MalValue marker = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = marker};
}

static MalKey sd_name_key(MalVm *vm, const char *name) {
    return mal_intrinsic_string_key(vm, (const byte *) name);
}

static bool sd_read_state(
    MalVm *vm, MalValue receiver, MalValue callee, MalStringDecoderState *state
) {
    if (!mal_value_is_object(receiver)) goto mismatch;
    MalPropertyLookup branded = mal_object_get_own(
        mal_value_to_object(receiver), sd_state_key(callee));
    if (!branded.present || !mal_value_is_object(branded.desc.value)) goto mismatch;

    MalObject *object = mal_value_to_object(branded.desc.value);
    MalPropertyLookup encoding = mal_object_get_own(object, sd_name_key(vm, "encoding"));
    MalPropertyLookup pending = mal_object_get_own(object, sd_name_key(vm, "pending"));
    if (!encoding.present || !mal_value_is_int32(encoding.desc.value) ||
        !pending.present || !mal_value_is_int32(pending.desc.value)) {
        goto mismatch;
    }
    i32 raw_encoding = mal_value_to_i32(encoding.desc.value);
    if (raw_encoding < MAL_SD_UTF8 || raw_encoding > MAL_SD_HEX) goto mismatch;
    state->object = object;
    state->encoding = (MalStringDecoderEncoding) raw_encoding;
    state->pending = (u32) mal_value_to_i32(pending.desc.value);
    return true;

mismatch:
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                       "StringDecoder method called on incompatible receiver");
    return false;
}

static void sd_write_pending(MalVm *vm, MalStringDecoderState *state, u32 pending) {
    mal_object_set(state->object, sd_name_key(vm, "pending"),
                   mal_value_from_i32((i32) pending));
    state->pending = pending;
}

static u32 sd_pending_pack(const byte *bytes, usize count) {
    u32 packed = (u32) count << 24;
    for (usize i = 0; i < count; i++) {
        packed |= (u32) (u8) bytes[i] << (i * 8);
    }
    return packed;
}

static usize sd_pending_unpack(u32 packed, byte bytes[3]) {
    usize count = packed >> 24;
    if (count > 3) count = 0;
    for (usize i = 0; i < count; i++) bytes[i] = (byte) (packed >> (i * 8));
    return count;
}

static bool sd_byte_view(
    MalVm *vm, MalValue value, const byte **data, usize *length
) {
    MalArrayBufferObject *buffer;
    usize byte_offset;
    if (mal_value_is_typed_array_object(value)) {
        MalTypedArrayObject *array = mal_value_to_typed_array_object(value);
        if (mal_typed_array_object_is_out_of_bounds(array)) goto invalid;
        buffer = array->buffer;
        byte_offset = array->byte_offset;
        *length = mal_typed_array_object_byte_length(array);
    } else if (mal_value_is_data_view_object(value)) {
        MalDataViewObject *view = mal_value_to_data_view_object(value);
        buffer = view->buffer;
        if (buffer == nullptr || buffer->detached ||
            view->byte_offset > buffer->byte_length ||
            (!view->length_tracking &&
             (u64) view->byte_offset + view->byte_length > buffer->byte_length)) {
            goto invalid;
        }
        byte_offset = view->byte_offset;
        *length = view->length_tracking
            ? buffer->byte_length - byte_offset
            : view->byte_length;
    } else {
        goto invalid;
    }
    *data = buffer->data == nullptr
        ? (const byte *) ""
        : buffer->data + byte_offset;
    return true;

invalid:
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                       "StringDecoder.write requires a Buffer or Uint8Array");
    return false;
}

static bool sd_checked_output(MalVm *vm, usize length) {
    if (length <= MAL_STRING_MAX_CODE_UNITS) return true;
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                       "StringDecoder output is too large");
    return false;
}

static MalValue sd_string_from_units(MalVm *vm, const c16 *units, usize length) {
    if (!sd_checked_output(vm, length)) return mal_value_new_undefined();
    return mal_value_from_string(mal_string_new_copy(&vm->heap, units, length));
}

static MalValue sd_allocation_error(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                       "StringDecoder allocation failed");
    return mal_value_new_undefined();
}

static byte *sd_join_pending(
    u32 packed, const byte *data, usize length, usize *total_out
) {
    byte saved[3];
    usize saved_length = sd_pending_unpack(packed, saved);
    if (length > SIZE_MAX - saved_length) return nullptr;
    usize total = saved_length + length;
    byte *joined = malloc(total == 0 ? 1 : total);
    if (joined == nullptr) return nullptr;
    if (saved_length > 0) memcpy(joined, saved, saved_length);
    if (length > 0) memcpy(joined + saved_length, data, length);
    *total_out = total;
    return joined;
}

static i32 sd_utf8_sequence_length(u8 byte_value) {
    if (byte_value <= 0x7f) return 0;
    if ((byte_value >> 5) == 0x06) return 2;
    if ((byte_value >> 4) == 0x0e) return 3;
    if ((byte_value >> 3) == 0x1e) return 4;
    if ((byte_value >> 6) == 0x02) return -1;
    return -2;
}

/* Match Node's boundary detector: C0/C1, F5-F7 and semantically invalid second
 * bytes remain pending until the syntactic sequence is complete. The strict
 * codec then applies one replacement per malformed subsequence/byte. */
static usize sd_utf8_incomplete_tail(const byte *bytes, usize length) {
    if (length == 0) return 0;
    i32 kind = sd_utf8_sequence_length((u8) bytes[length - 1]);
    if (kind > 0) return 1;
    if (kind != -1 || length < 2) return 0;

    kind = sd_utf8_sequence_length((u8) bytes[length - 2]);
    if (kind >= 3) return 2;
    if (kind != -1 || length < 3) return 0;

    kind = sd_utf8_sequence_length((u8) bytes[length - 3]);
    return kind == 4 ? 3 : 0;
}

static MalValue sd_decode_utf8(
    MalVm *vm, MalStringDecoderState *state, const byte *data, usize length,
    bool final
) {
    usize total;
    byte *joined = sd_join_pending(state->pending, data, length, &total);
    if (joined == nullptr) return sd_allocation_error(vm);

    usize retained = final ? 0 : sd_utf8_incomplete_tail(joined, total);
    usize decoded_length = total - retained;
    if (decoded_length > MAL_STRING_MAX_CODE_UNITS * 2) {
        free(joined);
        return sd_checked_output(vm, MAL_STRING_MAX_CODE_UNITS + 1);
    }
    usize unit_count;
    c16 *units = mal_utf8_decode(joined, decoded_length, &unit_count);
    if (units == nullptr) {
        free(joined);
        return sd_allocation_error(vm);
    }
    if (!sd_checked_output(vm, unit_count)) {
        free(units);
        free(joined);
        return mal_value_new_undefined();
    }

    u32 next_pending = retained == 0
        ? 0
        : sd_pending_pack(joined + decoded_length, retained);
    MalValue result = sd_string_from_units(vm, units, unit_count);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        sd_write_pending(vm, state, next_pending);
    }
    free(units);
    free(joined);
    return result;
}

static bool sd_utf16_high(const byte *bytes) {
    u16 unit = (u16) (u8) bytes[0] | ((u16) (u8) bytes[1] << 8);
    return unit >= 0xd800 && unit <= 0xdbff;
}

static MalValue sd_decode_utf16le(
    MalVm *vm, MalStringDecoderState *state, const byte *data, usize length,
    bool final
) {
    byte old[3];
    usize old_length = sd_pending_unpack(state->pending, old);
    usize total;
    byte *joined = sd_join_pending(state->pending, data, length, &total);
    if (joined == nullptr) return sd_allocation_error(vm);

    usize output_bytes;
    usize retained = 0;
    if (final) {
        output_bytes = total & ~(usize) 1;
    } else if (old_length == 1 && total == 2) {
        output_bytes = 2;
    } else if (old_length >= 2 && sd_utf16_high(old) && total < 4) {
        output_bytes = 0;
        retained = total;
    } else {
        usize forced = old_length >= 2 && sd_utf16_high(old) ? 4 : 0;
        usize remaining = total - forced;
        if ((remaining & 1) != 0) {
            output_bytes = total - 1;
            retained = 1;
        } else if (remaining >= 2 && sd_utf16_high(joined + total - 2)) {
            output_bytes = total - 2;
            retained = 2;
        } else {
            output_bytes = total;
        }
    }

    usize unit_count = output_bytes / 2;
    if (!sd_checked_output(vm, unit_count)) {
        free(joined);
        return mal_value_new_undefined();
    }
    c16 *units = malloc(sizeof(c16) * (unit_count == 0 ? 1 : unit_count));
    if (units == nullptr) {
        free(joined);
        return sd_allocation_error(vm);
    }
    for (usize i = 0; i < unit_count; i++) {
        units[i] = (c16) ((u8) joined[i * 2] |
                          ((u16) (u8) joined[i * 2 + 1] << 8));
    }

    u32 next_pending = retained == 0
        ? 0
        : sd_pending_pack(joined + total - retained, retained);
    MalValue result = sd_string_from_units(vm, units, unit_count);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        sd_write_pending(vm, state, next_pending);
    }
    free(units);
    free(joined);
    return result;
}

static MalValue sd_decode_base64(
    MalVm *vm, MalStringDecoderState *state, const byte *data, usize length,
    bool final
) {
    usize total;
    byte *joined = sd_join_pending(state->pending, data, length, &total);
    if (joined == nullptr) return sd_allocation_error(vm);
    usize consumed = total - total % 3;
    usize retained = total - consumed;
    bool padding = state->encoding == MAL_SD_BASE64;
    usize output_length = consumed / 3 * 4;
    if (final && retained != 0) {
        output_length += padding ? 4 : retained + 1;
    }
    if (!sd_checked_output(vm, output_length)) {
        free(joined);
        return mal_value_new_undefined();
    }
    c16 *units = malloc(sizeof(c16) * (output_length == 0 ? 1 : output_length));
    if (units == nullptr) {
        free(joined);
        return sd_allocation_error(vm);
    }
    static const byte standard[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    static const byte url[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const byte *alphabet = state->encoding == MAL_SD_BASE64URL ? url : standard;
    usize read = 0;
    usize written = 0;
    while (read + 3 <= consumed) {
        u32 value = ((u32) (u8) joined[read] << 16) |
                    ((u32) (u8) joined[read + 1] << 8) |
                    (u8) joined[read + 2];
        units[written++] = alphabet[(value >> 18) & 0x3f];
        units[written++] = alphabet[(value >> 12) & 0x3f];
        units[written++] = alphabet[(value >> 6) & 0x3f];
        units[written++] = alphabet[value & 0x3f];
        read += 3;
    }
    if (final && retained == 1) {
        u32 value = (u32) (u8) joined[consumed] << 16;
        units[written++] = alphabet[(value >> 18) & 0x3f];
        units[written++] = alphabet[(value >> 12) & 0x3f];
        if (padding) {
            units[written++] = '=';
            units[written++] = '=';
        }
    } else if (final && retained == 2) {
        u32 value = ((u32) (u8) joined[consumed] << 16) |
                    ((u32) (u8) joined[consumed + 1] << 8);
        units[written++] = alphabet[(value >> 18) & 0x3f];
        units[written++] = alphabet[(value >> 12) & 0x3f];
        units[written++] = alphabet[(value >> 6) & 0x3f];
        if (padding) units[written++] = '=';
    }

    u32 next_pending = !final && retained != 0
        ? sd_pending_pack(joined + consumed, retained)
        : 0;
    MalValue result = sd_string_from_units(vm, units, written);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        sd_write_pending(vm, state, next_pending);
    }
    free(units);
    free(joined);
    return result;
}

static MalValue sd_decode_stateless(
    MalVm *vm, MalStringDecoderState *state, const byte *data, usize length
) {
    usize output_length = state->encoding == MAL_SD_HEX ? length * 2 : length;
    if (state->encoding == MAL_SD_HEX && length > MAL_STRING_MAX_CODE_UNITS / 2) {
        return sd_checked_output(vm, MAL_STRING_MAX_CODE_UNITS + 1);
    }
    if (!sd_checked_output(vm, output_length)) return mal_value_new_undefined();
    c16 *units = malloc(sizeof(c16) * (output_length == 0 ? 1 : output_length));
    if (units == nullptr) return sd_allocation_error(vm);
    if (state->encoding == MAL_SD_HEX) {
        static const byte digits[] = "0123456789abcdef";
        for (usize i = 0; i < length; i++) {
            u8 value = (u8) data[i];
            units[i * 2] = digits[value >> 4];
            units[i * 2 + 1] = digits[value & 0x0f];
        }
    } else {
        for (usize i = 0; i < length; i++) {
            units[i] = state->encoding == MAL_SD_ASCII
                ? (u8) data[i] & 0x7f
                : (u8) data[i];
        }
    }
    MalValue result = sd_string_from_units(vm, units, output_length);
    free(units);
    return result;
}

static MalValue sd_decode(
    MalVm *vm, MalStringDecoderState *state, const byte *data, usize length,
    bool final
) {
    switch (state->encoding) {
        case MAL_SD_UTF8:
            return sd_decode_utf8(vm, state, data, length, final);
        case MAL_SD_UTF16LE:
            return sd_decode_utf16le(vm, state, data, length, final);
        case MAL_SD_BASE64:
        case MAL_SD_BASE64URL:
            return sd_decode_base64(vm, state, data, length, final);
        case MAL_SD_LATIN1:
        case MAL_SD_ASCII:
        case MAL_SD_HEX:
            return sd_decode_stateless(vm, state, data, length);
    }
    return mal_value_new_undefined();
}

static MalValue sd_constructor(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) receiver;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "StringDecoder constructor requires 'new'");
        return mal_value_new_undefined();
    }
    MalStringDecoderEncoding encoding;
    const char *canonical;
    if (!sd_encoding(vm, argc > 0 ? args[0] : mal_value_new_undefined(),
                     &encoding, &canonical)) {
        return mal_value_new_undefined();
    }

    MalValue roots[] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) canonical)),
        mal_native_function_object_get_slot(
            mal_value_to_native_function_object(callee), 0),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_OBJECT_PROTOTYPE, &prototype)) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    roots[0] = mal_value_from_object(prototype);
    roots[0] = mal_value_from_object(
        mal_object_new(&vm->heap, mal_value_to_object(roots[0])));
    roots[1] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));

    MalObject *state = mal_value_to_object(roots[1]);
    mal_intrinsic_define_data(vm, state, (const byte *) "encoding",
                              mal_value_from_i32((i32) encoding), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, state, (const byte *) "pending",
                              mal_value_from_i32(0), MAL_PROPERTY_WRITABLE);
    MalPropertyDesc state_desc = mal_intrinsic_data_desc(roots[1], MAL_PROPERTY_NONE);
    mal_object_define_own(
        mal_value_to_object(roots[0]),
        (MalKey) {.kind = MAL_KEY_SYMBOL, .value = roots[3]}, &state_desc);
    mal_intrinsic_define_data(
        vm, mal_value_to_object(roots[0]), (const byte *) "encoding", roots[2],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);

    MalValue result = roots[0];
    mal_gc_unroot(&root);
    return result;
}

static MalValue sd_write(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) new_target;
    MalStringDecoderState state;
    if (!sd_read_state(vm, receiver, callee, &state)) {
        return mal_value_new_undefined();
    }
    const byte *data;
    usize length;
    if (argc < 1 || !sd_byte_view(vm, args[0], &data, &length)) {
        return mal_value_new_undefined();
    }
    return sd_decode(vm, &state, data, length, false);
}

static MalValue sd_end(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc,
    MalValue new_target, MalValue callee
) {
    (void) new_target;
    MalStringDecoderState state;
    if (!sd_read_state(vm, receiver, callee, &state)) {
        return mal_value_new_undefined();
    }
    const byte *data = (const byte *) "";
    usize length = 0;
    if (argc > 0 && !mal_value_is_undefined(args[0]) &&
        !sd_byte_view(vm, args[0], &data, &length)) {
        return mal_value_new_undefined();
    }
    MalValue result = sd_decode(vm, &state, data, length, true);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        sd_write_pending(vm, &state, 0);
    }
    return result;
}

static MalNativeFunctionObject *sd_function(
    MalVm *vm, const char *name, i32 length, MalNativeFunctionCallback callback,
    MalValue marker
) {
    MalNativeFunctionObject *function = mal_native_function_object_new_with_slots(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), callback, &marker, 1);
    MalValue rooted = mal_value_from_native_function_object(function);
    MalRootSpan root;
    mal_gc_root(&root, &rooted, 1);
    function->length = length;
    mal_intrinsic_define_data(vm, (MalObject *) function, (const byte *) "length",
                              mal_value_from_i32(length), MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&root);
    return function;
}

void mal_host_install_node_string_decoder(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch
) {
    (void) launch;
    MalValue roots[] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));

    roots[4] = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    roots[0] = mal_value_from_object(mal_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));
    MalNativeFunctionObject *constructor = sd_function(
        vm, "StringDecoder", 1, sd_constructor, roots[4]);
    mal_native_function_object_set_constructor(constructor);
    roots[1] = mal_value_from_native_function_object(constructor);
    mal_intrinsic_define_data(vm, (MalObject *) constructor, (const byte *) "prototype",
                              roots[0], MAL_PROPERTY_WRITABLE);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]),
                              (const byte *) "constructor", roots[1],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    roots[2] = mal_value_from_native_function_object(
        sd_function(vm, "write", 1, sd_write, roots[4]));
    roots[3] = mal_value_from_native_function_object(
        sd_function(vm, "end", 1, sd_end, roots[4]));
    MalPropertyFlags method_flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                                    MAL_PROPERTY_CONFIGURABLE;
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "write",
                              roots[2], method_flags);
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[0]), (const byte *) "end",
                              roots[3], method_flags);

    roots[5] = mal_value_from_object(mal_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE])));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[5]),
                              (const byte *) "StringDecoder", roots[1],
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                                  MAL_PROPERTY_CONFIGURABLE);

    for (i32 i = 0; i < count; i++) {
        if (strcmp(slots[i].name, "StringDecoder") == 0) {
            vm->globals[slots[i].slot] = roots[1];
        } else if (strcmp(slots[i].name, "default") == 0) {
            vm->globals[slots[i].slot] = roots[5];
        }
    }
    mal_gc_unroot(&root);
}

#endif /* MAL_NODE */
