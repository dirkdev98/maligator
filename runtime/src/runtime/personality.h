#pragma once

#include "vm.h"

/*
 * Apply a host personality the driver chose itself, such as a universal development
 * binary applying the surfaces its images request. Links every personality.
 */
void mal_runtime_personality_install(MalVm *vm, bool web_platform, bool node);

/*
 * The host personalities a compiled image lists first in its install table, so a
 * program links only its own: the web one for web use, the Node and web one, which
 * adds immediates and Node's console and host behaviour, for Node use. Each applies
 * once per isolate: a personality the driver already applied wins.
 */
void mal_host_install_web_personality(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
void mal_host_install_node_personality(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
void mal_host_install_node_web_personality(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, const MalHostLaunchContext *launch);
