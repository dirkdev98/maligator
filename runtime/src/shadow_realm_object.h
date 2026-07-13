#pragma once

#include "./defaults.h"

#if MAL_REALMS

#include "object.h"
#include "value.h"

/**
 * A ShadowRealm instance: an ordinary object plus its [[ShadowRealm]] internal
 * slot. The pointed-to realm is owned by the VM and is not a GC edge.
 */
typedef struct MalShadowRealmObject {
    MalObject object;
    MalRealm *shadow_realm;
} MalShadowRealmObject;

/** Allocate a ShadowRealm instance holding the VM-owned shadow realm. */
MalShadowRealmObject *mal_shadow_realm_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalRealm *shadow_realm
);

/** ShadowRealm instance value helpers. */
bool mal_value_is_shadow_realm_object(MalValue value);
MalShadowRealmObject *mal_value_to_shadow_realm_object(MalValue value);
MalValue mal_value_from_shadow_realm_object(MalShadowRealmObject *object);

#endif // MAL_REALMS
