#pragma once

#include "vm.h"

/** The Node.js release whose API surface the runtime reports, without the leading "v". */
#define MAL_NODE_COMPAT_VERSION "26.12.0"

/** Publish a Node module's default object and requested named exports. */
void mal_node_module_publish(
    MalVm *vm, const char *id, const MalHostInstallSlot *slots, i32 count, MalValue module);

bool mal_node_module_install_cached(
    MalVm *vm, const char *id, const MalHostInstallSlot *slots, i32 count);

MalValue mal_node_module_get_cached(MalVm *vm, const char *id);

/** Throw `prototype` with `message` and a Node `code` property such as ERR_INVALID_ARG_TYPE. */
void mal_node_throw_code(MalVm *vm, MalIntrinsic prototype, const char *message, const char *code);

/**
 * Throw Node's system error for `err`: "CODE: description, syscall 'path' -> 'dest'"
 * with errno, code, syscall and the optional path and dest properties.
 */
void mal_node_throw_errno(
    MalVm *vm, int err, const char *syscall, const char *path, const char *dest);
MalValue mal_node_module_get_builtin(MalVm *vm, MalString *name);
