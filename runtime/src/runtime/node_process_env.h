#pragma once

#include "vm.h"

char **mal_process_environ(void);
void mal_process_define_env(MalVm *vm, MalObject *process);
void mal_host_install_process_env(
    MalVm *vm,
    const MalHostInstallSlot *slots,
    i32 count,
    const MalHostLaunchContext *launch
);
