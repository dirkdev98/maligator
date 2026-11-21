#pragma once

#include "vm.h"

/* Installs TransformStream, its controller, and the text streams. */
void mal_transform_stream_install(MalVm *vm, MalObject *global_this);

void mal_host_install_web_compression(MalVm *vm, const MalHostInstallSlot *slots,
    i32 count, const MalHostLaunchContext *launch);
