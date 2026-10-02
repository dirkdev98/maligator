#pragma once

#include "vm.h"

/** Publish a Node module's default object and requested named exports. */
void mal_node_module_publish(
    MalVm *vm, const char *id, const MalHostInstallSlot *slots, i32 count, MalValue module);

bool mal_node_module_install_cached(
    MalVm *vm, const char *id, const MalHostInstallSlot *slots, i32 count);

MalValue mal_node_module_get_cached(MalVm *vm, const char *id);
MalValue mal_node_module_get_builtin(MalVm *vm, MalString *name);
