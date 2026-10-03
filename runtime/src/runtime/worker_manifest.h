#pragma once

#include "vm.h"

/* Replacement is allowed only after this VM's prior worker tree has joined. */
bool mal_worker_manifest_register(MalVm *vm, const char *path);
void mal_worker_manifest_clear(void);
