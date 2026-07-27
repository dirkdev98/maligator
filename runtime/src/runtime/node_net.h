#pragma once

#include "vm.h"

void mal_host_install_node_net(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);

bool mal_node_net_drain(MalVm *vm);
