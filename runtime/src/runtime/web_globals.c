#include "web_globals.h"

#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "array_buffer_object.h"
#include "array_object.h"
#include "date_object.h"
#include "function_object.h"
#include "gc.h"
#include "heap.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "map_object.h"
#include "microtask.h"
#include "object.h"
#include "object_ops.h"
#include "property_iter.h"
#include "property_store.h"
#include "table.h"
#include "text_encoding.h"
#include "typed_array_object.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/* Monotonic + wall-clock baselines captured at install (single host isolate for
 * now; per-isolate storage is a Phase-4/SMP follow-up). */
static f64 mal_web_time_origin_ms = 0;   // wall-clock ms at install (performance.timeOrigin)
static u64 mal_web_mono_base_ns = 0;     // CLOCK_MONOTONIC ns at install

static u64 mal_web_mono_ns(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (u64) ts.tv_sec * 1000000000ull + (u64) ts.tv_nsec;
}

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

/* Extract the byte range of a BufferSource (TypedArray or ArrayBuffer). Returns
 * false for anything else. DataView is a follow-up (its struct is private). */
static bool mal_web_buffer_source(MalValue v, const byte **out, usize *out_len) {
    if (mal_value_is_typed_array_object(v)) {
        MalTypedArrayObject *ta = mal_value_to_typed_array_object(v);
        if (ta->buffer == nullptr) {
            *out = nullptr;
            *out_len = 0;
            return true;
        }
        *out = (const byte *) ta->buffer->data + ta->byte_offset;
        *out_len = mal_typed_array_object_byte_length(ta);
        return true;
    }
    if (mal_value_is_array_buffer_object(v)) {
        MalArrayBufferObject *ab = mal_value_to_array_buffer_object(v);
        *out = (const byte *) ab->data;
        *out_len = ab->detached ? 0 : ab->byte_length;
        return true;
    }
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
    byte *bytes = mal_utf8_encode(mal_string_code_units(str), mal_string_length(str), &out_len);
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
    byte *dst = ta->buffer != nullptr ? (byte *) ta->buffer->data + ta->byte_offset : nullptr;
    usize cap = mal_typed_array_object_byte_length(ta);

    const c16 *u = mal_string_code_units(str);
    usize len = mal_string_length(str);
    usize read = 0;
    usize written = 0;
    for (usize i = 0; i < len;) {
        u32 cp = u[i];
        usize adv = 1;
        if (cp >= 0xD800 && cp <= 0xDBFF) {
            if (i + 1 < len && u[i + 1] >= 0xDC00 && u[i + 1] <= 0xDFFF) {
                cp = 0x10000 + ((cp - 0xD800) << 10) + (u[i + 1] - 0xDC00);
                adv = 2;
            } else {
                cp = 0xFFFD;
            }
        } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
            cp = 0xFFFD;
        }
        usize n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
        if (written + n > cap) {
            break;
        }
        if (cp < 0x80) {
            dst[written] = (byte) cp;
        } else if (cp < 0x800) {
            dst[written] = (byte) (0xC0 | (cp >> 6));
            dst[written + 1] = (byte) (0x80 | (cp & 0x3F));
        } else if (cp < 0x10000) {
            dst[written] = (byte) (0xE0 | (cp >> 12));
            dst[written + 1] = (byte) (0x80 | ((cp >> 6) & 0x3F));
            dst[written + 2] = (byte) (0x80 | (cp & 0x3F));
        } else {
            dst[written] = (byte) (0xF0 | (cp >> 18));
            dst[written + 1] = (byte) (0x80 | ((cp >> 12) & 0x3F));
            dst[written + 2] = (byte) (0x80 | ((cp >> 6) & 0x3F));
            dst[written + 3] = (byte) (0x80 | (cp & 0x3F));
        }
        written += n;
        read += adv;
        i += adv;
    }

    MalObject *result = mal_intrinsic_new_object(vm);
    mal_object_set(result, mal_intrinsic_string_key(vm, (const byte *) "read"),
        mal_value_from_f64((f64) read));
    mal_object_set(result, mal_intrinsic_string_key(vm, (const byte *) "written"),
        mal_value_from_f64((f64) written));
    return mal_value_from_object(result);
}

/* Recognize the UTF-8 encoding labels we support (case-insensitive). */
static bool mal_web_is_utf8_label(const MalString *s) {
    static const char *aliases[] = {"utf-8", "utf8", "unicode-1-1-utf-8", "unicode11utf8",
        "unicode20utf8", "x-unicode20utf8"};
    usize len = mal_string_length(s);
    const c16 *u = mal_string_code_units(s);
    for (usize a = 0; a < countof(aliases); a++) {
        const char *alias = aliases[a];
        usize alen = strlen(alias);
        // WHATWG strips leading/trailing ASCII whitespace before matching.
        usize start = 0;
        usize end = len;
        while (start < end && (u[start] == ' ' || u[start] == '\t' || u[start] == '\n'
                                  || u[start] == '\r' || u[start] == '\f')) {
            start++;
        }
        while (end > start && (u[end - 1] == ' ' || u[end - 1] == '\t' || u[end - 1] == '\n'
                                  || u[end - 1] == '\r' || u[end - 1] == '\f')) {
            end--;
        }
        if (end - start != alen) {
            continue;
        }
        bool eq = true;
        for (usize i = 0; i < alen; i++) {
            c16 x = u[start + i];
            if (x >= 'A' && x <= 'Z') {
                x = (c16) (x + 32);
            }
            if (x != (c16) (unsigned char) alias[i]) {
                eq = false;
                break;
            }
        }
        if (eq) {
            return true;
        }
    }
    return false;
}

static MalValue mal_web_text_decoder_ctor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) callee;
    // Only UTF-8 is supported; a recognized non-UTF-8 label is a RangeError, and
    // options (fatal/ignoreBOM) are accepted-and-ignored for v1.
    if (argc >= 1 && !mal_value_is_undefined(args[0])) {
        MalString *label;
        if (!mal_vm_to_string(vm, args[0], &label)) {
            return mal_value_new_undefined();
        }
        if (!mal_web_is_utf8_label(label)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
                "TextDecoder: only the 'utf-8' encoding is supported");
            return mal_value_new_undefined();
        }
    }
    (void) this_value;
    return mal_value_from_object(mal_web_ordinary_instance(vm, nt));
}

static MalValue mal_web_text_decoder_decode(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    if (argc < 1 || mal_value_is_undefined(args[0])) {
        return mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));
    }
    const byte *bytes;
    usize len;
    if (!mal_web_buffer_source(args[0], &bytes, &len)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "decode input must be an ArrayBuffer or TypedArray");
        return mal_value_new_undefined();
    }
    // Skip a leading UTF-8 BOM (ignoreBOM defaults to false).
    if (len >= 3 && (u8) bytes[0] == 0xEF && (u8) bytes[1] == 0xBB && (u8) bytes[2] == 0xBF) {
        bytes += 3;
        len -= 3;
    }
    usize count;
    c16 *units = mal_utf8_decode(bytes, len, &count);
    MalValue s = mal_value_from_string(mal_string_new_copy(&vm->heap, units, count));
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

/* ---------------------------------------------------------------------------
 * btoa / atob (base64 over a Latin-1 "binary string").
 * --------------------------------------------------------------------------- */

static const char mal_b64_enc[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

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
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "btoa: string contains a character outside the Latin1 range");
            return mal_value_new_undefined();
        }
    }
    usize groups;
    usize out_len;
    if (!mal_checked_size_add(n, 2, SIZE_MAX, &groups) ||
        !mal_checked_size_multiply(groups / 3, 4, MAL_STRING_MAX_CODE_UNITS, &out_len)) {
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
        u32 b0 = (u8) u[i];
        u32 b1 = i + 1 < n ? (u8) u[i + 1] : 0;
        u32 b2 = i + 2 < n ? (u8) u[i + 2] : 0;
        u32 triple = (b0 << 16) | (b1 << 8) | b2;
        out[o++] = (c16) (u8) mal_b64_enc[(triple >> 18) & 0x3F];
        out[o++] = (c16) (u8) mal_b64_enc[(triple >> 12) & 0x3F];
        out[o++] = i + 1 < n ? (c16) (u8) mal_b64_enc[(triple >> 6) & 0x3F] : '=';
        out[o++] = i + 2 < n ? (c16) (u8) mal_b64_enc[triple & 0x3F] : '=';
    }
    MalValue result = mal_value_from_string(mal_string_new_copy(&vm->heap, out, o));
    free(out);
    return result;
}

static i32 mal_b64_val(c16 c) {
    if (c >= 'A' && c <= 'Z') {
        return c - 'A';
    }
    if (c >= 'a' && c <= 'z') {
        return c - 'a' + 26;
    }
    if (c >= '0' && c <= '9') {
        return c - '0' + 52;
    }
    if (c == '+') {
        return 62;
    }
    if (c == '/') {
        return 63;
    }
    return -1;
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
        if (c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f') {
            continue;
        }
        cleaned[m++] = c;
    }
    // Drop up to two trailing '=' pads, then require a valid length.
    usize pad = 0;
    while (pad < 2 && m > 0 && cleaned[m - 1] == '=') {
        m--;
        pad++;
    }
    if (m % 4 == 1) {
        free(cleaned);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "atob: invalid base64 length");
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
        i32 v = mal_b64_val(cleaned[i]);
        if (v < 0) {
            free(cleaned);
            free(out);
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "atob: string contains an invalid character");
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
    f64 ms = (f64) (mal_web_mono_ns() - mal_web_mono_base_ns) / 1.0e6;
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
    arc4random_buf(b, sizeof(b));
    b[6] = (u8) ((b[6] & 0x0F) | 0x40); // version 4
    b[8] = (u8) ((b[8] & 0x3F) | 0x80); // variant 10xx
    static const char hex[] = "0123456789abcdef";
    char out[36];
    usize o = 0;
    for (usize i = 0; i < 16; i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10) {
            out[o++] = '-';
        }
        out[o++] = hex[b[i] >> 4];
        out[o++] = hex[b[i] & 0x0F];
    }
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, out, o));
}

static MalValue mal_web_crypto_get_random_values(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    if (argc < 1 || !mal_value_is_typed_array_object(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "getRandomValues requires an integer TypedArray");
        return mal_value_new_undefined();
    }
    MalTypedArrayObject *ta = mal_value_to_typed_array_object(args[0]);
    if (ta->kind == MAL_TA_FLOAT32 || ta->kind == MAL_TA_FLOAT64) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "getRandomValues: floating-point TypedArrays are not supported");
        return mal_value_new_undefined();
    }
    u32 byte_len = mal_typed_array_object_byte_length(ta);
    if (byte_len > 65536) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "getRandomValues: byteLength exceeds 65536");
        return mal_value_new_undefined();
    }
    if (byte_len > 0 && ta->buffer != nullptr) {
        arc4random_buf((byte *) ta->buffer->data + ta->byte_offset, byte_len);
    }
    return args[0];
}

/* ---------------------------------------------------------------------------
 * structuredClone: a deep clone honoring circular + shared references.
 * --------------------------------------------------------------------------- */

static MalKey mal_sc_index_key(u32 index) {
    return (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)};
}

/* Recursively clone `value`. `memo` maps every original object to its clone
 * (SameValueZero identity), which both resolves circular/shared references and —
 * because it is rooted by the caller and every clone is inserted into it right
 * after allocation — keeps all in-progress clones reachable across the recursion's
 * allocations. Returns the clone, or sets a pending TypeError (and returns
 * undefined) for an uncloneable value. */
static MalValue mal_sc_clone(MalVm *vm, MalValue value, MalMapObject *memo) {
    // Primitives pass through; Symbols are not cloneable.
    if (!mal_value_is_object(value)) {
        if (mal_value_is_symbol(value)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "structuredClone: a Symbol cannot be cloned");
            return mal_value_new_undefined();
        }
        return value;
    }
    if (mal_value_is_callable(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "structuredClone: a function cannot be cloned");
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
        u32 len = src->detached ? 0 : src->byte_length;
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
            if (!mal_vm_get_property(vm, value, mal_sc_index_key(i), &element)) {
                return mal_value_new_undefined();
            }
            MalValue cloned = mal_sc_clone(vm, element, memo);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
            mal_object_set(out, mal_sc_index_key(i), cloned);
        }
        return clone;
    }

    // Map / Set (not the Weak variants): clone entries.
    if (mal_value_is_map_object(value) || mal_value_is_set_object(value)) {
        MalMapObject *src = mal_value_to_map_object(value);
        if (src->weak) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "structuredClone: a WeakMap/WeakSet cannot be cloned");
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
        MalPropertyIter iter;
        mal_property_iter_init(
            &iter, mal_value_to_object(value), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
        MalKey key;
        MalPropertyDesc desc;
        while (mal_property_iter_next(&iter, &key, &desc)) {
            if (key.kind != MAL_KEY_STRING) {
                continue; // symbol-keyed props are not cloned
            }
            MalValue cloned = mal_sc_clone(vm, desc.value, memo);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
            mal_object_set(out, key, cloned);
        }
        return clone;
    }

    // Everything else (Promise, Proxy, Error, boxed primitives, ...) is not
    // structured-cloneable in this v1.
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "structuredClone: value could not be cloned");
    return mal_value_new_undefined();
}

static MalValue mal_web_structured_clone(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    MalValue input = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalObject *map_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_MAP_PROTOTYPE]);
    MalMapObject *memo = mal_map_object_new(&vm->heap, MAL_HEAP_MAP_OBJECT, map_proto, false);
    MalValue memo_val = mal_value_from_map_object(memo);
    MalRootSpan rs;
    mal_gc_root(&rs, &memo_val, 1);
    MalValue result = mal_sc_clone(vm, input, memo);
    mal_gc_unroot(&rs);
    return result;
}

/* ---------------------------------------------------------------------------
 * Installation.
 * --------------------------------------------------------------------------- */

void mal_web_globals_install(MalVm *vm, MalObject *global_this) {
    mal_web_mono_base_ns = mal_web_mono_ns();
    struct timespec rt;
    clock_gettime(CLOCK_REALTIME, &rt);
    mal_web_time_origin_ms = (f64) rt.tv_sec * 1000.0 + (f64) rt.tv_nsec / 1.0e6;

    // TextEncoder / TextDecoder.
    MalObject *enc_proto =
        mal_web_install_class(vm, global_this, (const byte *) "TextEncoder", 0,
            mal_web_text_encoder_ctor, "utf-8");
    mal_intrinsic_define_method_n(vm, enc_proto, (const byte *) "encode", 1,
        mal_web_text_encoder_encode);
    mal_intrinsic_define_method_n(vm, enc_proto, (const byte *) "encodeInto", 2,
        mal_web_text_encoder_encode_into);

    MalObject *dec_proto =
        mal_web_install_class(vm, global_this, (const byte *) "TextDecoder", 0,
            mal_web_text_decoder_ctor, "utf-8");
    mal_intrinsic_define_method_n(vm, dec_proto, (const byte *) "decode", 1,
        mal_web_text_decoder_decode);

    // btoa / atob.
    mal_intrinsic_define_method_n(vm, global_this, (const byte *) "btoa", 1, mal_web_btoa);
    mal_intrinsic_define_method_n(vm, global_this, (const byte *) "atob", 1, mal_web_atob);

    // queueMicrotask.
    mal_intrinsic_define_method_n(vm, global_this, (const byte *) "queueMicrotask", 1,
        mal_web_queue_microtask);

    // structuredClone.
    mal_intrinsic_define_method_n(vm, global_this, (const byte *) "structuredClone", 1,
        mal_web_structured_clone);

    // performance (now / timeOrigin).
    MalObject *performance = mal_intrinsic_new_object(vm);
    mal_intrinsic_define_method_n(vm, performance, (const byte *) "now", 0, mal_web_performance_now);
    mal_intrinsic_define_data(vm, performance, (const byte *) "timeOrigin",
        mal_value_from_f64(mal_web_time_origin_ms), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, global_this, (const byte *) "performance",
        mal_value_from_object(performance), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    // crypto (randomUUID / getRandomValues).
    MalObject *crypto = mal_intrinsic_new_object(vm);
    mal_intrinsic_define_method_n(vm, crypto, (const byte *) "randomUUID", 0,
        mal_web_crypto_random_uuid);
    mal_intrinsic_define_method_n(vm, crypto, (const byte *) "getRandomValues", 1,
        mal_web_crypto_get_random_values);
    mal_intrinsic_define_data(vm, global_this, (const byte *) "crypto",
        mal_value_from_object(crypto), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}
