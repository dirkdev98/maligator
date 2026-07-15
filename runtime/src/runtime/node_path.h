#pragma once

#include "./defaults.h"

typedef struct MalVm MalVm;
typedef struct MalHostInstallSlot MalHostInstallSlot;
typedef struct MalHostLaunchContext MalHostLaunchContext;

/**
 * Host installer for the `node:path` built-in (POSIX semantics), implemented
 * behind surface.node / MAL_NODE. Matches the
 * engine-neutral MalHostInstaller ABI (see vm.h): fills the export global slots
 * the emitted manifest hands it — the named functions `basename`, `dirname`,
 * `extname`, `isAbsolute`, `join`, `relative`, `resolve`, the POSIX `delimiter`
 * and `sep` constants, and a `default` object carrying the same values. The
 * `launch` context is unused here. Referenced by name from the emitted install
 * manifest (mal_host_install_node_path); the compiler's dead-code elimination
 * keeps the whole module TU out of programs that never import `node:path`.
 */
void mal_host_install_node_path(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch
);
