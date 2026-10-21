#include "object_ops.h"

#include <assert.h>
#include <stdlib.h>

#include "array_object.h"
#include "gc.h"
#include "heap_symbol.h"
#include "perf_stats.h"
#include "value_ops.h"
#include "vm.h"

/** Zero is the permanently exhausted state, matching the prototype-chain epoch. */
static void mal_semantic_epoch_bump(u64 *epoch) {
    if (*epoch == 0) return;
    *epoch = *epoch == UINT64_MAX ? 0 : *epoch + 1;
}

void mal_invalidate_array_elements_protector(void) {
    mal_array_elements_protector = false;
    // Object mutation binds the owning mutator's heap before invalidating its epochs.
    MalSemanticEpochs *epochs = &mal_vm_from_heap(mal_gc_current_heap())->semantic_epochs;
    mal_semantic_epoch_bump(&epochs->activity);
    mal_semantic_epoch_bump(&epochs->array_elements);
}

void mal_invalidate_primitive_method_protector(void) {
    mal_primitive_method_protector = false;
    MalSemanticEpochs *epochs = &mal_vm_from_heap(mal_gc_current_heap())->semantic_epochs;
    mal_semantic_epoch_bump(&epochs->activity);
    mal_semantic_epoch_bump(&epochs->watched_methods);
}

/* A descriptor can introduce young edges through value, getter, or setter. */
static inline void mal_gc_card_desc(MalHeapHeader *owner, const MalPropertyDesc *desc) {
    mal_gc_card(owner, desc->value);
    mal_gc_card(owner, desc->getter);
    mal_gc_card(owner, desc->setter);
}

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

/* MAL_SHAPE_MAX_INLINE_SLOTS is defined in shape.h (shared with the static
 * object-literal shape builder). */

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
    if (mal_object_overflow(object) == nullptr) {
        mal_object_set_overflow_pointer(
            object, mal_table_new());
    }
    return mal_object_overflow(object);
}

/** Shaped objects keep private elements in their shape; dictionaries keep them in the table. */
static bool mal_object_shapes_private(const MalObject *object) {
    return !mal_object_has_public_overflow(object) &&
        object->shape != mal_shape_dictionary_empty();
}

MalValue *mal_object_private_value_slot(MalObject *object, MalSymbol *symbol) {
    MalValue key = mal_value_from_symbol(symbol);
    i32 index = mal_shape_find(
        object->shape, (MalKey) {.kind = MAL_KEY_SYMBOL, .value = key}, MAL_SHAPE_FIND_GET_OWN);
    if (index >= 0) {
        symbol->private_entry_hint = (u32) index + 1;
        return &((MalValue *) mal_object_fields_nonempty(object))[index];
    }
    return mal_table_private_value_slot(mal_object_overflow(object), symbol);
}

bool mal_object_get_private(MalObject *object, MalSymbol *symbol, MalValue *value) {
    const MalValue *slot = mal_object_private_value_slot(object, symbol);
    if (slot == nullptr) return false;
    *value = *slot;
    return true;
}

bool mal_object_add_private(MalObject *object, MalKey key, MalValue value) {
    assert(key.kind == MAL_KEY_SYMBOL &&
           mal_symbol_is_private(mal_value_to_symbol(key.value)));
    // Only this function adds private names to shapes, after proving them absent, so
    // an existing transition proves the name is not already in the source shape.
    MalShape *child =
        mal_shape_find_add_transition(object->shape, key, (u8) MAL_PROPERTY_WRITABLE);
    if (child == nullptr && mal_shape_find(object->shape, key, MAL_SHAPE_FIND_DEFINE_OWN) >= 0) {
        return false;
    }
    // PrivateFieldAdd ignores [[Extensible]], so frozen receivers still gain slots.
    if (!mal_value_to_symbol(key.value)->private_table_resident &&
        mal_object_shapes_private(object) && mal_object_can_add_shaped_property(object) &&
        (mal_object_overflow(object) == nullptr ||
         !mal_table_lookup(mal_object_overflow(object), key).present)) {
        if (child == nullptr) {
            child = mal_shape_add_property(object->shape, key, (u8) MAL_PROPERTY_WRITABLE);
        }
        u32 count = child->inline_count;
        mal_object_grow_slots(object, object->shape->inline_count, count);
        mal_object_field_initialize(object, child, count - 1, value);
        object->shape = child;
        mal_value_to_symbol(key.value)->private_entry_hint = count;
        mal_gc_card(&object->header, key.value);
        return true;
    }
    bool private_only = !mal_object_has_public_overflow(object);
    MalTable *table = mal_object_ensure_overflow(object);
    MalPropertyDesc desc = mal_object_data_desc(value, MAL_PROPERTY_WRITABLE);
    MalPropertyEnsure ensured = mal_property_ensure(table, key, &desc);
    object->overflow_private_only = private_only;
    if (!ensured.inserted) return false;
    mal_gc_card_desc(&object->header, &desc);
    mal_gc_card(&object->header, key.value);
    return true;
}

bool mal_object_reserve_private(MalObject *object, usize additional) {
    if (mal_object_shapes_private(object)) {
        usize count = object->shape->inline_count + additional;
        if (count > MAL_SHAPE_MAX_INLINE_SLOTS) count = MAL_SHAPE_MAX_INLINE_SLOTS;
        mal_object_grow_slots(object, object->shape->inline_count, (u32) count);
        return true;
    }
    bool private_only = !mal_object_has_public_overflow(object);
    MalTable *table = mal_object_ensure_overflow(object);
    object->overflow_private_only = private_only;
    return mal_table_reserve(table, mal_table_size(table) + additional);
}

/**
 * Drop a shaped object to dictionary mode: migrate each inline slot into the
 * overflow table (preserving insertion order via the shape's slot order), then
 * clear the shape and slots. A no-op for an already-empty-shape object. After
 * this the object behaves exactly as the pre-shapes table-only representation.
 */
static void mal_object_dictionarize(MalObject *object) {
    if (object->shape->inline_count == 0) {
        object->overflow_private_only = false;
        return;
    }
    if (mal_object_note_prototype_mutation(object)) {
        MAL_PERF_COUNT(prototype_epoch_dictionary_invalidations);
    }
    MalShape *shape = object->shape;
    MalTable *table = mal_object_ensure_overflow(object);
    for (u32 i = 0; i < shape->inline_count; ++i) {
        const MalShapeProp *prop = &shape->props[i];
        MalPropertyDesc desc = mal_object_data_desc(mal_object_field_load(object, prop->slot), prop->attrs);
        mal_property_define(table, mal_key_from_value(prop->key), &desc);
    }
    object->shape = mal_shape_dictionary_empty();
    object->overflow_private_only = false;
    // The values now live in the table. Separately-owned buffers are freed;
    // coallocated storage remains part of the managed object cell.
    mal_object_record_slot_dictionary_migration(object);
    mal_object_release_slots(object);
}

/**
 * Move a full shape's private elements into a private-only table and rebuild the
 * shape from its public properties, so a class with many private fields keeps its
 * public ones shaped. Returns false when the shape holds no private element.
 */
static bool mal_object_evict_shaped_private(MalObject *object) {
    const MalShape *shape = object->shape;
    u32 count = shape->inline_count;
    bool shaped_private = false;
    for (u32 i = 0; i < count && !shaped_private; i++) {
        shaped_private = !mal_value_is_string(shape->props[i].key);
    }
    if (!shaped_private || shape->tree_root == nullptr) return false;
    MAL_PERF_COUNT(shape_private_evictions);
    if (mal_object_note_prototype_mutation(object)) {
        MAL_PERF_COUNT(prototype_epoch_define_invalidations);
    }
    MalTable *table = mal_object_ensure_overflow(object);
    MalShape *public_shape = shape->tree_root;
    MalValue values[MAL_SHAPE_MAX_INLINE_SLOTS];
    u32 kept = 0;
    for (u32 i = 0; i < count; i++) {
        const MalShapeProp *prop = &shape->props[i];
        MalValue value = mal_object_field_load(object, i);
        if (mal_value_is_string(prop->key)) {
            public_shape = mal_shape_add_property(
                public_shape, mal_key_from_value(prop->key), prop->attrs);
            values[kept++] = value;
            continue;
        }
        MalPropertyDesc desc = mal_object_data_desc(value, (MalPropertyFlags) prop->attrs);
        mal_property_ensure(table, mal_key_from_value(prop->key), &desc);
        mal_gc_card_desc(&object->header, &desc);
        mal_gc_card(&object->header, prop->key);
        mal_value_to_symbol(prop->key)->private_table_resident = true;
    }
    // Every old slot is overwritten or dropped, so shade each for the snapshot barrier.
    MalValue *fields = mal_object_fields_nonempty(object);
    for (u32 i = 0; i < count; i++) mal_gc_write_barrier(fields[i]);
    for (u32 i = 0; i < kept; i++) fields[i] = values[i];
    object->shape = public_shape;
    object->overflow_private_only = true;
    return true;
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

void mal_object_set_integrity_level(MalObject *object, bool clear_writable) {
    object->extensible = false;
    bool changed_dense_elements = false;
    if (object->header.type == MAL_HEAP_ARRAY_OBJECT) {
        MalArrayObject *array = (MalArrayObject *) object;
        bool packed_dense = !array->dense_deopted &&
            (array->elements != nullptr || array->length == 0) &&
            array->dense_count == array->length && !array->dense_maybe_holey;
        if (packed_dense) {
            changed_dense_elements = array->dense_count != 0 &&
                (array->dense_elements_configurable ||
                 (clear_writable && array->dense_elements_writable));
            array->dense_elements_configurable = false;
            if (clear_writable) array->dense_elements_writable = false;
        } else {
            mal_object_array_deoptimize(array);
        }
        if (clear_writable) array->length_writable = false;
    }
    bool has_shape_properties = object->shape->inline_count != 0;
    bool has_overflow_properties =
        mal_object_has_public_overflow(object) && mal_table_size(mal_object_overflow(object)) != 0;
    bool noted_prototype_mutation = false;
    if (changed_dense_elements) {
        if (object->watched_method_proto) {
            mal_invalidate_primitive_method_protector();
        }
        noted_prototype_mutation = mal_object_note_prototype_mutation(object);
        if (noted_prototype_mutation) {
            MAL_PERF_COUNT(prototype_epoch_define_invalidations);
        }
    }
    if (!has_shape_properties && !has_overflow_properties) return;

    if (object->watched_method_proto && !changed_dense_elements) {
        mal_invalidate_primitive_method_protector();
    }
    if (has_shape_properties && !mal_object_has_public_overflow(object)) {
        // Shaped storage contains data properties only. Seal/freeze changes their
        // attributes uniformly, so move to the canonical integrity variant without
        // allocating a per-object dictionary or moving any values.
        if (!noted_prototype_mutation &&
            mal_object_note_prototype_mutation(object)) {
            MAL_PERF_COUNT(prototype_epoch_define_invalidations);
        }
        object->shape = mal_shape_set_integrity(object->shape, clear_writable);
        return;
    } else if (has_shape_properties) {
        // Defensive mixed-representation fallback. Ordinary operations currently
        // dictionarize before adding overflow properties, but exotic evolution
        // must not make integrity handling incomplete.
        mal_object_dictionarize(object);
    } else if (!noted_prototype_mutation &&
               mal_object_note_prototype_mutation(object)) {
        MAL_PERF_COUNT(prototype_epoch_define_invalidations);
    }

    MalTableIter iter;
    mal_table_iter_init(&iter, mal_object_overflow(object), MAL_TABLE_ITER_STORAGE);
    MalKey key;
    void *entry;
    while (mal_table_iter_next(&iter, &key, &entry)) {
        if (key.kind == MAL_KEY_SYMBOL &&
            mal_symbol_is_private(mal_value_to_symbol(key.value))) {
            continue;
        }
        MalPropertyDesc desc = mal_property_entry_desc(mal_object_overflow(object), entry);
        desc.flags &= ~MAL_PROPERTY_CONFIGURABLE;
        if (clear_writable && !(desc.flags & MAL_PROPERTY_ACCESSOR)) {
            desc.flags &= ~MAL_PROPERTY_WRITABLE;
        }
        mal_property_write_entry(mal_object_overflow(object), entry, &desc);
    }
}

MalObject *mal_object_get_prototype(const MalObject *object) {
    return mal_object_prototype(object);
}

bool mal_object_set_prototype(MalObject *object, MalObject *prototype) {
    if (mal_object_prototype(object) == prototype) {
        return true;
    }

    // SetImmutablePrototype: an immutable-prototype exotic object (e.g.
    // %Object.prototype%) only accepts its current prototype (handled above);
    // any other value fails.
    if (object->immutable_prototype) {
        return false;
    }

    if (!object->extensible) {
        return false;
    }

    for (MalObject *cursor = prototype; cursor != nullptr; cursor = mal_object_prototype(cursor)) {
        if (cursor == object) {
            return false;
        }
    }

    // Reparenting a watched prototype changes every default-proto array's inherited
    // chain, so the fast-elements protector no longer holds.
    if (object->fast_elements_proto) {
        mal_invalidate_array_elements_protector();
    }
    if (object->watched_method_proto) {
        mal_invalidate_primitive_method_protector();
    }
    if (mal_object_note_prototype_mutation(object)) {
        MAL_PERF_COUNT(prototype_epoch_reparent_invalidations);
    }

    // SATB: reparenting overwrites the traced prototype edge; shade the old
    // prototype (boxed, since prototype is a MalObject* not a MalValue) before it
    // is dropped. Early-returned above when unchanged, so this is a real overwrite.
    if (mal_object_prototype(object) != nullptr) {
        mal_gc_write_barrier(mal_value_from_heap(&mal_object_prototype(object)->header));
    }
    mal_object_set_prototype_pointer(object, prototype);
    mal_object_mark_as_prototype(prototype);
    // Old object reparented onto a young prototype: remember it (the prototype is a
    // MalObject*, not a MalValue, so card on its boxed form).
    if (prototype != nullptr) {
        mal_gc_card(&object->header, mal_value_from_heap(&prototype->header));
    }
    return true;
}

/**
 * Deoptimize an array from the dense element vector to legacy table storage: move
 * every present dense element into the property table under its index key, free the
 * vector, and mark the array table-mode forever. Called when an index needs an
 * attribute the dense vector cannot express (non-default-data, accessor) or is too
 * sparse to store densely. Safe on an already-table-mode array (no-op).
 */
void mal_object_array_deoptimize(MalArrayObject *array) {
    if (array->dense_deopted) {
        return;
    }
    MalValue *buffer = array->elements;
    bool inline_buffer = mal_array_object_elements_inline(array);
    u32 count = array->dense_count;
    // Switch to table mode FIRST so the mal_object_define_own calls below take the
    // ordinary table path instead of recursing into the dense path.
    array->elements = nullptr;
    array->capacity = 0;
    array->dense_count = 0;
    array->dense_deopted = true;
    array->dense_maybe_holey = false;
    MalPropertyFlags element_flags =
        mal_array_object_dense_element_flags(array);
    array->dense_elements_writable = true;
    array->dense_elements_configurable = true;
    if (buffer == nullptr) {
        return; // lazy-empty array: nothing to migrate
    }
    // The detached buffer is otherwise unreachable; a table insert below can trigger
    // GC, so root the not-yet-migrated values across the migration.
    MalRootSpan span;
    mal_gc_root(&span, buffer, (i32) count);
    // This is a representation change of properties that already exist, not an
    // observable extension. Permit the table inserts even after
    // [[PreventExtensions]] has run (for example, while freezing an array).
    bool extensible = array->object.extensible;
    array->object.extensible = true;
    for (u32 i = 0; i < count; i++) {
        if (mal_value_is_array_hole(buffer[i])) {
            continue;
        }
        MalPropertyDesc desc = mal_object_data_desc(buffer[i], element_flags);
        MalKey key = mal_key_index(i);
        mal_object_define_own(&array->object, key, &desc);
    }
    array->object.extensible = extensible;
    mal_gc_unroot(&span);
    if (!inline_buffer) gc_free_raw(mal_gc_current_heap(), buffer); // dense vector lives in the RAW space
}

MalPropertyLookup mal_object_get_own(const MalObject *object, MalKey key) {
    // Dense array element: an in-range, non-hole index reads straight from the
    // vector (a synthesized default-data descriptor). In dense mode no index keys
    // live in the table, so a dense miss is absent — do not consult the overflow.
    if (key.kind == MAL_KEY_INDEX && object->header.type == MAL_HEAP_ARRAY_OBJECT) {
        const MalArrayObject *array = (const MalArrayObject *) object;
        if (mal_array_object_is_dense(array)) {
            u32 index = mal_key_index_value(key);
            MalValue value;
            if (mal_array_object_dense_get(array, index, &value)) {
                return (MalPropertyLookup){
                    .present = true,
                    .entry = nullptr,
                    .desc = mal_object_data_desc(
                        value, mal_array_object_dense_element_flags(array)),
                };
            }
            return (MalPropertyLookup){.present = false, .entry = nullptr};
        }
        // Table-mode array (deopted or lazy-empty): fall through to the table lookup.
    }
    bool private_key = key.kind == MAL_KEY_SYMBOL &&
        mal_symbol_is_private(mal_value_to_symbol(key.value));
    // Shaped string property or private element: synthesize a data descriptor from the inline slot.
    if (key.kind == MAL_KEY_STRING || private_key) {
        i32 idx = mal_shape_find(object->shape, key, MAL_SHAPE_FIND_GET_OWN);
        if (idx >= 0) {
            const MalShapeProp *prop = &object->shape->props[idx];
            return (MalPropertyLookup){
                .present = true,
                .entry = nullptr, // shaped props have no table entry
                .desc = mal_object_data_desc(mal_object_field_load(object, prop->slot), prop->attrs),
            };
        }
    }
    // Index/symbol keys and dictionary-mode objects live in the overflow table.
    if (mal_object_overflow(object) != nullptr &&
        (!object->overflow_private_only || private_key)) {
        return mal_property_lookup(mal_object_overflow(object), key);
    }
    return (MalPropertyLookup){.present = false, .entry = nullptr};
}

static MalPropertyResolution mal_object_resolve_property_with_entry(
    const MalObject *object, MalKey key, void **entry_out
) {
    if (entry_out != nullptr) {
        *entry_out = nullptr;
    }
    for (const MalObject *cursor = object; cursor != nullptr; cursor = mal_object_prototype(cursor)) {
        MalPropertyLookup lookup = mal_object_get_own(cursor, key);

        if (lookup.present) {
            if (entry_out != nullptr) {
                *entry_out = lookup.entry;
            }
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

MalPropertyResolution mal_object_resolve_property(const MalObject *object, MalKey key) {
    return mal_object_resolve_property_with_entry(object, key, nullptr);
}

MalDefineOwnStatus mal_object_define_own(MalObject *object, MalKey key, const MalPropertyDesc *desc) {
    if (mal_object_note_prototype_mutation(object)) {
        MAL_PERF_COUNT(prototype_epoch_define_invalidations);
    }
    // Defining an integer-index property on a watched prototype (%Array.prototype% or
    // %Object.prototype%) dirties the fast-elements protector — an inherited indexed
    // property could now intercept an array's fresh-index store.
    if (key.kind == MAL_KEY_INDEX && object->fast_elements_proto) {
        mal_invalidate_array_elements_protector();
    }
    // Defining any property on a watched primitive prototype invalidates the
    // primitive-method cache (a new/changed method could shadow a cached lookup).
    if (object->watched_method_proto) {
        mal_invalidate_primitive_method_protector();
    }

    if (key.kind == MAL_KEY_SYMBOL &&
        mal_symbol_is_private(mal_value_to_symbol(key.value))) {
        i32 index = mal_shape_find(object->shape, key, MAL_SHAPE_FIND_DEFINE_OWN);
        bool shaped_data = !mal_object_desc_is_accessor(*desc);
        if (index >= 0) {
            const MalShapeProp *prop = &object->shape->props[index];
            if (shaped_data && desc->flags == (MalPropertyFlags) prop->attrs) {
                MalPropertyDesc current =
                    mal_object_data_desc(mal_object_field_load(object, prop->slot), prop->attrs);
                if (!mal_object_define_is_compatible(current, *desc)) {
                    return MAL_DEFINE_OWN_REJECTED;
                }
                mal_object_field_store(object, prop->slot, desc->value);
                return MAL_DEFINE_OWN_APPLIED;
            }
            // Attribute transitions keep the dictionary's descriptor machinery.
            mal_object_dictionarize(object);
        } else if (shaped_data && desc->flags == MAL_PROPERTY_WRITABLE &&
                   mal_object_shapes_private(object) &&
                   mal_object_can_add_shaped_property(object) &&
                   (mal_object_overflow(object) == nullptr ||
                    !mal_table_lookup(mal_object_overflow(object), key).present)) {
            return mal_object_add_private(object, key, desc->value)
                ? MAL_DEFINE_OWN_APPLIED : MAL_DEFINE_OWN_REJECTED;
        }
        bool private_only = !mal_object_has_public_overflow(object);
        MalTable *table = mal_object_ensure_overflow(object);
        MalPropertyEnsure ensured = mal_property_ensure(table, key, desc);
        object->overflow_private_only = private_only;
        if (ensured.inserted) {
            mal_gc_card_desc(&object->header, desc);
            mal_gc_card(&object->header, key.value);
            return MAL_DEFINE_OWN_APPLIED;
        }
        if (!mal_object_define_is_compatible(ensured.desc, *desc)) {
            return MAL_DEFINE_OWN_REJECTED;
        }
        MalPropertyDesc stored = *desc;
        stored.flags |= ensured.desc.flags & MAL_PROPERTY_INTERNAL_FLAGS;
        mal_property_write_entry(table, ensured.entry, &stored);
        mal_gc_card_desc(&object->header, &stored);
        return MAL_DEFINE_OWN_APPLIED;
    }

    // Dense array element fast path. A default-data store at an integer index goes
    // straight into the vector; anything the vector cannot represent (non-default
    // attributes, an accessor, or a too-sparse index) deoptimizes the array to table
    // storage, then falls through to the ordinary define below.
    if (key.kind == MAL_KEY_INDEX && object->header.type == MAL_HEAP_ARRAY_OBJECT) {
        MalArrayObject *array = (MalArrayObject *) object;
        if (!array->dense_deopted) {
            u32 index = mal_key_index_value(key);
            bool present = mal_array_object_dense_has(array, index);
            MalPropertyFlags element_flags =
                mal_array_object_dense_element_flags(array);
            if (present) {
                MalPropertyDesc current = mal_object_data_desc(
                    array->elements[index], element_flags);
                if (!mal_object_define_is_compatible(current, *desc)) {
                    return MAL_DEFINE_OWN_REJECTED;
                }
            }
            bool exact_dense_data =
                !mal_object_desc_is_accessor(*desc) &&
                desc->flags == element_flags;
            if (exact_dense_data) {
                // Defining a NEW index on a non-extensible array is rejected;
                // overwriting an existing element is allowed.
                if (!object->extensible && !present) {
                    return MAL_DEFINE_OWN_REJECTED;
                }
                if (mal_array_object_dense_store(array, index, desc->value) ==
                    MAL_ARRAY_DENSE_APPLIED) {
                    return MAL_DEFINE_OWN_APPLIED;
                }
            }
            // Not dense-storable: deopt, then continue to the table path below.
            mal_object_array_deoptimize(array);
        }
    }

    // Shape fast path: exact-attribute data redefinitions stay shaped. This is
    // especially important for SetFunctionName updating the configurable `name`
    // slot installed at function creation.
    if (key.kind == MAL_KEY_STRING && !mal_object_desc_is_accessor(*desc)) {
        i32 idx = mal_shape_find(object->shape, key, MAL_SHAPE_FIND_DEFINE_OWN);
        if (idx >= 0) {
            const MalShapeProp *prop = &object->shape->props[idx];
            if (prop->attrs == (u8) desc->flags) {
                MalPropertyDesc current =
                    mal_object_data_desc(mal_object_field_load(object, prop->slot), prop->attrs);
                if (!mal_object_define_is_compatible(current, *desc)) {
                    return MAL_DEFINE_OWN_REJECTED;
                }
                mal_object_field_store(object, prop->slot, desc->value);
                return MAL_DEFINE_OWN_APPLIED;
            }
            // An attribute transition needs the dictionary's full descriptor
            // compatibility machinery.
        } else if (mal_object_desc_is_default_data(desc) &&
            !mal_object_has_public_overflow(object) &&
            (mal_object_can_add_shaped_property(object) ||
             (object->extensible && mal_object_evict_shaped_private(object)))) {
            if (!object->extensible) {
                return MAL_DEFINE_OWN_REJECTED;
            }
            MalShape *child =
                mal_shape_add_property(object->shape, key, (u8) MAL_DEFAULT_DATA_FLAGS);
            u32 count = child->inline_count;
            mal_object_grow_slots(object, object->shape->inline_count, count);
            mal_object_field_initialize(object, child, count - 1, desc->value);
            object->shape = child;
            // Old object gains a new shaped property. The value is carded here;
            // the canonical property atom is retained by vm->atoms and the
            // heap-owned transition tree is scanned as a root.
            mal_gc_card(&object->header, desc->value);
            mal_gc_card(&object->header, key.value);
            return MAL_DEFINE_OWN_APPLIED;
        }
        // Object already carries dictionary props: fall through to the table path.
    }

    // Dictionary path (non-default attrs, accessor, index/symbol key, or an object
    // already in dictionary mode): operate on the overflow table as before.
    mal_object_dictionarize(object);
    MalTable *table = mal_object_ensure_overflow(object);
    MalPropertyLookup lookup;
    if (object->extensible) {
        MalPropertyEnsure ensured = mal_property_ensure(table, key, desc);
        if (ensured.inserted) {
            mal_gc_card_desc(&object->header, desc); // old object -> young desc refs
            mal_gc_card(&object->header, key.value); // ... and the (string/symbol) key
            return MAL_DEFINE_OWN_APPLIED;
        }
        lookup = (MalPropertyLookup) {
            .present = true,
            .entry = ensured.entry,
            .desc = ensured.desc,
        };
    } else {
        lookup = mal_property_lookup(table, key);
        if (!lookup.present) {
            return MAL_DEFINE_OWN_REJECTED;
        }
    }

    if (!mal_object_define_is_compatible(lookup.desc, *desc)) {
        return MAL_DEFINE_OWN_REJECTED;
    }

    MalPropertyDesc stored = *desc;
    stored.flags |= lookup.desc.flags & MAL_PROPERTY_INTERNAL_FLAGS;
    mal_property_write_entry(table, lookup.entry, &stored);
    mal_gc_card_desc(&object->header, &stored); // old object -> young desc refs
    return MAL_DEFINE_OWN_APPLIED;
}

bool mal_object_append_plan_init(
    MalShapeAppendPlan *plan, MalShape *source, MalShape *final, u32 count
) {
    if (plan == nullptr) return false;
    *plan = (MalShapeAppendPlan) {0};
    if (source == nullptr || final == nullptr || count == 0) {
        return false;
    }
    // A non-null source also records that a caller attempted initialization.
    // Keeping final null on failure makes the plan unusable while letting lazy
    // caches avoid rebuilding the same immutable shapes on every fallback.
    plan->source = source;

    u32 source_count = source->inline_count;
    if (source_count > MAL_SHAPE_MAX_INLINE_SLOTS
        || count > MAL_SHAPE_MAX_INLINE_SLOTS - source_count
        || final->inline_count != source_count + count) {
        return false;
    }

    for (u32 i = 0; i < source_count; ++i) {
        const MalShapeProp *source_prop = &source->props[i];
        const MalShapeProp *final_prop = &final->props[i];
        if (source_prop->key != final_prop->key
            || source_prop->slot != final_prop->slot
            || source_prop->attrs != final_prop->attrs) {
            return false;
        }
    }
    for (u32 i = source_count; i < final->inline_count; ++i) {
        const MalShapeProp *prop = &final->props[i];
        if (prop->slot != i || !mal_shape_attrs_are_default(prop->attrs)) {
            return false;
        }
        for (u32 prior = 0; prior < i; ++prior) {
            if (mal_key_value_equals(final->props[prior].key, prop->key)) {
                return false;
            }
        }
    }

    plan->final = final;
    return true;
}

bool mal_object_try_append_shaped_values(
    MalObject *object, const MalShapeAppendPlan *plan, const MalValue *values,
    u32 count
) {
    if (object == nullptr || plan == nullptr || plan->source == nullptr
        || plan->final == nullptr || values == nullptr || count == 0
        || object->header.type != MAL_HEAP_OBJECT || object->shape != plan->source
        || mal_object_has_public_overflow(object) || !object->extensible) {
        return false;
    }

    u32 source_count = plan->source->inline_count;
    u32 final_count = plan->final->inline_count;
    if (source_count > MAL_SHAPE_MAX_INLINE_SLOTS || final_count <= source_count
        || final_count > MAL_SHAPE_MAX_INLINE_SLOTS
        || count != final_count - source_count
        || (source_count > 0 && mal_object_fields(object) == nullptr)
        || (source_count == 0 && object->slots_owned)) {
        return false;
    }

    if (object->watched_method_proto) {
        mal_invalidate_primitive_method_protector();
    }
    if (mal_object_note_prototype_mutation(object)) {
        MAL_PERF_COUNT(prototype_epoch_append_invalidations);
    }
    mal_object_grow_slots(object, source_count, final_count);
    for (u32 i = 0; i < count; ++i) {
        const MalShapeProp *prop = &plan->final->props[source_count + i];
        mal_object_field_initialize(object, plan->final, prop->slot, values[i]);
        mal_gc_card(&object->header, values[i]);
        mal_gc_card(&object->header, prop->key);
    }
    object->shape = plan->final;
    return true;
}

bool mal_object_delete_own(MalObject *object, MalKey key) {
    if (mal_object_note_prototype_mutation(object)) {
        MAL_PERF_COUNT(prototype_epoch_delete_invalidations);
    }
    if (object->watched_method_proto) {
        mal_invalidate_primitive_method_protector();
    }
    // Dense array element: a configurable present index becomes a hole. In dense
    // mode no index keys live in the table, so this is the whole operation.
    if (key.kind == MAL_KEY_INDEX && object->header.type == MAL_HEAP_ARRAY_OBJECT) {
        MalArrayObject *array = (MalArrayObject *) object;
        if (mal_array_object_is_dense(array)) {
            u32 index = mal_key_index_value(key);
            if (mal_array_object_dense_has(array, index) &&
                !array->dense_elements_configurable) {
                return false;
            }
            mal_array_object_dense_delete(array, index);
            return true;
        }
    }

    MalPropertyLookup lookup = mal_object_get_own(object, key);

    if (!lookup.present) {
        return true;
    }

    if (!mal_object_desc_is_configurable(lookup.desc)) {
        return false;
    }

    // SATB: shade the deleted property's descriptor refs. mal_table_delete shades
    // the key + inline value generically, but a property's value/getter/setter
    // live in the descriptor, so shade them here where the descriptor is known.
    mal_gc_write_barrier(lookup.desc.value);
    mal_gc_write_barrier(lookup.desc.getter);
    mal_gc_write_barrier(lookup.desc.setter);

    // A shape is a fixed layout, so removing a shaped property drops the object
    // to dictionary mode first, then deletes from the table.
    if (key.kind == MAL_KEY_STRING &&
        mal_shape_find(object->shape, key, MAL_SHAPE_FIND_DELETE_OWN) >= 0) {
        mal_object_dictionarize(object);
    }
    if (mal_object_overflow(object) != nullptr) {
        return mal_table_delete(mal_object_overflow(object), key);
    }
    return true;
}

/**
 * How mal_object_set last wrote `key` on objects of `shape`: into an own writable
 * slot, or by adding a default data property, which stays valid while the
 * prototype chain epoch holds. Runtime code builds and updates its objects with
 * mal_object_set, which otherwise resolves the key through the prototype chain and
 * then searches the shape again.
 */
typedef struct MalObjectSetSite {
    const MalShape *shape;
    MalValue key;
    const MalObject *prototype;
    u64 epoch;
    /** The shape after an addition; null for an own-slot write. */
    MalShape *child;
    u32 slot;
} MalObjectSetSite;

#define MAL_OBJECT_SET_SITES 512

static MAL_ISOLATE_LOCAL MalObjectSetSite g_object_set_sites[MAL_OBJECT_SET_SITES];

static MalObjectSetSite *mal_object_set_site(const MalShape *shape, MalValue key) {
    MalIsolateLocals *isolate = mal_isolate_locals();
    MalObjectSetSite *sites = isolate->object_set_sites;
    if (__builtin_expect(sites == nullptr, 0)) sites = isolate->object_set_sites = g_object_set_sites;
    uptr hash = ((uptr) shape >> 4) ^ ((uptr) key >> 3) * 0x9e3779b1u;
    return &sites[(hash ^ hash >> 9) % MAL_OBJECT_SET_SITES];
}

// Prototype mutations bump the epoch, and so does freeing a prototype before its
// address can return; the receiver's own keys are exactly its shape's.
static bool mal_object_set_is_cacheable(const MalObject *object, MalKey key) {
    return key.kind == MAL_KEY_STRING && object->header.type == MAL_HEAP_OBJECT &&
        !object->is_prototype && !object->watched_method_proto && object->extensible &&
        !mal_object_has_public_overflow(object) && mal_prototype_chain_epoch != 0;
}

static bool mal_object_try_cached_add(
    MalObject *object, const MalObjectSetSite *site, MalKey key, MalValue value
) {
    if (site->prototype != mal_object_prototype(object) ||
        site->epoch != mal_prototype_chain_epoch) {
        MAL_PERF_COUNT(object_set_cache_misses);
        return false;
    }
    MAL_PERF_COUNT(object_set_cache_hits);
    MalShape *child = site->child;
    u32 count = child->inline_count;
    mal_object_grow_slots(object, object->shape->inline_count, count);
    mal_object_field_initialize(object, child, count - 1, value);
    object->shape = child;
    mal_gc_card(&object->header, value);
    mal_gc_card(&object->header, key.value);
    return true;
}

static bool mal_object_try_cached_set(MalObject *object, MalKey key, MalValue value) {
    const MalObjectSetSite *site = mal_object_set_site(object->shape, key.value);
    if (site->shape != object->shape || site->key != key.value) {
        MAL_PERF_COUNT(object_set_cache_misses);
        return false;
    }
    if (site->child != nullptr) return mal_object_try_cached_add(object, site, key, value);
    MAL_PERF_COUNT(object_set_cache_hits);
    mal_object_field_store(object, site->slot, value);
    return true;
}

static void mal_object_record_add(
    const MalObject *object, const MalShape *shape, MalKey key
) {
    const MalShape *child = object->shape;
    if (child->inline_count != shape->inline_count + 1 ||
        child->props[child->inline_count - 1].key != key.value ||
        child->props[child->inline_count - 1].attrs != (u8) MAL_DEFAULT_DATA_FLAGS) {
        return;
    }
    for (const MalObject *cursor = mal_object_prototype(object); cursor != nullptr;
         cursor = mal_object_prototype(cursor)) {
        if (cursor->header.type != MAL_HEAP_OBJECT &&
            mal_tag_for_heap_type(cursor->header.type) != MAL_VALUE_CALLABLE) {
            return;
        }
    }
    MAL_PERF_COUNT(object_set_cache_fills);
    *mal_object_set_site(shape, key.value) = (MalObjectSetSite) {
        .shape = shape,
        .key = key.value,
        .prototype = mal_object_prototype(object),
        .epoch = mal_prototype_chain_epoch,
        .child = (MalShape *) child,
    };
}

bool mal_object_add_cached(MalObject *object, MalKey key, MalValue value) {
    if (!mal_object_set_is_cacheable(object, key)) return false;
    const MalObjectSetSite *site = mal_object_set_site(object->shape, key.value);
    return site->shape == object->shape && site->key == key.value && site->child != nullptr &&
        mal_object_try_cached_add(object, site, key, value);
}

void mal_object_note_added_property(const MalObject *object, const MalShape *shape, MalKey key) {
    if (mal_object_set_is_cacheable(object, key)) mal_object_record_add(object, shape, key);
}

static void mal_object_set_new_own(MalObject *object, MalKey key, MalValue value) {
    bool cacheable = mal_object_set_is_cacheable(object, key);
    const MalShape *shape = object->shape;
    MalPropertyDesc desc = mal_object_data_desc(value, MAL_DEFAULT_DATA_FLAGS);
    mal_object_define_own(object, key, &desc);
    if (cacheable) mal_object_record_add(object, shape, key);
}

bool mal_object_set(MalObject *object, MalKey key, MalValue value) {
    // Reassigning/adding a property on a watched primitive prototype (e.g.
    // `String.prototype.charCodeAt = fn`) invalidates the primitive-method cache.
    if (object->watched_method_proto) {
        mal_invalidate_primitive_method_protector();
    }
    if (mal_object_set_is_cacheable(object, key) && mal_object_try_cached_set(object, key, value)) {
        return true;
    }
    void *resolved_entry;
    MalPropertyResolution resolution =
        mal_object_resolve_property_with_entry(object, key, &resolved_entry);

    if (!resolution.found) {
        if (!object->extensible) {
            return false;
        }

        mal_object_set_new_own(object, key, value);
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

        mal_object_set_new_own(object, key, value);
        return true;
    }

    // Own writable data property. Fast path: write the inline slot directly.
    if (key.kind == MAL_KEY_STRING) {
        i32 idx = mal_shape_find(object->shape, key, MAL_SHAPE_FIND_SET_OWN);
        if (idx >= 0) {
            u32 slot = object->shape->props[idx].slot;
            mal_object_field_store(object, slot, value);
            if (mal_object_set_is_cacheable(object, key)) {
                MAL_PERF_COUNT(object_set_cache_fills);
                *mal_object_set_site(object->shape, key.value) = (MalObjectSetSite) {
                    .shape = object->shape,
                    .key = key.value,
                    .slot = slot,
                };
            }
            return true;
        }
    }

    if (resolved_entry != nullptr) {
        resolution.desc.value = value;
        mal_property_write_entry(mal_object_overflow(object), resolved_entry, &resolution.desc);
        mal_gc_card_desc(&object->header, &resolution.desc);
        return true;
    }

    resolution.desc.value = value;
    mal_object_define_own(object, key, &resolution.desc);

    return true;
}
