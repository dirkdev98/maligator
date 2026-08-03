#pragma once

#include "vm.h"

void mal_host_install_node_sqlite(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
