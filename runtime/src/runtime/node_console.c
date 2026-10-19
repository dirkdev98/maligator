#include "node_console.h"

#if MAL_NODE

#include "builtin_console.h"
#include "node_module.h"

void mal_host_install_node_console(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch) {
    (void) launch;
    if (mal_node_module_install_cached(vm, "node:console", slots, count)) return;
    mal_builtin_console_install_class(vm);
    mal_node_module_publish(vm, "node:console", slots, count, vm->intrinsics[MAL_INTRINSIC_CONSOLE]);
}

#endif /* MAL_NODE */
