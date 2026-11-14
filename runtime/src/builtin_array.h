#pragma once

#include "./defaults.h"
#include "intrinsics.h"
#include "perf_stats.h"
#include "value_ops.h"
#include "vm.h"

#include <math.h>

/** Builtin Array.prototype.values callback used by guarded iterator fast paths. */

/**
 * Create the Array constructor and install the Array builtins on the
 * constructor and %Array.prototype%.
 */
void mal_builtin_array_install(MalVm *vm);

/** Numeric SameValueZero search using the runtime's vectorized word scan. */
bool mal_builtin_array_dense_numeric_includes(
    const MalArrayObject *array, MalValue search, u32 start);

/**
 * An exact loaded includes method can search an ordinary dense Array without a
 * native call frame. Numeric fromIndex cannot reenter; all coercing inputs and
 * indexed prototype changes retain the generic algorithm.
 */
static inline bool mal_builtin_array_includes_try(
    MalVm *vm, MalValue callee, MalValue receiver, MalValue search,
    MalValue from_index, bool *out
) {
    if (callee != vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE_INCLUDES] ||
        !mal_value_is_array_object(receiver) ||
        vm->semantic_epochs.array_elements != MAL_SEMANTIC_EPOCH_INITIAL) {
        MAL_PERF_COUNT(array_includes_direct_fallbacks);
        return false;
    }
    const MalArrayObject *array = mal_value_to_array_object(receiver);
    if (array->dense_deopted || mal_object_prototype(&array->object) !=
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE])) {
        MAL_PERF_COUNT(array_includes_direct_fallbacks);
        return false;
    }
    u32 length = array->length;
    // Includes returns before coercing fromIndex when the snapped length is zero.
    if (length == 0) {
        *out = false;
        MAL_PERF_COUNT(array_includes_direct_hits);
        return true;
    }
    f64 relative = 0;
    if (!mal_value_is_undefined(from_index)) {
        if (!mal_ops_is_number(from_index)) {
            MAL_PERF_COUNT(array_includes_direct_fallbacks);
            return false;
        }
        relative = trunc(mal_ops_number_as_f64(from_index));
    }
    MAL_PERF_COUNT(array_includes_direct_hits);
    if (relative >= (f64) length) {
        *out = false;
        return true;
    }
    if (relative < 0) relative += (f64) length;
    u32 start = relative > 0 ? (u32) relative : 0;
    if (mal_ops_is_number(search) && array->dense_count >= 8) {
        *out = mal_builtin_array_dense_numeric_includes(array, search, start);
        return true;
    }
    u32 end = array->dense_count < length ? array->dense_count : length;
    for (u32 index = start; index < end; index++) {
        MalValue element = array->elements[index];
        if (mal_value_is_array_hole(element)) element = MAL_VALUE_UNDEFINED;
        if (mal_ops_strict_equal_bool(element, search) ||
            (mal_value_is_nan(element) && mal_value_is_nan(search))) {
            *out = true;
            return true;
        }
    }
    *out = end < length && mal_value_is_undefined(search);
    return true;
}

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

/**
 * Whether `callee.call(receiver, ...)` is the realm's own `Array.from` on its own
 * Array constructor, so that the result is a fresh Array holding only what the
 * mapper returned.
 */
bool mal_builtin_array_from_is_realm_own(const MalVm *vm, MalValue callee, MalValue receiver);

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
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    bool *exact_hit_out
);

/**
 * Guarded dispatch for a direct `.pop()`, `.shift()` or `.unshift(...)` site.
 * The intrinsic method on an ordinary dense Array whose prototype chain holds no
 * indexed properties applies its dense fast path; any other case returns false
 * without mutating, and the `_direct` entry then makes the ordinary cached call.
 */
bool mal_builtin_array_deque_try_direct(
    MalVm *vm,
    MalGuardedBuiltinCallOp operation,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    MalValue *result_out
);

MalCompletion mal_builtin_array_deque_direct(
    MalVm *vm,
    MalGuardedBuiltinCallOp operation,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

/**
 * The `__arrayIterationEligible` guard over its four arguments: the loaded
 * method, the receiver, the method id and a callable. Side-effect free.
 */
bool mal_builtin_array_iteration_eligible_values(MalVm *vm, const MalValue *args);

#define MAL_BUILTIN_ARRAY_ITERATION_METHOD_COUNT 12
/** The builtin each `__arrayIterationEligible` method id stands for. */
extern MalNativeFunctionCallback const
    mal_builtin_array_iteration_callbacks[MAL_BUILTIN_ARRAY_ITERATION_METHOD_COUNT];
/** Whether ArraySpeciesCreate on an exact Array receiver builds a plain Array. */
bool mal_builtin_array_default_species(MalVm *vm, MalValue receiver);

/**
 * mal_builtin_array_iteration_eligible_values over separate operands, for generated
 * code: a constant method id folds to one callback comparison.
 */
static inline __attribute__((always_inline)) bool mal_builtin_array_iteration_eligible_known(
    MalVm *vm, MalValue method, MalValue receiver, MalValue method_id, MalValue callback
) {
    f64 id = mal_ops_number_as_f64(method_id);
    if (!mal_value_is_array_object(receiver) || !mal_value_is_native_function_object(method) ||
        !mal_value_is_callable(callback) ||
        !(id >= 0 && id < MAL_BUILTIN_ARRAY_ITERATION_METHOD_COUNT)) {
        return false;
    }
    u32 index = (u32) id;
    MalValue prototype = vm->intrinsics[MAL_INTRINSIC_ARRAY_PROTOTYPE];
    const MalObject *array = &mal_value_to_array_object(receiver)->object;
    if (!mal_value_is_object(prototype) || mal_object_prototype(array) != mal_value_to_object(prototype) ||
        mal_native_function_object_callback(mal_value_to_native_function_object(method)) !=
            mal_builtin_array_iteration_callbacks[index]) {
        return false;
    }
#if MAL_REALMS
    if (mal_vm_callee_realm(vm, method) != vm->current_realm) return false;
#endif
    // map, filter and flatMap build their result with ArraySpeciesCreate.
    if (index != 5 && index != 6 && index != 11) return true;
#if MAL_PRIMORDIALS_LOCKED
    // The locked graph keeps %Array.prototype%.constructor; only an own one could redirect.
    if (array->shape != nullptr && array->shape->inline_count == 0 &&
        !mal_object_has_public_overflow(array)) {
        return true;
    }
#endif
    return mal_builtin_array_default_species(vm, receiver);
}

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
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

// Families share callback argument contracts, never receiver or result semantics.
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
    MAL_BUILTIN_TYPED_ARRAY_FOR_EACH,
    MAL_BUILTIN_TYPED_ARRAY_SOME,
    MAL_BUILTIN_TYPED_ARRAY_EVERY,
    MAL_BUILTIN_TYPED_ARRAY_FIND,
    MAL_BUILTIN_TYPED_ARRAY_FIND_INDEX,
    MAL_BUILTIN_TYPED_ARRAY_MAP,
    MAL_BUILTIN_TYPED_ARRAY_FILTER,
    MAL_BUILTIN_TYPED_ARRAY_FIND_LAST,
    MAL_BUILTIN_TYPED_ARRAY_FIND_LAST_INDEX,
    MAL_BUILTIN_COLLECTION_FOR_EACH,
    MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_SOME,
    MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_EVERY,
    MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FIND,
    MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FIND_INDEX,
    MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_MAP,
    MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FILTER,
    MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FIND_LAST,
    MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_FIND_LAST_INDEX,
    MAL_BUILTIN_TYPED_ARRAY_REDUCE,
    MAL_BUILTIN_TYPED_ARRAY_REDUCE_RIGHT,
    MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_REDUCE,
    MAL_BUILTIN_ARRAY_OR_TYPED_ARRAY_REDUCE_RIGHT,
    MAL_BUILTIN_MAP_FOR_EACH,
    MAL_BUILTIN_SET_FOR_EACH,
} MalBuiltinArrayIterationOp;

/**
 * Call a statically identified collection callback builtin after validating the
 * ordinary loaded callee once. A shadowed or cross-Realm method retains the
 * original cached call and all of its observable behavior.
 */
MalCompletion mal_builtin_array_iteration_direct(
    MalVm *vm,
    MalBuiltinArrayIterationOp operation,
    i32 callback_function_index,
    MalCompiledFunction compiled_callback,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

MalCompletion mal_builtin_array_numeric_reduce_direct(
    MalVm *vm,
    MalBuiltinArrayIterationOp operation,
    i32 callback_function_index,
    MalCompiledFunction compiled_callback,
    MalNumericReduceCallback numeric_reduce_callback,
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
