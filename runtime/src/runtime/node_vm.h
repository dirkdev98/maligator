#pragma once

#include "vm.h"

/** Curated node:vm isolated-context execution surface. */
void mal_host_install_node_vm(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
