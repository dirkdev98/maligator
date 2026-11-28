#pragma once

#include "./defaults.h"
#include "builtin_string.h"
#include "intrinsics.h"
#include "object_ops.h"
#include "proxy_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/*
 * Operations a generated leaf fast path finishes without collecting, calling
 * JavaScript, throwing or polling. Each answers exactly as the full operation
 * would, or returns false without writing `out` so the full entry, which runs
 * the operation with its effects, takes over from the original arguments.
 */

/** Longer chains leave the walk to the full entry, which polls between hops. */
#define MAL_LEAF_PROTOTYPE_WALK_LIMIT 64u

/**
 * InstanceofOperator for a script or native function that inherits straight from
 * %Function.prototype% without an own @@hasInstance. That inherited method is
 * non-writable and non-configurable, so it is the intact OrdinaryHasInstance.
 * Bound functions, Proxies, other right sides, an accessor or missing (lazily
 * created) `prototype`, a non-object `prototype` (a TypeError) and a Proxy in
 * `value`'s chain all decline.
 */
static inline bool mal_leaf_instanceof(
    MalVm *vm, MalValue value, MalValue target, MalValue *out
) {
    if (!mal_value_is_function_object(target) &&
        !mal_value_is_native_function_object(target)) {
        return false;
    }
    const MalObject *callable = mal_value_to_object(target);
    MalObject *parent = mal_object_prototype(callable);
    MalValue prototype_value;
    if (parent == nullptr ||
        mal_value_from_object(parent) != vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE] ||
        !mal_vm_default_instanceof_prototype(vm, callable, &prototype_value)) {
        return false;
    }
    if (!mal_value_is_object(value)) {
        *out = MAL_VALUE_FALSE;
        return true;
    }
    if (!mal_value_is_object(prototype_value)) return false;
    const MalObject *prototype = mal_value_to_object(prototype_value);
    MalValue walk = value;
    for (u32 hop = 0; hop < MAL_LEAF_PROTOTYPE_WALK_LIMIT; hop++) {
        if (mal_value_is_proxy_object(walk)) return false;
        MalObject *next = mal_object_prototype(mal_value_to_object(walk));
        if (next == nullptr || next == prototype) {
            *out = next == nullptr ? MAL_VALUE_FALSE : MAL_VALUE_TRUE;
            return true;
        }
        walk = mal_value_from_object(next);
    }
    return false;
}

/**
 * `key in object` from the shape or the has-cache, as the full operator's cached
 * answers. A non-object (a TypeError) or an unknown answer declines.
 */
static inline bool mal_leaf_in(MalVm *vm, MalValue key, MalValue object, MalValue *out) {
    if (!mal_value_is_object(object)) return false;
    i32 present = mal_vm_shape_has_own_key(vm, object, key)
        ? 1
        : mal_vm_has_cached(vm, object, key);
    if (present < 0) return false;
    *out = mal_value_new_boolean(present != 0);
    return true;
}

/**
 * ToNumber of a Number, String, Boolean, null or undefined. Objects reach user
 * code through ToPrimitive, and Symbols and BigInts throw, so they decline.
 */
static inline bool mal_leaf_to_number(MalValue value, f64 *out) {
    if (mal_ops_is_number(value)) {
        *out = mal_ops_number_as_f64(value);
        return true;
    }
    if (!mal_value_is_string(value) && !mal_value_is_boolean(value) && !mal_value_is_nil(value)) {
        return false;
    }
    *out = mal_ops_to_number(value);
    return true;
}

/**
 * `String.prototype.charCodeAt` on a primitive String with an absent, undefined or
 * Number position. Ropes are read by walking them, which allocates nothing. Other
 * receivers and positions reach ToString or ToNumber, and another callee may be a
 * replacement under mutable primordials, so they decline.
 */
static inline bool mal_leaf_string_char_code_at(
    MalValue callee, MalValue receiver, MalValue position, MalValue *out
) {
    if (!mal_value_is_string(receiver) || !mal_value_is_native_function_object(callee) ||
        mal_native_function_object_callback(mal_value_to_native_function_object(callee)) !=
            mal_builtin_string_char_code_at_callback) {
        return false;
    }
    f64 index;
    if (mal_ops_is_number(position)) {
        index = mal_ops_number_as_f64(position);
    } else if (mal_value_is_undefined(position)) {
        index = 0;
    } else {
        return false;
    }
    *out = mal_builtin_string_char_code_at_number(receiver, index);
    return true;
}
