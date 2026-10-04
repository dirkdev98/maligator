#pragma once

#include "unicode.h"
#include "utf16.h"

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
        : mal_value_from_i32(mal_string_code_unit_at(string, (usize) position));
    MAL_PERF_COUNT(string_char_code_at_direct_hits);
    return result;
}

/** Stronger compiler kernel when a dominating loop test proves the exact Number
 * position is non-negative and below this same primitive String's length. */
static inline MalValue mal_builtin_string_char_code_at_in_bounds(
    MalValue this_value, usize position
) {
    MalString *string = mal_value_to_string(this_value);
    MalValue result = mal_value_from_i32(mal_string_code_unit_at(string, position));
    MAL_PERF_COUNT(string_char_code_at_direct_hits);
    return result;
}

typedef struct MalStringLeafReadCache {
    const MalString *source;
    const MalString *leaf;
    usize start;
    usize end;
    usize leaf_offset;
    u32 heap_epoch;
    /** Consecutive leaf misses on `source` within one heap epoch. */
    u32 misses;
} MalStringLeafReadCache;

#define MAL_STRING_LEAF_READ_FLATTEN_MISSES 16u
#define MAL_STRING_LEAF_READ_FLATTEN_CODE_UNITS ((usize) 1 << 20)

/** Rope and slice tail of `mal_builtin_string_char_code_at_cached_in_bounds`. */
MalValue mal_builtin_string_char_code_at_rope_in_bounds(
    MalVm *vm, MalStringLeafReadCache *cache, MalValue this_value, usize position
);

/** Flat in-range reads stay in generated code, which compilers otherwise call out
 * of line once a kernel carries its rope and conversion paths inline. */
static inline __attribute__((always_inline)) bool mal_builtin_string_char_code_at_flat(
    MalValue this_value, f64 position, MalValue *out
) {
    const MalString *string = mal_value_to_string(this_value);
    // Truncating a non-negative in-range position is its ToIntegerOrInfinity.
    if (string->storage < MAL_STRING_STORAGE_DEPENDENT && position >= 0 &&
        position < (f64) string->length) {
        MAL_PERF_COUNT(string_char_code_at_direct_hits);
        *out = mal_value_from_i32(mal_string_flat_code_unit_at(string, (usize) position));
        return true;
    }
    return false;
}

/** A read within the rope leaf the site's cache last resolved. */
static inline __attribute__((always_inline)) bool mal_builtin_string_char_code_at_cached_leaf(
    const MalVm *vm, const MalStringLeafReadCache *cache, MalValue this_value, usize position,
    MalValue *out
) {
    // Sweep epochs protect unrooted leaf identities; payload addresses are reacquired each read.
    if (cache->source != mal_value_to_string(this_value) || cache->heap_epoch != vm->heap.epoch ||
        position < cache->start || position >= cache->end) {
        return false;
    }
    MAL_PERF_COUNT(string_char_code_at_direct_hits);
    *out = mal_value_from_i32(mal_string_flat_code_unit_at(
        cache->leaf, cache->leaf_offset + position - cache->start));
    return true;
}

static inline __attribute__((always_inline)) MalValue mal_builtin_string_char_code_at_cached_in_bounds(
    MalVm *vm, MalStringLeafReadCache *cache, MalValue this_value, usize position
) {
    MalValue result;
    if (mal_builtin_string_char_code_at_flat(this_value, (f64) position, &result) ||
        mal_builtin_string_char_code_at_cached_leaf(vm, cache, this_value, position, &result)) {
        return result;
    }
    return mal_builtin_string_char_code_at_rope_in_bounds(vm, cache, this_value, position);
}

/** Every `mal_builtin_string_char_code_at_cached_number` case off the flat path. */
MalValue mal_builtin_string_char_code_at_cached_number_slow(
    MalVm *vm, MalStringLeafReadCache *cache, MalValue this_value, f64 position
);

/** `mal_builtin_string_char_code_at_number` for generated sites, which keep a leaf
 * cache so repeated reads of one rope do not walk it from the root. */
static inline __attribute__((always_inline)) MalValue mal_builtin_string_char_code_at_cached_number(
    MalVm *vm, MalStringLeafReadCache *cache, MalValue this_value, f64 position
) {
    MalValue result;
    if (mal_builtin_string_char_code_at_flat(this_value, position, &result)) return result;
    // Cached leaves only cover in-range positions, so a hit needs no conversion.
    if (position >= 0 && position < (f64) mal_string_length(mal_value_to_string(this_value))) {
        if (mal_builtin_string_char_code_at_cached_leaf(vm, cache, this_value, (usize) position, &result)) {
            return result;
        }
        return mal_builtin_string_char_code_at_rope_in_bounds(vm, cache, this_value, (usize) position);
    }
    return mal_builtin_string_char_code_at_cached_number_slow(vm, cache, this_value, position);
}

// Hits cannot allocate or reenter; misses leave output untouched without coercion.
bool mal_builtin_string_char_code_at_try(
    MalVm *vm, MalValue callee, MalValue this_value,
    const MalValue *args, i32 arg_count,
    MalStringLeafReadCache *leaf_cache, MalValue *out
);

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
    i32 arg_count,
    MalStringLeafReadCache *leaf_cache
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
    f64 position,
    MalStringLeafReadCache *leaf_cache
);

MalValue mal_builtin_string_char_code_at_known_generic(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count
);

/** Exact %String.prototype.charCodeAt% invocation after locked primitive-String
 * property resolution was erased. Numeric positions use the semantic kernel inline;
 * coercive positions retain the complete builtin algorithm. */
static inline __attribute__((always_inline)) MalValue mal_builtin_string_char_code_at_known(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,
    MalStringLeafReadCache *leaf_cache
) {
    if (arg_count >= 1 && mal_value_is_string(this_value) && mal_ops_is_number(args[0])) {
        return mal_builtin_string_char_code_at_cached_number(
            vm, leaf_cache, this_value, mal_ops_number_as_f64(args[0]));
    }
    if (arg_count >= 0 && mal_value_is_string(this_value) &&
        (arg_count == 0 || mal_ops_is_number(args[0]))) {
        return mal_builtin_string_char_code_at_cached_number_slow(
            vm, leaf_cache, this_value, arg_count == 0 ? 0 : mal_ops_number_as_f64(args[0]));
    }
    return mal_builtin_string_char_code_at_known_generic(vm, this_value, args, arg_count);
}

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

// Character positions remain UTF-16 code-unit offsets for every physical encoding.
static inline MalValue mal_builtin_string_character_numeric(
    MalVm *vm, MalString *string, f64 position, MalStringCharacterOp operation
) {
    usize length = mal_string_length(string);
    position = mal_ops_number_to_integer_or_infinity(position);
    if (operation == MAL_STRING_CHARACTER_AT && position < 0) position += (f64) length;
    if (position < 0 || position >= (f64) length) {
        return operation == MAL_STRING_CHARACTER_CHAR_AT
            ? mal_value_from_string(mal_intrinsic_ascii(vm, "")) : mal_value_new_undefined();
    }
    usize index = (usize) position;
    c16 unit = mal_string_code_unit_at(string, index);
    if (operation == MAL_STRING_CHARACTER_CODE_POINT_AT) {
        u32 code_point = unit;
        if (index + 1 < length && mal_utf16_is_lead_surrogate(unit)) {
            c16 trail = mal_string_code_unit_at(string, index + 1);
            if (mal_utf16_is_trail_surrogate(trail)) {
                code_point = mal_utf16_compose_pair(unit, trail);
            }
        }
        return mal_value_from_i32((i32) code_point);
    }
    return mal_value_from_string(mal_intrinsic_code_unit(vm, unit));
}

// Flat-string guard misses leave receiver coercion and position conversion to the caller.
bool mal_builtin_string_character_direct(
    MalVm *vm, MalValue receiver, f64 position,
    MalStringCharacterOp operation, MalValue *result
);

// Search primitive strings without changing their representation.
MalValue mal_builtin_string_search_strings(
    MalString *string, MalString *search, f64 position, MalStringSearchOp operation
);

// A false result is side-effect-free; primitive strings search their borrowed leaf storage.
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
 * ordinary String#split call as the complete fallback. On success, both output
 * values must remain rooted across reentry. The opaque traversal root retains the
 * separator for flat input, or owns a rope frontier and copied search pattern.
 */
bool mal_builtin_string_split_cursor_init(
    MalVm *vm,
    MalValue callee,
    MalValue receiver,
    MalValue separator,
    MalValue *subject_out,
    MalValue *traversal_out,
    MalStringSplitCursor *cursor_out
);

/** Locked-world cursor initialization with the builtin identity proved by C emission. */
bool mal_builtin_string_split_cursor_init_locked(
    MalVm *vm,
    MalValue receiver,
    MalValue separator,
    MalValue *subject_out,
    MalValue *traversal_out,
    MalStringSplitCursor *cursor_out
);

/** Publish the next split element as an immutable subject span. */
bool mal_builtin_string_split_cursor_next(
    MalValue subject,
    MalValue traversal,
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

/** For a certified length-only consumer; never creates a trimmed string. */
bool mal_builtin_string_trim_span_length_direct(
    MalVm *vm, MalValue callee, MalValue subject, usize start, usize end, u32 *out);

/** Caller proves the captured builtin identity and any required semantic epochs. */
bool mal_builtin_string_trim_span_length_locked(
    MalValue subject, usize start, usize end, u32 *out);

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

MalValue mal_builtin_string_case_known(MalVm *vm, MalString *string, bool upper, MalUnicodeLocale locale);
MalValue mal_builtin_string_normalize_known(MalVm *vm, MalString *string, bool compatibility, bool compose);

MalValue mal_builtin_string_trim_known(MalVm *vm, MalString *string, bool start, bool end);
MalValue mal_builtin_string_is_well_formed_known(MalString *string);
MalValue mal_builtin_string_to_well_formed_known(MalVm *vm, MalString *string);

// Canonical primitive-string calls; replacement and attribute coercion remain observable.
MalValue mal_builtin_string_replace_known(MalVm *vm, MalString *string, MalString *search, MalValue replacement, bool all);
MalValue mal_builtin_string_html_known(MalVm *vm, MalString *string, MalValue attribute_value, const byte *tag, const byte *attribute);

// Primitive locale/options data are prepared; receiver and comparison coercions still run in order.
MalValue mal_builtin_string_locale_compare_prepared(MalVm *vm, MalValue receiver, MalValue that, const byte *locale, usize locale_length, u8 options);
