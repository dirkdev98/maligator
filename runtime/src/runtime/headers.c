#include "headers_object.h"

#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "builtin_iterator.h"
#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "property_iter.h"
#include "property_store.h"
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
    c16 *out = malloc(sizeof(c16) * (len == 0 ? 1 : len));
    for (usize i = 0; i < len; i++) {
        c16 unit = units[i];
        out[i] = unit >= 'A' && unit <= 'Z' ? (c16) (unit + ('a' - 'A')) : unit;
    }
    MalString *result = mal_string_new_copy(&vm->heap, out, len);
    free(out);
    return result;
}

static MalString *mal_headers_trim_value(MalVm *vm, const MalString *value) {
    const c16 *units = mal_string_code_units(value);
    usize start = 0;
    usize end = mal_string_length(value);
    while (start < end && (units[start] == ' ' || units[start] == '\t')) {
        start++;
    }
    while (end > start && (units[end - 1] == ' ' || units[end - 1] == '\t')) {
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
    return h;
}

MalHeadersObject *mal_headers_create(MalVm *vm) {
    return mal_headers_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_HEADERS_PROTOTYPE]));
}

void mal_headers_append_entry(MalHeadersObject *h, MalString *name, MalString *value) {
    if (h->count == h->cap) {
        h->cap = h->cap == 0 ? 8 : h->cap * 2;
        h->entries = realloc(h->entries, sizeof(MalHeaderEntry) * (usize) h->cap);
    }
    h->entries[h->count].name = name;
    h->entries[h->count].value = value;
    h->count++;
    mal_gc_card(&h->object.header, mal_value_from_string(name));
    mal_gc_card(&h->object.header, mal_value_from_string(value));
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

    char *lower = malloc(name_len == 0 ? 1 : name_len);
    for (usize i = 0; i < name_len; i++) {
        char unit = name[i];
        lower[i] = unit >= 'A' && unit <= 'Z' ? (char) (unit + ('a' - 'A')) : unit;
    }

    MalValue roots[2] = {
        mal_value_from_headers_object(h),
        mal_value_new_undefined(),
    };
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 2);
    roots[1] = mal_value_from_string(
        mal_string_new_ascii(&vm->heap, (const byte *) lower, name_len));
    MalString *v = mal_string_new_ascii(&vm->heap, (const byte *) value + value_start,
        value_end - value_start);
    mal_headers_append_entry(h, mal_value_to_string(roots[1]), v);
    mal_gc_unroot(&rs);
    free(lower);
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
    if (!mal_headers_validate_value(vm, value)) {
        mal_gc_unroot(&rs);
        return false;
    }
    MalString *normalized_value = mal_headers_trim_value(vm, value);
    mal_headers_append_entry(h, name, normalized_value);
    mal_gc_unroot(&rs);
    return true;
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

/* Fill from the currently supported HeadersInit arms: Headers or an enumerable
 * record. Record keys are snapshotted before getters run, as Web IDL requires. */
static bool mal_headers_fill_from_init(MalVm *vm, MalHeadersObject *h, MalValue init) {
    if (mal_value_is_headers_object(init)) {
        MalHeadersObject *src = mal_value_to_headers_object(init);
        for (i32 i = 0; i < src->count; i++) {
            mal_headers_append_entry(h, src->entries[i].name, src->entries[i].value);
        }
        return true;
    }
    if (!mal_value_is_object(init)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Headers init must be an object");
        return false;
    }

    MalObject *object = mal_value_to_object(init);
    MalPropertyIter iter;
    mal_property_iter_init(
        &iter, object, MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
    MalKey key;
    MalPropertyDesc desc;
    i32 key_count = 0;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind != MAL_KEY_SYMBOL) {
            key_count++;
        }
    }

    MalKey *keys = malloc(sizeof(MalKey) * (usize) (key_count == 0 ? 1 : key_count));
    MalValue *key_roots = malloc(sizeof(MalValue) * (usize) (key_count == 0 ? 1 : key_count));
    for (i32 i = 0; i < key_count; i++) {
        key_roots[i] = mal_value_new_undefined();
    }
    MalRootSpan key_span;
    mal_gc_root(&key_span, key_roots, key_count);

    mal_property_iter_init(&iter, object, MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
    i32 index = 0;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind == MAL_KEY_SYMBOL) {
            continue;
        }
        keys[index] = key;
        key_roots[index] = key.value;
        index++;
    }

    MalValue value = mal_value_new_undefined();
    MalRootSpan value_span;
    mal_gc_root(&value_span, &value, 1);
    bool ok = true;
    for (i32 i = 0; i < key_count; i++) {
        if (!mal_vm_get_property(vm, init, keys[i], &value)
            || !mal_headers_append_values(vm, h, key_roots[i], value)) {
            ok = false;
            break;
        }
    }
    mal_gc_unroot(&value_span);
    mal_gc_unroot(&key_span);
    free(key_roots);
    free(keys);
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
        MalString *name = tmp->entries[0].name;
        MalString *value = tmp->entries[0].value;
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
        if (first < 0) {
            mal_headers_append_entry(h, name, value);
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
        mal_headers_remove(h, n);
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
    c16 *buf = malloc(sizeof(c16) * (total == 0 ? 1 : total));
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
    MalValue result = mal_value_from_string(mal_string_new_copy(&vm->heap, buf, offset));
    free(buf);
    return result;
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

MalHeadersObject *mal_headers_from_init(MalVm *vm, MalValue init) {
    MalValue roots[2] = {mal_value_new_undefined(), init};
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 2);
    MalHeadersObject *h = mal_headers_create(vm);
    roots[0] = mal_value_from_headers_object(h);
    if (!mal_value_is_undefined(roots[1])) {
        mal_gc_native_rooted_begin(vm);
        mal_headers_fill_from_init(vm, h, roots[1]);
        mal_gc_native_rooted_end(vm);
    }
    mal_gc_unroot(&rs);
    return h;
}

static MalValue mal_headers_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    (void) callee;
    MalValue init = argc >= 1 ? args[0] : mal_value_new_undefined();
    return mal_value_from_headers_object(mal_headers_from_init(vm, init));
}

/* --- sorted, live iteration (entries / keys / values / forEach / @@iterator) --- */

static MalKey mal_headers_index_key(u32 index) {
    return (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)};
}

typedef enum { MAL_HEADERS_ENTRIES, MAL_HEADERS_KEYS, MAL_HEADERS_VALUES } MalHeadersIterKind;

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

enum {
    MAL_HEADERS_ITER_SLOT_HEADERS,
    MAL_HEADERS_ITER_SLOT_INDEX,
    MAL_HEADERS_ITER_SLOT_KIND,
};

static MalValue mal_headers_iterator_self(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm;
    (void) args;
    (void) argc;
    (void) nt;
    (void) callee;
    return self;
}

static MalValue mal_headers_iterator_next(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) self;
    (void) args;
    (void) argc;
    (void) nt;
    MalNativeFunctionObject *next = mal_value_to_native_function_object(callee);
    MalValue headers_value =
        mal_native_function_object_get_slot(next, MAL_HEADERS_ITER_SLOT_HEADERS);
    if (!mal_value_is_headers_object(headers_value)) {
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }

    i32 index = mal_value_to_i32(
        mal_native_function_object_get_slot(next, MAL_HEADERS_ITER_SLOT_INDEX));
    MalHeadersIterKind kind = (MalHeadersIterKind) mal_value_to_i32(
        mal_native_function_object_get_slot(next, MAL_HEADERS_ITER_SLOT_KIND));
    MalValue roots[3] = {
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 3);
    if (!mal_headers_iteration_item(vm, mal_value_to_headers_object(headers_value), index,
            &roots[0], &roots[1])) {
        mal_gc_unroot(&rs);
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }
    mal_native_function_object_set_slot(
        next, MAL_HEADERS_ITER_SLOT_INDEX, mal_value_from_i32(index + 1));

    if (kind == MAL_HEADERS_ENTRIES) {
        roots[2] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 2));
        MalObject *pair = (MalObject *) mal_value_to_array_object(roots[2]);
        mal_object_set(pair, mal_headers_index_key(0), roots[0]);
        mal_object_set(pair, mal_headers_index_key(1), roots[1]);
    } else {
        roots[2] = kind == MAL_HEADERS_KEYS ? roots[0] : roots[1];
    }
    MalValue result = mal_vm_create_iter_result(vm, roots[2], false);
    mal_gc_unroot(&rs);
    return result;
}

static MalValue mal_headers_make_iterator(MalVm *vm, MalHeadersObject *h, MalHeadersIterKind kind) {
    MalValue roots[4] = {
        mal_value_from_headers_object(h),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan rs;
    mal_gc_root(&rs, roots, 4);
    roots[1] = mal_value_from_object(mal_intrinsic_new_object(vm));
    MalObject *fn_proto = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalValue slots[3] = {roots[0], mal_value_from_i32(0), mal_value_from_i32((i32) kind)};
    MalRootSpan slot_span;
    mal_gc_root(&slot_span, slots, 3);
    roots[2] = mal_value_from_native_function_object(mal_native_function_object_new_with_slots(
        &vm->heap, fn_proto, mal_intrinsic_ascii(vm, (const byte *) "next"),
        mal_headers_iterator_next, slots, 3));
    mal_intrinsic_define_data(vm, mal_value_to_object(roots[1]), (const byte *) "next", roots[2],
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    roots[3] = mal_value_from_native_function_object(mal_native_function_object_new(
        &vm->heap, fn_proto, mal_intrinsic_ascii(vm, (const byte *) "[Symbol.iterator]"),
        mal_headers_iterator_self));
    MalPropertyDesc desc = mal_intrinsic_data_desc(
        roots[3], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(mal_value_to_object(roots[1]),
        mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &desc);
    mal_gc_unroot(&slot_span);
    MalValue result = roots[1];
    mal_gc_unroot(&rs);
    return result;
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

MAL_HEADERS_ITER(mal_headers_method_entries, MAL_HEADERS_ENTRIES)
MAL_HEADERS_ITER(mal_headers_method_keys, MAL_HEADERS_KEYS)
MAL_HEADERS_ITER(mal_headers_method_values, MAL_HEADERS_VALUES)

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
            mal_object_set(array, mal_headers_index_key(index++),
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
}
