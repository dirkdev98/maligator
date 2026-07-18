#include "url_object.h"

#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "builtin_iterator.h"
#include "function_object.h"
#include "gc.h"
#include "heap.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "mal_url.h" // Rust FFI: ada-url handle + component accessors
#include "object.h"
#include "object_ops.h"
#include "property_store.h"
#include "text_encoding.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// The entire URL surface depends on the ada C++ parser (mal_url_* FFI). A
// surface.webPlatform:false build drops ada + the `-lc++` link (Rust `web-platform`
// feature), so this TU must reference no ada symbols — compile it away wholesale.
// URLSearchParams lives here too (pure C, but part of the same web surface).
#if MAL_WEB_PLATFORM

/* ---------------------------------------------------------------------------
 * Shared helpers.
 * --------------------------------------------------------------------------- */

static MalKey url_index_key(u32 index) {
    return (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)};
}

/* Turn an FFI probe-fill (UTF-8) getter into a MalString value. */
typedef int32_t (*MalUrlGetterFn)(void *handle, uint8_t *out, int32_t cap);

static MalValue url_component(MalVm *vm, void *handle, MalUrlGetterFn getter) {
    int32_t len = getter(handle, nullptr, 0);
    if (len <= 0) {
        return mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));
    }
    byte *buf = malloc((usize) len);
    getter(handle, (uint8_t *) buf, len);
    usize count;
    c16 *units = mal_utf8_decode(buf, (usize) len, &count);
    MalValue s = mal_value_from_string(mal_string_new_copy(&vm->heap, units, count));
    free(units);
    free(buf);
    return s;
}

/* OrdinaryCreateFromConstructor: a plain object over new_target.prototype (native
 * ctors receive this=undefined). */
static MalObject *url_instance_proto(MalVm *vm, MalValue new_target, MalIntrinsic fallback) {
    MalObject *proto = mal_value_to_object(vm->intrinsics[fallback]);
    if (mal_value_is_object(new_target)) {
        MalValue p = mal_vm_function_prototype(vm, new_target);
        if (mal_value_is_object(p)) {
            proto = mal_value_to_object(p);
        }
    }
    return proto;
}

/* ---------------------------------------------------------------------------
 * URL object.
 * --------------------------------------------------------------------------- */

static MalUrlObject *url_object_new(MalHeap *heap, MalObject *prototype, void *handle) {
    MalUrlObject *u = mal_heap_alloc(heap, sizeof(MalUrlObject), MAL_HEAP_URL_OBJECT);
    mal_object_init(heap, &u->object, MAL_HEAP_URL_OBJECT, prototype);
    u->handle = handle;
    return u;
}

static void url_finalize(MalHeapHeader *cell) {
    MalUrlObject *u = (MalUrlObject *) cell;
    if (u->handle != nullptr) {
        mal_url_free(u->handle);
        u->handle = nullptr;
    }
}

/* Parse (input, base?) from JS args into an ada handle, or null with a pending
 * TypeError. */
static void *url_parse_args(MalVm *vm, const MalValue *args, i32 argc) {
    MalString *input;
    if (argc < 1 || !mal_vm_to_string(vm, args[0], &input)) {
        if (argc < 1) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "URL requires an argument");
        }
        return nullptr;
    }
    bool has_base = argc >= 2 && !mal_value_is_undefined(args[1]);
    const c16 *base_units = nullptr;
    usize base_len = 0;
    if (has_base) {
        MalString *base;
        if (!mal_vm_to_string(vm, args[1], &base)) {
            return nullptr;
        }
        base_units = mal_string_code_units(base);
        base_len = mal_string_length(base);
    }
    return mal_url_parse(mal_string_code_units(input), mal_string_length(input),
        base_units, base_len, has_base);
}

static MalValue url_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) callee;
    void *handle = url_parse_args(vm, args, argc);
    if (handle == nullptr) {
        if (vm->completion.kind != MAL_COMPLETION_THROW) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid URL");
        }
        return mal_value_new_undefined();
    }
    MalObject *proto = url_instance_proto(vm, nt, MAL_INTRINSIC_URL_PROTOTYPE);
    return mal_value_from_url_object(url_object_new(&vm->heap, proto, handle));
}

static MalValue url_can_parse(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) nt;
    (void) callee;
    MalString *input;
    if (argc < 1 || !mal_vm_to_string(vm, args[0], &input)) {
        return mal_value_new_boolean(false);
    }
    bool has_base = argc >= 2 && !mal_value_is_undefined(args[1]);
    const c16 *base_units = nullptr;
    usize base_len = 0;
    if (has_base) {
        MalString *base;
        if (!mal_vm_to_string(vm, args[1], &base)) {
            return mal_value_new_boolean(false);
        }
        base_units = mal_string_code_units(base);
        base_len = mal_string_length(base);
    }
    return mal_value_new_boolean(mal_url_can_parse(mal_string_code_units(input),
        mal_string_length(input), base_units, base_len, has_base));
}

/* Getter: `get <name>()` returning a URL component. */
#define URL_GETTER(fn, ffi)                                                                      \
    static MalValue fn(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt,    \
        MalValue callee) {                                                                       \
        (void) args;                                                                             \
        (void) argc;                                                                             \
        (void) nt;                                                                               \
        (void) callee;                                                                           \
        if (!mal_value_is_url_object(self)) {                                                    \
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "not a URL");             \
            return mal_value_new_undefined();                                                    \
        }                                                                                        \
        return url_component(vm, mal_value_to_url_object(self)->handle, ffi);                    \
    }

URL_GETTER(url_get_href, mal_url_href)
URL_GETTER(url_get_protocol, mal_url_protocol)
URL_GETTER(url_get_username, mal_url_username)
URL_GETTER(url_get_password, mal_url_password)
URL_GETTER(url_get_host, mal_url_host)
URL_GETTER(url_get_hostname, mal_url_hostname)
URL_GETTER(url_get_port, mal_url_port)
URL_GETTER(url_get_pathname, mal_url_pathname)
URL_GETTER(url_get_search, mal_url_search)
URL_GETTER(url_get_hash, mal_url_hash)
URL_GETTER(url_get_origin, mal_url_origin)

/* Setter taking a plain string (href/protocol). */
#define URL_SETTER_STR(fn, ffi)                                                                  \
    static MalValue fn(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt,    \
        MalValue callee) {                                                                       \
        (void) nt;                                                                               \
        (void) callee;                                                                           \
        if (!mal_value_is_url_object(self)) {                                                    \
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "not a URL");             \
            return mal_value_new_undefined();                                                    \
        }                                                                                        \
        MalString *v;                                                                            \
        if (argc < 1 || !mal_vm_to_string(vm, args[0], &v)) {                                    \
            return mal_value_new_undefined();                                                    \
        }                                                                                        \
        ffi(mal_value_to_url_object(self)->handle, mal_string_code_units(v),                     \
            mal_string_length(v));                                                               \
        return mal_value_new_undefined();                                                        \
    }

URL_SETTER_STR(url_set_href, mal_url_set_href)
URL_SETTER_STR(url_set_protocol, mal_url_set_protocol)

/* Setter taking an optional string; the JS IDL setters are non-nullable, so
 * is_null is always false (an empty string clears via ada's own rules). */
#define URL_SETTER_OPT(fn, ffi)                                                                  \
    static MalValue fn(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt,    \
        MalValue callee) {                                                                       \
        (void) nt;                                                                               \
        (void) callee;                                                                           \
        if (!mal_value_is_url_object(self)) {                                                    \
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "not a URL");             \
            return mal_value_new_undefined();                                                    \
        }                                                                                        \
        MalString *v;                                                                            \
        if (argc < 1 || !mal_vm_to_string(vm, args[0], &v)) {                                    \
            return mal_value_new_undefined();                                                    \
        }                                                                                        \
        ffi(mal_value_to_url_object(self)->handle, mal_string_code_units(v),                     \
            mal_string_length(v), false);                                                        \
        return mal_value_new_undefined();                                                        \
    }

URL_SETTER_OPT(url_set_username, mal_url_set_username)
URL_SETTER_OPT(url_set_password, mal_url_set_password)
URL_SETTER_OPT(url_set_host, mal_url_set_host)
URL_SETTER_OPT(url_set_hostname, mal_url_set_hostname)
URL_SETTER_OPT(url_set_port, mal_url_set_port)
URL_SETTER_OPT(url_set_pathname, mal_url_set_pathname)
URL_SETTER_OPT(url_set_search, mal_url_set_search)
URL_SETTER_OPT(url_set_hash, mal_url_set_hash)

/* toString() / toJSON() == href. */
static MalValue url_to_string(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    return url_get_href(vm, self, args, argc, nt, callee);
}

/* ---------------------------------------------------------------------------
 * URLSearchParams: form-urlencoded model over a MalString pair list.
 * --------------------------------------------------------------------------- */

static MalUrlSearchParamsObject *usp_new(MalHeap *heap, MalObject *prototype) {
    MalUrlSearchParamsObject *p =
        mal_heap_alloc(heap, sizeof(MalUrlSearchParamsObject), MAL_HEAP_URL_SEARCH_PARAMS_OBJECT);
    mal_object_init(heap, &p->object, MAL_HEAP_URL_SEARCH_PARAMS_OBJECT, prototype);
    p->pairs = nullptr;
    p->count = 0;
    p->cap = 0;
    return p;
}

static void usp_finalize(MalHeapHeader *cell) {
    MalUrlSearchParamsObject *p = (MalUrlSearchParamsObject *) cell;
    free(p->pairs);
    p->pairs = nullptr;
    p->count = 0;
    p->cap = 0;
}

static void usp_trace(MalHeapHeader *cell) {
    MalUrlSearchParamsObject *p = (MalUrlSearchParamsObject *) cell;
    for (i32 i = 0; i < p->count; i++) {
        mal_gc_mark_value(mal_value_from_string(p->pairs[i].name));
        mal_gc_mark_value(mal_value_from_string(p->pairs[i].value));
    }
}

static void usp_append(MalUrlSearchParamsObject *p, MalString *name, MalString *value) {
    if (p->count == p->cap) {
        p->cap = p->cap == 0 ? 8 : p->cap * 2;
        p->pairs = realloc(p->pairs, sizeof(MalUspPair) * (usize) p->cap);
    }
    p->pairs[p->count].name = name;
    p->pairs[p->count].value = value;
    p->count++;
    mal_gc_card(&p->object.header, mal_value_from_string(name));
    mal_gc_card(&p->object.header, mal_value_from_string(value));
}

/* Byte helpers for application/x-www-form-urlencoded. */
static int usp_hex_val(byte c) {
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

/* Decode a form-urlencoded token: '+' -> space, %XX -> byte, else literal. */
static byte *usp_form_decode(const byte *in, usize len, usize *out_len) {
    byte *out = malloc(len == 0 ? 1 : len);
    usize o = 0;
    for (usize i = 0; i < len; i++) {
        byte c = in[i];
        if (c == '+') {
            out[o++] = ' ';
        } else if (c == '%' && i + 2 < len) {
            int hi = usp_hex_val(in[i + 1]);
            int lo = usp_hex_val(in[i + 2]);
            if (hi >= 0 && lo >= 0) {
                out[o++] = (byte) (hi * 16 + lo);
                i += 2;
            } else {
                out[o++] = c;
            }
        } else {
            out[o++] = c;
        }
    }
    *out_len = o;
    return out;
}

static MalString *usp_bytes_to_string(MalVm *vm, const byte *bytes, usize len) {
    usize count;
    c16 *units = mal_utf8_decode(bytes, len, &count);
    MalString *s = mal_string_new_copy(&vm->heap, units, count);
    free(units);
    return s;
}

/* Parse a form-urlencoded byte buffer into pairs. */
static void usp_parse_bytes(MalVm *vm, MalUrlSearchParamsObject *p, const byte *bytes, usize len) {
    usize start = 0;
    for (usize i = 0; i <= len; i++) {
        if (i == len || bytes[i] == '&') {
            if (i > start) {
                usize eq = start;
                while (eq < i && bytes[eq] != '=') {
                    eq++;
                }
                const byte *nb = bytes + start;
                usize nlen = eq - start;
                const byte *vb;
                usize vlen;
                if (eq < i) {
                    vb = bytes + eq + 1;
                    vlen = i - eq - 1;
                } else {
                    vb = bytes + i;
                    vlen = 0;
                }
                usize ndl;
                usize vdl;
                byte *nd = usp_form_decode(nb, nlen, &ndl);
                byte *vd = usp_form_decode(vb, vlen, &vdl);
                // Root the name across the value allocation (both are freshly
                // allocated and not yet reachable from the params object).
                MalValue nsv = mal_value_from_string(usp_bytes_to_string(vm, nd, ndl));
                MalRootSpan rs;
                mal_gc_root(&rs, &nsv, 1);
                MalString *vs = usp_bytes_to_string(vm, vd, vdl);
                usp_append(p, mal_value_to_string(nsv), vs);
                mal_gc_unroot(&rs);
                free(nd);
                free(vd);
            }
            start = i + 1;
        }
    }
}

/* Parse a query String (UTF-16), stripping one leading '?'. */
static void usp_parse_string(MalVm *vm, MalUrlSearchParamsObject *p, MalString *query) {
    const c16 *u = mal_string_code_units(query);
    usize len = mal_string_length(query);
    usize off = (len > 0 && u[0] == '?') ? 1 : 0;
    usize blen;
    byte *bytes = mal_utf8_encode(u + off, len - off, &blen);
    usp_parse_bytes(vm, p, bytes, blen);
    free(bytes);
}

static bool usp_to_usv_string(MalVm *vm, MalValue input, MalValue *out) {
    MalString *string;
    if (!mal_vm_to_string(vm, input, &string)) {
        return false;
    }

    usize length = mal_string_length(string);
    const c16 *source = mal_string_code_units(string);
    bool well_formed = true;
    for (usize i = 0; i < length; i++) {
        c16 unit = source[i];
        if (unit >= 0xD800 && unit <= 0xDBFF) {
            if (i + 1 < length && source[i + 1] >= 0xDC00 && source[i + 1] <= 0xDFFF) {
                i++;
            } else {
                well_formed = false;
            }
        } else if (unit >= 0xDC00 && unit <= 0xDFFF) {
            well_formed = false;
        }
    }
    if (well_formed) {
        *out = mal_value_from_string(string);
        return true;
    }

    MalValue source_root = mal_value_from_string(string);
    MalRootSpan source_span;
    mal_gc_root(&source_span, &source_root, 1);
    c16 *units = malloc(sizeof(c16) * (length == 0 ? 1 : length));
    for (usize i = 0; i < length; i++) {
        c16 unit = source[i];
        if (unit >= 0xD800 && unit <= 0xDBFF) {
            if (i + 1 < length && source[i + 1] >= 0xDC00 && source[i + 1] <= 0xDFFF) {
                units[i] = unit;
                units[i + 1] = source[i + 1];
                i++;
            } else {
                units[i] = 0xFFFD;
            }
        } else {
            units[i] = unit >= 0xDC00 && unit <= 0xDFFF ? 0xFFFD : unit;
        }
    }
    *out = mal_value_from_string(mal_string_new_copy(&vm->heap, units, length));
    free(units);
    mal_gc_unroot(&source_span);
    return true;
}

/* Current Web IDL sequence conversion propagates abrupt completions without
 * IteratorClose. Inner sequences are fully converted and staged before the URL
 * constructor enforces its exactly-two-items requirement. */
static bool usp_convert_inner_sequence(MalVm *vm, MalValue input, MalValue *sequence_out) {
    if (!mal_value_is_object(input)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "URLSearchParams pair must be an iterable object");
        return false;
    }

    MalValue method;
    if (!mal_vm_get_property(vm, input,
            mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &method)) {
        return false;
    }
    MalIteratorRecord record;
    if (!mal_vm_get_iterator_from_method(vm, input, method, &record)) {
        return false;
    }

    *sequence_out = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
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
        MalValue converted;
        if (!usp_to_usv_string(vm, element, &converted)) {
            break;
        }
        mal_array_object_store(mal_value_to_array_object(*sequence_out),
            url_index_key(index++), converted);
    }

    mal_gc_unroot(&element_span);
    mal_gc_unroot(&record_span);
    return ok;
}

static bool usp_convert_sequence(
    MalVm *vm, MalValue input, MalValue method, MalValue *sequence_out) {
    MalIteratorRecord record;
    if (!mal_vm_get_iterator_from_method(vm, input, method, &record)) {
        return false;
    }

    *sequence_out = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalValue roots[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan record_span, roots_span;
    mal_gc_root(&record_span, &record.iterator, 2);
    mal_gc_root(&roots_span, roots, 2);

    bool ok = false;
    u32 index = 0;
    while (true) {
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &roots[0], &done)) {
            break;
        }
        if (done) {
            ok = true;
            break;
        }
        roots[1] = mal_value_new_undefined();
        if (!usp_convert_inner_sequence(vm, roots[0], &roots[1])) {
            break;
        }
        mal_array_object_store(mal_value_to_array_object(*sequence_out),
            url_index_key(index++), roots[1]);
    }

    mal_gc_unroot(&roots_span);
    mal_gc_unroot(&record_span);
    return ok;
}

static bool usp_fill_from_sequence(
    MalVm *vm, MalUrlSearchParamsObject *p, MalValue sequence) {
    MalArrayObject *outer = mal_value_to_array_object(sequence);
    for (u32 i = 0; i < mal_array_object_length(outer); i++) {
        MalValue pair_value;
        mal_array_object_dense_get(outer, i, &pair_value);
        MalArrayObject *pair = mal_value_to_array_object(pair_value);
        if (mal_array_object_length(pair) != 2) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "URLSearchParams pair must contain exactly two items");
            return false;
        }
        MalValue name;
        MalValue value;
        mal_array_object_dense_get(pair, 0, &name);
        mal_array_object_dense_get(pair, 1, &value);
        usp_append(p, mal_value_to_string(name), mal_value_to_string(value));
    }
    return true;
}

static bool usp_convert_record(MalVm *vm, MalValue input, MalValue *record_out) {
    *record_out = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    MalValue roots[5] = {
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan roots_span;
    mal_gc_root(&roots_span, roots, 5);
    if (!mal_vm_own_property_keys(vm, input, &roots[0])) {
        mal_gc_unroot(&roots_span);
        return false;
    }

    MalArrayObject *keys = mal_value_to_array_object(roots[0]);
    u32 key_count = mal_array_object_length(keys);
    bool ok = true;
    for (u32 i = 0; i < key_count; i++) {
        mal_array_object_dense_get(keys, i, &roots[1]);
        MalKey key;
        if (!mal_vm_value_to_property_key(vm, roots[1], &key)) {
            ok = false;
            break;
        }
        bool present;
        MalPropertyDesc desc;
        if (!mal_vm_get_own_property(vm, input, key, &present, &desc)) {
            ok = false;
            break;
        }
        if (!present || !(desc.flags & MAL_PROPERTY_ENUMERABLE)) {
            continue;
        }

        // Web IDL converts the record key before Get(O, key).
        if (!usp_to_usv_string(vm, roots[1], &roots[2]) ||
            !mal_vm_get_property(vm, input, key, &roots[3]) ||
            !usp_to_usv_string(vm, roots[3], &roots[3])) {
            ok = false;
            break;
        }

        MalArrayObject *record = mal_value_to_array_object(*record_out);
        bool replaced = false;
        for (u32 j = 0; j < mal_array_object_length(record); j++) {
            MalValue pair_value;
            MalValue prior_key;
            mal_array_object_dense_get(record, j, &pair_value);
            MalArrayObject *pair = mal_value_to_array_object(pair_value);
            mal_array_object_dense_get(pair, 0, &prior_key);
            if (mal_string_equals(
                    mal_value_to_string(prior_key), mal_value_to_string(roots[2]))) {
                mal_array_object_store(pair, url_index_key(1), roots[3]);
                replaced = true;
                break;
            }
        }
        if (replaced) {
            continue;
        }

        roots[4] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 2));
        MalArrayObject *pair = mal_value_to_array_object(roots[4]);
        mal_array_object_store(pair, url_index_key(0), roots[2]);
        mal_array_object_store(pair, url_index_key(1), roots[3]);
        mal_array_object_store(record,
            url_index_key(mal_array_object_length(record)), roots[4]);
    }

    mal_gc_unroot(&roots_span);
    return ok;
}

/* Convert the URLSearchParams constructor union. Object discrimination observes
 * @@iterator once; an absent method selects the existing record arm. */
static bool usp_fill_from_init(MalVm *vm, MalUrlSearchParamsObject *p, MalValue init) {
    if (!mal_value_is_object(init)) {
        MalValue string = mal_value_new_undefined();
        MalRootSpan string_span;
        mal_gc_root(&string_span, &string, 1);
        bool ok = usp_to_usv_string(vm, init, &string);
        if (ok) {
            usp_parse_string(vm, p, mal_value_to_string(string));
        }
        mal_gc_unroot(&string_span);
        return ok;
    }

    MalValue method;
    if (!mal_vm_get_property(vm, init,
            mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &method)) {
        return false;
    }
    if (!mal_value_is_nil(method)) {
        if (!mal_value_is_callable(method)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "URLSearchParams init iterator is not callable");
            return false;
        }
        MalValue sequence = mal_value_new_undefined();
        MalRootSpan sequence_span;
        mal_gc_root(&sequence_span, &sequence, 1);
        bool ok = usp_convert_sequence(vm, init, method, &sequence)
            && usp_fill_from_sequence(vm, p, sequence);
        mal_gc_unroot(&sequence_span);
        return ok;
    }
    MalValue record = mal_value_new_undefined();
    MalRootSpan record_span;
    mal_gc_root(&record_span, &record, 1);
    bool ok = usp_convert_record(vm, init, &record)
        && usp_fill_from_sequence(vm, p, record);
    mal_gc_unroot(&record_span);
    return ok;
}

static MalUrlSearchParamsObject *usp_create(MalVm *vm) {
    return usp_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_URL_SEARCH_PARAMS_PROTOTYPE]));
}

/* Growable UTF-16 output buffer for serialization. */
typedef struct {
    c16 *data;
    usize len;
    usize cap;
} UspOut;

static void usp_out_push(UspOut *o, c16 unit) {
    if (o->len == o->cap) {
        o->cap = o->cap == 0 ? 32 : o->cap * 2;
        o->data = realloc(o->data, sizeof(c16) * o->cap);
    }
    o->data[o->len++] = unit;
}

static bool usp_form_unreserved(byte c) {
    return (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
        || c == '*' || c == '-' || c == '.' || c == '_';
}

/* Append a String, form-urlencoded (space -> '+', unreserved literal, else %XX). */
static void usp_encode_append(UspOut *o, const MalString *s) {
    static const char hex[] = "0123456789ABCDEF";
    usize blen;
    byte *bytes = mal_utf8_encode(mal_string_code_units(s), mal_string_length(s), &blen);
    for (usize i = 0; i < blen; i++) {
        byte c = bytes[i];
        if (c == ' ') {
            usp_out_push(o, '+');
        } else if (usp_form_unreserved(c)) {
            usp_out_push(o, (c16) (u8) c);
        } else {
            usp_out_push(o, '%');
            usp_out_push(o, (c16) (u8) hex[(u8) c >> 4]);
            usp_out_push(o, (c16) (u8) hex[(u8) c & 0x0F]);
        }
    }
    free(bytes);
}

/* Serialize the pair list to an application/x-www-form-urlencoded String. */
static MalValue usp_serialize(MalVm *vm, MalUrlSearchParamsObject *p) {
    UspOut o = {nullptr, 0, 0};
    for (i32 i = 0; i < p->count; i++) {
        if (i > 0) {
            usp_out_push(&o, '&');
        }
        usp_encode_append(&o, p->pairs[i].name);
        usp_out_push(&o, '=');
        usp_encode_append(&o, p->pairs[i].value);
    }
    MalValue result = mal_value_from_string(mal_string_new_copy(&vm->heap, o.data, o.len));
    free(o.data);
    return result;
}

static MalUrlSearchParamsObject *usp_this(MalValue self) {
    return mal_value_is_url_search_params_object(self) ? mal_value_to_url_search_params_object(self)
                                                       : nullptr;
}

static MalUrlSearchParamsObject *usp_this_or_throw(MalVm *vm, MalValue self) {
    MalUrlSearchParamsObject *p = usp_this(self);
    if (p == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "URLSearchParams method called on incompatible receiver");
    }
    return p;
}

static bool usp_require_args(MalVm *vm, i32 argc, i32 required) {
    if (argc >= required) {
        return true;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "Not enough arguments for URLSearchParams method");
    return false;
}

static MalValue usp_ctor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) callee;
    MalObject *proto = url_instance_proto(vm, nt, MAL_INTRINSIC_URL_SEARCH_PARAMS_PROTOTYPE);
    MalUrlSearchParamsObject *p = usp_new(&vm->heap, proto);
    MalValue result = mal_value_from_url_search_params_object(p);
    if (argc >= 1 && !mal_value_is_undefined(args[0])) {
        MalRootSpan rs;
        mal_gc_root(&rs, &result, 1);
        mal_gc_native_rooted_begin(vm);
        usp_fill_from_init(vm, p, args[0]);
        mal_gc_native_rooted_end(vm);
        mal_gc_unroot(&rs);
    }
    return result;
}

static MalValue usp_get(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalUrlSearchParamsObject *p = usp_this_or_throw(vm, self);
    if (p == nullptr || !usp_require_args(vm, argc, 1)) {
        return mal_value_new_undefined();
    }
    MalValue name_value = mal_value_new_undefined();
    MalRootSpan rs;
    mal_gc_root(&rs, &name_value, 1);
    mal_gc_native_rooted_begin(vm);
    bool converted = usp_to_usv_string(vm, args[0], &name_value);
    mal_gc_native_rooted_end(vm);
    if (!converted) {
        mal_gc_unroot(&rs);
        return mal_value_new_undefined();
    }
    MalString *name = mal_value_to_string(name_value);
    for (i32 i = 0; i < p->count; i++) {
        if (mal_string_equals(p->pairs[i].name, name)) {
            MalValue result = mal_value_from_string(p->pairs[i].value);
            mal_gc_unroot(&rs);
            return result;
        }
    }
    mal_gc_unroot(&rs);
    return mal_value_new_null();
}

static MalValue usp_get_all(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalUrlSearchParamsObject *p = usp_this_or_throw(vm, self);
    if (p == nullptr || !usp_require_args(vm, argc, 1)) {
        return mal_value_new_undefined();
    }
    MalValue roots[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 2);
    mal_gc_native_rooted_begin(vm);
    bool converted = usp_to_usv_string(vm, args[0], &roots[0]);
    mal_gc_native_rooted_end(vm);
    if (!converted) {
        mal_gc_unroot(&rs);
        return mal_value_new_undefined();
    }
    MalString *name = mal_value_to_string(roots[0]);
    // Pre-size the array (an index-set does not grow array length), then fill.
    u32 matches = 0;
    for (i32 i = 0; i < p->count; i++) {
        if (mal_string_equals(p->pairs[i].name, name)) {
            matches++;
        }
    }
    roots[1] = mal_value_from_array_object(mal_intrinsic_new_array(vm, matches));
    MalObject *out = (MalObject *) mal_value_to_array_object(roots[1]);
    u32 n = 0;
    for (i32 i = 0; i < p->count; i++) {
        if (mal_string_equals(p->pairs[i].name, name)) {
            mal_object_set(out, url_index_key(n++), mal_value_from_string(p->pairs[i].value));
        }
    }
    MalValue result = roots[1];
    mal_gc_unroot(&rs);
    return result;
}

static MalValue usp_has(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalUrlSearchParamsObject *p = usp_this_or_throw(vm, self);
    if (p == nullptr || !usp_require_args(vm, argc, 1)) {
        return mal_value_new_undefined();
    }
    MalValue roots[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 2);
    mal_gc_native_rooted_begin(vm);
    bool converted = usp_to_usv_string(vm, args[0], &roots[0]);
    if (converted && argc >= 2) {
        converted = usp_to_usv_string(vm, args[1], &roots[1]);
    }
    mal_gc_native_rooted_end(vm);
    if (!converted) {
        mal_gc_unroot(&rs);
        return mal_value_new_undefined();
    }
    MalString *name = mal_value_to_string(roots[0]);
    MalString *value = argc >= 2 ? mal_value_to_string(roots[1]) : nullptr;
    bool found = false;
    for (i32 i = 0; i < p->count; i++) {
        if (mal_string_equals(p->pairs[i].name, name)
            && (value == nullptr || mal_string_equals(p->pairs[i].value, value))) {
            found = true;
            break;
        }
    }
    mal_gc_unroot(&rs);
    return mal_value_new_boolean(found);
}

static MalValue usp_append_method(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalUrlSearchParamsObject *p = usp_this_or_throw(vm, self);
    if (p == nullptr || !usp_require_args(vm, argc, 2)) {
        return mal_value_new_undefined();
    }
    MalValue roots[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 2);
    mal_gc_native_rooted_begin(vm);
    bool converted = usp_to_usv_string(vm, args[0], &roots[0])
        && usp_to_usv_string(vm, args[1], &roots[1]);
    if (converted) {
        usp_append(p, mal_value_to_string(roots[0]), mal_value_to_string(roots[1]));
    }
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&rs);
    if (!converted) {
        return mal_value_new_undefined();
    }
    return mal_value_new_undefined();
}

/* set: replace the first match's value + drop the rest; else append. */
static MalValue usp_set(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalUrlSearchParamsObject *p = usp_this_or_throw(vm, self);
    if (p == nullptr || !usp_require_args(vm, argc, 2)) {
        return mal_value_new_undefined();
    }
    MalValue roots[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 2);
    mal_gc_native_rooted_begin(vm);
    bool converted = usp_to_usv_string(vm, args[0], &roots[0])
        && usp_to_usv_string(vm, args[1], &roots[1]);
    if (!converted) {
        mal_gc_native_rooted_end(vm);
        mal_gc_unroot(&rs);
        return mal_value_new_undefined();
    }
    MalString *name = mal_value_to_string(roots[0]);
    MalString *value = mal_value_to_string(roots[1]);
    i32 first = -1;
    i32 w = 0;
    for (i32 i = 0; i < p->count; i++) {
        if (mal_string_equals(p->pairs[i].name, name)) {
            mal_gc_write_barrier(mal_value_from_string(p->pairs[i].name));
            mal_gc_write_barrier(mal_value_from_string(p->pairs[i].value));
            if (first < 0) {
                first = w;
                if (w != i) {
                    mal_gc_write_barrier(mal_value_from_string(p->pairs[w].name));
                    mal_gc_write_barrier(mal_value_from_string(p->pairs[w].value));
                }
                p->pairs[w].name = name;
                p->pairs[w].value = value;
                mal_gc_card(&p->object.header, mal_value_from_string(name));
                mal_gc_card(&p->object.header, mal_value_from_string(value));
                w++;
            }
            // drop subsequent matches
        } else {
            if (w != i) {
                mal_gc_write_barrier(mal_value_from_string(p->pairs[w].name));
                mal_gc_write_barrier(mal_value_from_string(p->pairs[w].value));
            }
            p->pairs[w++] = p->pairs[i];
            mal_gc_card(&p->object.header, mal_value_from_string(p->pairs[w - 1].name));
            mal_gc_card(&p->object.header, mal_value_from_string(p->pairs[w - 1].value));
        }
    }
    if (first < 0) {
        usp_append(p, name, value);
    } else {
        p->count = w;
    }
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&rs);
    return mal_value_new_undefined();
}

static MalValue usp_delete(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalUrlSearchParamsObject *p = usp_this_or_throw(vm, self);
    if (p == nullptr || !usp_require_args(vm, argc, 1)) {
        return mal_value_new_undefined();
    }
    MalValue roots[2] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 2);
    mal_gc_native_rooted_begin(vm);
    bool converted = usp_to_usv_string(vm, args[0], &roots[0]);
    if (converted && argc >= 2) {
        converted = usp_to_usv_string(vm, args[1], &roots[1]);
    }
    if (!converted) {
        mal_gc_native_rooted_end(vm);
        mal_gc_unroot(&rs);
        return mal_value_new_undefined();
    }
    MalString *name = mal_value_to_string(roots[0]);
    MalString *value = argc >= 2 ? mal_value_to_string(roots[1]) : nullptr;
    i32 w = 0;
    for (i32 i = 0; i < p->count; i++) {
        bool remove = mal_string_equals(p->pairs[i].name, name)
            && (value == nullptr || mal_string_equals(p->pairs[i].value, value));
        if (!remove) {
            if (w != i) {
                mal_gc_write_barrier(mal_value_from_string(p->pairs[w].name));
                mal_gc_write_barrier(mal_value_from_string(p->pairs[w].value));
            }
            p->pairs[w++] = p->pairs[i];
            mal_gc_card(&p->object.header, mal_value_from_string(p->pairs[w - 1].name));
            mal_gc_card(&p->object.header, mal_value_from_string(p->pairs[w - 1].value));
        } else {
            mal_gc_write_barrier(mal_value_from_string(p->pairs[i].name));
            mal_gc_write_barrier(mal_value_from_string(p->pairs[i].value));
        }
    }
    p->count = w;
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&rs);
    return mal_value_new_undefined();
}

/* Stable sort by name (UTF-16 code-unit order); insertion sort keeps same-name
 * pairs in insertion order. */
static MalValue usp_sort(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalUrlSearchParamsObject *p = usp_this_or_throw(vm, self);
    if (p == nullptr) {
        return mal_value_new_undefined();
    }
    for (i32 i = 1; i < p->count; i++) {
        MalUspPair key = p->pairs[i];
        i32 j = i - 1;
        while (j >= 0 && mal_string_compare(p->pairs[j].name, key.name) > 0) {
            p->pairs[j + 1] = p->pairs[j];
            j--;
        }
        p->pairs[j + 1] = key;
    }
    return mal_value_new_undefined();
}

static MalValue usp_to_string(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalUrlSearchParamsObject *p = usp_this_or_throw(vm, self);
    if (p == nullptr) {
        return mal_value_new_undefined();
    }
    return usp_serialize(vm, p);
}

static MalValue usp_for_each(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalUrlSearchParamsObject *p = usp_this_or_throw(vm, self);
    if (p == nullptr || !usp_require_args(vm, argc, 1)) {
        return mal_value_new_undefined();
    }
    if (!mal_value_is_callable(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "URLSearchParams forEach callback is not callable");
        return mal_value_new_undefined();
    }
    MalValue cb = args[0];
    MalValue this_arg = argc >= 2 ? args[1] : mal_value_new_undefined();
    // Re-read p->pairs each step (the callback may mutate the list).
    for (i32 i = 0; i < p->count; i++) {
        MalValue call_args[3] = {
            mal_value_from_string(p->pairs[i].value),
            mal_value_from_string(p->pairs[i].name),
            self,
        };
        mal_vm_call_value(vm, cb, this_arg, call_args, 3);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
    }
    return mal_value_new_undefined();
}

/* Iterator kinds for entries/keys/values. */
typedef enum { USP_ENTRIES, USP_KEYS, USP_VALUES } UspIterKind;

/* Build a snapshot Array (of [k,v] pairs / keys / values) and return its iterator,
 * reusing the Array iterator rather than a bespoke iterator object. */
static MalValue usp_make_iterator(MalVm *vm, MalUrlSearchParamsObject *p, UspIterKind kind) {
    // Pre-size the snapshot (an index-set does not grow array length).
    MalValue arr_val = mal_value_from_array_object(mal_intrinsic_new_array(vm, (u32) p->count));
    MalRootSpan rs;
    mal_gc_root(&rs, &arr_val, 1);
    MalObject *arr = (MalObject *) mal_value_to_array_object(arr_val);
    for (i32 i = 0; i < p->count; i++) {
        if (kind == USP_ENTRIES) {
            // The [key, value] sub-array is unreachable until stored in arr, so root
            // it across its own element fills.
            MalValue pair_val = mal_value_from_array_object(mal_intrinsic_new_array(vm, 2));
            MalRootSpan prs;
            mal_gc_root(&prs, &pair_val, 1);
            MalObject *pair = (MalObject *) mal_value_to_array_object(pair_val);
            mal_object_set(pair, url_index_key(0), mal_value_from_string(p->pairs[i].name));
            mal_object_set(pair, url_index_key(1), mal_value_from_string(p->pairs[i].value));
            mal_object_set(arr, url_index_key((u32) i), pair_val);
            mal_gc_unroot(&prs);
            continue;
        }
        // keys/values: the string is reachable via `p` (rooted through `self`).
        MalValue element = kind == USP_KEYS ? mal_value_from_string(p->pairs[i].name)
                                            : mal_value_from_string(p->pairs[i].value);
        mal_object_set(arr, url_index_key((u32) i), element);
    }
    // Return arr[Symbol.iterator]().
    MalValue iter_fn;
    MalValue iterator = mal_value_new_undefined();
    if (mal_vm_get_property(
            vm, arr_val, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &iter_fn)
        && mal_value_is_callable(iter_fn)) {
        MalCompletion c = mal_vm_call_value(vm, iter_fn, arr_val, nullptr, 0);
        if (c.kind != MAL_COMPLETION_THROW) {
            iterator = c.value;
        }
    }
    mal_gc_unroot(&rs);
    return iterator;
}

#define USP_ITER(fn, kind)                                                                       \
    static MalValue fn(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt,    \
        MalValue callee) {                                                                       \
        (void) args;                                                                             \
        (void) argc;                                                                             \
        (void) nt;                                                                               \
        (void) callee;                                                                           \
        MalUrlSearchParamsObject *p = usp_this_or_throw(vm, self);                               \
        if (p == nullptr) {                                                                       \
            return mal_value_new_undefined();                                                    \
        }                                                                                        \
        return usp_make_iterator(vm, p, kind);                                                   \
    }

USP_ITER(usp_entries, USP_ENTRIES)
USP_ITER(usp_keys, USP_KEYS)
USP_ITER(usp_values, USP_VALUES)

static MalValue usp_get_size(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalUrlSearchParamsObject *p = usp_this_or_throw(vm, self);
    return p != nullptr ? mal_value_from_f64((f64) p->count) : mal_value_new_undefined();
}

/* url.searchParams: a snapshot URLSearchParams parsed from url.search (v1 is not
 * live — write-back to the URL is a follow-up). */
static MalValue url_get_search_params(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    if (!mal_value_is_url_object(self)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "not a URL");
        return mal_value_new_undefined();
    }
    MalValue search = url_component(vm, mal_value_to_url_object(self)->handle, mal_url_search);
    MalRootSpan srs;
    mal_gc_root(&srs, &search, 1); // survives the params-object allocation below
    MalUrlSearchParamsObject *p = usp_create(vm);
    MalValue result = mal_value_from_url_search_params_object(p);
    MalRootSpan rrs;
    mal_gc_root(&rrs, &result, 1);
    usp_parse_string(vm, p, mal_value_to_string(search));
    mal_gc_unroot(&rrs);
    mal_gc_unroot(&srs);
    return result;
}

/* ---------------------------------------------------------------------------
 * Installation (host entry only).
 * --------------------------------------------------------------------------- */

static void url_define_accessor(MalVm *vm, MalObject *proto, const byte *name,
    MalNativeFunctionCallback getter, MalNativeFunctionCallback setter) {
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(
            mal_native_function_object_new(&vm->heap, fn_proto, mal_intrinsic_ascii(vm, name), getter)),
        .setter = setter != nullptr
            ? mal_value_from_native_function_object(mal_native_function_object_new(
                  &vm->heap, fn_proto, mal_intrinsic_ascii(vm, name), setter))
            : mal_value_new_undefined(),
    };
    mal_object_define_own(proto, mal_intrinsic_string_key(vm, name), &desc);
}

void mal_url_install(MalVm *vm, MalObject *global_this) {
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *obj_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);

    // URL constructor + prototype.
    MalObject *url_proto = mal_object_new(&vm->heap, obj_proto);
    MalNativeFunctionObject *url_ctor = mal_native_function_object_new_arity(
        &vm->heap, fn_proto, mal_intrinsic_ascii(vm, (const byte *) "URL"), 1, url_constructor);
    mal_native_function_object_set_constructor(url_ctor);
    vm->intrinsics[MAL_INTRINSIC_URL_CONSTRUCTOR] = mal_value_from_native_function_object(url_ctor);
    vm->intrinsics[MAL_INTRINSIC_URL_PROTOTYPE] = mal_value_from_object(url_proto);
    mal_intrinsic_define_data(vm, (MalObject *) url_ctor, (const byte *) "prototype",
        vm->intrinsics[MAL_INTRINSIC_URL_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, url_proto, (const byte *) "constructor",
        vm->intrinsics[MAL_INTRINSIC_URL_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    url_define_accessor(vm, url_proto, (const byte *) "href", url_get_href, url_set_href);
    url_define_accessor(vm, url_proto, (const byte *) "protocol", url_get_protocol, url_set_protocol);
    url_define_accessor(vm, url_proto, (const byte *) "username", url_get_username, url_set_username);
    url_define_accessor(vm, url_proto, (const byte *) "password", url_get_password, url_set_password);
    url_define_accessor(vm, url_proto, (const byte *) "host", url_get_host, url_set_host);
    url_define_accessor(vm, url_proto, (const byte *) "hostname", url_get_hostname, url_set_hostname);
    url_define_accessor(vm, url_proto, (const byte *) "port", url_get_port, url_set_port);
    url_define_accessor(vm, url_proto, (const byte *) "pathname", url_get_pathname, url_set_pathname);
    url_define_accessor(vm, url_proto, (const byte *) "search", url_get_search, url_set_search);
    url_define_accessor(vm, url_proto, (const byte *) "hash", url_get_hash, url_set_hash);
    url_define_accessor(vm, url_proto, (const byte *) "origin", url_get_origin, nullptr);
    url_define_accessor(vm, url_proto, (const byte *) "searchParams", url_get_search_params, nullptr);
    mal_intrinsic_define_method_n(vm, url_proto, (const byte *) "toString", 0, url_to_string);
    mal_intrinsic_define_method_n(vm, url_proto, (const byte *) "toJSON", 0, url_to_string);
    mal_intrinsic_define_method_n(vm, (MalObject *) url_ctor, (const byte *) "canParse", 1, url_can_parse);
    mal_intrinsic_define_data(vm, global_this, (const byte *) "URL",
        vm->intrinsics[MAL_INTRINSIC_URL_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    // URLSearchParams constructor + prototype.
    MalObject *usp_proto = mal_object_new(&vm->heap, obj_proto);
    MalNativeFunctionObject *usp_ctor_obj = mal_native_function_object_new_arity(
        &vm->heap, fn_proto, mal_intrinsic_ascii(vm, (const byte *) "URLSearchParams"), 0, usp_ctor);
    mal_native_function_object_set_constructor(usp_ctor_obj);
    vm->intrinsics[MAL_INTRINSIC_URL_SEARCH_PARAMS_CONSTRUCTOR] =
        mal_value_from_native_function_object(usp_ctor_obj);
    vm->intrinsics[MAL_INTRINSIC_URL_SEARCH_PARAMS_PROTOTYPE] = mal_value_from_object(usp_proto);
    mal_intrinsic_define_data(vm, (MalObject *) usp_ctor_obj, (const byte *) "prototype",
        vm->intrinsics[MAL_INTRINSIC_URL_SEARCH_PARAMS_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, usp_proto, (const byte *) "constructor",
        vm->intrinsics[MAL_INTRINSIC_URL_SEARCH_PARAMS_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_method_n(vm, usp_proto, (const byte *) "get", 1, usp_get);
    mal_intrinsic_define_method_n(vm, usp_proto, (const byte *) "getAll", 1, usp_get_all);
    mal_intrinsic_define_method_n(vm, usp_proto, (const byte *) "has", 1, usp_has);
    mal_intrinsic_define_method_n(vm, usp_proto, (const byte *) "set", 2, usp_set);
    mal_intrinsic_define_method_n(vm, usp_proto, (const byte *) "append", 2, usp_append_method);
    mal_intrinsic_define_method_n(vm, usp_proto, (const byte *) "delete", 1, usp_delete);
    mal_intrinsic_define_method_n(vm, usp_proto, (const byte *) "sort", 0, usp_sort);
    mal_intrinsic_define_method_n(vm, usp_proto, (const byte *) "toString", 0, usp_to_string);
    mal_intrinsic_define_method_n(vm, usp_proto, (const byte *) "forEach", 1, usp_for_each);
    mal_intrinsic_define_method_n(vm, usp_proto, (const byte *) "entries", 0, usp_entries);
    mal_intrinsic_define_method_n(vm, usp_proto, (const byte *) "keys", 0, usp_keys);
    MalValue values_fn =
        mal_intrinsic_define_method_n(vm, usp_proto, (const byte *) "values", 0, usp_values);
    url_define_accessor(vm, usp_proto, (const byte *) "size", usp_get_size, nullptr);

    // [Symbol.iterator] === entries.
    MalValue entries_fn;
    if (mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_URL_SEARCH_PARAMS_PROTOTYPE],
            mal_intrinsic_string_key(vm, (const byte *) "entries"), &entries_fn)) {
        MalPropertyDesc desc =
            mal_intrinsic_data_desc(entries_fn, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_object_define_own(
            usp_proto, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &desc);
    }
    (void) values_fn;

    mal_intrinsic_define_data(vm, global_this, (const byte *) "URLSearchParams",
        vm->intrinsics[MAL_INTRINSIC_URL_SEARCH_PARAMS_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    // GC hooks.
    mal_gc_register_finalizer(MAL_HEAP_URL_OBJECT, url_finalize);
    mal_gc_register_finalizer(MAL_HEAP_URL_SEARCH_PARAMS_OBJECT, usp_finalize);
    mal_gc_register_tracer(MAL_HEAP_URL_SEARCH_PARAMS_OBJECT, usp_trace);
}

#endif // MAL_WEB_PLATFORM
