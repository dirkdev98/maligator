#pragma once

#include "vm.h"

/* querystring.parse(text) with the default separators and decoder. */
MalValue mal_node_querystring_parse(MalVm *vm, MalValue text);

void mal_host_install_node_querystring(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count,
    const MalHostLaunchContext *launch);
