#pragma once

#include "./defaults.h"
#include "function_object.h"
#include "temporal_object.h"
#include "value.h"

typedef struct MalVm MalVm;

/** Entry points the Temporal component offers to built-ins outside Temporal. */
typedef struct MalTemporalOperations {
    /** Free an object's temporal_rs handle. */
    void (*release)(MalTemporalKind kind, void *handle);
    /** Read a Temporal.Duration's units, years through nanoseconds; false for other objects. */
    bool (*duration_units)(const MalTemporalObject *object, f64 units[10]);
    /** Date.prototype.toTemporalInstant, which Date defines when Temporal is installed. */
    MalNativeFunctionCallback date_to_temporal_instant;
} MalTemporalOperations;

/** Install the Temporal namespace. */
void mal_temporal_install(MalVm *vm);

extern const MalTemporalOperations mal_temporal_operations;
