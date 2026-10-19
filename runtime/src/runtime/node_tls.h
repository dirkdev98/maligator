#pragma once

#include "vm.h"

void mal_host_install_node_tls(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
/* Stores tls.Server credentials and policy on `server`, which listen turns into a config. */
bool mal_node_tls_server_setup(MalVm *vm, MalValue server, MalValue options);
MalValue mal_node_tls_server_add_context(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee);
MalValue mal_node_tls_server_set_secure_context(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 argc, MalValue new_target, MalValue callee);
