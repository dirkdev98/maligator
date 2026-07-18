#pragma once

#include "vm.h"

/* Express-compatible node:http surface backed by the host HTTP listener. */
void mal_host_install_node_http(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);

/* Run at most one queued server lifecycle event as a runtime macrotask. */
bool mal_node_http_drain(MalVm *vm);
