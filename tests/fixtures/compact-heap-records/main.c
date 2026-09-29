#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "function_object.h"
#include "gc.h"
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
    MalShape *narrow = object->shape;
    bool ok = mal_shape_field_representation(narrow->props[0].field) == MAL_FIELD_I32;
    const f64 integers[] = {INT32_MIN, -1.0, 0.0, 1.0, INT32_MAX};
    for (usize index = 0; index < sizeof(integers) / sizeof(integers[0]); index++) {
        MalValue boxed = mal_value_from_f64_convert_nan(integers[index]);
        mal_object_field_store(object, 0, boxed);
        ok = ok && object->shape == narrow &&
            mal_object_field_load(object, 0) == mal_value_from_i32((i32) integers[index]);
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

static bool widening_preserves_payload(MalVm *vm, bool external) {
    MalString *child_keys[] = {mal_intrinsic_ascii(vm, "__compact_retained_payload")};
    MalShape *child_shape = mal_shape_from_string_keys(&vm->heap, child_keys, 1);
    MalValue child_values[] = {mal_value_from_i32(1234)};
    MalObject *child = mal_object_new_shaped(&vm->heap, nullptr, child_shape, child_values, 1);
    MalValue live[] = {mal_value_from_object(child), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, live, 2);
    MalString *keys[64];
    MalValue values[64];
    for (u32 slot = 0; slot < 64; slot++) {
        char key[64];
        snprintf(key, sizeof(key), "__compact_widen_%s_%u", external ? "external" : "inline", slot);
        keys[slot] = mal_intrinsic_ascii(vm, key);
        values[slot] = mal_value_new_undefined();
    }
    values[0] = mal_value_from_i32(7);
    values[31] = live[0];
    values[32] = mal_value_from_f64_convert_nan(-0.0);
    values[63] = live[0];
    MalShape *logical = mal_shape_from_string_keys(&vm->heap, keys, 64);
    MalObject *object = mal_object_new_shaped(&vm->heap, nullptr, logical, values, 64);
    live[1] = mal_value_from_object(object);
    if (external) {
        void *fields = malloc(object->shape->payload_bytes);
        if (fields == nullptr) abort();
        memcpy(fields, mal_object_fields_nonempty(object), object->shape->payload_bytes);
        mal_object_set_fields_pointer(object, fields);
        object->slots_owned = true;
    }
    void *payload = mal_object_fields_nonempty(object);
    MalShape *original = object->shape;
    // A different constructor observation widens two fields that this store must preserve.
    values[31] = mal_value_new_undefined();
    values[32] = mal_value_new_undefined();
    mal_shape_compact_from_values(logical, values, 64);
    mal_object_field_store(object, 63, mal_value_new_undefined());
    bool ok = object->shape != original && mal_object_fields_nonempty(object) == payload &&
        object->slots_owned == external && mal_object_field_load(object, 31) == live[0] &&
        mal_object_field_load(object, 63) == mal_value_new_undefined() &&
        mal_shape_field_representation(object->shape->props[31].field) == MAL_FIELD_TAGGED &&
        mal_shape_field_representation(object->shape->props[32].field) == MAL_FIELD_TAGGED;
    live[0] = mal_value_new_undefined();
    mal_gc_collect(vm);
    MalValue retained = mal_object_field_load(object, 31);
    ok = ok && mal_value_is_heap_type(retained, MAL_HEAP_OBJECT);
    if (mal_value_is_heap_type(retained, MAL_HEAP_OBJECT)) {
        ok = ok && mal_object_field_load(mal_value_to_object(retained), 0) == child_values[0];
    }
    f64 number;
    bool numeric = mal_ops_try_number_as_f64(mal_object_field_load(object, 32), &number);
    ok = ok && numeric && number == 0.0 && signbit(number);

    // The size-changing path may move storage; the following canonical fallback must not.
    mal_object_field_store(object, 0, mal_value_from_f64_convert_nan(1.5));
    payload = mal_object_fields_nonempty(object);
    mal_object_field_store(object, 0, mal_value_new_undefined());
    ok = ok && object->shape == logical && mal_object_fields_nonempty(object) == payload &&
        mal_object_field_load(object, 0) == mal_value_new_undefined() &&
        mal_object_field_load(object, 31) == retained;
    mal_gc_collect(vm);
    ok = ok && mal_object_field_load(object, 31) == retained;
    mal_gc_unroot(&root);
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
    const MalShape *shape = object->shape;
    if (shape->heap_fields != 0) flags |= 16;
    if (shape->tagged_fields != 0) flags |= 32;
    for (u32 index = 0; index < shape->inline_count; index++) {
        MalFieldRepresentation representation =
            mal_shape_field_representation(shape->props[index].field);
        if (representation == MAL_FIELD_I32) flags |= 4;
        if (representation == MAL_FIELD_F64) flags |= 8;
    }
    return mal_value_from_i32(flags);
}

int main(int argc, char **argv) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalHostLaunchContext launch = {.argc = argc, .argv = argv};
    mal_vm_run_host_installs(&vm, &launch);
    if (!numeric_field_stores(&vm) || !widening_preserves_payload(&vm, false) ||
        !widening_preserves_payload(&vm, true)) {
        fputs("compact field-store or widening contract failed\n", stderr);
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
