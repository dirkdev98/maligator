#pragma once

#include "./defaults.h"

/* Node child processes support synchronous capture and asynchronous inherited/ignored stdio. */

typedef struct MalVm MalVm;
typedef struct MalHostInstallSlot MalHostInstallSlot;
typedef struct MalHostLaunchContext MalHostLaunchContext;

void mal_host_install_node_child_process(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch
);
