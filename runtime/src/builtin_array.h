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

/** Array literal spread semantics with a packed ordinary-Array fast path. */
MalValue mal_builtin_array_from_iterable(MalVm *vm, MalValue source);

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

bool mal_builtin_array_at_try_direct(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue *result_out
);

MalCompletion mal_builtin_array_at_direct(
    MalVm *vm,
    MalCallCache *fallback_cache,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

/** Array callback methods admitted by the compiler's known-builtin analysis. */
typedef enum MalBuiltinArrayIterationOp {
    MAL_BUILTIN_ARRAY_ITERATION_FOR_EACH,
    MAL_BUILTIN_ARRAY_ITERATION_SOME,
    MAL_BUILTIN_ARRAY_ITERATION_EVERY,
    MAL_BUILTIN_ARRAY_ITERATION_FIND,
    MAL_BUILTIN_ARRAY_ITERATION_FIND_INDEX,
    MAL_BUILTIN_ARRAY_ITERATION_MAP,
    MAL_BUILTIN_ARRAY_ITERATION_FILTER,
    MAL_BUILTIN_ARRAY_ITERATION_REDUCE,
    MAL_BUILTIN_ARRAY_ITERATION_REDUCE_RIGHT,
    MAL_BUILTIN_ARRAY_ITERATION_FIND_LAST,
    MAL_BUILTIN_ARRAY_ITERATION_FIND_LAST_INDEX,
    MAL_BUILTIN_ARRAY_ITERATION_FLAT_MAP,
} MalBuiltinArrayIterationOp;

/**
 * Call a statically identified Array callback builtin after validating the
 * ordinary loaded callee once. A shadowed or cross-Realm method retains the
 * original cached call and all of its observable behavior.
 */
MalCompletion mal_builtin_array_iteration_direct(
    MalVm *vm,
    MalCallCache *fallback_cache,
    MalBuiltinArrayIterationOp operation,
    i32 callback_function_index,
    MalCompiledFunction compiled_callback,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

/** Exact %Array.prototype.push% invocation after locked property resolution was
 * erased by the compiler. Dense ordinary Arrays append without callback/identity
 * guards; every representation or semantic miss executes the builtin algorithm. */
MalValue mal_builtin_array_push_known(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count
);

/** Exact dense operations after Core proves an initially dense fresh Array remains private
 * and is used only by push/pop and length reads for its whole lifetime. */
MalValue mal_builtin_array_push_contained(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count
);
MalValue mal_builtin_array_pop_contained(MalVm *vm, MalValue this_value);

/**
 * Whether an ordinary Array can execute the intrinsic push algorithm without
 * observing prototype mutation. Direct builtin dispatch rechecks this at the
 * call boundary and falls back to the ordinary algorithm on rejection.
 */
bool mal_builtin_array_push_virtual_guard(MalVm *vm);

/** Try a non-reentrant dense append; false leaves JS-visible Array state unchanged. */
bool mal_builtin_array_push_try_direct(
    MalVm *vm,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue *result_out
);

/** Side-effect-free proof for iterating a fresh current-realm Array. */
bool mal_builtin_array_iterator_protocol_guard(MalVm *vm);

bool mal_builtin_array_pair_destructure_try(
    MalVm *vm, MalValue source,
    MalValue *first_out, bool *first_done_out,
    MalValue *second_out, bool *second_done_out
);

MalValue mal_builtin_array_sort(MalVm *vm, MalValue receiver,
    const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee);
MalValue mal_builtin_array_to_sorted(MalVm *vm, MalValue receiver,
    const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee);
