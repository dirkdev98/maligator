#pragma once

#include "./defaults.h"
#include "value.h"

typedef struct MalVm MalVm;

/** Install the Stage 4 Temporal namespace when MAL_TEMPORAL is enabled. */
void mal_builtin_temporal_install(MalVm *vm);

/** Create a Temporal.Instant directly from an integral Date time value. */
MalValue mal_builtin_temporal_instant_from_epoch_milliseconds(
    MalVm *vm,
    f64 milliseconds
);
