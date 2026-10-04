#pragma once

#include "vm.h"

/* Installs a retained domain on this VM; earlier children and URLs keep theirs. */
bool mal_worker_manifest_register(MalVm *vm, const char *path);
