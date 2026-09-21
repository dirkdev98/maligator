#include "object_ops.h"

#include <assert.h>
#include <stdlib.h>

#include "array_object.h"
#include "gc.h"
#include "heap_symbol.h"
#include "perf_stats.h"
#include "value_ops.h"
#include "vm.h"

/**
 * Array fast-elements protector. True while neither %Array.prototype% nor
 * %Object.prototype% has an integer-index own property and neither has been
 * reparented — i.e. an array whose [[Prototype]] is the default %Array.prototype%
 * has a fully index-clean prototype chain, so a fresh-index store cannot be
 * intercepted by an inherited indexed setter and can skip the prototype-chain
 * resolve. Invalidated permanently (conservative) the first time that stops holding.
 * Read on the array index [[Set]] hot path (mal_vm_set_property).
 */
bool mal_array_elements_protector = true;

/**
 * Holds while no watched built-in prototype/lookup object has been mutated. Property
 * inline caches retain resolved data values only while this is true; any
 * define/set/delete/reparent clears it (see `watched_method_proto`).
 */
bool mal_primitive_method_protector = true;

/** Zero is the permanently exhausted state, matching the prototype-chain epoch. */
static void mal_semantic_epoch_bump(u64 *epoch) {
    if (*epoch == 0) return;
    *epoch = *epoch == UINT64_MAX ? 0 : *epoch + 1;
}

void mal_invalidate_array_elements_protector(void) {
    mal_array_elements_protector = false;
    // Like RAW allocation and every other MOP helper today, mutation runs on the
    // process's one active VM. A future multi-VM scheduler must pass/activate the
    // owning VM here before per-VM epochs can remain sound.
    MalSemanticEpochs *epochs = &mal_vm_from_heap(mal_gc_current_heap())->semantic_epochs;
    mal_semantic_epoch_bump(&epochs->activity);
    mal_semantic_epoch_bump(&epochs->array_elements);
}

void mal_invalidate_primitive_method_protector(void) {
    mal_primitive_method_protector = false;
    // See the active-VM ownership invariant above.
    MalSemanticEpochs *epochs = &mal_vm_from_heap(mal_gc_current_heap())->semantic_epochs;
    mal_semantic_epoch_bump(&epochs->activity);
    mal_semantic_epoch_bump(&epochs->watched_methods);
}

/* Generational card barrier for a property descriptor stored into `owner`'s
 * dictionary table: any of value/getter/setter may be a young heap pointer. No-op
 * unless MAL_GC_GENERATIONAL is built (mal_gc_card folds out). */
static inline void mal_gc_card_desc(MalHeapHeader *owner, const MalPropertyDesc *desc) {
    mal_gc_card(owner, desc->value);
    mal_gc_card(owner, desc->getter);
    mal_gc_card(owner, desc->setter);
}

/** %Array.prototype% (set at intrinsics init); see object_ops.h. */
MalObject *mal_array_prototype_object = nullptr;

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
    if (object->overflow == nullptr) {
        object->overflow = mal_table_new(MAL_TABLE_MODE_OBJECT, MAL_TABLE_ROLE_OBJECT);
    }
    return object->overflow;
}

bool mal_object_add_private(MalObject *object, MalKey key, MalValue value) {
    assert(key.kind == MAL_KEY_SYMBOL &&
           mal_symbol_is_private(mal_value_to_symbol(key.value)));
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
        MalPropertyDesc desc = mal_object_data_desc(object->slots[prop->slot], prop->attrs);
        mal_property_define(table, mal_key_from_value(prop->key), &desc);
    }
    object->shape = mal_shape_dictionary_empty();
    object->overflow_private_only = false;
    // The values now live in the table. Separately-owned buffers are freed;
    // coallocated storage remains part of the managed object cell.
    mal_object_record_slot_dictionary_migration(object);
    mal_object_release_slots(object);
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
        bool packed_dense = array->elements != nullptr &&
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
        mal_object_has_public_overflow(object) && mal_table_size(object->overflow) != 0;
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
    mal_table_iter_init(&iter, object->overflow, MAL_TABLE_ITER_STORAGE);
    MalKey key;
    void *entry;
    while (mal_table_iter_next(&iter, &key, &entry)) {
        if (key.kind == MAL_KEY_SYMBOL &&
            mal_symbol_is_private(mal_value_to_symbol(key.value))) {
            continue;
        }
        MalPropertyDesc desc = mal_property_entry_desc(object->overflow, entry);
        desc.flags &= ~MAL_PROPERTY_CONFIGURABLE;
        if (clear_writable && !(desc.flags & MAL_PROPERTY_ACCESSOR)) {
            desc.flags &= ~MAL_PROPERTY_WRITABLE;
        }
        mal_property_write_entry(object->overflow, entry, &desc);
    }
}

MalObject *mal_object_get_prototype(const MalObject *object) {
    return object->prototype;
}

bool mal_object_set_prototype(MalObject *object, MalObject *prototype) {
    if (object->prototype == prototype) {
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

    for (MalObject *cursor = prototype; cursor != nullptr; cursor = cursor->prototype) {
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
    if (object->prototype != nullptr) {
        mal_gc_write_barrier(mal_value_from_heap(&object->prototype->header));
    }
    object->prototype = prototype;
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
    gc_free_raw(mal_gc_current_heap(), buffer); // dense vector lives in the RAW space
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
    // Shaped string property: synthesize a data descriptor from the inline slot.
    if (key.kind == MAL_KEY_STRING) {
        i32 idx = mal_shape_find(object->shape, key, MAL_SHAPE_FIND_GET_OWN);
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
    bool private_key = key.kind == MAL_KEY_SYMBOL &&
        mal_symbol_is_private(mal_value_to_symbol(key.value));
    if (object->overflow != nullptr &&
        (!object->overflow_private_only || private_key)) {
        return mal_property_lookup(object->overflow, key);
    }
    return (MalPropertyLookup){.present = false, .entry = nullptr};
}

static MalPropertyResolution mal_object_resolve_property_with_entry(
    const MalObject *object, MalKey key, void **entry_out
) {
    if (entry_out != nullptr) {
        *entry_out = nullptr;
    }
    for (const MalObject *cursor = object; cursor != nullptr; cursor = cursor->prototype) {
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
                    mal_object_data_desc(object->slots[prop->slot], prop->attrs);
                if (!mal_object_define_is_compatible(current, *desc)) {
                    return MAL_DEFINE_OWN_REJECTED;
                }
                mal_gc_write_barrier(object->slots[prop->slot]); // SATB: shade overwritten ref
                object->slots[prop->slot] = desc->value;
                mal_gc_card(&object->header, desc->value); // old object -> young value
                return MAL_DEFINE_OWN_APPLIED;
            }
            // An attribute transition needs the dictionary's full descriptor
            // compatibility machinery.
        } else if (mal_object_desc_is_default_data(desc) &&
            !mal_object_has_public_overflow(object)
            && mal_shape_can_add_property(object->shape, key)) {
            // Pure shaped (or empty) object with no dictionary props: grow the
            // shape and the inline slots. Coallocated managed cells cannot move,
            // so their first growth migrates to a separately-owned buffer.
            if (!object->extensible) {
                return MAL_DEFINE_OWN_REJECTED;
            }
            MalShape *child =
                mal_shape_add_property(object->shape, key, (u8) MAL_DEFAULT_DATA_FLAGS);
            u32 count = child->inline_count;
            mal_object_grow_slots(object, object->shape->inline_count, count);
            object->slots[count - 1] = desc->value;
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
        || (source_count > 0 && object->slots == nullptr)
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
        object->slots[prop->slot] = values[i];
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
    if (object->overflow != nullptr) {
        return mal_table_delete(object->overflow, key);
    }
    return true;
}

bool mal_object_set(MalObject *object, MalKey key, MalValue value) {
    // Reassigning/adding a property on a watched primitive prototype (e.g.
    // `String.prototype.charCodeAt = fn`) invalidates the primitive-method cache.
    if (object->watched_method_proto) {
        mal_invalidate_primitive_method_protector();
    }
    void *resolved_entry;
    MalPropertyResolution resolution =
        mal_object_resolve_property_with_entry(object, key, &resolved_entry);

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
        i32 idx = mal_shape_find(object->shape, key, MAL_SHAPE_FIND_SET_OWN);
        if (idx >= 0) {
            u32 slot = object->shape->props[idx].slot;
            mal_gc_write_barrier(object->slots[slot]); // SATB: shade overwritten ref
            object->slots[slot] = value;
            mal_gc_card(&object->header, value); // old object -> young value
            return true;
        }
    }

    if (resolved_entry != nullptr) {
        resolution.desc.value = value;
        mal_property_write_entry(object->overflow, resolved_entry, &resolution.desc);
        mal_gc_card_desc(&object->header, &resolution.desc);
        return true;
    }

    resolution.desc.value = value;
    mal_object_define_own(object, key, &resolution.desc);

    return true;
}
