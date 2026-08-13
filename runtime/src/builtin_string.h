#pragma once

#include "./defaults.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "perf_stats.h"
#include "value_ops.h"
#include "vm.h"

/**
 * Create the String constructor and install the String builtins on
 * %String.prototype%.
 *
 * There are no wrapper objects: constructing behaves like calling and string
 * methods receive the primitive string as their this value.
 */
void mal_builtin_string_install(MalVm *vm);

/**
 * Non-coercing semantic kernel for a compiler-proven primitive String receiver
 * and Number position. The surrounding protocol license proves that the loaded
 * method is the unmodified builtin. Keeping this header-local lets generated C
 * remove native dispatch entirely on an optimistic hit.
 */
static inline MalValue mal_builtin_string_char_code_at_number(
    MalValue this_value, f64 position
) {
    position = mal_ops_number_to_integer_or_infinity(position);
    MalString *string = mal_value_to_string(this_value);
    MalValue result = position < 0 || position >= (f64) mal_string_length(string)
        ? mal_value_new_nan()
        : mal_value_from_i32(mal_string_code_units(string)[(usize) position]);
    MAL_PERF_COUNT(string_char_code_at_direct_hits);
    return result;
}

/** Stronger compiler kernel when a dominating loop test proves the exact Number
 * position is non-negative and below this same primitive String's length. */
static inline MalValue mal_builtin_string_char_code_at_in_bounds(
    MalValue this_value, usize position
) {
    MalString *string = mal_value_to_string(this_value);
    MalValue result = mal_value_from_i32(mal_string_code_units(string)[position]);
    MAL_PERF_COUNT(string_char_code_at_direct_hits);
    return result;
}

/**
 * Guarded native-backend dispatch for a direct `.charCodeAt(...)` site.
 * Primitive strings with the live builtin callback and an absent or numeric position
 * read their UTF-16 code unit directly; every guard miss uses the ordinary
 * per-site cached call path unchanged.
 */
MalCompletion mal_builtin_string_char_code_at_direct(
    MalVm *vm,
    MalCallCache *fallback_cache,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
);

/** Closed native path for `primitiveString.search(/literal/)`. */
bool mal_builtin_string_search_regexp_direct(
    MalVm *vm,
    MalValue callee,
    MalValue receiver,
    MalValue regexp,
    MalValue *out
);

/**
 * Producer-consumer fusion for exact builtin `string.slice(start)` immediately
 * consumed by the exact Number constructor. Guard failure is side-effect-free.
 */
bool mal_builtin_string_slice_to_number_direct(
    MalVm *vm,
    MalValue slice_callee,
    MalValue number_callee,
    MalValue receiver,
    f64 relative_start,
    f64 *number_out
);

#define MAL_STRING_SPLIT_PROJECTION_MAX_OUTPUTS 8u

/**
 * Allocation-free Array projection for a compiler-proven `String#split` result.
 * Materializes only the requested element indices and returns the virtual result
 * length. Guard failure has no observable effect so generated code can execute
 * the complete Get+Call+property fallback unchanged.
 */
bool mal_builtin_string_split_projection(
    MalVm *vm,
    MalValue callee,
    MalValue receiver,
    MalValue separator,
    const u32 *indices,
    MalValue **outputs,
    u32 output_count,
    u32 *length_out
);
