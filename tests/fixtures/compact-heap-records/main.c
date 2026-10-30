#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "function_object.h"
#include "gc.h"
#include "heap_symbol.h"
#include "intrinsics.h"
#include "object_ops.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

static bool numeric_field_stores(MalVm *vm) {
    MalString *keys[] = {
        mal_intrinsic_ascii(vm, "__compact_numeric_boundary"),
        mal_intrinsic_ascii(vm, "fraction"),
        mal_intrinsic_ascii(vm, "overflow"),
        mal_intrinsic_ascii(vm, "nan"),
    };
    MalShape *logical = mal_shape_from_string_keys(&vm->heap, keys, 4);
    MalValue initial[] = {
        mal_value_from_i32(1), mal_value_from_i32(2),
        mal_value_from_i32(3), mal_value_from_i32(4),
    };
    MalObject *object = mal_object_new_shaped(&vm->heap, nullptr, logical, initial, 4);
    MalValue live = mal_value_from_object(object);
    MalRootSpan root;
    mal_gc_root(&root, &live, 1);
    MalShape *shape = object->shape;
    bool ok = true;
    const f64 integers[] = {INT32_MIN, -1.0, 0.0, 1.0, INT32_MAX};
    for (usize index = 0; index < sizeof(integers) / sizeof(integers[0]); index++) {
        MalValue boxed = mal_value_from_f64_convert_nan(integers[index]);
        mal_object_field_store(object, 0, boxed);
        f64 loaded;
        ok = ok && object->shape == shape &&
            mal_ops_try_number_as_f64(mal_object_field_load(object, 0), &loaded) &&
            loaded == integers[index] && !!signbit(loaded) == !!signbit(integers[index]);
    }
    const f64 widened[] = {-0.0, 1.25, (f64) INT32_MAX + 1.0, NAN};
    for (u32 ordinal = 0; ordinal < 4; ordinal++) {
        mal_object_field_store(object, ordinal, mal_value_from_f64_convert_nan(widened[ordinal]));
    }
    mal_gc_collect(vm);
    for (u32 ordinal = 0; ordinal < 4; ordinal++) {
        f64 actual;
        bool numeric = mal_ops_try_number_as_f64(mal_object_field_load(object, ordinal), &actual);
        ok = ok && numeric;
        if (numeric) {
            ok = ok && (isnan(widened[ordinal]) ? isnan(actual)
                : actual == widened[ordinal] &&
                  (actual != 0.0 || !!signbit(actual) == !!signbit(widened[ordinal])));
        }
    }
    mal_gc_unroot(&root);
    return ok;
}

static bool growing_preserves_fields(MalVm *vm, u32 mode) {
    static MalString key_storage[4][MAL_SHAPE_MAX_INLINE_SLOTS];
    static u8 key_names[4][MAL_SHAPE_MAX_INLINE_SLOTS][64];
    MalString *keys[MAL_SHAPE_MAX_INLINE_SLOTS];
    for (u32 slot = 0; slot < MAL_SHAPE_MAX_INLINE_SLOTS; slot++) {
        u8 *name = key_names[mode][slot];
        usize length = (usize) snprintf((char *) name, sizeof(key_names[mode][slot]),
                                       "__compact_grow_%u_%u", mode, slot);
        keys[slot] = &key_storage[mode][slot];
        mal_string_init_external_latin1(keys[slot], name, length);
        // Only immortal property names may extend a shape beyond its dynamic-key limit.
        keys[slot]->header.storage = MAL_HEAP_STORAGE_IMMORTAL;
    }
    MalString *child_keys[] = {mal_intrinsic_ascii(vm, "__compact_grown_child")};
    MalShape *child_shape = mal_shape_from_string_keys(&vm->heap, child_keys, 1);
    MalValue live[] = {
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined()
    };
    MalRootSpan roots;
    mal_gc_root(&roots, live, countof(live));
    if (mode == 3) live[3] = mal_value_from_symbol(mal_symbol_new_private(&vm->heap));
    bool ok = true;
    // Without a constructor reservation an object stays shaped only to the ordinary bound.
    for (u32 count = 0; ok && count < MAL_SHAPE_ORDINARY_SLOTS; count++) {
        MalValue marker = mal_value_from_i32((i32) count);
        live[0] = mal_value_from_object(mal_object_new_shaped(
            &vm->heap, nullptr, child_shape, &marker, 1));
        MalValue values[MAL_SHAPE_MAX_INLINE_SLOTS];
        for (u32 slot = 0; slot < count; slot++) {
            values[slot] = slot % 4 == 0 ? mal_value_from_i32((i32) slot)
                : slot % 4 == 1 ? mal_value_from_f64_convert_nan(-0.0)
                : slot % 4 == 2 ? live[0] : mal_value_new_undefined();
        }
        MalShape *shape = mal_shape_from_string_keys(&vm->heap, keys, count);
        MalObject *object = count == 0 ? mal_object_new(&vm->heap, nullptr)
            : mal_object_new_shaped(&vm->heap, nullptr, shape, values, count);
        live[1] = mal_value_from_object(object);
        if (mode == 3) {
            ok = mal_object_set(object, mal_key_from_value(live[3]), marker) &&
                object->storage_kind == MAL_OBJECT_EXTERNAL && object->overflow_private_only;
            if (!ok) {
                fprintf(stderr, "compact metadata setup failed: count=%u\n", count);
                break;
            }
        }
        if (mode == 2 && count != 0) {
            usize payload_bytes = sizeof(MalValue) * count;
            // Owned slot arrays are raw heap cells, as object growth allocates them.
            void *fields = mal_heap_alloc_raw(&vm->heap, payload_bytes);
            memcpy(fields, mal_object_fields_nonempty(object), payload_bytes);
            mal_object_set_fields_pointer(object, fields);
            object->slots_owned = true;
        }
        void *inline_fields = (u8 *) (object + 1) + sizeof(void *);
        usize prefix_bytes = sizeof(MalObject) + sizeof(void *);
        usize cell_bytes = mal_heap_allocation_charge(prefix_bytes + sizeof(MalValue) * count);
        bool retains_inline = object->storage_kind == MAL_OBJECT_COMPACT ||
            mal_object_fields(object) == inline_fields;
        bool fits_inline = !object->slots_owned && retains_inline &&
            sizeof(MalValue) * (count + 1) <= cell_bytes - prefix_bytes;
        MalValue appended_marker = mal_value_from_i32((i32) count + 1000);
        live[2] = mal_value_from_object(mal_object_new_shaped(
            &vm->heap, nullptr, child_shape, &appended_marker, 1));
        MalPropertyDesc desc = {
            .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
            .value = live[2],
            .getter = mal_value_new_undefined(),
            .setter = mal_value_new_undefined(),
        };
        MalKey key = mal_key_from_value(mal_value_from_string(keys[count]));
        ok = mal_object_define_own(object, key, &desc) == MAL_DEFINE_OWN_APPLIED &&
            mal_value_to_object(live[1]) == object &&
            object->shape->inline_count == count + 1 &&
            object->slot_capacity >= count + 1 &&
            (fits_inline ? !object->slots_owned && mal_object_fields(object) == inline_fields
                : object->slots_owned);
        live[0] = mal_value_new_undefined();
        live[2] = mal_value_new_undefined();
        mal_gc_collect(vm);
        for (u32 slot = 0; ok && slot < count; slot++) {
            ok = mal_object_field_load(object, slot) == values[slot] &&
                object->shape->props[slot].key == mal_value_from_string(keys[slot]);
            if (ok && slot % 4 == 2) {
                ok = mal_object_field_load(mal_value_to_object(values[slot]), 0) == marker;
            }
        }
        MalPropertyLookup appended = mal_object_get_own(object, key);
        ok = ok && appended.present && appended.desc.flags == desc.flags &&
            appended.desc.value == desc.value &&
            mal_object_field_load(mal_value_to_object(appended.desc.value), 0) == appended_marker;
        if (ok && mode == 3) {
            MalPropertyLookup metadata = mal_object_get_own(object, mal_key_from_value(live[3]));
            ok = metadata.present && metadata.desc.value == marker;
        }
        if (!ok) fprintf(stderr, "compact growth failed: mode=%u count=%u\n", mode, count);
    }
    mal_gc_unroot(&roots);
    return ok;
}

static MalValue record_layout(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalValue new_target, MalValue callee
) {
    (void) vm;
    (void) this_value;
    (void) new_target;
    (void) callee;
    if (arg_count != 1 || !mal_value_is_heap_type(args[0], MAL_HEAP_OBJECT)) {
        return mal_value_from_i32(0);
    }
    MalObject *object = mal_value_to_object(args[0]);
    i32 flags = object->header.storage == MAL_HEAP_STORAGE_DYNAMIC ? 1 : 0;
    if (object->storage_kind == MAL_OBJECT_COMPACT) flags |= 2;
    if (object->storage_kind == MAL_OBJECT_EXTERNAL) flags |= 64;
    if (object->shape == mal_shape_dictionary_empty()) flags |= 128;
    return mal_value_from_i32(flags);
}

int main(int argc, char **argv) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalHostLaunchContext launch = {.argc = argc, .argv = argv};
    mal_vm_run_host_installs(&vm, &launch);
    if (!numeric_field_stores(&vm) || !growing_preserves_fields(&vm, 0) ||
        !growing_preserves_fields(&vm, 2) || !growing_preserves_fields(&vm, 3)) {
        fputs("field-store or growth contract failed\n", stderr);
        mal_vm_free(&vm);
        return 1;
    }
    MalObject *global = mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    MalNativeFunctionObject *probe = mal_native_function_object_new(
        &vm.heap, mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(&vm, "__compact_record_layout"), record_layout);
    MalPropertyDesc descriptor = {
        .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_from_native_function_object(probe),
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(
        global, mal_intrinsic_string_key(&vm, "__compact_record_layout"), &descriptor);
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    int code = vm.completion.kind == MAL_COMPLETION_NORMAL ? 0 : 1;
    if (code != 0) fputs("compact-heap-records fixture threw\n", stderr);
    mal_gc_collect(&vm);
    mal_vm_free_callable(entry);
    mal_vm_free(&vm);
    return code;
}
