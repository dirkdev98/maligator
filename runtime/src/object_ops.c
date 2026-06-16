#include "object_ops.h"

#include "value_ops.h"

static bool mal_object_desc_is_accessor(MalPropertyDesc desc) {
    return (desc.flags & MAL_PROPERTY_ACCESSOR) != 0;
}

static bool mal_object_desc_is_configurable(MalPropertyDesc desc) {
    return (desc.flags & MAL_PROPERTY_CONFIGURABLE) != 0;
}

static bool mal_object_desc_is_enumerable(MalPropertyDesc desc) {
    return (desc.flags & MAL_PROPERTY_ENUMERABLE) != 0;
}

static bool mal_object_desc_is_writable(MalPropertyDesc desc) {
    return (desc.flags & MAL_PROPERTY_WRITABLE) != 0;
}

static bool mal_object_define_is_compatible(MalPropertyDesc current, MalPropertyDesc next) {
    if (mal_object_desc_is_configurable(current)) {
        return true;
    }

    if (mal_object_desc_is_configurable(next)) {
        return false;
    }

    if (mal_object_desc_is_enumerable(current) != mal_object_desc_is_enumerable(next)) {
        return false;
    }

    if (mal_object_desc_is_accessor(current) != mal_object_desc_is_accessor(next)) {
        return false;
    }

    if (mal_object_desc_is_accessor(current)) {
        return current.getter == next.getter && current.setter == next.setter;
    }

    if (!mal_object_desc_is_writable(current)) {
        if (mal_object_desc_is_writable(next)) {
            return false;
        }

        // SameValue, not bitwise: equal-but-distinct strings/BigInts (which are
        // not interned) must compare equal so a no-op redefinition is allowed.
        if (!mal_ops_same_value(current.value, next.value)) {
            return false;
        }
    }

    return true;
}

MalTable *mal_object_properties(MalObject *object) {
    return object->properties;
}

bool mal_object_is_extensible(const MalObject *object) {
    return object->extensible;
}

void mal_object_set_extensible(MalObject *object, bool extensible) {
    object->extensible = extensible;
}

MalObject *mal_object_get_prototype(const MalObject *object) {
    return object->prototype;
}

bool mal_object_set_prototype(MalObject *object, MalObject *prototype) {
    if (object->prototype == prototype) {
        return true;
    }

    if (!object->extensible) {
        return false;
    }

    for (MalObject *cursor = prototype; cursor != nullptr; cursor = cursor->prototype) {
        if (cursor == object) {
            return false;
        }
    }

    object->prototype = prototype;
    return true;
}

MalPropertyLookup mal_object_get_own(const MalObject *object, MalKey key) {
    return mal_property_lookup(object->properties, key);
}

MalPropertyResolution mal_object_resolve_property(const MalObject *object, MalKey key) {
    for (const MalObject *cursor = object; cursor != nullptr; cursor = cursor->prototype) {
        MalPropertyLookup lookup = mal_object_get_own(cursor, key);

        if (lookup.present) {
            return (MalPropertyResolution) {
                .found = true,
                .own = cursor == object,
                .holder = (MalObject *) cursor,
                .desc = lookup.desc,
            };
        }
    }

    return (MalPropertyResolution) {.found = false, .own = false, .holder = nullptr};
}

MalDefineOwnStatus mal_object_define_own(MalObject *object, MalKey key, const MalPropertyDesc *desc) {
    MalPropertyLookup lookup = mal_object_get_own(object, key);

    if (!lookup.present) {
        if (!object->extensible) {
            return MAL_DEFINE_OWN_REJECTED;
        }

        mal_property_define(object->properties, key, desc);
        return MAL_DEFINE_OWN_APPLIED;
    }

    if (!mal_object_define_is_compatible(lookup.desc, *desc)) {
        return MAL_DEFINE_OWN_REJECTED;
    }

    mal_property_write_entry(object->properties, lookup.entry, desc);
    return MAL_DEFINE_OWN_APPLIED;
}

bool mal_object_delete_own(MalObject *object, MalKey key) {
    MalPropertyLookup lookup = mal_object_get_own(object, key);

    if (!lookup.present) {
        return true;
    }

    if (!mal_object_desc_is_configurable(lookup.desc)) {
        return false;
    }

    return mal_table_delete(object->properties, key);
}

bool mal_object_set(MalObject *object, MalKey key, MalValue value) {
    MalPropertyResolution resolution = mal_object_resolve_property(object, key);

    if (!resolution.found) {
        if (!object->extensible) {
            return false;
        }

        mal_property_set_value(object->properties, key, value);
        return true;
    }

    if (mal_object_desc_is_accessor(resolution.desc)) {
        return false;
    }

    if (!mal_object_desc_is_writable(resolution.desc)) {
        return false;
    }

    if (!resolution.own) {
        if (!object->extensible) {
            return false;
        }

        mal_property_set_value(object->properties, key, value);
        return true;
    }

    resolution.desc.value = value;
    mal_object_define_own(object, key, &resolution.desc);

    return true;
}
