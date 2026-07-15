#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/** Create the JSON namespace object with stringify and parse. */
void mal_builtin_json_install(MalVm *vm);
