#pragma once

#include "vm.h"

/*
 * The native `node:fs` synchronous surface (runtime layer). This TU owns all JS
 * marshalling — coercing arguments, building result values (strings, Stats /
 * Dirent objects, arrays), and translating errno into Node-shaped Errors — and
 * rejecting embedded NUL in paths before delegating syscalls to the host layer
 * (posix_fs.c). Only the *Sync methods
 * this slice needs: existsSync, readFileSync (UTF-8), writeFileSync (string or
 * Uint8Array), statSync, readdirSync ({ withFileTypes }), mkdirSync, and the
 * copy/realpath/mkdtemp/rm operations used by compiler caches. No async / fd /
 * stream API.
 *
 * Keeping the whole surface in one translation unit preserves module dead-code
 * elimination: nothing else references this object, so unless a program imports
 * `node:fs` (which makes the emitted host-install manifest reference
 * mal_host_install_node_fs) neither this nor posix_fs.c is pulled from the archive.
 */

/*
 * Host installer for `node:fs`. Fills each requested export's global slot with the
 * matching native function. Engine-neutral MalHostInstaller ABI (see vm.h); the
 * emitted install manifest references it by name for any reached `node:fs` import.
 */
void mal_host_install_node_fs(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch
);
