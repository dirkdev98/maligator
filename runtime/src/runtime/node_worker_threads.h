#pragma once

#include "vm.h"

/** node:worker_threads over the native worker isolates in workers.h. */
void mal_host_install_node_worker_threads(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
