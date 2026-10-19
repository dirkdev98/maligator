#pragma once

#include "vm.h"

/* node:zlib installer: deflate, gzip and Brotli codecs over the Rust backend. */
void mal_host_install_node_zlib(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
