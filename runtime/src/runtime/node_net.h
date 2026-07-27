#pragma once

#include "vm.h"

void mal_host_install_node_net(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);

bool mal_node_net_drain(MalVm *vm);
bool mal_node_net_start_tls(
    MalVm *vm, MalValue socket,
    const byte *server_name, usize server_name_length,
    const byte *ca_pem, usize ca_pem_length,
    const byte *alpn, usize alpn_length, bool insecure);
