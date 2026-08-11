#pragma once

#include "vm.h"

/** Curated node:v8 flags surface used to configure VM-context behavior. */
void mal_host_install_node_v8(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
