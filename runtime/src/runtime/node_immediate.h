#pragma once

#include "vm.h"

typedef struct MalObject MalObject;

/* Install and tear down the Node setImmediate/clearImmediate global queue. */
void mal_node_immediates_install(MalVm *vm, MalObject *global_this);
void mal_node_immediates_free(MalVm *vm);
