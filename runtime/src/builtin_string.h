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
