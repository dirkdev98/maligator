#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalVm MalVm;
typedef struct MalString MalString;
typedef struct MalEnv MalEnv;
#if MAL_REALMS
typedef struct MalRealm MalRealm;
#endif

typedef struct MalFunctionObject {
    MalObject object;
    i32 function_index;

    /**
     * Captured-variable chain of the activation this closure was created in.
     */
    MalEnv *creation_env;

#if MAL_REALMS
    /**
     * The realm this closure was created in, stamped at init from
     * heap->current_realm. A back-pointer to malloc-owned realm metadata (not a GC
     * cell), so the collector never traces it — realms are scanned via vm->realms.
     */
    MalRealm *realm;
#endif
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
     * The arity exposed as the `length` own property. Spec built-in functions
     * carry the count of required parameters; materialized as a real
     * { writable: false, enumerable: false, configurable: true } own property
     * at creation (so reflection/delete see it), defaulting to 0.
     */
    i32 length;

    /**
     * Whether this native function implements [[Construct]]. Most built-ins
     * (prototype methods, accessors, plain functions) do not; only the built-in
     * constructors are flagged (in mal_intrinsics_init). Construct dispatch and
     * IsConstructor (Reflect.construct) consult this.
     */
    bool is_constructor;

    /**
     * Whether the constructor callback itself performed
     * OrdinaryCreateFromConstructor using new.target. Such callbacks must not
     * have the generic native-construct seam repeat the observable prototype
     * lookup after they return.
     */
    bool handles_new_target_prototype;

#if MAL_PROFILE && MAL_PERF_STATS
    /** Exact-profile subsystem owning this native callback, or zero for core runtime. */
    u8 profile_category;
#endif

    /**
     * Internal slots (the spec's [[...]] closure state). Heap-owned, nullptr
     * when the function carries none. Created via
     * mal_native_function_object_new_with_slots; a pair of functions can share
     * one mutable cell by storing the same heap object in a slot.
     */
    MalValue *slots;
    i32 slot_count;

#if MAL_REALMS
    /**
     * The realm this native function was created in, stamped at init from
     * heap->current_realm. Back-pointer to malloc-owned realm metadata (not a GC
     * cell); the collector never traces it (realms are scanned via vm->realms).
     */
    MalRealm *realm;
#endif
} MalNativeFunctionObject;

/**
 * Initialize script function object state and metadata in caller-provided storage.
 */
void mal_function_object_init(
    MalHeap *heap,
    MalFunctionObject *function,
    MalObject *prototype,
    i32 function_index,
    i32 length,
    MalString *name,
    MalKey length_key,
    MalKey name_key
);

/**
 * Allocate a script function with coallocated `length` and `name` shape slots.
 */
MalFunctionObject *mal_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    i32 function_index,
    i32 length,
    MalString *name,
    MalKey length_key,
    MalKey name_key
);

/**
 * Read the VM function definition index carried by a script function object.
 */
i32 mal_function_object_function_index(const MalFunctionObject *function);

/**
 * Initialize native function object state and metadata in caller-provided storage.
 * `length` is the arity exposed as the `length` own property; a null `name`
 * installs only `length`.
 */
void mal_native_function_object_init(
    MalHeap *heap,
    MalNativeFunctionObject *function,
    MalObject *prototype,
    MalString *name,
    i32 length,
    MalNativeFunctionCallback callback
);

/**
 * Allocate and initialize a new native function object with arity 0.
 */
MalNativeFunctionObject *mal_native_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    MalNativeFunctionCallback callback
);

/**
 * Allocate a native function object with an explicit arity (its `length`).
 */
MalNativeFunctionObject *mal_native_function_object_new_arity(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    i32 length,
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

/** Allocate a native function with explicit arity and copied internal slots. */
MalNativeFunctionObject *mal_native_function_object_new_with_slots_arity(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    i32 length,
    MalNativeFunctionCallback callback,
    const MalValue *slots,
    i32 slot_count
);

/** Explicit-arity slots constructor using caller-supplied canonical metadata keys. */
MalNativeFunctionObject *mal_native_function_object_new_with_slots_arity_keys(
    MalHeap *heap,
    MalObject *prototype,
    MalString *name,
    i32 length,
    MalNativeFunctionCallback callback,
    const MalValue *slots,
    i32 slot_count,
    MalKey length_key,
    MalKey name_key
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
 * Whether the native function implements [[Construct]].
 */
bool mal_native_function_object_is_constructor(const MalNativeFunctionObject *function);

/**
 * Flag the native function as a constructor (implements [[Construct]]).
 */
void mal_native_function_object_set_constructor(MalNativeFunctionObject *function);

/** Mark/query a native constructor that selects its instance prototype itself. */
bool mal_native_function_object_handles_new_target_prototype(
    const MalNativeFunctionObject *function);
void mal_native_function_object_set_handles_new_target_prototype(
    MalNativeFunctionObject *function);

/**
 * Read internal slot `index` (the spec's closure state). Returns undefined when
 * out of range, so callbacks can read optional slots without bounds checks.
 */
MalValue mal_native_function_object_get_slot(const MalNativeFunctionObject *function, i32 index);

/**
 * Overwrite internal slot `index` in place. Used for mutable shared cells.
 */
void mal_native_function_object_set_slot(MalNativeFunctionObject *function, i32 index, MalValue value);
