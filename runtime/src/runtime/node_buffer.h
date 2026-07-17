#pragma once

#include "vm.h"

/** Install the global Buffer constructor and the node:buffer module exports. */
void mal_host_install_node_buffer(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch
);
