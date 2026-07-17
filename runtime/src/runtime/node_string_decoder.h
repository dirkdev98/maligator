#pragma once

#include "vm.h"

/** Install the curated node:string_decoder module exports. */
void mal_host_install_node_string_decoder(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch
);
