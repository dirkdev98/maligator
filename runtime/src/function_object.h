#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalVm MalVm;
typedef struct MalString MalString;
typedef struct MalEnv MalEnv;
#if MAL_REALMS
typedef struct MalRealm MalRealm;
#endif

typedef enum MalFunctionOwnKey {
    MAL_FUNCTION_OWN_LENGTH = 1 << 0,
    MAL_FUNCTION_OWN_NAME = 1 << 1,
    MAL_FUNCTION_OWN_ARGUMENTS = 1 << 2,
    MAL_FUNCTION_OWN_CALLER = 1 << 3,
    MAL_FUNCTION_OWN_PROTOTYPE = 1 << 4,
} MalFunctionOwnKey;

typedef struct MalFunctionObject {
    MalObject object;
    MalObject *property_storage;
    MalValue metadata[2];
    i32 function_index;
    // Creation-time keys retain their order even when installed lazily or moved to a table.
    u8 initial_own_keys;

    // Closed images select a tagged owner, inline vector, or exact complete chain.
    // Dynamic images retain the ordinary lexical chain.
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
    MalObject *property_storage;
    MalValue metadata[3];

    MalString *name;
    MalNativeFunctionCallback callback;

    /**
     * Small closure slot sets borrow the trailing storage. Larger sets own a
     * RAW vector so the cell stays in a small size class.
     */
    MalValue *slots;
    i32 slot_count;
    bool slots_inline;

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

    bool is_async;

#if MAL_PROFILE && MAL_PERF_STATS
    /** Exact-profile subsystem owning this native callback, or zero for core runtime. */
    u8 profile_category;
#endif

#if MAL_REALMS
    /**
     * The realm this native function was created in, stamped at init from
     * heap->current_realm. Back-pointer to malloc-owned realm metadata (not a GC
     * cell); the collector never traces it (realms are scanned via vm->realms).
     */
    MalRealm *realm;
#endif

    /** Keep the inline closure slots aligned on targets with narrower pointers. */
    MalValue trailing[];
} MalNativeFunctionObject;

/**
 * The shared shape whose own properties are `length` and, when named, `name`, in
 * that order. Shapes live as long as their heap, so callers may cache the result
 * for fixed keys.
 */
MalShape *mal_function_object_metadata_shape(
    MalHeap *heap, MalKey length_key, MalKey name_key, bool named);

/**
 * Allocate a script function in one cell: the object, its `length` and `name`
 * fields in `metadata_shape` (named), then capture_bytes of tail storage. The caller
 * initializes the capture tail before any allocation, publication, or safepoint.
 */
static inline MalFunctionObject *mal_function_object_new(
    MalHeap *heap,
    MalShape *metadata_shape,
    MalObject *prototype,
    i32 function_index,
    i32 length,
    MalString *name,
    usize capture_bytes
) {
    assert(name != nullptr && metadata_shape->inline_count == 2);
    MalFunctionObject *function = mal_heap_alloc_uninitialized(
        heap, sizeof(MalFunctionObject) + capture_bytes,
        MAL_HEAP_FUNCTION_OBJECT);
    // Closures are created per call, so the fresh cell is initialized in place rather
    // than through the generic object and shaped-value constructors.
    MalValue *fields = function->metadata;
    MalHeapHeader header = function->object.header;
    function->object = (MalObject) {
        .header = header,
        .extensible = true,
        .storage_kind = MAL_OBJECT_COMPACT,
        .slot_capacity = 2,
        // Function state follows these fields; property growth must move elsewhere.
        .inline_payload_eights = 2,
        .shape = metadata_shape,
    };
    function->property_storage = prototype;
    mal_object_mark_as_prototype(prototype);
    function->function_index = function_index;
    function->initial_own_keys = MAL_FUNCTION_OWN_LENGTH | MAL_FUNCTION_OWN_NAME;
    function->creation_env = nullptr;
#if MAL_REALMS
    function->realm = heap->current_realm;
#endif
    fields[0] = mal_value_from_i32(length);
    fields[1] = mal_value_from_string(name);
    mal_gc_card(&function->object.header, fields[1]);
    return function;
}

/**
 * Read the VM function definition index carried by a script function object.
 */
static inline i32 mal_function_object_function_index(const MalFunctionObject *function) {
    return function->function_index;
}

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

static inline MalNativeFunctionCallback mal_native_function_object_callback(
    const MalNativeFunctionObject *function
) {
    return function->callback;
}

/**
 * Whether the native function implements [[Construct]].
 */
bool mal_native_function_object_is_constructor(const MalNativeFunctionObject *function);

/**
 * Flag the native function as a constructor (implements [[Construct]]).
 */
void mal_native_function_object_set_constructor(MalNativeFunctionObject *function);

bool mal_native_function_object_is_async(const MalNativeFunctionObject *function);
// JS-compatible async callbacks must return a Promise for every completion.
void mal_native_function_object_set_async(MalNativeFunctionObject *function);

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
