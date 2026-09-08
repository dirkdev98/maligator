#pragma once

#include "./defaults.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "perf_stats.h"
#include "value_ops.h"
#include "vm.h"

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

/** Guarded direct dispatch whose Core certificate proves the raw f64 position is
 * an exact non-negative integer below the same primitive String receiver length.
 * The cast happens only after the live receiver and builtin identity guards pass. */
MalCompletion mal_builtin_string_char_code_at_direct_in_bounds(
    MalVm *vm,
    MalCallCache *fallback_cache,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    f64 position
);

/** Exact %String.prototype.charCodeAt% invocation after locked primitive-String
 * property resolution was erased. Numeric positions use the semantic kernel;
 * coercive positions retain the complete builtin algorithm. */
MalValue mal_builtin_string_char_code_at_known(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count
);

typedef enum MalStringSearchOp {
    MAL_STRING_SEARCH_INDEX_OF,
    MAL_STRING_SEARCH_LAST_INDEX_OF,
    MAL_STRING_SEARCH_INCLUDES,
    MAL_STRING_SEARCH_STARTS_WITH,
    MAL_STRING_SEARCH_ENDS_WITH,
} MalStringSearchOp;

typedef enum MalStringCharacterOp {
    MAL_STRING_CHARACTER_AT,
    MAL_STRING_CHARACTER_CHAR_AT,
    MAL_STRING_CHARACTER_CODE_POINT_AT,
} MalStringCharacterOp;

// Flat-string guard misses leave receiver coercion and position conversion to the caller.
bool mal_builtin_string_character_direct(
    MalVm *vm, MalValue receiver, f64 position,
    MalStringCharacterOp operation, MalValue *result
);

// A false result is side-effect-free; flat primitive strings take the allocation-free path.
bool mal_builtin_string_search_direct(
    MalValue receiver, MalValue needle, f64 position,
    MalStringSearchOp operation, MalValue *result
);

/** Allocation-free summary of a closed ASCII upper/lower-case capture chain. */
bool mal_builtin_string_ascii_case_chain_length_span(
    MalVm *vm,
    MalValue upper_callee,
    MalValue lower_callee,
    MalValue subject,
    i32 start,
    i32 end,
    u32 *length_out
);

/** Authority-closed variant: Core proved both String method identities. */
bool mal_builtin_string_ascii_case_chain_length_span_locked(
    MalVm *vm,
    MalValue subject,
    i32 start,
    i32 end,
    u32 *length_out
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

/** Locked slice identity plus compiler-proven exact Number intrinsic. */
bool mal_builtin_string_slice_to_number_direct_locked(
    MalVm *vm,
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

/**
 * Locked-world variant of the split projection. The compiler has proved the
 * builtin identity and retained the ordinary Get+Call as the local-guard
 * fallback, so this entry point validates only the receiver and arguments.
 */
bool mal_builtin_string_split_projection_locked(
    MalVm *vm,
    MalValue receiver,
    MalValue separator,
    const u32 *indices,
    MalValue **outputs,
    u32 output_count,
    u32 *length_out
);

/** Exact locked String.prototype.split call after property/callback resolution. */
MalValue mal_builtin_string_split_direct(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 arg_count
);

/** Loop-carried state for a compiler-proven closed String#split result. */
typedef struct {
    usize position;
    bool done;
} MalStringSplitCursor;

/**
 * Start a closed split cursor. A false result is side-effect-free and leaves the
 * ordinary String#split call as the complete fallback.
 */
bool mal_builtin_string_split_cursor_init(
    MalVm *vm,
    MalValue callee,
    MalValue receiver,
    MalValue separator,
    MalValue *subject_out,
    MalValue *separator_out,
    MalStringSplitCursor *cursor_out
);

/** Locked-world cursor initialization with the builtin identity proved by C emission. */
bool mal_builtin_string_split_cursor_init_locked(
    MalVm *vm,
    MalValue receiver,
    MalValue separator,
    MalValue *subject_out,
    MalValue *separator_out,
    MalStringSplitCursor *cursor_out
);

/** Publish the next split element as an immutable subject span. */
bool mal_builtin_string_split_cursor_next(
    MalValue subject,
    MalValue separator,
    MalStringSplitCursor *cursor,
    usize *start_out,
    usize *end_out
);

/** Materialize one split span for the cold generic String method path. */
MalValue mal_builtin_string_split_cursor_materialize(
    MalVm *vm, MalValue subject, usize start, usize end
);

/** Validate the exact current-Realm trim callback once for a licensed region. */
bool mal_builtin_string_trim_identity(MalVm *vm, MalValue callee);

/** Guard and execute exact builtin trim directly over one split span. */
bool mal_builtin_string_trim_span_direct(
    MalVm *vm,
    MalValue callee,
    MalValue subject,
    usize start,
    usize end,
    MalValue *out
);

/** Locked-world span trim with the builtin identity proved by C emission. */
bool mal_builtin_string_trim_span_direct_locked(
    MalVm *vm,
    MalValue subject,
    usize start,
    usize end,
    MalValue *out
);

/** Mutable-world region variant after one entry identity/epoch validation. */
bool mal_builtin_string_trim_span_direct_licensed(
    MalVm *vm,
    MalValue subject,
    usize start,
    usize end,
    MalValue *out
);

typedef enum MalStringRangeOp {
    MAL_STRING_RANGE_SLICE,
    MAL_STRING_RANGE_SUBSTRING,
    MAL_STRING_RANGE_SUBSTR,
} MalStringRangeOp;

// Canonical builtin identity, primitive receiver, and numeric bounds are caller proofs.
MalValue mal_builtin_string_range_numeric(MalVm *vm, MalString *string, f64 start, f64 end, MalStringRangeOp operation);
MalValue mal_builtin_string_repeat_numeric(MalVm *vm, MalString *string, f64 count);
MalValue mal_builtin_string_from_codes_numbers(MalVm *vm, const f64 *numbers, i32 count, bool code_points);

MalValue mal_builtin_string_pad_numeric(MalVm *vm, MalString *string, f64 target, MalValue fill, bool pad_start);
// A guard miss has no effects; a hit may allocate or leave a pending throw.
bool mal_builtin_string_concat_direct(MalVm *vm, MalValue receiver, const MalValue *arguments, i32 argument_count, MalValue *result);
