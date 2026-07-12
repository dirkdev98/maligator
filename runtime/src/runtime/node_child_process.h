#pragma once

#include "./defaults.h"

/*
 * node:child_process host built-in (runtime layer, behind surface.node / MAL_NODE).
 *
 * A deliberately tiny slice: only the synchronous, no-shell
 * execFileSync(file[, args][, options]), exposed as the module's single named
 * export. It is the child-spawning primitive the compiler's own build pipeline
 * (src/local-build.ts, src/rust-build.ts, src/index.ts, …) leans on.
 *
 * Options honored: `cwd`; an explicit, fully enumerable `env` object (its own
 * enumerable string-keyed properties become the child's entire environment —
 * nothing is inherited); `stdio` as one of "pipe" / "inherit" / "ignore" (a
 * string, or a 3-element array per stream); `input` fed to stdin; and `encoding`
 * — UTF-8 captured stdout is returned as a string. Streams left at the default
 * ("pipe") are captured; "inherit"/"ignore" return null.
 *
 * A nonzero exit or a terminating signal throws an Error carrying `.status`
 * (exit code | null) and `.signal` (name | null) — the fields the compiler reads
 * — plus `.stdout`/`.stderr`. A launch failure (missing executable, bad cwd)
 * throws an Error carrying `.code`/`.errno`/`.syscall`/`.path`.
 * Executable, argument, cwd, and environment strings containing embedded NULs
 * are rejected before reaching the host layer.
 *
 * All syscalls live in the host layer (runtime/src/host/posix_process.h); this
 * layer only marshals MalValues to/from that request/result — no fork/exec here.
 */

typedef struct MalVm MalVm;
typedef struct MalHostInstallSlot MalHostInstallSlot;
typedef struct MalHostLaunchContext MalHostLaunchContext;

/**
 * Fill the `node:child_process` export slots (only `execFileSync`) with their
 * native values. Matches the engine-neutral MalHostInstaller ABI (see
 * runtime/src/vm.h): the emitted host-install manifest references this symbol for
 * a program that imports `execFileSync` from `node:child_process`. Any slot whose
 * name is not `execFileSync` is left untouched.
 */
void mal_host_install_node_child_process(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch
);
