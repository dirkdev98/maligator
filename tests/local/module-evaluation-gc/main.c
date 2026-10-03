#include <stdio.h>

#include "gc.h"
#include "intrinsics.h"
#include "object_ops.h"
#include "vm.h"
#include "vm_ops.h"

extern const MalRuntimeImage mal_runtime_image;

static MalValue collection_count(MalVm *vm, MalValue receiver, const MalValue *args,
    i32 argc, MalValue new_target, MalValue callee) {
    (void) receiver; (void) args; (void) argc; (void) new_target; (void) callee;
    return mal_value_from_f64((f64) mal_gc_collection_count(vm));
}

int main(void) {
    MalVm vm;
    mal_vm_init(&vm, &mal_runtime_image);
    MalObject *global = mal_value_to_object(vm.intrinsics[MAL_INTRINSIC_GLOBAL_THIS]);
    mal_intrinsic_define_method(&vm, global, "__moduleGcCount", collection_count);
    MalCallable *entry = mal_vm_create_callable(&vm, 0);
    mal_vm_run(&vm, entry);
    MalValue finished = mal_value_new_undefined();
    bool ok = vm.completion.kind == MAL_COMPLETION_NORMAL && vm.gc_native_frames == 0 &&
        mal_vm_get_property(&vm, mal_value_from_object(global),
            mal_intrinsic_string_key(&vm, "moduleGcFinished"), &finished) &&
        mal_value_is_boolean(finished) && mal_value_to_boolean(finished);
    mal_vm_free_callable(entry);
    mal_vm_free(&vm);
    if (!ok) return 1;
    puts("module-evaluation-gc PASS");
    return 0;
}
