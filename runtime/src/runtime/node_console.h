#pragma once

#include "vm.h"

/* Native node:console installer: the global console plus its Console class. */
void mal_host_install_node_console(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
