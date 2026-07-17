#pragma once

#include "vm.h"

/* Native node:tty installer. The compiler references this symbol only when a
 * reached host-module export survives DCE. */
void mal_host_install_node_tty(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
