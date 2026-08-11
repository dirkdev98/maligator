#pragma once

#include "vm.h"

/** Curated node:diagnostics_channel tracing fast path. */
void mal_host_install_node_diagnostics_channel(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
