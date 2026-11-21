#pragma once

#include "vm.h"

/** Install globalThis.mal, the toolchain's internal bridge to its own native host. */
void mal_host_install_maligator(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
