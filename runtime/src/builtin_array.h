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

/** Exact %Array.prototype.push% invocation after locked property resolution was
 * erased by the compiler. Dense ordinary Arrays append without callback/identity
 * guards; every representation or semantic miss executes the builtin algorithm. */
MalValue mal_builtin_array_push_known(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count
);

/**
 * Whether an ordinary Array can execute the intrinsic push algorithm without
 * observing prototype mutation. Direct builtin dispatch rechecks this at the
 * call boundary and falls back to the ordinary algorithm on rejection.
 */
bool mal_builtin_array_push_virtual_guard(MalVm *vm);
