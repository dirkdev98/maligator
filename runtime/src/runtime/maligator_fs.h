#pragma once

#include "vm.h"

/** Install `maligator:internal/fs`, the native layer under `maligator:fs`. */
void mal_host_install_maligator_internal_fs(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
