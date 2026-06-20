#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalVm MalVm;

/**
 * A WeakRef instance: an ordinary object plus the [[WeakRefTarget]] slot, held
 * WEAKLY. The collector does not trace `target`; instead it registers a reached
 * WeakRef on its weak worklist and, after marking, sets `target` to undefined if
 * the target did not survive. So `deref()` returns the target while it is live
 * and undefined once it has been collected.
 */
typedef struct MalWeakRefObject {
    MalObject object;
    MalValue target;
} MalWeakRefObject;

/**
 * Install the WeakRef constructor and WeakRef.prototype.
 */
void mal_builtin_weak_ref_install(MalVm *vm);
