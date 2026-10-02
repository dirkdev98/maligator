#pragma once

#include "vm.h"

/* HTTPS request/get share the streamed HTTP transport with verified TLS. */
void mal_host_install_node_https(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);

/* Unsupported TLS constraints must fail before opening a connection. */
bool mal_node_https_validate_options(MalVm *vm, MalValue options, bool agent, MalValue default_agent);
