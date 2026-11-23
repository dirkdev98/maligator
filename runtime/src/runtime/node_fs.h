#pragma once

#include "vm.h"

/* Bind named filesystem operations without installing stream prototypes. */
void mal_host_install_node_fs_named(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
void mal_host_install_node_fs_read_stream(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
void mal_host_install_node_fs_read_file(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);

/* Install the complete node:fs module for default and dynamic imports. */
void mal_host_install_node_fs(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch
);

/** Host installer for the promise-based filesystem submodule. */
void mal_host_install_node_fs_promises(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch
);
