#pragma once

#include "vm.h"

/** Install globalThis.mal and its configured-asset materialization API. */
void mal_host_install_maligator(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
