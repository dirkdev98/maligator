#pragma once

#include "vm.h"

/* Curated node:perf_hooks performance clock. */
void mal_host_install_node_perf_hooks(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
