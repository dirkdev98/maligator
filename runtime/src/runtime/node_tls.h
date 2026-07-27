#pragma once

#include "vm.h"

/* Loadable node:tls boundary; socket TLS is a subsequent compatibility slice. */
void mal_host_install_node_tls(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
