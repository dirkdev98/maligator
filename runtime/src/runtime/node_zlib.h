#pragma once

#include "vm.h"

/* Decompression-only node:zlib installer. */
void mal_host_install_node_zlib(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
