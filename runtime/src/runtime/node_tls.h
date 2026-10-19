#pragma once

#include "vm.h"

void mal_host_install_node_tls(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
/* Stores tls.Server credentials and policy on `server`, which listen turns into a config. */
bool mal_node_tls_server_setup(MalVm *vm, MalValue server, MalValue options);
