#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Install the DataView constructor and DataView.prototype.
 */
void mal_builtin_data_view_install(MalVm *vm);
