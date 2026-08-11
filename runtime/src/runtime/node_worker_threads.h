#pragma once

#include "vm.h"

/** Single-process node:worker_threads identity surface. */
void mal_host_install_node_worker_threads(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
