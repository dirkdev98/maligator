#pragma once

#include "./defaults.h"

typedef struct MalVm MalVm;

/** Install the Stage 4 Temporal namespace when MAL_TEMPORAL is enabled. */
void mal_builtin_temporal_install(MalVm *vm);

