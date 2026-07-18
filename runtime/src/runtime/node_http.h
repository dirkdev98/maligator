#pragma once

#include "vm.h"

/* Express-compatible node:http initialization floor; no networking lifecycle. */
void mal_host_install_node_http(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
