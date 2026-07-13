#include "./shadow_realm_object.h"

#if MAL_REALMS

MalShadowRealmObject *mal_shadow_realm_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalRealm *shadow_realm
) {
    MalShadowRealmObject *object =
        mal_heap_alloc(heap, sizeof(MalShadowRealmObject), MAL_HEAP_SHADOW_REALM_OBJECT);
    mal_object_init(heap, &object->object, MAL_HEAP_SHADOW_REALM_OBJECT, prototype);
    object->shadow_realm = shadow_realm;
    return object;
}

bool mal_value_is_shadow_realm_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_SHADOW_REALM_OBJECT);
}

MalShadowRealmObject *mal_value_to_shadow_realm_object(MalValue value) {
    return (MalShadowRealmObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_shadow_realm_object(MalShadowRealmObject *object) {
    return mal_value_from_heap((MalHeapHeader *) object);
}

#endif // MAL_REALMS
