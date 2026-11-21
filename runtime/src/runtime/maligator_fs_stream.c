#include "maligator_fs.h"

#include "function_object.h"
#include "intrinsics.h"
#include "vm_ops.h"
#include "web_surface.h"

static MalValue fs_readable_stream(MalVm *vm, MalValue self, const MalValue *args, i32 argc,
    MalValue nt, MalValue callee) {
    (void) self; (void) nt; (void) callee;
    MalObject *streams = mal_web_streams_ensure(vm);
    if (streams == nullptr) return mal_value_new_undefined();
    MalCompletion result = mal_vm_construct_value(
        vm, mal_web_group_export(vm, streams, "ReadableStream"), args, argc);
    if (result.kind == MAL_COMPLETION_THROW) vm->completion = result;
    return result.value;
}

void mal_host_install_maligator_internal_fs_stream(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch) {
    (void) launch;
    for (i32 i = 0; i < count; i++) {
        vm->globals[slots[i].slot] = mal_value_from_native_function_object(
            mal_native_function_object_new_arity(&vm->heap,
                mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
                mal_intrinsic_ascii(vm, "readableStream"), 2, fs_readable_stream));
    }
}
