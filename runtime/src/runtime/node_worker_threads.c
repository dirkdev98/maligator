#include "node_worker_threads.h"

#if MAL_NODE

#include "gc.h"
#include "intrinsics.h"
#include "node_module.h"
#include "object.h"
#include "object_ops.h"
#include "value.h"

void mal_host_install_node_worker_threads(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    MalValue module = vm->intrinsics[MAL_INTRINSIC_NODE_WORKER_THREADS_MODULE];
    if (mal_value_is_undefined(module)) {
        module = mal_value_from_object(mal_intrinsic_new_object(vm));
        MalRootSpan root;
        mal_gc_root(&root, &module, 1);
        mal_intrinsic_define_data(vm, mal_value_to_object(module),
            "isMainThread", mal_value_new_boolean(true),
            MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE |
                MAL_PROPERTY_CONFIGURABLE);
        vm->intrinsics[MAL_INTRINSIC_NODE_WORKER_THREADS_MODULE] = module;
        mal_gc_unroot(&root);
    }
    mal_node_module_publish(vm, slots, count, module);
}

#endif /* MAL_NODE */
