#pragma once

#include "vm.h"

/* Native node:async_hooks installer. The compiler references this symbol only
 * when the curated AsyncResource export survives DCE. */
void mal_host_install_node_async_hooks(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
