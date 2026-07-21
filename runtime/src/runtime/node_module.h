#pragma once

#include "vm.h"

/** Publish a Node module's default object and requested named exports. */
void mal_node_module_publish(
    MalVm *vm, const MalHostInstallSlot *slots, i32 count, MalValue module);
