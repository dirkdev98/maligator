#pragma once

#include "vm.h"

/* Installers for Node's legacy aliases: node:constants, node:sys and node:punycode. */
void mal_host_install_node_constants(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
void mal_host_install_node_sys(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
void mal_host_install_node_punycode(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
