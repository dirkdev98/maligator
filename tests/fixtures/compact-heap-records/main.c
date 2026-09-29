#include <stdio.h>

#include "function_object.h"
#include "gc.h"
#include "intrinsics.h"
#include "object_ops.h"
#include "vm.h"

extern const MalRuntimeImage mal_runtime_image;

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
