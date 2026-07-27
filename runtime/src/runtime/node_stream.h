#pragma once

#include "vm.h"

/* Curated in-memory node:stream installer. */
void mal_host_install_node_stream(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);

/* Complete a host-backed readable after its final queued chunk was delivered. */
void mal_node_stream_end_readable(MalVm *vm, MalValue receiver);
