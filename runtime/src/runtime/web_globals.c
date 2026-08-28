#include "web_globals.h"

#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "ascii.h"
#include "array_buffer_object.h"
#include "array_object.h"
#include "base64.h"
#include "builtin_data_view.h"
#include "builtin_math.h"
#include "checked_size.h"
#include "date_object.h"
#include "entropy.h"
#include "web_events_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "hex.h"
#include "intrinsics.h"
#include "map_object.h"
#include "microtask.h"
#include "monotonic_clock.h"
#include "object.h"
#include "object_ops.h"
#include "property_iter.h"
#include "property_store.h"
#include "table.h"
#include "utf16.h"
#include "utf8.h"
#include "typed_array_object.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/* Monotonic + wall-clock baselines captured at install (single host isolate for
 * now; per-isolate storage is a Phase-4/SMP follow-up). */
static f64 mal_web_time_origin_ms = 0;   // wall-clock ms at install (performance.timeOrigin)
static u64 mal_web_mono_base_ns = 0;     // CLOCK_MONOTONIC ns at install

/* ---------------------------------------------------------------------------
 * TextEncoder / TextDecoder.
 * --------------------------------------------------------------------------- */

/* Allocate a Uint8Array over a fresh exact-size buffer holding `data`. Roots the
 * buffer across the view allocation (the view alloc can trigger a collection). */
static MalValue mal_web_new_uint8array(MalVm *vm, const byte *data, usize len) {
    MalObject *ab_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
    MalArrayBufferObject *buffer =
        mal_array_buffer_object_new(&vm->heap, ab_proto, (u32) len, (u32) len, false, false);
    if (len > 0) {
        memcpy(buffer->data, data, len);
    }
    MalValue buf_val = mal_value_from_array_buffer_object(buffer);
    MalRootSpan rs;
    mal_gc_root(&rs, &buf_val, 1);
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]);
    MalTypedArrayObject *view =
        mal_typed_array_object_new(&vm->heap, proto, buffer, MAL_TA_UINT8, 0, (u32) len, false);
    mal_gc_unroot(&rs);
    return mal_value_from_typed_array_object(view);
}

/* Extract the byte range of a BufferSource (TypedArray, ArrayBuffer, or
 * DataView). Returns true with *out and *out_len set (possibly empty) on success. On
 * failure it throws and returns false: a TypeError for a non-BufferSource value,
 * or for an out-of-bounds DataView or one backed by a resizable buffer. A
 * detached backing store reads as empty rather than an error. */
static bool mal_web_buffer_source(MalVm *vm, MalValue v, const byte **out, usize *out_len) {
    MalBufferSourceSpan span;
    MalBufferSourceSpanStatus status = mal_buffer_source_span(v, &span);
    if (status == MAL_BUFFER_SOURCE_SPAN_OK) {
        if (mal_value_is_data_view_object(v) && span.resizable) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "DataView has a resizable or out-of-bounds ArrayBuffer");
            return false;
        }
        *out = span.data;
        *out_len = span.length;
        return true;
    }
    if (status == MAL_BUFFER_SOURCE_SPAN_DETACHED
        || (status == MAL_BUFFER_SOURCE_SPAN_OUT_OF_BOUNDS
            && mal_value_is_typed_array_object(v))) {
        *out = nullptr;
        *out_len = 0;
        return true;
    }
    if (status == MAL_BUFFER_SOURCE_SPAN_OUT_OF_BOUNDS) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "DataView has a resizable or out-of-bounds ArrayBuffer");
        return false;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "decode input must be an ArrayBuffer, TypedArray, or DataView");
    return false;
}

/* OrdinaryCreateFromConstructor: allocate a plain object whose [[Prototype]] is
 * new_target.prototype (falling back to %Object.prototype%). Native constructors
 * receive `this` = undefined, so they must build their own instance. */
static MalObject *mal_web_ordinary_instance(MalVm *vm, MalValue new_target) {
    MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    if (mal_value_is_object(new_target)) {
        MalValue proto_value = mal_vm_function_prototype(vm, new_target);
        if (mal_value_is_object(proto_value)) {
            proto = mal_value_to_object(proto_value);
        }
    }
    return mal_object_new(&vm->heap, proto);
}

static MalValue mal_web_text_encoder_ctor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) args;
    (void) argc;
    (void) callee;
    // `new TextEncoder()`: an ordinary object over the prototype (UTF-8, stateless).
    return mal_value_from_object(mal_web_ordinary_instance(vm, nt));
}

static MalValue mal_web_text_encoder_encode(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    MalString *str;
    MalValue input = argc >= 1 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_undefined(input)) {
        return mal_web_new_uint8array(vm, nullptr, 0);
    }
    if (!mal_vm_to_string(vm, input, &str)) {
        return mal_value_new_undefined();
    }
    usize out_len;
    byte *bytes = mal_string_to_utf8(str, &out_len);
    if (bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue result = mal_web_new_uint8array(vm, bytes, out_len);
    free(bytes);
    return result;
}

/* encodeInto(source, destination): write source's UTF-8 into destination's bytes,
 * never splitting a code point; returns { read, written }. */
static MalValue mal_web_text_encoder_encode_into(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    MalString *str;
    if (argc < 1 || !mal_vm_to_string(vm, args[0], &str)) {
        if (argc < 1) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "encodeInto requires a source");
        }
        return mal_value_new_undefined();
    }
    if (argc < 2 || !mal_value_is_typed_array_object(args[1])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "encodeInto destination must be a Uint8Array");
        return mal_value_new_undefined();
    }
    MalTypedArrayObject *ta = mal_value_to_typed_array_object(args[1]);
    byte *dst = nullptr;
    if (ta->buffer != nullptr && ta->buffer->data != nullptr) {
        dst = (byte *) ta->buffer->data + ta->byte_offset;
    }
    usize cap = mal_typed_array_object_byte_length(ta);

    const c16 *u = mal_string_code_units(str);
    usize len = mal_string_length(str);
    usize read = 0;
    usize written = 0;
    mal_utf8_encode_into(u, len, dst, cap, &read, &written);

    MalObject *result = mal_intrinsic_new_object(vm);
    mal_object_set(result, mal_intrinsic_string_key(vm, (const byte *) "read"),
        mal_value_from_f64((f64) read));
    mal_object_set(result, mal_intrinsic_string_key(vm, (const byte *) "written"),
        mal_value_from_f64((f64) written));
    return mal_value_from_object(result);
}

typedef enum {
    MAL_TEXT_ENCODING_UTF8,
    MAL_TEXT_ENCODING_UTF16LE,
    MAL_TEXT_ENCODING_UTF16BE,
    MAL_TEXT_ENCODING_INVALID,
} MalTextEncoding;

static bool mal_web_is_encoding_label_whitespace(c16 unit) {
    return unit == ' ' || unit == '\t' || unit == '\n' || unit == '\r' || unit == '\f';
}

/* Match an Encoding Standard label after trimming ASCII whitespace and folding
 * ASCII case. */
static bool mal_web_encoding_label_matches(
    const MalString *s, const char *const *aliases, usize alias_count) {
    usize len = mal_string_length(s);
    const c16 *u = mal_string_code_units(s);
    for (usize a = 0; a < alias_count; a++) {
        const char *alias = aliases[a];
        usize alen = strlen(alias);
        // WHATWG strips leading/trailing ASCII whitespace before matching.
        usize start = 0;
        usize end = len;
        while (start < end && mal_web_is_encoding_label_whitespace(u[start])) {
            start++;
        }
        while (end > start && mal_web_is_encoding_label_whitespace(u[end - 1])) {
            end--;
        }
        if (end - start != alen) {
            continue;
        }
        if (mal_ascii_units_equal_ci(u + start, end - start, alias)) {
            return true;
        }
    }
    return false;
}

static MalTextEncoding mal_web_text_encoding(const MalString *label) {
    static const char *const utf8_aliases[] = {"utf-8", "utf8", "unicode-1-1-utf-8",
        "unicode11utf8", "unicode20utf8", "x-unicode20utf8"};
    static const char *const utf16le_aliases[] = {
        "csunicode", "iso-10646-ucs-2", "ucs-2", "unicode", "unicodefeff", "utf-16", "utf-16le"};
    static const char *const utf16be_aliases[] = {"unicodefffe", "utf-16be"};
    if (mal_web_encoding_label_matches(label, utf8_aliases, countof(utf8_aliases))) {
        return MAL_TEXT_ENCODING_UTF8;
    }
    if (mal_web_encoding_label_matches(label, utf16le_aliases, countof(utf16le_aliases))) {
        return MAL_TEXT_ENCODING_UTF16LE;
    }
    if (mal_web_encoding_label_matches(label, utf16be_aliases, countof(utf16be_aliases))) {
        return MAL_TEXT_ENCODING_UTF16BE;
    }
    return MAL_TEXT_ENCODING_INVALID;
}

/* Per-instance TextDecoder options and streaming state, packed as an int32 stored
 * on the instance under a private "brand" symbol carried in each function's slot
 * 0 (the StringDecoder pattern). At most three bytes can be pending for each of
 * the supported encodings. The brand doubles as a receiver check. */
#define MAL_TEXT_DECODER_FATAL 1
#define MAL_TEXT_DECODER_IGNORE_BOM 2
#define MAL_TEXT_DECODER_ENCODING_SHIFT 2
#define MAL_TEXT_DECODER_ENCODING_MASK (3 << MAL_TEXT_DECODER_ENCODING_SHIFT)
#define MAL_TEXT_DECODER_ACTIVE (1 << 4)
#define MAL_TEXT_DECODER_BOM_SEEN (1 << 5)
#define MAL_TEXT_DECODER_PENDING_COUNT_SHIFT 6
#define MAL_TEXT_DECODER_PENDING_COUNT_MASK (3 << MAL_TEXT_DECODER_PENDING_COUNT_SHIFT)
#define MAL_TEXT_DECODER_PENDING_BYTES_SHIFT 8
#define MAL_TEXT_DECODER_BASE_MASK 0x0f

static MalKey mal_web_text_decoder_brand_key(MalValue callee) {
    MalValue brand = mal_native_function_object_get_slot(
        mal_value_to_native_function_object(callee), 0);
    return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = brand};
}

/* Read the option flags off `self`, or throw a TypeError for a receiver that was
 * not produced by this TextDecoder constructor. */
static bool mal_web_text_decoder_flags(MalVm *vm, MalValue self, MalValue callee, i32 *out) {
    if (mal_value_is_object(self) && mal_value_is_native_function_object(callee)) {
        MalPropertyLookup lookup =
            mal_object_get_own(mal_value_to_object(self), mal_web_text_decoder_brand_key(callee));
        if (lookup.present && mal_value_is_int32(lookup.desc.value)) {
            *out = mal_value_to_i32(lookup.desc.value);
            return true;
        }
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "TextDecoder method called on an incompatible receiver");
    return false;
}

static void mal_web_text_decoder_set_flags(
    MalValue self, MalValue callee, i32 flags) {
    mal_object_set(mal_value_to_object(self), mal_web_text_decoder_brand_key(callee),
        mal_value_from_i32(flags));
}

/* Return the prefix which can be decoded without treating a valid partial UTF-8
 * sequence at the end as an error. Invalid prefixes are left for the regular
 * decoder, including its restore/reconsume behavior. */
static usize mal_web_utf8_stream_prefix(const byte *bytes, usize len) {
    usize i = 0;
    while (i < len) {
        u8 lead = (u8) bytes[i];
        usize needed;
        u8 second_min = 0x80;
        u8 second_max = 0xbf;
        if (lead < 0x80 || lead < 0xc2 || lead > 0xf4) {
            i++;
            continue;
        } else if (lead <= 0xdf) {
            needed = 2;
        } else if (lead <= 0xef) {
            needed = 3;
            if (lead == 0xe0) second_min = 0xa0;
            if (lead == 0xed) second_max = 0x9f;
        } else {
            needed = 4;
            if (lead == 0xf0) second_min = 0x90;
            if (lead == 0xf4) second_max = 0x8f;
        }

        usize consumed = 1;
        bool invalid = false;
        for (usize k = 1; k < needed && i + k < len; k++) {
            u8 continuation = (u8) bytes[i + k];
            u8 minimum = k == 1 ? second_min : 0x80;
            u8 maximum = k == 1 ? second_max : 0xbf;
            if (continuation < minimum || continuation > maximum) {
                invalid = true;
                break;
            }
            consumed++;
        }
        if (!invalid && i + needed > len) {
            return i;
        }
        i += invalid ? consumed : needed;
    }
    return len;
}

static usize mal_web_utf16_stream_prefix(
    const byte *bytes, usize len, bool big_endian) {
    usize pending = len % 2;
    usize complete = len - pending;
    if (complete >= 2) {
        u8 first = (u8) bytes[complete - 2];
        u8 second = (u8) bytes[complete - 1];
        c16 unit = big_endian
            ? (c16) ((first << 8) | second)
            : (c16) ((second << 8) | first);
        if (mal_utf16_is_lead_surrogate(unit)) {
            pending += 2;
        }
    }
    return len - pending;
}

static MalValue mal_web_text_decoder_ctor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    MalTextEncoding encoding = MAL_TEXT_ENCODING_UTF8;
    if (argc >= 1 && !mal_value_is_undefined(args[0])) {
        MalString *label;
        if (!mal_vm_to_string(vm, args[0], &label)) {
            return mal_value_new_undefined();
        }
        encoding = mal_web_text_encoding(label);
        if (encoding == MAL_TEXT_ENCODING_INVALID) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                "TextDecoder: unsupported encoding label");
            return mal_value_new_undefined();
        }
    }
    // Read fatal/ignoreBOM from the options dictionary before allocating so a
    // throwing getter aborts construction cleanly.
    i32 flags = (i32) encoding << MAL_TEXT_DECODER_ENCODING_SHIFT;
    if (argc >= 2 && mal_value_is_object(args[1])) {
        MalValue value;
        if (!mal_vm_get_property(vm, args[1],
                mal_intrinsic_string_key(vm, (const byte *) "fatal"), &value)) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_truthy(value)) {
            flags |= MAL_TEXT_DECODER_FATAL;
        }
        if (!mal_vm_get_property(vm, args[1],
                mal_intrinsic_string_key(vm, (const byte *) "ignoreBOM"), &value)) {
            return mal_value_new_undefined();
        }
        if (mal_value_is_truthy(value)) {
            flags |= MAL_TEXT_DECODER_IGNORE_BOM;
        }
    }
    MalValue instance = mal_value_from_object(mal_web_ordinary_instance(vm, nt));
    MalRootSpan rs;
    mal_gc_root(&rs, &instance, 1);
    MalPropertyDesc desc =
        mal_intrinsic_data_desc(mal_value_from_i32(flags), MAL_PROPERTY_WRITABLE);
    mal_object_define_own(
        mal_value_to_object(instance), mal_web_text_decoder_brand_key(callee), &desc);
    mal_gc_unroot(&rs);
    return instance;
}

static MalValue mal_web_text_decoder_get_encoding(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    i32 flags;
    if (!mal_web_text_decoder_flags(vm, self, callee, &flags)) {
        return mal_value_new_undefined();
    }
    MalTextEncoding encoding =
        (MalTextEncoding) ((flags & MAL_TEXT_DECODER_ENCODING_MASK) >> MAL_TEXT_DECODER_ENCODING_SHIFT);
    const byte *name = encoding == MAL_TEXT_ENCODING_UTF16LE ? (const byte *) "utf-16le"
        : encoding == MAL_TEXT_ENCODING_UTF16BE                  ? (const byte *) "utf-16be"
                                                                 : (const byte *) "utf-8";
    return mal_value_from_string(mal_intrinsic_ascii(vm, name));
}

static MalValue mal_web_text_decoder_get_fatal(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    i32 flags;
    if (!mal_web_text_decoder_flags(vm, self, callee, &flags)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean((flags & MAL_TEXT_DECODER_FATAL) != 0);
}

static MalValue mal_web_text_decoder_get_ignore_bom(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    i32 flags;
    if (!mal_web_text_decoder_flags(vm, self, callee, &flags)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean((flags & MAL_TEXT_DECODER_IGNORE_BOM) != 0);
}

static MalValue mal_web_text_decoder_decode(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    i32 flags;
    if (!mal_web_text_decoder_flags(vm, self, callee, &flags)) {
        return mal_value_new_undefined();
    }
    MalValue input = argc >= 1 ? args[0] : mal_value_new_undefined();
    const byte *bytes = nullptr;
    usize len = 0;
    if (!mal_value_is_undefined(input) && !mal_web_buffer_source(vm, input, &bytes, &len)) {
        return mal_value_new_undefined();
    }

    bool stream = false;
    MalValue options = argc >= 2 ? args[1] : mal_value_new_undefined();
    if (!mal_value_is_undefined(options) && !mal_value_is_null(options)) {
        if (!mal_value_is_object(options)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "TextDecoder.decode options must be an object");
            return mal_value_new_undefined();
        }
        MalValue value;
        if (!mal_vm_get_property(vm, options,
                mal_intrinsic_string_key(vm, (const byte *) "stream"), &value)) {
            return mal_value_new_undefined();
        }
        stream = mal_value_is_truthy(value);
    }

    // Dictionary conversion can detach or resize the input backing store.
    if (!mal_value_is_undefined(input) && !mal_web_buffer_source(vm, input, &bytes, &len)) {
        return mal_value_new_undefined();
    }

    u32 state = (u32) flags;
    if ((state & MAL_TEXT_DECODER_ACTIVE) == 0) {
        state &= MAL_TEXT_DECODER_BASE_MASK;
    }
    MalTextEncoding encoding =
        (MalTextEncoding) ((flags & MAL_TEXT_DECODER_ENCODING_MASK) >> MAL_TEXT_DECODER_ENCODING_SHIFT);

    usize old_pending =
        (state & MAL_TEXT_DECODER_PENDING_COUNT_MASK) >> MAL_TEXT_DECODER_PENDING_COUNT_SHIFT;
    if (len > SIZE_MAX - old_pending) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "TextDecoder.decode input is too large");
        return mal_value_new_undefined();
    }
    usize total = old_pending + len;
    byte *combined = malloc(total == 0 ? 1 : total);
    if (combined == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    u32 packed = state >> MAL_TEXT_DECODER_PENDING_BYTES_SHIFT;
    for (usize i = 0; i < old_pending; i++) {
        combined[i] = (byte) (packed >> (i * 8));
    }
    if (len > 0) {
        memcpy(combined + old_pending, bytes, len);
    }

    usize decode_len = total;
    if (stream) {
        decode_len = encoding == MAL_TEXT_ENCODING_UTF8
            ? mal_web_utf8_stream_prefix(combined, total)
            : mal_web_utf16_stream_prefix(
                  combined, total, encoding == MAL_TEXT_ENCODING_UTF16BE);
    }
    usize pending = total - decode_len;
    state &= MAL_TEXT_DECODER_BASE_MASK | MAL_TEXT_DECODER_BOM_SEEN;
    if (stream) state |= MAL_TEXT_DECODER_ACTIVE;
    state |= (u32) pending << MAL_TEXT_DECODER_PENDING_COUNT_SHIFT;
    for (usize i = 0; i < pending; i++) {
        state |= (u32) (u8) combined[decode_len + i]
            << (MAL_TEXT_DECODER_PENDING_BYTES_SHIFT + i * 8);
    }

    usize count;
    bool had_error;
    c16 *units = encoding == MAL_TEXT_ENCODING_UTF8
        ? mal_utf8_decode_report(combined, decode_len, &count, &had_error)
        : mal_utf16_decode_report(
              combined, decode_len, encoding == MAL_TEXT_ENCODING_UTF16BE, &count, &had_error);
    free(combined);
    if (units == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }

    usize start = 0;
    if ((state & MAL_TEXT_DECODER_BOM_SEEN) == 0 && count > 0) {
        state |= MAL_TEXT_DECODER_BOM_SEEN;
        if ((state & MAL_TEXT_DECODER_IGNORE_BOM) == 0 && units[0] == 0xfeff) {
            start = 1;
        }
    }
    mal_web_text_decoder_set_flags(self, callee, (i32) state);
    if ((flags & MAL_TEXT_DECODER_FATAL) != 0 && had_error) {
        free(units);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "TextDecoder.decode: input is not valid for the selected encoding");
        return mal_value_new_undefined();
    }
    MalValue s =
        mal_value_from_string(mal_string_new_copy(&vm->heap, units + start, count - start));
    free(units);
    return s;
}

/* Install a class: constructor (writable+configurable on global), prototype with
 * a "constructor" backref and an `encoding` data property. Returns the prototype. */
static MalObject *mal_web_install_class(
    MalVm *vm, MalObject *global_this, const byte *name, i32 length,
    MalNativeFunctionCallback ctor_fn, const char *encoding) {
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *obj_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);

    MalObject *proto = mal_object_new(&vm->heap, obj_proto);
    MalNativeFunctionObject *ctor = mal_native_function_object_new_arity(
        &vm->heap, fn_proto, mal_intrinsic_ascii(vm, name), length, ctor_fn);
    mal_native_function_object_set_constructor(ctor);

    mal_intrinsic_define_data(vm, (MalObject *) ctor, (const byte *) "prototype",
        mal_value_from_object(proto), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, proto, (const byte *) "constructor",
        mal_value_from_native_function_object(ctor),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, proto, (const byte *) "encoding",
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) encoding)),
        MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, global_this, name, mal_value_from_native_function_object(ctor),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    return proto;
}

/* A native function carrying `brand` in slot 0, so its callback can recover the
 * per-instance state key from `callee` (the TextDecoder brand pattern). */
static MalNativeFunctionObject *mal_web_branded_function(
    MalVm *vm, const byte *name, i32 length, MalNativeFunctionCallback fn, MalValue brand) {
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    return mal_native_function_object_new_with_slots_arity(
        &vm->heap, fn_proto, mal_intrinsic_ascii(vm, name), length, fn, &brand, 1);
}

/* Define a readonly accessor whose getter carries `brand` in slot 0. */
static void mal_web_define_branded_getter(MalVm *vm, MalObject *proto, const byte *name,
    MalNativeFunctionCallback getter, MalValue brand) {
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(
            mal_web_branded_function(vm, name, 0, getter, brand)),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(proto, mal_intrinsic_string_key(vm, name), &desc);
}

/* Define a prototype method whose callback carries `brand` in slot 0. */
static void mal_web_define_branded_method(MalVm *vm, MalObject *proto, const byte *name,
    i32 length, MalNativeFunctionCallback fn, MalValue brand) {
    mal_intrinsic_define_data(vm, proto, name,
        mal_value_from_native_function_object(mal_web_branded_function(vm, name, length, fn, brand)),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

/* ---------------------------------------------------------------------------
 * btoa / atob (base64 over a Latin-1 "binary string").
 * --------------------------------------------------------------------------- */

static MalValue mal_web_btoa(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    MalString *str;
    if (argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "btoa requires an argument");
        return mal_value_new_undefined();
    }
    if (!mal_vm_to_string(vm, args[0], &str)) {
        return mal_value_new_undefined();
    }
    const c16 *u = mal_string_code_units(str);
    usize n = mal_string_length(str);
    for (usize i = 0; i < n; i++) {
        if (u[i] > 0xFF) {
            mal_dom_exception_throw(vm,
                "btoa: string contains a character outside the Latin1 range",
                "InvalidCharacterError");
            return mal_value_new_undefined();
        }
    }
    usize out_len;
    if (!mal_base64_encoded_length(
            n, true, MAL_STRING_MAX_CODE_UNITS, &out_len)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return mal_value_new_undefined();
    }
    c16 *out = malloc(sizeof(c16) * (out_len == 0 ? 1 : out_len));
    if (out == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return mal_value_new_undefined();
    }
    usize o = 0;
    for (usize i = 0; i < n; i += 3) {
        byte input[3];
        usize input_length = n - i < 3 ? n - i : 3;
        for (usize j = 0; j < input_length; j++) input[j] = (byte) (u8) u[i + j];
        byte encoded[4];
        usize encoded_length = mal_base64_encode_block(
            input, input_length, MAL_BASE64_ALPHABET_STANDARD, true, encoded);
        for (usize j = 0; j < encoded_length; j++) out[o++] = (u8) encoded[j];
    }
    MalValue result = mal_value_from_string(mal_string_new_copy(&vm->heap, out, o));
    free(out);
    return result;
}

static MalValue mal_web_atob(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    MalString *str;
    if (argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "atob requires an argument");
        return mal_value_new_undefined();
    }
    if (!mal_vm_to_string(vm, args[0], &str)) {
        return mal_value_new_undefined();
    }
    const c16 *in = mal_string_code_units(str);
    usize in_len = mal_string_length(str);

    // Strip ASCII whitespace (spec: remove \t \n \f \r space) into a compact buffer.
    c16 *cleaned = malloc(sizeof(c16) * (in_len == 0 ? 1 : in_len));
    if (cleaned == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return mal_value_new_undefined();
    }
    usize m = 0;
    for (usize i = 0; i < in_len; i++) {
        c16 c = in[i];
        if (mal_base64_is_ascii_whitespace(c)) {
            continue;
        }
        cleaned[m++] = c;
    }
    // Padding may only complete an otherwise four-unit block. Unpadded input is
    // accepted, but a partial padding sequence such as "Zg=" remains invalid.
    if (m % 4 == 0) {
        if (m > 0 && cleaned[m - 1] == '=') {
            m--;
        }
        if (m > 0 && cleaned[m - 1] == '=') {
            m--;
        }
    }
    if (m % 4 == 1) {
        free(cleaned);
        mal_dom_exception_throw(
            vm, "atob: invalid base64 length", "InvalidCharacterError");
        return mal_value_new_undefined();
    }

    c16 *out = malloc(sizeof(c16) * (m == 0 ? 1 : m)); // decoded bytes <= input length
    if (out == nullptr) {
        free(cleaned);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return mal_value_new_undefined();
    }
    usize o = 0;
    u32 acc = 0;
    i32 bits = 0;
    for (usize i = 0; i < m; i++) {
        i32 v = mal_base64_decode_digit(
            cleaned[i], MAL_BASE64_ALPHABET_STANDARD);
        if (v < 0) {
            free(cleaned);
            free(out);
            mal_dom_exception_throw(vm, "atob: string contains an invalid character",
                "InvalidCharacterError");
            return mal_value_new_undefined();
        }
        acc = (acc << 6) | (u32) v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out[o++] = (c16) ((acc >> bits) & 0xFF);
        }
    }
    free(cleaned);
    MalValue result = mal_value_from_string(mal_string_new_copy(&vm->heap, out, o));
    free(out);
    return result;
}

/* ---------------------------------------------------------------------------
 * queueMicrotask.
 * --------------------------------------------------------------------------- */

static MalValue mal_web_queue_microtask(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    if (argc < 1 || !mal_value_is_callable(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "queueMicrotask requires a callable");
        return mal_value_new_undefined();
    }
    // A reaction job with no capabilities runs the callback (arg undefined) and
    // discards its result/throw — matching queueMicrotask's fire-and-forget shape.
    mal_vm_enqueue_reaction_job(vm, args[0], false, mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined());
    return mal_value_new_undefined();
}

/* ---------------------------------------------------------------------------
 * performance.
 * --------------------------------------------------------------------------- */

static MalValue mal_web_performance_now(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm;
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    f64 ms = (f64) (mal_monotonic_now_ns() - mal_web_mono_base_ns) / 1.0e6;
    return mal_value_from_f64(ms);
}

/* ---------------------------------------------------------------------------
 * crypto.
 * --------------------------------------------------------------------------- */

static MalValue mal_web_crypto_random_uuid(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    u8 b[16];
    if (mal_host_entropy(b, sizeof(b)) != 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            "crypto.randomUUID: host entropy unavailable");
        return mal_value_new_undefined();
    }
    b[6] = (u8) ((b[6] & 0x0F) | 0x40); // version 4
    b[8] = (u8) ((b[8] & 0x3F) | 0x80); // variant 10xx
    char out[36];
    usize o = 0;
    for (usize i = 0; i < 16; i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10) {
            out[o++] = '-';
        }
        mal_hex_encode_byte_lower((byte) b[i], out + o);
        o += 2;
    }
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, out, o));
}

static MalValue mal_web_crypto_get_random_values(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    if (argc < 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "getRandomValues requires an integer TypedArray");
        return mal_value_new_undefined();
    }
    if (!mal_value_is_typed_array_object(args[0])) {
        mal_dom_exception_throw(vm, "getRandomValues requires an integer TypedArray",
            "TypeMismatchError");
        return mal_value_new_undefined();
    }
    MalTypedArrayObject *ta = mal_value_to_typed_array_object(args[0]);
    if (ta->kind == MAL_TA_FLOAT32 || ta->kind == MAL_TA_FLOAT64) {
        mal_dom_exception_throw(vm,
            "getRandomValues: floating-point TypedArrays are not supported",
            "TypeMismatchError");
        return mal_value_new_undefined();
    }
    // The shared validated path, as every other entropy sink uses: a detached
    // buffer and a view left out of bounds by a resizable buffer both compute a
    // zero byte length, so testing the length alone would silently "succeed"
    // having written nothing and hand back an array the caller believes is
    // random. Refuse instead.
    MalBufferSourceSpan span;
    if (mal_buffer_source_span(args[0], &span) != MAL_BUFFER_SOURCE_SPAN_OK) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "crypto.getRandomValues: detached or out-of-bounds TypedArray");
        return mal_value_new_undefined();
    }
    if (span.length > 65536) {
        mal_dom_exception_throw(vm, "getRandomValues: byteLength exceeds 65536",
            "QuotaExceededError");
        return mal_value_new_undefined();
    }
    if (span.length > 0) {
        if (mal_host_entropy((byte *) span.data, span.length) != 0) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
                "crypto.getRandomValues: host entropy unavailable");
            return mal_value_new_undefined();
        }
    }
    return args[0];
}

/* ---------------------------------------------------------------------------
 * structuredClone: a deep clone honoring circular + shared references.
 * --------------------------------------------------------------------------- */

static bool mal_sc_stage_transfer_list(
    MalVm *vm, MalValue options, MalValue *staged_out) {
    *staged_out = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    if (mal_value_is_undefined(options) || mal_value_is_null(options)) {
        return true;
    }
    if (!mal_value_is_object(options)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "structuredClone options must be an object");
        return false;
    }

    MalValue transfer = mal_value_new_undefined();
    MalRootSpan transfer_span;
    mal_gc_root(&transfer_span, &transfer, 1);
    if (!mal_vm_get_property(vm, options,
            mal_intrinsic_string_key(vm, (const byte *) "transfer"), &transfer)) {
        mal_gc_unroot(&transfer_span);
        return false;
    }
    if (mal_value_is_undefined(transfer)) {
        mal_gc_unroot(&transfer_span);
        return true;
    }
    if (!mal_value_is_object(transfer)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "structuredClone transfer must be iterable");
        mal_gc_unroot(&transfer_span);
        return false;
    }

    MalValue method;
    if (!mal_vm_get_property(vm, transfer,
            mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &method)) {
        mal_gc_unroot(&transfer_span);
        return false;
    }
    MalIteratorRecord record;
    if (!mal_vm_get_iterator_from_method(vm, transfer, method, &record)) {
        mal_gc_unroot(&transfer_span);
        return false;
    }
    MalValue element = mal_value_new_undefined();
    MalRootSpan record_span, element_span;
    mal_gc_root(&record_span, &record.iterator, 2);
    mal_gc_root(&element_span, &element, 1);
    bool ok = false;
    u32 index = 0;
    while (true) {
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &element, &done)) {
            break;
        }
        if (done) {
            ok = true;
            break;
        }
        mal_array_object_store(mal_value_to_array_object(*staged_out),
            mal_key_index(index++), element);
    }
    mal_gc_unroot(&element_span);
    mal_gc_unroot(&record_span);
    mal_gc_unroot(&transfer_span);
    return ok;
}

static bool mal_sc_prepare_transfers(
    MalVm *vm, MalValue staged, MalMapObject *memo) {
    MalArrayObject *values = mal_value_to_array_object(staged);
    u32 length = mal_array_object_length(values);
    for (u32 i = 0; i < length; i++) {
        MalValue value;
        (void) mal_array_object_dense_get(values, i, &value);
        if (!mal_value_is_array_buffer_object(value)) {
            mal_dom_exception_throw(vm,
                "structuredClone: transfer list item is not transferable",
                "DataCloneError");
            return false;
        }
        MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(value);
        if (buffer->detached || buffer->shared || buffer->immutable) {
            mal_dom_exception_throw(vm,
                "structuredClone: ArrayBuffer cannot be transferred",
                "DataCloneError");
            return false;
        }
        for (u32 j = 0; j < i; j++) {
            MalValue prior;
            (void) mal_array_object_dense_get(values, j, &prior);
            if (value == prior) {
                mal_dom_exception_throw(vm,
                    "structuredClone: duplicate transferable", "DataCloneError");
                return false;
            }
        }
    }

    for (u32 i = 0; i < length; i++) {
        MalValue value;
        (void) mal_array_object_dense_get(values, i, &value);
        MalArrayBufferObject *source = mal_value_to_array_buffer_object(value);
        MalArrayBufferObject *destination = mal_array_buffer_object_new(&vm->heap,
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
            source->byte_length, source->byte_length, false, false);
        if (source->byte_length > 0 && destination->data == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        destination->sensitive = source->sensitive;
        if (source->byte_length > 0) {
            memcpy(destination->data, source->data, source->byte_length);
        }
        MalValue destination_value =
            mal_value_from_array_buffer_object(destination);
        MalRootSpan destination_span;
        mal_gc_root(&destination_span, &destination_value, 1);
        mal_map_object_set(memo, value, destination_value);
        mal_gc_unroot(&destination_span);
        mal_array_buffer_object_detach(source);
    }
    return true;
}

/* Recursively clone `value`. `memo` maps every original object to its clone
 * (SameValueZero identity), which both resolves circular/shared references and —
 * because it is rooted by the caller and every clone is inserted into it right
 * after allocation — keeps all in-progress clones reachable across the recursion's
 * allocations. Returns the clone, or sets a pending DataCloneError (and returns
 * undefined) for an uncloneable value. */
static MalValue mal_sc_clone(MalVm *vm, MalValue value, MalMapObject *memo) {
    // Primitives pass through; Symbols are not cloneable.
    if (!mal_value_is_object(value)) {
        if (mal_value_is_symbol(value)) {
            mal_dom_exception_throw(
                vm, "structuredClone: a Symbol cannot be cloned", "DataCloneError");
            return mal_value_new_undefined();
        }
        return value;
    }
    if (mal_value_is_callable(value)) {
        mal_dom_exception_throw(
            vm, "structuredClone: a function cannot be cloned", "DataCloneError");
        return mal_value_new_undefined();
    }
    // Already cloned (circular / shared reference).
    if (mal_map_object_has(memo, value)) {
        return mal_map_object_get(memo, value);
    }

    // Date: copy the time value.
    if (mal_value_is_date_object(value)) {
        MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_DATE_PROTOTYPE]);
        MalValue clone = mal_value_from_date_object(
            mal_date_object_new(&vm->heap, proto, mal_value_to_date_object(value)->date_value));
        mal_map_object_set(memo, value, clone);
        return clone;
    }

    // ArrayBuffer: copy the bytes.
    if (mal_value_is_array_buffer_object(value)) {
        MalArrayBufferObject *src = mal_value_to_array_buffer_object(value);
        if (src->detached) {
            mal_dom_exception_throw(
                vm, "structuredClone: a detached ArrayBuffer cannot be cloned", "DataCloneError");
            return mal_value_new_undefined();
        }
        u32 len = src->byte_length;
        MalObject *proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
        MalArrayBufferObject *dst = mal_array_buffer_object_new(&vm->heap, proto, len, len, false, false);
        if (len > 0) {
            memcpy(dst->data, src->data, len);
        }
        MalValue clone = mal_value_from_array_buffer_object(dst);
        mal_map_object_set(memo, value, clone);
        return clone;
    }

    // TypedArray: clone the bytes into a fresh buffer + same-kind view.
    if (mal_value_is_typed_array_object(value)) {
        MalTypedArrayObject *src = mal_value_to_typed_array_object(value);
        MalValue source_buffer = mal_value_from_array_buffer_object(src->buffer);
        if (mal_map_object_has(memo, source_buffer)) {
            MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(
                mal_map_object_get(memo, source_buffer));
            u32 element_size = mal_typed_array_element_size(src->kind);
            u32 count = src->length_tracking
                ? (buffer->byte_length - src->byte_offset) / element_size
                : src->length;
            MalObject *proto = mal_value_to_object(vm->intrinsics[
                MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE + src->kind]);
            MalValue clone = mal_value_from_typed_array_object(
                mal_typed_array_object_new(&vm->heap, proto, buffer, src->kind,
                    src->byte_offset, count, src->length_tracking));
            mal_map_object_set(memo, value, clone);
            return clone;
        }
        if (mal_typed_array_object_is_out_of_bounds(src)) {
            mal_dom_exception_throw(vm,
                "structuredClone: an out-of-bounds TypedArray cannot be cloned",
                "DataCloneError");
            return mal_value_new_undefined();
        }
        u32 count = mal_typed_array_object_length(src);
        u32 byte_len = count * mal_typed_array_element_size(src->kind);
        MalObject *ab_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]);
        MalArrayBufferObject *buf =
            mal_array_buffer_object_new(&vm->heap, ab_proto, byte_len, byte_len, false, false);
        if (byte_len > 0 && src->buffer != nullptr && !src->buffer->detached) {
            memcpy(buf->data, (const byte *) src->buffer->data + src->byte_offset, byte_len);
        }
        MalValue buf_val = mal_value_from_array_buffer_object(buf);
        MalRootSpan rs;
        mal_gc_root(&rs, &buf_val, 1); // survives the view allocation
        MalObject *proto =
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_KIND_PROTOTYPE_BASE + src->kind]);
        MalValue clone = mal_value_from_typed_array_object(
            mal_typed_array_object_new(&vm->heap, proto, buf, src->kind, 0, count, false));
        mal_gc_unroot(&rs);
        mal_map_object_set(memo, value, clone);
        return clone;
    }

    // Array: clone each index (memo before recursing for circular refs).
    if (mal_value_is_array_object(value)) {
        u32 len = mal_array_object_length(mal_value_to_array_object(value));
        MalValue clone = mal_value_from_array_object(mal_intrinsic_new_array(vm, len));
        mal_map_object_set(memo, value, clone);
        MalObject *out = (MalObject *) mal_value_to_array_object(clone);
        for (u32 i = 0; i < len; i++) {
            MalValue element;
            if (!mal_vm_get_property(vm, value, mal_key_index(i), &element)) {
                return mal_value_new_undefined();
            }
            MalValue cloned = mal_sc_clone(vm, element, memo);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
            mal_object_set(out, mal_key_index(i), cloned);
        }
        return clone;
    }

    // Map / Set (not the Weak variants): clone entries.
    if (mal_value_is_map_object(value) || mal_value_is_set_object(value)) {
        MalMapObject *src = mal_value_to_map_object(value);
        if (src->weak) {
            mal_dom_exception_throw(vm,
                "structuredClone: a WeakMap/WeakSet cannot be cloned", "DataCloneError");
            return mal_value_new_undefined();
        }
        bool is_set = mal_value_is_set_object(value);
        MalHeapType type = is_set ? MAL_HEAP_SET_OBJECT : MAL_HEAP_MAP_OBJECT;
        MalObject *proto = mal_value_to_object(
            vm->intrinsics[is_set ? MAL_INTRINSIC_SET_PROTOTYPE : MAL_INTRINSIC_MAP_PROTOTYPE]);
        MalMapObject *dst = mal_map_object_new(&vm->heap, type, proto, false);
        MalValue clone = mal_value_from_map_object(dst);
        mal_map_object_set(memo, value, clone);
        MalTableIter iter;
        mal_table_iter_init(&iter, src->entries, MAL_TABLE_ITER_STORAGE);
        MalKey k;
        void *entry;
        while (mal_table_iter_next(&iter, &k, &entry)) {
            MalValue cloned_key = mal_sc_clone(vm, k.value, memo);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
            if (is_set) {
                mal_map_object_set(dst, cloned_key, cloned_key);
            } else {
                MalValue cloned_val =
                    mal_sc_clone(vm, mal_table_entry_value(src->entries, entry), memo);
                if (vm->completion.kind == MAL_COMPLETION_THROW) {
                    return mal_value_new_undefined();
                }
                mal_map_object_set(dst, cloned_key, cloned_val);
            }
        }
        return clone;
    }

    // Ordinary object: clone own enumerable string-keyed properties into a plain
    // object (its [[Prototype]] becomes %Object.prototype%, per structuredClone).
    if (mal_value_heap_type(value) == MAL_HEAP_OBJECT) {
        MalValue clone = mal_value_from_object(mal_intrinsic_new_object(vm));
        mal_map_object_set(memo, value, clone);
        MalObject *out = mal_value_to_object(clone);

        usize key_count = 0;
        MalPropertyIter iter;
        mal_property_iter_init(
            &iter, mal_value_to_object(value), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            if (key.kind != MAL_KEY_STRING) {
                continue;
            }
            if (!mal_checked_size_add(key_count, 1, INT32_MAX, &key_count)) {
                mal_vm_throw_allocation_error(vm);
                return mal_value_new_undefined();
            }
        }

        usize allocation_count = key_count == 0 ? 1 : key_count;
        usize keys_size;
        usize roots_size;
        if (!mal_checked_size_multiply(
                allocation_count, sizeof(MalKey), SIZE_MAX, &keys_size)
            || !mal_checked_size_multiply(
                allocation_count, sizeof(MalValue), SIZE_MAX, &roots_size)) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        MalKey *keys = malloc(keys_size);
        if (keys == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        MalValue *key_roots = malloc(roots_size);
        if (key_roots == nullptr) {
            free(keys);
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        mal_property_iter_init(
            &iter, mal_value_to_object(value), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
        usize key_index = 0;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            if (key.kind == MAL_KEY_STRING) {
                keys[key_index] = key;
                key_roots[key_index++] = key.value;
            }
        }

        MalValue property_value = mal_value_new_undefined();
        MalRootSpan key_span;
        MalRootSpan value_span;
        mal_gc_root(&key_span, key_roots, (i32) key_count);
        mal_gc_root(&value_span, &property_value, 1);
        for (usize i = 0; i < key_count; i++) {
            MalPropertyLookup own = mal_object_get_own(mal_value_to_object(value), keys[i]);
            if (!own.present) {
                continue;
            }
            if (!mal_vm_get_property(vm, value, keys[i], &property_value)) {
                break;
            }
            MalValue cloned = mal_sc_clone(vm, property_value, memo);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                break;
            }
            mal_object_set(out, keys[i], cloned);
        }
        mal_gc_unroot(&value_span);
        mal_gc_unroot(&key_span);
        free(key_roots);
        free(keys);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
        return clone;
    }

    // Everything else (Promise, Proxy, boxed primitives, ...) is not
    // structured-cloneable in this v1.
    mal_dom_exception_throw(
        vm, "structuredClone: value could not be cloned", "DataCloneError");
    return mal_value_new_undefined();
}

static MalValue mal_web_structured_clone(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    if (argc < 1) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "structuredClone requires an argument");
        return mal_value_new_undefined();
    }
    MalValue roots[3] = {
        args[0], mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 3);
    if (!mal_sc_stage_transfer_list(vm,
            argc >= 2 ? args[1] : mal_value_new_undefined(), &roots[1])) {
        mal_gc_unroot(&roots_span);
        return mal_value_new_undefined();
    }
    MalObject *map_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_MAP_PROTOTYPE]);
    MalMapObject *memo = mal_map_object_new(&vm->heap, MAL_HEAP_MAP_OBJECT, map_proto, false);
    roots[2] = mal_value_from_map_object(memo);
    if (!mal_sc_prepare_transfers(vm, roots[1], memo)) {
        mal_gc_unroot(&roots_span);
        return mal_value_new_undefined();
    }
    MalValue result = mal_sc_clone(vm, roots[0], memo);
    mal_gc_unroot(&roots_span);
    return result;
}

/* ---------------------------------------------------------------------------
 * Installation.
 * --------------------------------------------------------------------------- */

void mal_structured_clone_global_install(MalVm *vm, MalObject *global_this) {
    mal_intrinsic_define_method_n(vm, global_this, (const byte *) "structuredClone", 1,
        mal_web_structured_clone);
}

void mal_text_encoding_globals_install(MalVm *vm, MalObject *global_this) {
    MalObject *enc_proto =
        mal_web_install_class(vm, global_this, (const byte *) "TextEncoder", 0,
            mal_web_text_encoder_ctor, "utf-8");
    mal_intrinsic_define_method_n(vm, enc_proto, (const byte *) "encode", 1,
        mal_web_text_encoder_encode);
    mal_intrinsic_define_method_n(vm, enc_proto, (const byte *) "encodeInto", 2,
        mal_web_text_encoder_encode_into);

    // TextDecoder carries its per-instance fatal/ignoreBOM options through a
    // private brand symbol placed in every function's slot 0; the constructor
    // stamps the packed flags onto the instance under that key and the decode
    // method plus the fatal/ignoreBOM getters read them back. This is why it is
    // wired by hand rather than via mal_web_install_class.
    MalObject *obj_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalValue dec_brand = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    MalObject *dec_proto = mal_object_new(&vm->heap, obj_proto);
    MalNativeFunctionObject *dec_ctor = mal_web_branded_function(
        vm, (const byte *) "TextDecoder", 0, mal_web_text_decoder_ctor, dec_brand);
    mal_native_function_object_set_constructor(dec_ctor);
    mal_intrinsic_define_data(vm, (MalObject *) dec_ctor, (const byte *) "prototype",
        mal_value_from_object(dec_proto), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, dec_proto, (const byte *) "constructor",
        mal_value_from_native_function_object(dec_ctor),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_web_define_branded_method(vm, dec_proto, (const byte *) "decode", 1,
        mal_web_text_decoder_decode, dec_brand);
    mal_web_define_branded_getter(vm, dec_proto, (const byte *) "encoding",
        mal_web_text_decoder_get_encoding, dec_brand);
    mal_web_define_branded_getter(vm, dec_proto, (const byte *) "fatal",
        mal_web_text_decoder_get_fatal, dec_brand);
    mal_web_define_branded_getter(vm, dec_proto, (const byte *) "ignoreBOM",
        mal_web_text_decoder_get_ignore_bom, dec_brand);
    mal_intrinsic_define_data(vm, global_this, (const byte *) "TextDecoder",
        mal_value_from_native_function_object(dec_ctor),
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

void mal_web_globals_install(MalVm *vm, MalObject *global_this) {
    mal_web_mono_base_ns = mal_monotonic_now_ns();
    struct timespec rt;
    clock_gettime(CLOCK_REALTIME, &rt);
    mal_web_time_origin_ms = (f64) rt.tv_sec * 1000.0 + (f64) rt.tv_nsec / 1.0e6;

    mal_text_encoding_globals_install(vm, global_this);

    // btoa / atob.
    mal_intrinsic_define_method_n(vm, global_this, (const byte *) "btoa", 1, mal_web_btoa);
    mal_intrinsic_define_method_n(vm, global_this, (const byte *) "atob", 1, mal_web_atob);

    // queueMicrotask.
    mal_intrinsic_define_method_n(vm, global_this, (const byte *) "queueMicrotask", 1,
        mal_web_queue_microtask);

    mal_structured_clone_global_install(vm, global_this);

    // performance (now / timeOrigin).
    MalObject *event_target_proto =
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_EVENT_TARGET_PROTOTYPE]);
    MalEventTargetObject *performance_target =
        mal_event_target_object_new(&vm->heap, event_target_proto);
    MalValue performance_value = mal_value_from_event_target_object(performance_target);
    MalRootSpan performance_root;
    mal_gc_root(&performance_root, &performance_value, 1);
    MalObject *performance = &performance_target->object;
    mal_intrinsic_define_method_n(vm, performance, (const byte *) "now", 0, mal_web_performance_now);
    mal_intrinsic_define_data(vm, performance, (const byte *) "timeOrigin",
        mal_value_from_f64(mal_web_time_origin_ms), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, global_this, (const byte *) "performance",
        performance_value,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_gc_unroot(&performance_root);

    // crypto (randomUUID / getRandomValues). This program already links the
    // entropy boundary, so Math.random's generator can be seeded from it rather
    // than from process divergence. Math.random remains non-cryptographic; see
    // builtin_math.h.
    mal_builtin_math_set_seed_source(mal_host_entropy);
    MalObject *crypto = mal_intrinsic_new_object(vm);
    mal_intrinsic_define_method_n(vm, crypto, (const byte *) "randomUUID", 0,
        mal_web_crypto_random_uuid);
    mal_intrinsic_define_method_n(vm, crypto, (const byte *) "getRandomValues", 1,
        mal_web_crypto_get_random_values);
    mal_intrinsic_define_data(vm, global_this, (const byte *) "crypto",
        mal_value_from_object(crypto), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}
