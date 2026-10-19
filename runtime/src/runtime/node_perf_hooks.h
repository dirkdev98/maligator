#pragma once

#include "vm.h"

/* node:perf_hooks: user timing, observers, timerify, histograms and nodeTiming. */
void mal_host_install_node_perf_hooks(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
