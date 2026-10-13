#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Object constructor and install the Object builtins on the
 * constructor and %Object.prototype%.
 */
void mal_builtin_object_install(MalVm *vm);

/** Exact Object.hasOwn invocation after the locked namespace/property seam was
 * erased. The builtin still performs ordinary object/key coercion and Proxy
 * internal methods. */
MalValue mal_builtin_object_has_own_known(
    MalVm *vm, const MalValue *args, i32 arg_count
);

/** Pure SameValue comparison after the locked Object.is property seam. */
MalValue mal_builtin_object_is_known(const MalValue *args, i32 arg_count);

/** Exact Object.keys invocation after the locked namespace/property seam. */
MalValue mal_builtin_object_keys_known(
    MalVm *vm, const MalValue *args, i32 arg_count
);

typedef enum MalObjectEnumerationKind {
    MAL_OBJECT_ENUMERATION_KEYS,
    MAL_OBJECT_ENUMERATION_VALUES,
    MAL_OBJECT_ENUMERATION_ENTRIES,
    MAL_OBJECT_ENUMERATION_NAMES,
    MAL_OBJECT_ENUMERATION_SYMBOLS,
    MAL_OBJECT_ENUMERATION_OWN_KEYS,
} MalObjectEnumerationKind;

// Counts without allocation or user code; a decline leaves the original call untouched.
bool mal_builtin_object_enumeration_count(MalValue callee, MalValue target, bool locked, MalObjectEnumerationKind kind, u32 *count_out);

// Caller-owned roots retain the eager sequence independently of later receiver mutations.
bool mal_builtin_object_enumeration_snapshot(MalVm *vm, MalValue callee, MalValue target, bool locked, MalObjectEnumerationKind kind, MalValue *elements, u32 capacity, u32 *count_out);

// Caller-rooted interleaved keys/values become cached pairs in their key slots.
MalValue mal_builtin_object_enumeration_entry(MalVm *vm, MalValue *elements, u32 index);
// Consumes entry storage; the caller caches the outer Array before any reentry.
MalValue mal_builtin_object_enumeration_materialize(MalVm *vm, MalObjectEnumerationKind kind, MalValue *elements, u32 count);

/** Exact Object.values invocation after the locked namespace/property seam. */
MalValue mal_builtin_object_values_known(
    MalVm *vm, const MalValue *args, i32 arg_count
);

/**
 * Object.prototype.toString: the "[object Tag]" fallback, also used by
 * builtins that delegate to it for non-array receivers.
 */
MalValue mal_builtin_object_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee);

/**
 * FromPropertyDescriptor: build the { value/get/set, writable, enumerable,
 * configurable } plain object for a resolved descriptor. Shared by
 * Object.getOwnPropertyDescriptor(s) and Reflect.getOwnPropertyDescriptor.
 */
MalValue mal_builtin_object_descriptor_object(MalVm *vm, MalPropertyDesc desc);

/** Parsed ToPropertyDescriptor result, including field presence. */
typedef struct MalPropertyDescriptorParse {
    bool has_value, has_writable, has_get, has_set, has_enumerable, has_configurable;
    MalPropertyDesc desc;
} MalPropertyDescriptorParse;

/**
 * Spec ToPropertyDescriptor over any object, using proxy-aware HasProperty/Get
 * in field order. Returns false with an abrupt completion left on the VM.
 */
bool mal_builtin_object_to_property_descriptor(
    MalVm *vm, MalValue descriptor, MalPropertyDescriptorParse *out);

/** Create a plain descriptor object containing exactly the parsed fields. */
MalValue mal_builtin_object_parsed_descriptor_object(
    MalVm *vm, const MalPropertyDescriptorParse *parsed);

/**
 * The spec [[DefineOwnProperty]] path shared by Object.defineProperty and
 * Reflect.defineProperty: ToPropertyDescriptor(descriptor_value) (which may
 * throw, leaving a pending completion + returning REJECTED) then define on the
 * target, returning APPLIED / REJECTED. Reflect maps the result to a boolean;
 * Object.defineProperty turns a plain REJECTED into a thrown TypeError.
 */
MalDefineOwnStatus mal_builtin_object_try_define(MalVm *vm, MalObject *target, MalKey key, MalValue descriptor_value);

/** Apply an already converted internal property descriptor to a non-Proxy target. */
MalDefineOwnStatus mal_builtin_object_try_define_parsed(
    MalVm *vm, MalObject *target, MalKey key,
    const MalPropertyDescriptorParse *parsed);

/** Dispatch [[DefineOwnProperty]] with an already converted descriptor. */
bool mal_builtin_object_define_own_property_parsed(
    MalVm *vm, MalValue target, MalKey key,
    const MalPropertyDescriptorParse *parsed);

/**
 * ToObject for a primitive: wrap a string/number/boolean/symbol/bigint in its
 * matching wrapper object (undefined/null/object return undefined). Used by the
 * sloppy-mode this-binding (OrdinaryCallBindThis) and Object.prototype methods.
 */
MalValue mal_builtin_object_box_primitive(MalVm *vm, MalValue value);

/** Shared SetIntegrityLevel implementation used by Object.freeze/seal and Realm init. */
bool mal_builtin_object_set_integrity(
    MalVm *vm, MalValue target, bool clear_writable);
