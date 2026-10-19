#pragma once

#include "vm.h"

void mal_host_install_node_dns(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);

void mal_host_install_node_dns_promises(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
