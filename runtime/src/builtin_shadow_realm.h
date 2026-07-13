#pragma once

#include "./defaults.h"

#if MAL_REALMS

#include "intrinsics.h"

typedef struct MalVm MalVm;

/**
 * Install the ShadowRealm constructor and prototype into caller-provided
 * intrinsic slots. The embedding remains responsible for exposing the
 * constructor on the global object.
 */
void mal_builtin_shadow_realm_install(
    MalVm *vm,
    MalIntrinsic constructor_slot,
    MalIntrinsic prototype_slot
);

#endif // MAL_REALMS
