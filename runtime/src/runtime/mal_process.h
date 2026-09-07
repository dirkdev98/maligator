#pragma once

#include "vm.h"

void mal_host_install_maligator_process(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
