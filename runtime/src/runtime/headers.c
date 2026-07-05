#include "headers_object.h"

#include <stdlib.h>

#include "array_object.h"
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

/* ASCII case-insensitive compare of two header names. */
static bool mal_headers_name_eq(const MalString *a, const MalString *b) {
    usize la = mal_string_length(a);
    if (la != mal_string_length(b)) {
        return false;
    }
    const c16 *ua = mal_string_code_units(a);
    const c16 *ub = mal_string_code_units(b);
    for (usize i = 0; i < la; i++) {
        c16 x = ua[i];
        c16 y = ub[i];
        if (x >= 'A' && x <= 'Z') {
            x = (c16) (x + 32);
        }
        if (y >= 'A' && y <= 'Z') {
            y = (c16) (y + 32);
        }
        if (x != y) {
            return false;
        }
    }
    return true;
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
}

void mal_headers_append_bytes(
    MalVm *vm, MalHeadersObject *h, const char *name, usize name_len, const char *value,
    usize value_len) {
    MalString *n = mal_string_new_ascii(&vm->heap, name, name_len);
    MalString *v = mal_string_new_ascii(&vm->heap, value, value_len);
    mal_headers_append_entry(h, n, v);
}

static void mal_headers_remove(MalHeadersObject *h, const MalString *name) {
    i32 w = 0;
    for (i32 i = 0; i < h->count; i++) {
        if (!mal_headers_name_eq(h->entries[i].name, name)) {
            h->entries[w++] = h->entries[i];
        }
    }
    h->count = w;
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

/* Fill from an init: another Headers (copy) or a plain object (own enum string
 * props with string values). Non-string values are skipped for v1. */
static void mal_headers_fill_from_init(MalVm *vm, MalHeadersObject *h, MalValue init) {
    if (mal_value_is_headers_object(init)) {
        MalHeadersObject *src = mal_value_to_headers_object(init);
        for (i32 i = 0; i < src->count; i++) {
            mal_headers_append_entry(h, src->entries[i].name, src->entries[i].value);
        }
        return;
    }
    if (!mal_value_is_object(init)) {
        return;
    }
    MalPropertyIter iter;
    mal_property_iter_init(
        &iter, mal_value_to_object(init), MAL_PROPERTY_ITER_ENUMERABLE_OWN_PROPERTY_ORDER);
    MalKey key;
    MalPropertyDesc desc;
    while (mal_property_iter_next(&iter, &key, &desc)) {
        if (key.kind != MAL_KEY_STRING || !mal_value_is_string(desc.value)) {
            continue;
        }
        mal_headers_append_entry(
            h, mal_value_to_string(key.value), mal_value_to_string(desc.value));
    }
}

/* --- prototype methods --- */

static MalHeadersObject *mal_headers_this(MalValue this_value) {
    return mal_value_is_headers_object(this_value) ? mal_value_to_headers_object(this_value)
                                                   : nullptr;
}

static MalString *mal_headers_arg_string(const MalValue *args, i32 arg_count, i32 i) {
    if (i < arg_count && mal_value_is_string(args[i])) {
        return mal_value_to_string(args[i]);
    }
    return nullptr;
}

static MalValue mal_headers_method_append(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm;
    (void) nt;
    (void) callee;
    MalHeadersObject *h = mal_headers_this(self);
    MalString *n = mal_headers_arg_string(args, argc, 0);
    MalString *v = mal_headers_arg_string(args, argc, 1);
    if (h != nullptr && n != nullptr && v != nullptr) {
        mal_headers_append_entry(h, n, v);
    }
    return mal_value_new_undefined();
}

static MalValue mal_headers_method_set(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm;
    (void) nt;
    (void) callee;
    MalHeadersObject *h = mal_headers_this(self);
    MalString *n = mal_headers_arg_string(args, argc, 0);
    MalString *v = mal_headers_arg_string(args, argc, 1);
    if (h != nullptr && n != nullptr && v != nullptr) {
        mal_headers_remove(h, n);
        mal_headers_append_entry(h, n, v);
    }
    return mal_value_new_undefined();
}

static MalValue mal_headers_method_has(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm;
    (void) nt;
    (void) callee;
    MalHeadersObject *h = mal_headers_this(self);
    MalString *n = mal_headers_arg_string(args, argc, 0);
    bool found = false;
    if (h != nullptr && n != nullptr) {
        for (i32 i = 0; i < h->count; i++) {
            if (mal_headers_name_eq(h->entries[i].name, n)) {
                found = true;
                break;
            }
        }
    }
    return mal_value_new_boolean(found);
}

static MalValue mal_headers_method_delete(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) vm;
    (void) nt;
    (void) callee;
    MalHeadersObject *h = mal_headers_this(self);
    MalString *n = mal_headers_arg_string(args, argc, 0);
    if (h != nullptr && n != nullptr) {
        mal_headers_remove(h, n);
    }
    return mal_value_new_undefined();
}

static MalValue mal_headers_method_get(
    MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) nt;
    (void) callee;
    MalHeadersObject *h = mal_headers_this(self);
    MalString *n = mal_headers_arg_string(args, argc, 0);
    if (h == nullptr || n == nullptr) {
        return mal_value_new_null();
    }
    usize total = 0;
    i32 matches = 0;
    for (i32 i = 0; i < h->count; i++) {
        if (mal_headers_name_eq(h->entries[i].name, n)) {
            total += mal_string_length(h->entries[i].value);
            matches++;
        }
    }
    if (matches == 0) {
        return mal_value_new_null();
    }
    total += (usize) (matches - 1) * 2; // ", " separators
    c16 *buf = malloc(sizeof(c16) * (total == 0 ? 1 : total));
    usize o = 0;
    i32 seen = 0;
    for (i32 i = 0; i < h->count; i++) {
        if (!mal_headers_name_eq(h->entries[i].name, n)) {
            continue;
        }
        if (seen++ > 0) {
            buf[o++] = ',';
            buf[o++] = ' ';
        }
        const c16 *v = mal_string_code_units(h->entries[i].value);
        usize vl = mal_string_length(h->entries[i].value);
        for (usize k = 0; k < vl; k++) {
            buf[o++] = v[k];
        }
    }
    MalValue result = mal_value_from_string(mal_string_new_copy(&vm->heap, buf, o));
    free(buf);
    return result;
}

MalHeadersObject *mal_headers_from_init(MalVm *vm, MalValue init) {
    MalHeadersObject *h = mal_headers_create(vm);
    mal_headers_fill_from_init(vm, h, init);
    return h;
}

static MalValue mal_headers_constructor(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    (void) callee;
    MalHeadersObject *h = mal_headers_create(vm);
    MalValue result = mal_value_from_headers_object(h);
    if (argc >= 1) {
        mal_headers_fill_from_init(vm, h, args[0]);
    }
    return result;
}

/* --- iteration (entries / keys / values / forEach / @@iterator) ---
 *
 * v1 yields pairs in insertion order with the stored name case; the spec's
 * lowercasing + sort + same-name combining is a follow-up. */

static MalKey mal_headers_index_key(u32 index) {
    return (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)};
}

typedef enum { MAL_HEADERS_ENTRIES, MAL_HEADERS_KEYS, MAL_HEADERS_VALUES } MalHeadersIterKind;

/* Build a pre-sized snapshot Array and return its Array iterator. */
static MalValue mal_headers_make_iterator(MalVm *vm, MalHeadersObject *h, MalHeadersIterKind kind) {
    MalValue arr_val = mal_value_from_array_object(mal_intrinsic_new_array(vm, (u32) h->count));
    MalRootSpan rs;
    mal_gc_root(&rs, &arr_val, 1);
    MalObject *arr = (MalObject *) mal_value_to_array_object(arr_val);
    for (i32 i = 0; i < h->count; i++) {
        if (kind == MAL_HEADERS_ENTRIES) {
            MalValue pair_val = mal_value_from_array_object(mal_intrinsic_new_array(vm, 2));
            MalRootSpan prs;
            mal_gc_root(&prs, &pair_val, 1);
            MalObject *pair = (MalObject *) mal_value_to_array_object(pair_val);
            mal_object_set(pair, mal_headers_index_key(0), mal_value_from_string(h->entries[i].name));
            mal_object_set(pair, mal_headers_index_key(1), mal_value_from_string(h->entries[i].value));
            mal_object_set(arr, mal_headers_index_key((u32) i), pair_val);
            mal_gc_unroot(&prs);
            continue;
        }
        MalValue element = kind == MAL_HEADERS_KEYS ? mal_value_from_string(h->entries[i].name)
                                                    : mal_value_from_string(h->entries[i].value);
        mal_object_set(arr, mal_headers_index_key((u32) i), element);
    }
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

#define MAL_HEADERS_ITER(fn, kind)                                                                \
    static MalValue fn(MalVm *vm, MalValue self, const MalValue *args, i32 argc, MalValue nt,     \
        MalValue callee) {                                                                        \
        (void) args;                                                                              \
        (void) argc;                                                                              \
        (void) nt;                                                                                \
        (void) callee;                                                                            \
        MalHeadersObject *h = mal_headers_this(self);                                             \
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
    MalHeadersObject *h = mal_headers_this(self);
    if (h == nullptr || argc < 1 || !mal_value_is_callable(args[0])) {
        return mal_value_new_undefined();
    }
    MalValue cb = args[0];
    MalValue this_arg = argc >= 2 ? args[1] : mal_value_new_undefined();
    for (i32 i = 0; i < h->count; i++) {
        MalValue call_args[3] = {
            mal_value_from_string(h->entries[i].value),
            mal_value_from_string(h->entries[i].name),
            self,
        };
        mal_vm_call_value(vm, cb, this_arg, call_args, 3);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
    }
    return mal_value_new_undefined();
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
