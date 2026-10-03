#pragma once

#include "./defaults.h"

/* Synchronous capture and asynchronous spawn support inherited/ignored stdio;
 * fork is importable but rejects calls because subprocess IPC is unavailable. */

typedef struct MalVm MalVm;
typedef struct MalHostInstallSlot MalHostInstallSlot;
typedef struct MalHostLaunchContext MalHostLaunchContext;

void mal_host_install_node_child_process(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch
);
