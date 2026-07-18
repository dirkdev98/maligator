#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Object constructor and install the Object builtins on the
 * constructor and %Object.prototype%.
 */
void mal_builtin_object_install(MalVm *vm);

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

/**
 * The spec [[DefineOwnProperty]] path shared by Object.defineProperty and
 * Reflect.defineProperty: ToPropertyDescriptor(descriptor_value) (which may
 * throw, leaving a pending completion + returning REJECTED) then define on the
 * target, returning APPLIED / REJECTED. Reflect maps the result to a boolean;
 * Object.defineProperty turns a plain REJECTED into a thrown TypeError.
 */
MalDefineOwnStatus mal_builtin_object_try_define(MalVm *vm, MalObject *target, MalKey key, MalValue descriptor_value);

/**
 * ToObject for a primitive: wrap a string/number/boolean/symbol/bigint in its
 * matching wrapper object (undefined/null/object return undefined). Used by the
 * sloppy-mode this-binding (OrdinaryCallBindThis) and Object.prototype methods.
 */
MalValue mal_builtin_object_box_primitive(MalVm *vm, MalValue value);
