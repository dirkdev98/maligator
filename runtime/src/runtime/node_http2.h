#pragma once

#include "vm.h"

void mal_host_install_node_http2(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
