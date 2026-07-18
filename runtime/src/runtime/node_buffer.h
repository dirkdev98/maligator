#pragma once

#include "vm.h"

/** Install the global Buffer constructor and the node:buffer module exports. */
void mal_host_install_node_buffer(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch
);

/**
 * Consume a malloc-compatible byte allocation and return a Buffer backed by it.
 * Ownership is consumed on success and failure. `bytes` may be null only when
 * `length` is zero. Installs the current realm's Buffer identity if necessary.
 */
MalValue mal_node_buffer_from_owned_bytes(MalVm *vm, byte *bytes, usize length);
