#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalVm MalVm;
typedef struct MalString MalString;
typedef struct MalEnv MalEnv;

typedef struct MalFunctionObject {
    MalObject object;
    i32 function_index;

    /**
     * Captured-variable chain of the activation this closure was created in.
     */
    MalEnv *creation_env;
} MalFunctionObject;

/**
 * Native callback ABI used by runtime-provided callable objects.
 *
 * new_target is undefined for plain calls and the resolved constructor for
 * construct calls, so natives can branch on construct-ness (Map() must throw
 * without new, Symbol() must throw with new).
 *
 * callee is the native function object being invoked — the spec's "active
 * function object" F. A callback reads its own internal slots (closure state)
 * through it via mal_native_function_object_get_slot, which is how built-in
 * closures such as the Promise resolving functions and the combinator element
 * closures carry captured state. Plain builtins ignore it.
 */
typedef MalValue (*MalNativeFunctionCallback)(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue new_target,
    MalValue callee
);

typedef struct MalNativeFunctionObject {
    MalObject object;
    MalString *name;
    MalNativeFunctionCallback callback;

    /**
     * Internal slots (the spec's [[...]] closure state). Heap-owned, nullptr
     * when the function carries none. Created via
     * mal_native_function_object_new_with_slots; a pair of functions can share
     * one mutable cell by storing the same heap object in a slot.
     *
     * TODO(gc): a GC root once tracing exists (these keep captured values
     * reachable, like MalEnv slots and bound-function arguments).
     */
    MalValue *slots;
    i32 slot_count;
} MalNativeFunctionObject;

/**
 * Initialize script function object state in caller-provided storage.
 */
void mal_function_object_init(
    MalHeap *heap,
    MalFunctionObject *function,
    MalObject *prototype,
    i32 function_index
);

/**
 * Allocate and initialize a new script function object.
 */
MalFunctionObject *mal_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    i32 function_index
);

/**
 * Read the VM function definition index carried by a script function object.
 */
i32 mal_function_object_function_index(const MalFunctionObject *function);

/**
 * Initialize native function object state in caller-provided storage.
 */
void mal_native_function_object_init(
    MalHeap *heap,
    MalNativeFunctionObject *function,
    MalObject *prototype,
    MalString *name,
    MalNativeFunctionCallback callback
);

/**
 * Allocate and initialize a new native function object.
 */
MalNativeFunctionObject *mal_native_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    MalNativeFunctionCallback callback
);

/**
 * Allocate a native function object carrying internal slots (closure state).
 * The slot_count values are copied into heap-owned storage; pass nullptr/0 for
 * none. To share one mutable cell between two functions (e.g. a resolving
 * function pair's [[AlreadyResolved]]), store the same heap object in a slot of
 * each.
 */
MalNativeFunctionObject *mal_native_function_object_new_with_slots(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    MalNativeFunctionCallback callback,
    const MalValue *slots,
    i32 slot_count
);

/**
 * Return the display name attached to a native function object.
 */
MalString *mal_native_function_object_name(const MalNativeFunctionObject *function);

/**
 * Return the callback carried by a native function object.
 */
MalNativeFunctionCallback mal_native_function_object_callback(const MalNativeFunctionObject *function);

/**
 * Read internal slot `index` (the spec's closure state). Returns undefined when
 * out of range, so callbacks can read optional slots without bounds checks.
 */
MalValue mal_native_function_object_get_slot(const MalNativeFunctionObject *function, i32 index);

/**
 * Overwrite internal slot `index` in place. Used for mutable shared cells.
 */
void mal_native_function_object_set_slot(MalNativeFunctionObject *function, i32 index, MalValue value);
