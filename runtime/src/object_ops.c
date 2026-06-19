#include "object_ops.h"

#include <stdlib.h>

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

/** Default data-property attribute set (writable + enumerable + configurable). */
static const MalPropertyFlags MAL_DEFAULT_DATA_FLAGS =
    MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE;

/**
 * Cap on inline shape slots (gc_todo.md Step 11.4). Beyond this an object drops
 * to dictionary mode: shape lookup is a linear scan, so large objects (e.g.
 * Array.prototype) are faster as a hash table, and the cap also bounds shape-tree
 * growth under churn.
 */
#define MAL_SHAPE_MAX_INLINE_SLOTS 32

static MalPropertyDesc mal_object_data_desc(MalValue value, MalPropertyFlags flags) {
    return (MalPropertyDesc){
        .flags = flags,
        .value = value,
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
}

/** Whether a descriptor is a plain default data property (shape-eligible). */
static bool mal_object_desc_is_default_data(const MalPropertyDesc *desc) {
    return (desc->flags & MAL_PROPERTY_ACCESSOR) == 0
        && (desc->flags & MAL_DEFAULT_DATA_FLAGS) == MAL_DEFAULT_DATA_FLAGS;
}

/** Lazily create and return the object's dictionary/overflow table. */
static MalTable *mal_object_ensure_overflow(MalObject *object) {
    if (object->overflow == nullptr) {
        object->overflow = mal_table_new(MAL_TABLE_MODE_OBJECT);
    }
    return object->overflow;
}

/**
 * Drop a shaped object to dictionary mode: migrate each inline slot into the
 * overflow table (preserving insertion order via the shape's slot order), then
 * clear the shape and slots. A no-op for an already-empty-shape object. After
 * this the object behaves exactly as the pre-shapes table-only representation.
 */
static void mal_object_dictionarize(MalObject *object) {
    if (object->shape->inline_count == 0) {
        return;
    }
    MalShape *shape = object->shape;
    MalTable *table = mal_object_ensure_overflow(object);
    for (u32 i = 0; i < shape->inline_count; ++i) {
        const MalShapeProp *prop = &shape->props[i];
        MalPropertyDesc desc = mal_object_data_desc(object->slots[prop->slot], prop->attrs);
        mal_property_define(table, prop->key, &desc);
    }
    object->shape = mal_shape_empty();
    object->slots = nullptr; // leaked until the GC exists (Phase 3); no free path yet
}

MalTable *mal_object_properties(MalObject *object) {
    // The table view must reflect every property, so a shaped object is dropped
    // to dictionary mode first. Callers (seal/freeze, array length, Reflect-style
    // direct set) already imply or tolerate dictionarization.
    mal_object_dictionarize(object);
    return mal_object_ensure_overflow(object);
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
    // Shaped string property: synthesize a data descriptor from the inline slot.
    if (key.kind == MAL_KEY_STRING) {
        i32 idx = mal_shape_find(object->shape, key);
        if (idx >= 0) {
            const MalShapeProp *prop = &object->shape->props[idx];
            return (MalPropertyLookup){
                .present = true,
                .entry = nullptr, // shaped props have no table entry
                .desc = mal_object_data_desc(object->slots[prop->slot], prop->attrs),
            };
        }
    }
    // Index/symbol keys and dictionary-mode objects live in the overflow table.
    if (object->overflow != nullptr) {
        return mal_property_lookup(object->overflow, key);
    }
    return (MalPropertyLookup){.present = false, .entry = nullptr};
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
    // Shape fast path: a default data property under a string key.
    if (key.kind == MAL_KEY_STRING && mal_object_desc_is_default_data(desc)) {
        i32 idx = mal_shape_find(object->shape, key);
        if (idx >= 0) {
            // Existing shaped data property (always writable+configurable): a
            // default-data redefine is compatible, so just update the value.
            object->slots[object->shape->props[idx].slot] = desc->value;
            return MAL_DEFINE_OWN_APPLIED;
        }
        if (object->overflow == nullptr
            && object->shape->inline_count < MAL_SHAPE_MAX_INLINE_SLOTS) {
            // Pure shaped (or empty) object with no dictionary props: grow the
            // shape and the inline slots. Object identity is the cell address, so
            // reallocating the slots buffer is sound.
            if (!object->extensible) {
                return MAL_DEFINE_OWN_REJECTED;
            }
            MalShape *child =
                mal_shape_add_property(object->shape, key, (u8) MAL_DEFAULT_DATA_FLAGS);
            u32 count = child->inline_count;
            object->slots = realloc(object->slots, sizeof(MalValue) * count);
            object->slots[count - 1] = desc->value;
            object->shape = child;
            return MAL_DEFINE_OWN_APPLIED;
        }
        // Object already carries dictionary props: fall through to the table path.
    }

    // Dictionary path (non-default attrs, accessor, index/symbol key, or an object
    // already in dictionary mode): operate on the overflow table as before.
    mal_object_dictionarize(object);
    MalTable *table = mal_object_ensure_overflow(object);
    MalPropertyLookup lookup = mal_property_lookup(table, key);

    if (!lookup.present) {
        if (!object->extensible) {
            return MAL_DEFINE_OWN_REJECTED;
        }
        mal_property_define(table, key, desc);
        return MAL_DEFINE_OWN_APPLIED;
    }

    if (!mal_object_define_is_compatible(lookup.desc, *desc)) {
        return MAL_DEFINE_OWN_REJECTED;
    }

    mal_property_write_entry(table, lookup.entry, desc);
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

    // A shape is a fixed layout, so removing a shaped property drops the object
    // to dictionary mode first, then deletes from the table.
    if (key.kind == MAL_KEY_STRING && mal_shape_find(object->shape, key) >= 0) {
        mal_object_dictionarize(object);
    }
    if (object->overflow != nullptr) {
        return mal_table_delete(object->overflow, key);
    }
    return true;
}

bool mal_object_set(MalObject *object, MalKey key, MalValue value) {
    MalPropertyResolution resolution = mal_object_resolve_property(object, key);

    if (!resolution.found) {
        if (!object->extensible) {
            return false;
        }

        MalPropertyDesc desc = mal_object_data_desc(value, MAL_DEFAULT_DATA_FLAGS);
        mal_object_define_own(object, key, &desc);
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

        MalPropertyDesc desc = mal_object_data_desc(value, MAL_DEFAULT_DATA_FLAGS);
        mal_object_define_own(object, key, &desc);
        return true;
    }

    // Own writable data property. Fast path: write the inline slot directly.
    if (key.kind == MAL_KEY_STRING) {
        i32 idx = mal_shape_find(object->shape, key);
        if (idx >= 0) {
            object->slots[object->shape->props[idx].slot] = value;
            return true;
        }
    }

    resolution.desc.value = value;
    mal_object_define_own(object, key, &resolution.desc);

    return true;
}
