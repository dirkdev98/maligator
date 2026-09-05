#pragma once

#include "./defaults.h"
#include "object.h"
#include "property_store.h"

/**
 * JS-object flavored result of attempting to define or update an own property.
 */
typedef enum MalDefineOwnStatus {
    MAL_DEFINE_OWN_APPLIED,
    MAL_DEFINE_OWN_REJECTED,
} MalDefineOwnStatus;

/**
 * Result of a JS-object flavored property lookup.
 */
typedef struct MalPropertyResolution {
    bool found;
    bool own;
    MalObject *holder;
    MalPropertyDesc desc;
} MalPropertyResolution;

/**
 * Return the backing table for an object's own properties.
 */
MalTable *mal_object_properties(MalObject *object);

/**
 * Return whether the object currently accepts creation of new own properties.
 */
bool mal_object_is_extensible(const MalObject *object);

/**
 * Set the object's extensibility state.
 */
void mal_object_set_extensible(MalObject *object, bool extensible);

/**
 * Apply sealed/frozen descriptor flags directly to an exact ordinary object or array.
 * The caller must exclude protected primordial objects whose mutation policy is
 * enforced by the VM-level define-own-property path.
 */
void mal_object_set_integrity_level(MalObject *object, bool clear_writable);

/**
 * Return the object's current prototype.
 */
MalObject *mal_object_get_prototype(const MalObject *object);

/**
 * Set the object's prototype.
 */
bool mal_object_set_prototype(MalObject *object, MalObject *prototype);

/**
 * Look up an own property descriptor without walking the prototype chain.
 */
MalPropertyLookup mal_object_get_own(const MalObject *object, MalKey key);

/**
 * Resolve a property by walking the ordinary prototype chain.
 */
MalPropertyResolution mal_object_resolve_property(const MalObject *object, MalKey key);

/**
 * Apply ordinary-object flavored define-own-property semantics.
 */
MalDefineOwnStatus mal_object_define_own(MalObject *object, MalKey key, const MalPropertyDesc *desc);

/**
 * Prove once that `final` is exactly `source` plus `count` unique default data
 * properties. Failure leaves `plan` invalid.
 */
bool mal_object_append_plan_init(
    MalShapeAppendPlan *plan, MalShape *source, MalShape *final, u32 count
);

/**
 * Apply a validated default-data append plan to an ordinary shaped object in one
 * slot growth. Per-object mismatches return false without changing the object.
 */
bool mal_object_try_append_shaped_values(
    MalObject *object, const MalShapeAppendPlan *plan, const MalValue *values,
    u32 count
);

/**
 * Perform an ordinary own-property deletion.
 */
bool mal_object_delete_own(MalObject *object, MalKey key);

/**
 * Perform a pragmatic ordinary set operation.
 */
bool mal_object_set(MalObject *object, MalKey key, MalValue value);

/**
 * Deoptimize a dense array to legacy table storage (no-op if already table-mode or
 * not dense). Used by operations that need per-element attributes the dense vector
 * cannot represent (e.g. Object.freeze/seal demoting elements to real table entries).
 */
void mal_object_array_deoptimize(struct MalArrayObject *array);

/**
 * Array fast-elements protector (see object_ops.c). True while a default-prototype
 * array's inherited chain has no integer-index property, so a fresh-index store
 * cannot hit an inherited setter and may skip the prototype-chain resolve.
 */
extern bool mal_array_elements_protector;

/**
 * Holds while no watched built-in prototype/lookup object has been mutated; gates
 * primitive, intrinsic-own, and inherited-method value caches.
 */
extern bool mal_primitive_method_protector;

/**
 * Permanently clear one legacy protector and advance the current VM's matching
 * semantic-family epoch. These remain cold mutation-path calls; generated proof
 * regions snapshot the epochs, while existing runtime fast paths keep reading the
 * compatibility booleans.
 */
void mal_invalidate_array_elements_protector(void);
void mal_invalidate_primitive_method_protector(void);

/**
 * The %Array.prototype% object (set at intrinsics init). Cached as a bare pointer so
 * the inline array index store fast path can confirm an array is on the default
 * prototype without a vm handle.
 */
extern MalObject *mal_array_prototype_object;
