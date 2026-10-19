#pragma once

#include "vm.h"

void mal_host_install_node_dns(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);

void mal_host_install_node_dns_promises(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);

/* Callback-style dns.lookup(hostname, options, callback), for modules that resolve names as Node's call it. */
MalValue mal_node_dns_lookup(MalVm *vm, const MalValue *args, i32 argc);
