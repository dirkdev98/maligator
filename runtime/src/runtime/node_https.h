#pragma once

#include "vm.h"

/* Loadable node:https boundary. TLS HTTP requests remain an explicit gap. */
void mal_host_install_node_https(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
