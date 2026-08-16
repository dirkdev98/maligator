#include "web_headers_object.h"

#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "builtin_iterator.h"
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "property_store.h"
#include "profile.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static bool mal_headers_token_unit(c16 unit) {
    return (unit >= '0' && unit <= '9') || (unit >= 'A' && unit <= 'Z')
        || (unit >= 'a' && unit <= 'z') || unit == '!' || unit == '#' || unit == '$'
        || unit == '%' || unit == '&' || unit == '\'' || unit == '*' || unit == '+'
        || unit == '-' || unit == '.' || unit == '^' || unit == '_' || unit == '`'
        || unit == '|' || unit == '~';
}

static bool mal_headers_validate_name(MalVm *vm, const MalString *name) {
    usize len = mal_string_length(name);
    const c16 *units = mal_string_code_units(name);
    if (len == 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid header name");
        return false;
    }
    for (usize i = 0; i < len; i++) {
        if (!mal_headers_token_unit(units[i])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid header name");
            return false;
        }
    }
    return true;
}

static bool mal_headers_validate_value(MalVm *vm, const MalString *value) {
    usize len = mal_string_length(value);
    const c16 *units = mal_string_code_units(value);
    for (usize i = 0; i < len; i++) {
        if (units[i] > 0xFF || units[i] == 0 || units[i] == '\r' || units[i] == '\n') {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Invalid header value");
            return false;
        }
    }
    return true;
}

static MalString *mal_headers_lowercase_name(MalVm *vm, const MalString *name) {
    usize len = mal_string_length(name);
    const c16 *units = mal_string_code_units(name);
    // Heap-owned rather than malloc'd: mal_heap_alloc_raw cannot return null, so
    // there is no allocation-failure path to leave the buffer unwritten.
    c16 *out = mal_heap_alloc_raw_profiled(
        &vm->heap, sizeof(c16) * (len == 0 ? 1 : len),
        MAL_PROFILE_ALLOCATION_FAMILY_HOST);
    for (usize i = 0; i < len; i++) {
        c16 unit = units[i];
        out[i] = unit >= 'A' && unit <= 'Z' ? (c16) (unit + ('a' - 'A')) : unit;
    }
    return mal_string_new_owned(&vm->heap, out, len);
}

static MalString *mal_headers_trim_value(MalVm *vm, const MalString *value) {
    const c16 *units = mal_string_code_units(value);
    usize start = 0;
    usize end = mal_string_length(value);
    while (start < end
        && (units[start] == ' ' || units[start] == '\t' || units[start] == '\r'
            || units[start] == '\n')) {
        start++;
    }
    while (end > start
        && (units[end - 1] == ' ' || units[end - 1] == '\t' || units[end - 1] == '\r'
            || units[end - 1] == '\n')) {
        end--;
    }
    return mal_string_new_copy(&vm->heap, units + start, end - start);
}

MalHeadersObject *mal_headers_object_new(MalHeap *heap, MalObject *prototype) {
    MalHeadersObject *h = mal_heap_alloc(heap, sizeof(MalHeadersObject), MAL_HEAP_HEADERS_OBJECT);
    mal_object_init(heap, &h->object, MAL_HEAP_HEADERS_OBJECT, prototype);
    h->entries = nullptr;
    h->count = 0;
    h->cap = 0;
    h->guard = MAL_HEADERS_GUARD_NONE;
    return h;
}

MalHeadersObject *mal_headers_create(MalVm *vm) {
    return mal_headers_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_HEADERS_PROTOTYPE]));
}

MalString *mal_headers_new_lowercase_name(
    MalVm *vm, const char *name, usize name_len) {
    c16 *units = mal_heap_alloc_raw_profiled(
        &vm->heap, sizeof(c16) * (name_len == 0 ? 1 : name_len),
        MAL_PROFILE_ALLOCATION_FAMILY_HOST);
    for (usize i = 0; i < name_len; i++) {
        u8 unit = (u8) name[i];
        units[i] = unit >= 'A' && unit <= 'Z'
            ? (c16) (unit + ('a' - 'A')) : (c16) unit;
    }
    return mal_string_new_owned(&vm->heap, units, name_len);
}

static bool mal_headers_name_equals_bytes_ci(
    const MalString *name, const char *bytes, usize length) {
    if (mal_string_length(name) != length) return false;
    const c16 *units = mal_string_code_units(name);
    for (usize i = 0; i < length; i++) {
        u8 unit = (u8) bytes[i];
        c16 lower = unit >= 'A' && unit <= 'Z'
            ? (c16) (unit + ('a' - 'A')) : (c16) unit;
        if (units[i] != lower) return false;
    }
    return true;
}

bool mal_headers_append_entry(MalHeadersObject *h, MalString *name, MalString *value) {
    if (h->count == h->cap) {
        // Grow into a temporary: committing cap before the realloc would leave the
        // list claiming capacity it does not have when the allocation fails.
        i32 cap = h->cap == 0 ? 8 : h->cap * 2;
        MalHeaderEntry *entries =
            realloc(h->entries, sizeof(MalHeaderEntry) * (usize) cap);
        if (entries == nullptr) return false;
        h->entries = entries;
        h->cap = cap;
    }
    h->entries[h->count].name = name;
    h->entries[h->count].value = value;
    h->count++;
    mal_gc_card(&h->object.header, mal_value_from_string(name));
    mal_gc_card(&h->object.header, mal_value_from_string(value));
    return true;
}

void mal_headers_append_bytes(
    MalVm *vm, MalHeadersObject *h, const char *name, usize name_len, const char *value,
    usize value_len) {
    usize value_start = 0;
    usize value_end = value_len;
    while (value_start < value_end && (value[value_start] == ' ' || value[value_start] == '\t')) {
        value_start++;
    }
    while (value_end > value_start
        && (value[value_end - 1] == ' ' || value[value_end - 1] == '\t')) {
        value_end--;
    }

    MalValue roots[2] = {
        mal_value_from_headers_object(h),
        mal_value_new_undefined(),
    };
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 2);
    for (i32 i = 0; i < h->count; i++) {
        if (mal_headers_name_equals_bytes_ci(h->entries[i].name, name, name_len)) {
            roots[1] = mal_value_from_string(h->entries[i].name);
            break;
        }
    }
    if (mal_value_is_undefined(roots[1])) {
        roots[1] = mal_value_from_string(
            mal_headers_new_lowercase_name(vm, name, name_len));
    }
    MalString *v = mal_string_new_ascii(&vm->heap, (const byte *) value + value_start,
        value_end - value_start);
    if (!mal_headers_append_entry(h, mal_value_to_string(roots[1]), v)) {
        mal_vm_throw_allocation_error(vm);
    }
    mal_gc_unroot(&rs);
}

static void mal_headers_remove(MalHeadersObject *h, const MalString *name) {
    i32 w = 0;
    for (i32 i = 0; i < h->count; i++) {
        if (!mal_string_equals(h->entries[i].name, name)) {
            h->entries[w++] = h->entries[i];
        } else {
            mal_gc_write_barrier(mal_value_from_string(h->entries[i].name));
            mal_gc_write_barrier(mal_value_from_string(h->entries[i].value));
        }
    }
    h->count = w;
}

static bool mal_headers_normalized_name(
    MalVm *vm, MalValue input, MalValue *name_root, MalString **out) {
    MalString *name;
    if (!mal_vm_to_string(vm, input, &name)) {
        return false;
    }
    *name_root = mal_value_from_string(name);
    if (!mal_headers_validate_name(vm, name)) {
        return false;
    }
    *name_root = mal_value_from_string(mal_headers_lowercase_name(vm, name));
    *out = mal_value_to_string(*name_root);
    return true;
}

static bool mal_headers_can_mutate(MalVm *vm, const MalHeadersObject *h) {
    if (h->guard == MAL_HEADERS_GUARD_IMMUTABLE) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Headers are immutable");
        return false;
    }
    return true;
}

static bool mal_headers_name_is_ascii(const MalString *name, const char *ascii) {
    usize length = strlen(ascii);
    if (mal_string_length(name) != length) return false;
    const c16 *units = mal_string_code_units(name);
    for (usize i = 0; i < length; i++) {
        if (units[i] != (c16) (u8) ascii[i]) return false;
    }
    return true;
}

static bool mal_headers_name_starts_ascii(const MalString *name, const char *ascii) {
    usize length = strlen(ascii);
    if (mal_string_length(name) < length) return false;
    const c16 *units = mal_string_code_units(name);
    for (usize i = 0; i < length; i++) {
        if (units[i] != (c16) (u8) ascii[i]) return false;
    }
    return true;
}

static bool mal_headers_forbidden_request_name(const MalString *name) {
    static const char *const forbidden[] = {"accept-charset", "accept-encoding",
        "access-control-request-headers", "access-control-request-method", "connection",
        "content-length", "cookie", "cookie2", "date", "dnt", "expect", "host",
        "keep-alive", "origin", "referer", "set-cookie", "te",
        "trailer", "transfer-encoding", "upgrade", "via"};
    for (usize i = 0; i < sizeof(forbidden) / sizeof(forbidden[0]); i++) {
        if (mal_headers_name_is_ascii(name, forbidden[i])) return true;
    }
    return mal_headers_name_starts_ascii(name, "proxy-")
        || mal_headers_name_starts_ascii(name, "sec-");
}

static bool mal_headers_value_starts_ascii_ci(
    const MalString *value, const char *ascii) {
    usize prefix = strlen(ascii);
    usize length = mal_string_length(value);
    if (length < prefix) return false;
    const c16 *units = mal_string_code_units(value);
    for (usize i = 0; i < prefix; i++) {
        c16 unit = units[i];
        if (unit >= 'A' && unit <= 'Z') unit = (c16) (unit + ('a' - 'A'));
        if (unit != (c16) (u8) ascii[i]) return false;
    }
    return length == prefix || units[prefix] == ';';
}

static bool mal_headers_no_cors_safelisted(
    const MalString *name, const MalString *value) {
    if (mal_string_length(value) > 128) return false;
    if (mal_headers_name_is_ascii(name, "accept")
        || mal_headers_name_is_ascii(name, "accept-language")
        || mal_headers_name_is_ascii(name, "content-language")) {
        return true;
    }
    if (!mal_headers_name_is_ascii(name, "content-type")) return false;
    return mal_headers_value_starts_ascii_ci(value, "application/x-www-form-urlencoded")
        || mal_headers_value_starts_ascii_ci(value, "multipart/form-data")
        || mal_headers_value_starts_ascii_ci(value, "text/plain");
}

static bool mal_headers_guard_allows(
    const MalHeadersObject *h, const MalString *name, const MalString *value) {
    if ((h->guard == MAL_HEADERS_GUARD_REQUEST
            || h->guard == MAL_HEADERS_GUARD_REQUEST_NO_CORS)
        && mal_headers_forbidden_request_name(name)) {
        return false;
    }
    if (h->guard == MAL_HEADERS_GUARD_REQUEST_NO_CORS
        && !mal_headers_no_cors_safelisted(name, value)) {
        return false;
    }
    if (h->guard == MAL_HEADERS_GUARD_RESPONSE
        && (mal_headers_name_is_ascii(name, "set-cookie")
            || mal_headers_name_is_ascii(name, "set-cookie2"))) {
        return false;
    }
    return true;
}

static bool mal_headers_append_values(
    MalVm *vm, MalHeadersObject *h, MalValue name_input, MalValue value_input) {
    MalValue roots[4] = {
        mal_value_from_headers_object(h),
        name_input,
        value_input,
        mal_value_new_undefined(),
    };
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 4);

    MalString *name;
    if (!mal_headers_normalized_name(vm, roots[1], &roots[3], &name)) {
        mal_gc_unroot(&rs);
        return false;
    }

    MalString *value;
    if (!mal_vm_to_string(vm, roots[2], &value)) {
        mal_gc_unroot(&rs);
        return false;
    }
    roots[2] = mal_value_from_string(value);
    roots[2] = mal_value_from_string(mal_headers_trim_value(vm, value));
    value = mal_value_to_string(roots[2]);
    if (!mal_headers_validate_value(vm, value)) {
        mal_gc_unroot(&rs);
        return false;
    }
    if (!mal_headers_guard_allows(h, name, value)) {
        mal_gc_unroot(&rs);
        return true;
    }
    bool mutable = mal_headers_can_mutate(vm, h);
    if (mutable && !mal_headers_append_entry(h, name, value)) {
        mal_vm_throw_allocation_error(vm);
        mutable = false;
    }
    mal_gc_unroot(&rs);
    return mutable;
}

/* --- GC hooks --- */

static void mal_headers_trace(MalHeapHeader *cell) {
    MalHeadersObject *h = (MalHeadersObject *) cell;
    for (i32 i = 0; i < h->count; i++) {
        mal_gc_mark_value(mal_value_from_string(h->entries[i].name));
        mal_gc_mark_value(mal_value_from_string(h->entries[i].value));
    }
}

static void mal_headers_finalize(MalHeapHeader *cell) {
    MalHeadersObject *h = (MalHeadersObject *) cell;
    if (h->entries != nullptr) {
        free(h->entries);
        h->entries = nullptr;
    }
    h->count = 0;
    h->cap = 0;
}

static bool mal_headers_to_byte_string(MalVm *vm, MalValue input, MalValue *out) {
    MalString *string;
    if (!mal_vm_to_string(vm, input, &string)) {
        return false;
    }
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < mal_string_length(string); i++) {
        if (units[i] > 0xFF) {
            mal_vm_throw_error(
                vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Value is not a ByteString");
            return false;
        }
    }
    *out = mal_value_from_string(string);
    return true;
}

/* Web IDL sequence conversion does not IteratorClose when IteratorStepValue or
 * element conversion is abrupt. Keep each converted inner sequence staged so
 * Fetch's pair-arity and header validation steps run only after the complete
 * outer sequence has converted. */
static bool mal_headers_convert_inner_sequence(
    MalVm *vm, MalValue input, MalValue *sequence_out) {
    if (!mal_value_is_object(input)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Header pair must be an iterable object");
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
        if (!mal_headers_to_byte_string(vm, element, &converted)) {
            break;
        }
        mal_array_object_store(mal_value_to_array_object(*sequence_out),
            mal_key_index(index++), converted);
    }

    mal_gc_unroot(&element_span);
    mal_gc_unroot(&record_span);
    return ok;
}

static bool mal_headers_convert_sequence(
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
        if (!mal_headers_convert_inner_sequence(vm, roots[0], &roots[1])) {
            break;
        }
        mal_array_object_store(mal_value_to_array_object(*sequence_out),
            mal_key_index(index++), roots[1]);
    }

    mal_gc_unroot(&roots_span);
    mal_gc_unroot(&record_span);
    return ok;
}

static bool mal_headers_fill_from_sequence(
    MalVm *vm, MalHeadersObject *h, MalValue sequence) {
    MalArrayObject *outer = mal_value_to_array_object(sequence);
    for (u32 i = 0; i < mal_array_object_length(outer); i++) {
        MalValue pair_value;
        mal_array_object_dense_get(outer, i, &pair_value);
        MalArrayObject *pair = mal_value_to_array_object(pair_value);
        if (mal_array_object_length(pair) != 2) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Header pair must contain exactly two items");
            return false;
        }
        MalValue name;
        MalValue value;
        mal_array_object_dense_get(pair, 0, &name);
        mal_array_object_dense_get(pair, 1, &value);
        if (!mal_headers_append_values(vm, h, name, value)) {
            return false;
        }
    }
    return true;
}

static bool mal_headers_convert_record(
    MalVm *vm, MalValue input, MalValue *record_out) {
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
    u32 output = 0;
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
        if (!mal_headers_to_byte_string(vm, roots[1], &roots[2]) ||
            !mal_vm_get_property(vm, input, key, &roots[3]) ||
            !mal_headers_to_byte_string(vm, roots[3], &roots[3])) {
            ok = false;
            break;
        }
        roots[4] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 2));
        MalArrayObject *pair = mal_value_to_array_object(roots[4]);
        mal_array_object_store(pair, mal_key_index(0), roots[2]);
        mal_array_object_store(pair, mal_key_index(1), roots[3]);
        mal_array_object_store(mal_value_to_array_object(*record_out),
            mal_key_index(output++), roots[4]);
    }

    mal_gc_unroot(&roots_span);
    return ok;
}

/* Fill from the HeadersInit sequence/record union. Both arms stage their fully
 * converted ByteStrings before Fetch validates or appends any header. */
static bool mal_headers_fill_from_init(MalVm *vm, MalHeadersObject *h, MalValue init) {
    if (!mal_value_is_object(init)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Headers init must be an object");
        return false;
    }

    MalValue method;
    if (!mal_vm_get_property(vm, init,
            mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &method)) {
        return false;
    }
    if (!mal_value_is_nil(method)) {
        if (!mal_value_is_callable(method)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Headers init iterator is not callable");
            return false;
        }
        MalValue sequence = mal_value_new_undefined();
        MalRootSpan sequence_span;
        mal_gc_root(&sequence_span, &sequence, 1);
        bool ok = mal_headers_convert_sequence(vm, init, method, &sequence)
            && mal_headers_fill_from_sequence(vm, h, sequence);
        mal_gc_unroot(&sequence_span);
        return ok;
    }
    MalValue record = mal_value_new_undefined();
    MalRootSpan record_span;
    mal_gc_root(&record_span, &record, 1);
    bool ok = mal_headers_convert_record(vm, init, &record)
        && mal_headers_fill_from_sequence(vm, h, record);
    mal_gc_unroot(&record_span);
    return ok;
}

/* --- prototype methods --- */

static MalHeadersObject *mal_headers_this(MalValue this_value) {
    return mal_value_is_headers_object(this_value) ? mal_value_to_headers_object(this_value)
                                                   : nullptr;
}

static MalHeadersObject *mal_headers_this_or_throw(MalVm *vm, MalValue this_value) {
    MalHeadersObject *h = mal_headers_this(this_value);
    if (h == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Headers method called on incompatible receiver");
    }
    return h;
}

static bool mal_headers_require_args(MalVm *vm, i32 argc, i32 required) {
    if (argc >= required) {
        return true;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "Not enough arguments for Headers method");
    return false;
}

static bool mal_headers_method_name(
    MalVm *vm, const MalValue *args, i32 argc, MalValue *root, MalString **name) {
    if (!mal_headers_require_args(vm, argc, 1)) {
        return false;
    }
    return mal_headers_normalized_name(vm, args[0], root, name);
}

static MalValue mal_headers_method_append(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalHeadersObject *h = mal_headers_this_or_throw(vm, self);
    if (h == nullptr || !mal_headers_require_args(vm, argc, 2)) {
        return mal_value_new_undefined();
    }
    mal_gc_native_rooted_begin(vm);
    mal_headers_append_values(vm, h, args[0], args[1]);
    mal_gc_native_rooted_end(vm);
    return mal_value_new_undefined();
}

static MalValue mal_headers_method_set(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalHeadersObject *h = mal_headers_this_or_throw(vm, self);
    if (h == nullptr || !mal_headers_require_args(vm, argc, 2)) {
        return mal_value_new_undefined();
    }
    mal_gc_native_rooted_begin(vm);
    MalHeadersObject *tmp = mal_headers_create(vm);
    MalValue tmp_value = mal_value_from_headers_object(tmp);
    MalRootSpan rs;
    mal_gc_root(&rs, &tmp_value, 1);
    if (mal_headers_append_values(vm, tmp, args[0], args[1])) {
        if (!mal_headers_can_mutate(vm, h)) {
            mal_gc_unroot(&rs);
            mal_gc_native_rooted_end(vm);
            return mal_value_new_undefined();
        }
        MalString *name = tmp->entries[0].name;
        MalString *value = tmp->entries[0].value;
        if (!mal_headers_guard_allows(h, name, value)) {
            mal_gc_unroot(&rs);
            mal_gc_native_rooted_end(vm);
            return mal_value_new_undefined();
        }
        i32 first = -1;
        i32 w = 0;
        for (i32 i = 0; i < h->count; i++) {
            if (!mal_string_equals(h->entries[i].name, name)) {
                h->entries[w++] = h->entries[i];
                continue;
            }
            mal_gc_write_barrier(mal_value_from_string(h->entries[i].name));
            mal_gc_write_barrier(mal_value_from_string(h->entries[i].value));
            if (first < 0) {
                first = w;
                h->entries[w++] = (MalHeaderEntry) {.name = name, .value = value};
                mal_gc_card(&h->object.header, mal_value_from_string(name));
                mal_gc_card(&h->object.header, mal_value_from_string(value));
            }
        }
        h->count = w;
        if (first < 0 && !mal_headers_append_entry(h, name, value)) {
            mal_vm_throw_allocation_error(vm);
        }
    }
    mal_gc_unroot(&rs);
    mal_gc_native_rooted_end(vm);
    return mal_value_new_undefined();
}

static MalValue mal_headers_method_has(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalHeadersObject *h = mal_headers_this_or_throw(vm, self);
    if (h == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue name_root = mal_value_new_undefined();
    MalRootSpan rs;
    mal_gc_root(&rs, &name_root, 1);
    mal_gc_native_rooted_begin(vm);
    MalString *n;
    bool valid = mal_headers_method_name(vm, args, argc, &name_root, &n);
    bool found = false;
    if (valid) {
        for (i32 i = 0; i < h->count; i++) {
            if (mal_string_equals(h->entries[i].name, n)) {
                found = true;
                break;
            }
        }
    }
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&rs);
    return mal_value_new_boolean(found);
}

static MalValue mal_headers_method_delete(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalHeadersObject *h = mal_headers_this_or_throw(vm, self);
    if (h == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue name_root = mal_value_new_undefined();
    MalRootSpan rs;
    mal_gc_root(&rs, &name_root, 1);
    mal_gc_native_rooted_begin(vm);
    MalString *n;
    if (mal_headers_method_name(vm, args, argc, &name_root, &n)) {
        MalString *empty = mal_string_new_ascii(&vm->heap, "", 0);
        if (mal_headers_guard_allows(h, n, empty) && mal_headers_can_mutate(vm, h)) {
            mal_headers_remove(h, n);
        }
    }
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&rs);
    return mal_value_new_undefined();
}

static MalValue mal_headers_join(MalVm *vm, MalHeadersObject *h, const MalString *name) {
    usize total = 0;
    i32 matches = 0;
    for (i32 i = 0; i < h->count; i++) {
        if (mal_string_equals(h->entries[i].name, name)) {
            total += mal_string_length(h->entries[i].value);
            matches++;
        }
    }
    if (matches == 0) {
        return mal_value_new_null();
    }
    total += (usize) (matches - 1) * 2;
    c16 *buf = mal_heap_alloc_raw_profiled(
        &vm->heap, sizeof(c16) * (total == 0 ? 1 : total),
        MAL_PROFILE_ALLOCATION_FAMILY_HOST);
    usize offset = 0;
    i32 seen = 0;
    for (i32 i = 0; i < h->count; i++) {
        if (!mal_string_equals(h->entries[i].name, name)) {
            continue;
        }
        if (seen++ > 0) {
            buf[offset++] = ',';
            buf[offset++] = ' ';
        }
        const c16 *units = mal_string_code_units(h->entries[i].value);
        usize len = mal_string_length(h->entries[i].value);
        memcpy(buf + offset, units, sizeof(c16) * len);
        offset += len;
    }
    return mal_value_from_string(mal_string_new_owned(&vm->heap, buf, offset));
}

static MalValue mal_headers_method_get(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalHeadersObject *h = mal_headers_this_or_throw(vm, self);
    if (h == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue name_root = mal_value_new_undefined();
    MalRootSpan rs;
    mal_gc_root(&rs, &name_root, 1);
    mal_gc_native_rooted_begin(vm);
    MalString *name;
    MalValue result = mal_headers_method_name(vm, args, argc, &name_root, &name)
        ? mal_headers_join(vm, h, name)
        : mal_value_new_undefined();
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&rs);
    return result;
}

static MalHeadersObject *mal_headers_from_init_with_prototype(
    MalVm *vm, MalValue init, MalObject *prototype) {
    MalValue roots[2] = {mal_value_new_undefined(), init};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 2);
    MalHeadersObject *h = mal_headers_object_new(&vm->heap, prototype);
    roots[0] = mal_value_from_headers_object(h);
    if (!mal_value_is_undefined(roots[1])) {
        mal_gc_native_rooted_begin(vm);
        mal_headers_fill_from_init(vm, h, roots[1]);
        mal_gc_native_rooted_end(vm);
    }
    mal_gc_unroot(&rs);
    return h;
}

MalHeadersObject *mal_headers_from_init(MalVm *vm, MalValue init) {
    return mal_headers_from_init_guarded(vm, init, MAL_HEADERS_GUARD_NONE);
}

MalHeadersObject *mal_headers_from_init_guarded(
    MalVm *vm, MalValue init, MalHeadersGuard guard) {
    MalHeadersObject *headers = mal_headers_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_HEADERS_PROTOTYPE]));
    headers->guard = guard;
    MalValue roots[2] = {mal_value_from_headers_object(headers), init};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 2);
    if (!mal_value_is_undefined(roots[1])) {
        mal_gc_native_rooted_begin(vm);
        mal_headers_fill_from_init(vm, headers, roots[1]);
        mal_gc_native_rooted_end(vm);
    }
    mal_gc_unroot(&rs);
    return headers;
}

static MalValue mal_headers_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) callee;
    if (mal_value_is_undefined(nt)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Constructor Headers requires 'new'");
        return mal_value_new_undefined();
    }
    MalValue init = argc >= 1 ? args[0] : mal_value_new_undefined();
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, nt, MAL_INTRINSIC_HEADERS_PROTOTYPE, &prototype)) {
        return mal_value_new_undefined();
    }
    MalValue prototype_root = mal_value_from_object(prototype);
    MalRootSpan prototype_span;
    mal_gc_root(&prototype_span, &prototype_root, 1);
    MalValue result = mal_value_from_headers_object(
        mal_headers_from_init_with_prototype(vm, init, prototype));
    mal_gc_unroot(&prototype_span);
    return result;
}

/* --- sorted, live iteration (entries / keys / values / forEach / @@iterator) --- */

static i32 mal_headers_name_compare(const MalString *a, const MalString *b) {
    usize a_len = mal_string_length(a);
    usize b_len = mal_string_length(b);
    usize len = a_len < b_len ? a_len : b_len;
    const c16 *a_units = mal_string_code_units(a);
    const c16 *b_units = mal_string_code_units(b);
    for (usize i = 0; i < len; i++) {
        if (a_units[i] != b_units[i]) {
            return a_units[i] < b_units[i] ? -1 : 1;
        }
    }
    return a_len == b_len ? 0 : (a_len < b_len ? -1 : 1);
}

static bool mal_headers_name_is_set_cookie(const MalString *name) {
    static const char set_cookie[] = "set-cookie";
    usize len = mal_string_length(name);
    if (len != sizeof(set_cookie) - 1) {
        return false;
    }
    const c16 *units = mal_string_code_units(name);
    for (usize i = 0; i < len; i++) {
        if (units[i] != (c16) set_cookie[i]) {
            return false;
        }
    }
    return true;
}

static i32 *mal_headers_sorted_indices(MalHeadersObject *h) {
    i32 *indices = malloc(sizeof(i32) * (usize) (h->count == 0 ? 1 : h->count));
    for (i32 i = 0; i < h->count; i++) {
        indices[i] = i;
        i32 j = i;
        while (j > 0
            && mal_headers_name_compare(
                   h->entries[indices[j - 1]].name, h->entries[indices[j]].name)
                > 0) {
            i32 tmp = indices[j - 1];
            indices[j - 1] = indices[j];
            indices[j] = tmp;
            j--;
        }
    }
    return indices;
}

static MalValue mal_headers_join_sorted_range(
    MalVm *vm, MalHeadersObject *h, const i32 *indices, i32 start, i32 end) {
    usize total = (usize) (end - start - 1) * 2;
    for (i32 i = start; i < end; i++) {
        total += mal_string_length(h->entries[indices[i]].value);
    }
    c16 *buf = malloc(sizeof(c16) * (total == 0 ? 1 : total));
    usize offset = 0;
    for (i32 i = start; i < end; i++) {
        if (i > start) {
            buf[offset++] = ',';
            buf[offset++] = ' ';
        }
        MalString *value = h->entries[indices[i]].value;
        usize len = mal_string_length(value);
        memcpy(buf + offset, mal_string_code_units(value), sizeof(c16) * len);
        offset += len;
    }
    MalValue result = mal_value_from_string(mal_string_new_copy(&vm->heap, buf, offset));
    free(buf);
    return result;
}

/* Fetch's sort-and-combine algorithm keeps Set-Cookie values as separate items. */
static bool mal_headers_iteration_item(MalVm *vm, MalHeadersObject *h, i32 target,
    MalValue *name_out, MalValue *value_out) {
    i32 *indices = mal_headers_sorted_indices(h);
    i32 output = 0;
    bool found = false;
    for (i32 i = 0; i < h->count;) {
        MalHeaderEntry *entry = &h->entries[indices[i]];
        if (mal_headers_name_is_set_cookie(entry->name)) {
            if (output == target) {
                *name_out = mal_value_from_string(entry->name);
                *value_out = mal_value_from_string(entry->value);
                found = true;
                break;
            }
            output++;
            i++;
            continue;
        }

        i32 end = i + 1;
        while (end < h->count
            && mal_string_equals(entry->name, h->entries[indices[end]].name)) {
            end++;
        }
        if (output == target) {
            *name_out = mal_value_from_string(entry->name);
            *value_out = end == i + 1 ? mal_value_from_string(entry->value)
                                      : mal_headers_join_sorted_range(vm, h, indices, i, end);
            found = true;
            break;
        }
        output++;
        i = end;
    }
    free(indices);
    return found;
}

static void mal_headers_iterator_trace(MalHeapHeader *cell) {
    MalHeadersIteratorObject *iterator = (MalHeadersIteratorObject *) cell;
    mal_gc_mark_value(mal_value_from_headers_object(iterator->headers));
}

static MalValue mal_headers_iterator_next(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    if (!mal_value_is_heap_type(self, MAL_HEAP_HEADERS_ITERATOR_OBJECT)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            "Receiver is not a Headers iterator");
        return mal_value_new_undefined();
    }

    MalHeadersIteratorObject *iterator = (MalHeadersIteratorObject *) mal_value_to_heap(self);
    MalValue roots[3] = {
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 3);
    if (!mal_headers_iteration_item(vm, iterator->headers, iterator->index,
            &roots[0], &roots[1])) {
        mal_gc_unroot(&rs);
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }
    iterator->index++;

    if (iterator->kind == MAL_HEADERS_ITERATOR_ENTRIES) {
        roots[2] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 2));
        MalObject *pair = (MalObject *) mal_value_to_array_object(roots[2]);
        mal_object_set(pair, mal_key_index(0), roots[0]);
        mal_object_set(pair, mal_key_index(1), roots[1]);
    } else {
        roots[2] = iterator->kind == MAL_HEADERS_ITERATOR_KEYS ? roots[0] : roots[1];
    }
    MalValue result = mal_vm_create_iter_result(vm, roots[2], false);
    mal_gc_unroot(&rs);
    return result;
}

static MalValue mal_headers_make_iterator(
    MalVm *vm, MalHeadersObject *h, MalHeadersIteratorKind kind) {
    MalHeadersIteratorObject *iterator = mal_heap_alloc(
        &vm->heap, sizeof(MalHeadersIteratorObject), MAL_HEAP_HEADERS_ITERATOR_OBJECT);
    mal_object_init(&vm->heap, &iterator->object, MAL_HEAP_HEADERS_ITERATOR_OBJECT,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_HEADERS_ITERATOR_PROTOTYPE]));
    iterator->headers = h;
    iterator->index = 0;
    iterator->kind = kind;
    mal_gc_card(&iterator->object.header, mal_value_from_headers_object(h));
    return mal_value_from_heap((MalHeapHeader *) iterator);
}

#define MAL_HEADERS_ITER(fn, kind)                                                                \
    static MalValue fn(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt,     \
        MalValue callee) {                                                                        \
        (void) args;                                                                              \
        (void) argc;                                                                              \
        (void) nt;                                                                                \
        (void) callee;                                                                            \
        MalHeadersObject *h = mal_headers_this_or_throw(vm, self);                                \
        if (h == nullptr) {                                                                        \
            return mal_value_new_undefined();                                                     \
        }                                                                                         \
        return mal_headers_make_iterator(vm, h, kind);                                            \
    }

MAL_HEADERS_ITER(mal_headers_method_entries, MAL_HEADERS_ITERATOR_ENTRIES)
MAL_HEADERS_ITER(mal_headers_method_keys, MAL_HEADERS_ITERATOR_KEYS)
MAL_HEADERS_ITER(mal_headers_method_values, MAL_HEADERS_ITERATOR_VALUES)

static MalValue mal_headers_method_for_each(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalHeadersObject *h = mal_headers_this_or_throw(vm, self);
    if (h == nullptr) {
        return mal_value_new_undefined();
    }
    if (!mal_headers_require_args(vm, argc, 1) || !mal_value_is_callable(args[0])) {
        if (argc >= 1) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                "Headers forEach callback must be callable");
        }
        return mal_value_new_undefined();
    }
    MalValue roots[5] = {
        args[0],
        argc >= 2 ? args[1] : mal_value_new_undefined(),
        self,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 5);
    mal_gc_native_rooted_begin(vm);
    i32 index = 0;
    while (mal_headers_iteration_item(vm, h, index++, &roots[3], &roots[4])) {
        MalValue call_args[3] = {roots[4], roots[3], roots[2]};
        MalCompletion completion = mal_vm_call_value(vm, roots[0], roots[1], call_args, 3);
        if (completion.kind == MAL_COMPLETION_THROW) {
            break;
        }
    }
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&rs);
    return mal_value_new_undefined();
}

static MalValue mal_headers_method_get_set_cookie(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    MalHeadersObject *h = mal_headers_this_or_throw(vm, self);
    if (h == nullptr) {
        return mal_value_new_undefined();
    }
    u32 count = 0;
    for (i32 i = 0; i < h->count; i++) {
        if (mal_headers_name_is_set_cookie(h->entries[i].name)) {
            count++;
        }
    }
    MalValue result = mal_value_from_array_object(mal_intrinsic_new_array(vm, count));
    MalRootSpan rs;
    mal_gc_root(&rs, &result, 1);
    MalObject *array = (MalObject *) mal_value_to_array_object(result);
    u32 index = 0;
    for (i32 i = 0; i < h->count; i++) {
        if (mal_headers_name_is_set_cookie(h->entries[i].name)) {
            mal_object_set(array, mal_key_index(index++),
                mal_value_from_string(h->entries[i].value));
        }
    }
    mal_gc_unroot(&rs);
    return result;
}

void mal_headers_install(MalVm *vm, MalObject *global_this) {
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *obj_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);

    MalObject *proto = mal_object_new(&vm->heap, obj_proto);
    MalNativeFunctionObject *ctor = mal_native_function_object_new_arity(
        &vm->heap, fn_proto, mal_intrinsic_ascii(vm, (const byte *) "Headers"), 1,
        mal_headers_constructor);
    mal_native_function_object_set_constructor(ctor);

    vm->intrinsics[MAL_INTRINSIC_HEADERS_CONSTRUCTOR] = mal_value_from_native_function_object(ctor);
    vm->intrinsics[MAL_INTRINSIC_HEADERS_PROTOTYPE] = mal_value_from_object(proto);

    MalObject *iterator_proto = mal_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE]));
    vm->intrinsics[MAL_INTRINSIC_HEADERS_ITERATOR_PROTOTYPE] =
        mal_value_from_object(iterator_proto);
    MalValue iterator_next = mal_value_from_native_function_object(
        mal_native_function_object_new_arity(&vm->heap, fn_proto,
            mal_intrinsic_ascii(vm, (const byte *) "next"), 0,
            mal_headers_iterator_next));
    MalPropertyDesc iterator_next_desc = mal_intrinsic_data_desc(
        iterator_next, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
            MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(iterator_proto,
        mal_intrinsic_string_key(vm, (const byte *) "next"), &iterator_next_desc);
    MalPropertyDesc iterator_tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "Headers Iterator")),
        MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(iterator_proto,
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG),
        &iterator_tag_desc);

    mal_intrinsic_define_data(vm, (MalObject *) ctor, (const byte *) "prototype",
        vm->intrinsics[MAL_INTRINSIC_HEADERS_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, proto, (const byte *) "constructor",
        vm->intrinsics[MAL_INTRINSIC_HEADERS_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, proto, (const byte *) "get", 1, mal_headers_method_get);
    mal_intrinsic_define_method_n(vm, proto, (const byte *) "set", 2, mal_headers_method_set);
    mal_intrinsic_define_method_n(vm, proto, (const byte *) "append", 2, mal_headers_method_append);
    mal_intrinsic_define_method_n(vm, proto, (const byte *) "has", 1, mal_headers_method_has);
    mal_intrinsic_define_method_n(vm, proto, (const byte *) "delete", 1, mal_headers_method_delete);
    mal_intrinsic_define_method_n(vm, proto, (const byte *) "entries", 0, mal_headers_method_entries);
    mal_intrinsic_define_method_n(vm, proto, (const byte *) "keys", 0, mal_headers_method_keys);
    mal_intrinsic_define_method_n(vm, proto, (const byte *) "values", 0, mal_headers_method_values);
    mal_intrinsic_define_method_n(vm, proto, (const byte *) "forEach", 1, mal_headers_method_for_each);
    mal_intrinsic_define_method_n(
        vm, proto, (const byte *) "getSetCookie", 0, mal_headers_method_get_set_cookie);
    // [Symbol.iterator] === entries.
    MalValue entries_fn;
    if (mal_vm_get_property(vm, vm->intrinsics[MAL_INTRINSIC_HEADERS_PROTOTYPE],
            mal_intrinsic_string_key(vm, (const byte *) "entries"), &entries_fn)) {
        MalPropertyDesc desc =
            mal_intrinsic_data_desc(entries_fn, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
        mal_object_define_own(
            proto, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &desc);
    }
    mal_intrinsic_define_data(vm, global_this, (const byte *) "Headers",
        vm->intrinsics[MAL_INTRINSIC_HEADERS_CONSTRUCTOR],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_gc_register_tracer(MAL_HEAP_HEADERS_OBJECT, mal_headers_trace);
    mal_gc_register_finalizer(MAL_HEAP_HEADERS_OBJECT, mal_headers_finalize);
    mal_gc_register_tracer(
        MAL_HEAP_HEADERS_ITERATOR_OBJECT, mal_headers_iterator_trace);
}
