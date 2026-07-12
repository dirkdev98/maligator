#pragma once

#include "vm.h"

/*
 * Native installer for the free global `process` (node compatibility surface).
 *
 * Matches the engine-neutral MalHostInstaller ABI (vm.h): the compiler emits a
 * direct reference to this symbol in a program's host-install manifest only when
 * `process` is actually reached (DCE), so an ordinary program never pulls this
 * translation unit in at link. The installer defines a writable/configurable
 * `globalThis.process`; the manifest normally carries zero export slots. It
 * exposes:
 *   - argv: [OS argv0, "<compiled>", OS argv1..] (the entry-module slot is a
 *     compile-time artifact the driver cannot see, so a stable placeholder stands
 *     in — see MalHostLaunchContext).
 *   - env: an enumerable snapshot of the process environment (reads / Object.keys
 *     / spread), taken once at install.
 *   - cwd(): the current working directory.
 *   - exit(code): terminate with a safe-integer status (default 0); invalid types
 *     and non-integral, non-finite, or unsafe numbers throw before termination.
 *
 * No node:process module, signals, streams, or metadata — only the four members
 * above. `launch` carries the OS command line (argc/argv) the driver's `main`
 * received; the driver threads its own argc/argv through mal_vm_run_host_installs.
 */
void mal_host_install_process(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
