#pragma once

#include "./defaults.h"
#include "intrinsics.h"
#include "vm.h"

/** Builtin Array.prototype.values callback used by guarded iterator fast paths. */
extern MalNativeFunctionCallback mal_array_values_callback;

/**
 * Create the Array constructor and install the Array builtins on the
 * constructor and %Array.prototype%.
 */
void mal_builtin_array_install(MalVm *vm);

/**
 * Spec-flavored HasProperty + Get for an element, walking the prototype chain
 * and invoking accessor getters. Strings expose their code units; other
 * primitives have no elements. Returns false for holes and for getters that
 * threw; the latter leaves the throw completion on the vm.
 */
bool mal_builtin_array_try_get(MalVm *vm, MalValue this_value, u32 index, MalValue *out);

/**
 * Spec-shaped length read for generic array iteration: any receiver except
 * null and undefined is accepted, and the length is read through a
 * u32-clamped ToLength. Strings answer their code unit count, other
 * primitives carry no elements. Returns false after throwing.
 */
bool mal_builtin_array_this_length(MalVm *vm, MalValue this_value, u32 *length_out);

/** Side-effect-free exact Array.prototype.map + default species guard. */
bool mal_builtin_array_exact_map_guard(
    MalVm *vm, MalValue callee, MalValue receiver);
bool mal_builtin_array_default_map_guard(MalVm *vm, MalValue receiver);

/**
 * Guarded native-backend dispatch for a direct `.push(...)` site. A fully intact
 * intrinsic method on an eligible ordinary dense Array appends directly; every
 * guard miss uses the ordinary per-site cached call path unchanged.
 */
MalCompletion mal_builtin_array_push_direct(
    MalVm *vm,
    MalCallCache *fallback_cache,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    bool *exact_hit_out
);

typedef enum MalPrivateAggregateMemoState {
    MAL_PRIVATE_AGGREGATE_MEMO_EMPTY = 0,
    MAL_PRIVATE_AGGREGATE_MEMO_FILLED = 1,
    MAL_PRIVATE_AGGREGATE_MEMO_DISABLED = 2,
} MalPrivateAggregateMemoState;

/**
 * Activation-local cache for one compiler-proven private dense-Number reducer.
 * `roots` points at caller-owned GC slots [callee, input]. The cached result is
 * admitted only when it is an immediate Number and therefore needs no root.
 */
typedef struct MalPrivateAggregateMemo {
    MalValue *roots;
    MalValue result;
    u64 watched_methods_epoch;
    u64 array_elements_epoch;
    u32 input_length;
#if MAL_REALMS
    MalRealm *realm;
#endif
    MalPrivateAggregateMemoState state;
    bool private_ok;
    bool admitted;
} MalPrivateAggregateMemo;

void mal_builtin_array_private_aggregate_memo_init(
    MalVm *vm, MalPrivateAggregateMemo *cache, MalValue input);
void mal_builtin_array_private_aggregate_memo_note_push(
    MalVm *vm, MalPrivateAggregateMemo *cache, bool exact_hit);
bool mal_builtin_array_private_aggregate_memo_probe(
    MalVm *vm, MalPrivateAggregateMemo *cache, MalValue callee,
    MalValue this_value, MalValue input, i32 function_index, MalValue *out);
void mal_builtin_array_private_aggregate_memo_fill(
    MalVm *vm, MalPrivateAggregateMemo *cache, MalValue callee,
    MalValue this_value, MalValue input, i32 function_index, MalValue result);

/**
 * Whether a freshly-created ordinary Array can execute the intrinsic push
 * algorithm without observing prototype mutation. Used by native virtual-array
 * regions before any physical receiver exists; callers recheck at every load and
 * call boundary and materialize on rejection.
 */
bool mal_builtin_array_push_virtual_guard(MalVm *vm);

/**
 * Admit the local representation and scheduling conditions for one fact-licensed
 * numeric `Array.prototype.reduce` region. Builtin identity and protector
 * dependencies are admitted by generated code through the shared semantic bridge;
 * this helper only exposes exact dense storage when the loop cannot be preempted.
 * On success `*elements_out` may be read directly for `[0, *length_out)`: the
 * admitted region allocates nothing, calls no JavaScript, and takes no
 * safepoint, so neither the dense storage nor the element values can change
 * before it ends. That is also why admission refuses while a preemption hook is
 * installed — the region replaces the per-element polls of the ordinary loop.
 *
 * The elements are NOT proven to be Numbers here. A region reads them under its
 * own per-element check and abandons the native attempt at the first element
 * that is not one, which is free precisely because nothing it did was
 * observable.
 */
bool mal_builtin_array_numeric_fold_local_admit(
    MalVm *vm,
    MalValue receiver,
    const MalValue **elements_out,
    u32 *length_out
);
