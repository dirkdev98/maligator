#include "builtin_string.h"

#include <assert.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "builtin_intl.h"
#include "builtin_iterator.h"
#include "builtin_regexp.h"
#include "ascii.h"
#include "checked_size.h"
#include "ecma_whitespace.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "perf_stats.h"
#include "profile.h"
#include "primitive_wrapper_object.h"
#include "rooted_collection.h"
#include "u16_buffer.h"
#include "utf16.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// ToString of a String argument (the constructor's input and the search/replace/
// separator arguments of the prototype methods): full ToString, so an object's
// @@toPrimitive / toString / valueOf runs and a Symbol throws a TypeError. On an
// abrupt completion (or one already pending — e.g. a sibling argument threw)
// returns the empty string; the throw is detected at the native-call boundary
// and the harmless computed result discarded, matching the spec's ReturnIfAbrupt.
static MalString *mal_builtin_string_coerce(MalVm *vm, MalValue value) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_intrinsic_ascii(vm, "");
    }
    if (mal_value_is_string(value)) {
        return mal_value_to_string(value);
    }
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) {
        return mal_intrinsic_ascii(vm, "");
    }
    return string;
}

/**
 * RequireObjectCoercible + ToString of a method receiver. Null/undefined throw
 * a TypeError; a String wrapper unwraps to its [[StringData]] (the ordinary
 * ToString would otherwise stringify the object as "[object Object]"); other
 * values stringify normally. On a nil receiver it sets a pending TypeError and
 * returns the empty string; the throw is detected at the call boundary and the
 * harmless computed result is discarded, so no caller needs a nullptr guard.
 */
static MalString *mal_builtin_string_this_to_string(MalVm *vm, MalValue this_value) {
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "String.prototype method called on null or undefined");
        return mal_intrinsic_ascii(vm, "");
    }
    if (mal_value_is_string(this_value)) {
        return mal_value_to_string(this_value);
    }

    MalValue primitive;
    if (mal_value_this_string_value(this_value, &primitive)) {
        return mal_value_to_string(primitive);
    }

    // ToString of a Symbol throws (the abstract operation, unlike String(sym)).
    if (mal_value_is_symbol(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol value to a string");
        return mal_intrinsic_ascii(vm, "");
    }

    // VM ToString runs a user toString/valueOf (and ToPrimitive); on a throw it
    // sets vm->completion, detected at the call boundary, and we return the
    // harmless empty string.
    MalString *string;
    if (!mal_vm_to_string(vm, this_value, &string)) {
        return mal_intrinsic_ascii(vm, "");
    }
    return string;
}

/**
 * ToNumber of a method argument that must throw on the non-coercible numeric
 * inputs (Symbol, BigInt) the way ToIntegerOrInfinity does. On a throwing input
 * it sets a pending TypeError and returns NaN; the throw is detected at the call
 * boundary so callers need no extra guard.
 */
static f64 mal_builtin_string_arg_to_number(MalVm *vm, MalValue value) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return NAN;
    }
    if (mal_ops_is_number(value)) {
        return mal_ops_number_as_f64(value);
    }
    // VM ToNumber runs ToPrimitive (a user valueOf/toString, and unwraps a
    // primitive wrapper) and throws TypeError on a Symbol or BigInt input. On a
    // throw it sets vm->completion, detected at the call boundary, and we return
    // NaN.
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) {
        return NAN;
    }
    return number;
}

/**
 * Non-observable Number extraction for primitive fast paths. Undefined is
 * represented as NaN because every String index operation below subsequently
 * applies ToIntegerOrInfinity/ToLength (or lastIndexOf's explicit NaN rule).
 */
static bool mal_builtin_string_primitive_number(MalValue value, f64 *number_out) {
    if (mal_ops_is_number(value)) {
        *number_out = mal_ops_number_as_f64(value);
        return true;
    }
    if (mal_value_is_undefined(value)) {
        *number_out = NAN;
        return true;
    }
    return false;
}

static bool mal_builtin_string_primitive_number_arg(
    const MalValue *args,
    i32 arg_count,
    i32 index,
    f64 missing,
    f64 *number_out
) {
    if (arg_count <= index) {
        *number_out = missing;
        return true;
    }
    return mal_builtin_string_primitive_number(args[index], number_out);
}

static bool mal_builtin_string_is_flat_value(MalValue value) {
    return mal_value_is_string(value) &&
        mal_string_storage(mal_value_to_string(value)) != MAL_STRING_STORAGE_CONS;
}

static bool mal_builtin_string_throw_length(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
    return false;
}

static MalValue mal_builtin_string_add(MalVm *vm, MalValue left, MalValue right) {
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue result;
    if (!mal_ops_add_checked(&vm->heap, left, right, &result)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    return result;
}

static MalValue mal_builtin_string_from_units(MalVm *vm, const c16 *code_units, usize length) {
    if (length > MAL_STRING_MAX_CODE_UNITS) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    if (length == 0) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, ""));
    }
    if (length == 1) {
        return mal_value_from_string(
            mal_intrinsic_code_unit(vm, code_units[0]));
    }
    return mal_value_from_string(mal_string_new_copy(&vm->heap, code_units, length));
}

static MalValue mal_builtin_string_empty(MalVm *vm) {
    return mal_value_from_string(mal_intrinsic_ascii(vm, ""));
}

typedef struct MalBuiltinRootedString {
    MalValue value;
    MalRootSpan span;
} MalBuiltinRootedString;

static void mal_builtin_string_root_init(
    MalBuiltinRootedString *root, MalString *string
) {
    root->value = mal_value_from_string(string);
    mal_gc_root(&root->span, &root->value, 1);
}

static MalString *mal_builtin_string_root_get(
    const MalBuiltinRootedString *root
) {
    return mal_value_to_string(root->value);
}

static void mal_builtin_string_root_dispose(MalBuiltinRootedString *root) {
    mal_gc_unroot(&root->span);
}

/** Flatten a cons string while it is rooted, then return stable contiguous data. */
static MalString *mal_builtin_string_flatten_for_scan(
    MalString *string, const c16 **code_units_out
) {
    if (mal_string_storage(string) != MAL_STRING_STORAGE_CONS) {
        *code_units_out = mal_string_code_units(string);
        return string;
    }
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    *code_units_out = mal_string_code_units(string);
    string = mal_builtin_string_root_get(&string_root);
    mal_builtin_string_root_dispose(&string_root);
    return string;
}

static MalValue mal_builtin_string_slice(MalVm *vm, MalString *string, usize offset, usize length) {
    if (offset == 0 && length == mal_string_length(string)) {
        return mal_value_from_string(string);
    }
    if (length == 0) {
        return mal_builtin_string_empty(vm);
    }
    if (length == 1) {
        return mal_value_from_string(
            mal_intrinsic_code_unit(vm, mal_string_code_units(string)[offset])
        );
    }
    return mal_value_from_string(mal_string_new_slice(&vm->heap, string, offset, length));
}

/**
 * ToIntegerOrInfinity-flavored index handling clamped to [0, length], with
 * negative values counting back from the end.
 */
static usize mal_builtin_string_clamp_relative(MalVm *vm, MalValue value, f64 fallback, usize length) {
    f64 relative = mal_value_is_undefined(value) ? fallback : mal_builtin_string_arg_to_number(vm, value);
    return (usize) mal_ops_number_clamp_relative(relative, (f64) length);
}

static bool mal_builtin_string_matches_at(const MalString *string, const MalString *search, usize position) {
    usize search_length = mal_string_length(search);
    if (position + search_length > mal_string_length(string)) {
        return false;
    }
    if (search_length == 0 || (position == 0 && string == search)) {
        return true;
    }

    const c16 *string_units = mal_string_code_units(string) + position;
    const c16 *search_units = mal_string_code_units(search);
    if (search_length == 1) {
        return string_units[0] == search_units[0];
    }

    return memcmp(
        string_units,
        search_units,
        (usize) sizeof(c16) * search_length
    ) == 0;
}

#define MAL_STRING_UNIT_SCAN_LANES ((usize) 4)
#define MAL_STRING_UNIT_NOT_FOUND ((usize) -1)

/**
 * Test four UTF-16 code units at once for a possible match. The subtraction
 * may mark an adjacent lane after a zero lane, so callers confirm the four
 * units before returning; it cannot miss an equal lane.
 */
static inline bool mal_builtin_string_word_may_contain_unit(u64 word, c16 unit) {
    const u64 lane_ones = 0x0001000100010001ULL;
    const u64 lane_high_bits = 0x8000800080008000ULL;
    u64 different = word ^ ((u64) unit * lane_ones);
    return ((different - lane_ones) & ~different & lane_high_bits) != 0;
}

/**
 * Find one UTF-16 code unit in [from, end). Fixed-size memcpy permits
 * unaligned input while still compiling to a single word load.
 */
static usize mal_builtin_string_find_unit(
    const c16 *units,
    usize from,
    usize end,
    c16 unit
) {
    while (end - from >= MAL_STRING_UNIT_SCAN_LANES) {
        MAL_PERF_COUNT(string_unit_scan_word_blocks);
        u64 word;
        memcpy(&word, units + from, sizeof(word));
        if (mal_builtin_string_word_may_contain_unit(word, unit)) {
            MAL_PERF_COUNT(string_unit_scan_candidate_blocks);
            for (usize lane = 0; lane < MAL_STRING_UNIT_SCAN_LANES; lane++) {
                if (units[from + lane] == unit) {
                    return from + lane;
                }
            }
        }
        from += MAL_STRING_UNIT_SCAN_LANES;
    }
    while (from < end) {
        MAL_PERF_COUNT(string_unit_scan_scalar_code_units);
        if (units[from] == unit) return from;
        from++;
    }
    return end;
}

/**
 * Find one UTF-16 code unit backwards in [0, end). Returns the sentinel when
 * absent so index zero remains a valid result.
 */
static usize mal_builtin_string_reverse_find_unit(
    const c16 *units,
    usize end,
    c16 unit
) {
    while (end >= MAL_STRING_UNIT_SCAN_LANES) {
        MAL_PERF_COUNT(string_unit_scan_word_blocks);
        usize start = end - MAL_STRING_UNIT_SCAN_LANES;
        u64 word;
        memcpy(&word, units + start, sizeof(word));
        if (mal_builtin_string_word_may_contain_unit(word, unit)) {
            MAL_PERF_COUNT(string_unit_scan_candidate_blocks);
            for (usize lane = MAL_STRING_UNIT_SCAN_LANES; lane > 0; lane--) {
                usize position = start + lane - 1;
                if (units[position] == unit) {
                    return position;
                }
            }
        }
        end = start;
    }
    while (end > 0) {
        MAL_PERF_COUNT(string_unit_scan_scalar_code_units);
        end--;
        if (units[end] == unit) return end;
    }
    return MAL_STRING_UNIT_NOT_FOUND;
}

/**
 * Find the first occurrence of search at or after from. Returns -1 when not
 * found. An empty search matches immediately.
 */
static i64 mal_builtin_string_find(const MalString *string, const MalString *search, usize from) {
    MAL_PERF_COUNT(string_search_calls);
    usize length = mal_string_length(string);
    usize search_length = mal_string_length(search);
    if (search_length > length || from > length - search_length) {
        return -1;
    }

    if (search_length == 0) {
        return (i64) from;
    }
    if (string == search) {
        return 0;
    }

    if (search_length == 1) {
        const c16 *string_units = mal_string_code_units(string);
        c16 search_unit = mal_string_code_units(search)[0];
        usize position = mal_builtin_string_find_unit(
            string_units, from, length, search_unit
        );
        return position == length ? -1 : (i64) position;
    }

    MAL_PERF_COUNT(string_search_multi_unit_calls);
    const c16 *string_units = mal_string_code_units(string);
    const c16 *search_units = mal_string_code_units(search);
    c16 first_unit = search_units[0];
    c16 last_unit = search_units[search_length - 1];
    usize last_offset = search_length - 1;
    usize interior_length = search_length - 2;
    usize end = length - search_length + 1;
    usize position = from;
    while (position < end) {
        usize candidate = mal_builtin_string_find_unit(
            string_units, position, end, first_unit
        );
        if (candidate == end) {
            MAL_PERF_ADD(string_search_candidates, end - position);
            MAL_PERF_ADD(string_search_first_unit_rejects, end - position);
            break;
        }
        MAL_PERF_ADD(string_search_candidates, candidate - position + 1);
        MAL_PERF_ADD(string_search_first_unit_rejects, candidate - position);
        position = candidate + 1;
        if (string_units[candidate + last_offset] != last_unit) {
            MAL_PERF_COUNT(string_search_last_unit_rejects);
            continue;
        }
        if (interior_length == 0) {
            return (i64) candidate;
        }
        MAL_PERF_COUNT(string_search_memcmp_calls);
        MAL_PERF_ADD(string_search_memcmp_code_units, interior_length);
        if (memcmp(
                string_units + candidate + 1,
                search_units + 1,
                sizeof(c16) * interior_length
            ) == 0) {
            return (i64) candidate;
        }
    }

    return -1;
}

/**
 * Find the last occurrence of search at or before from. The caller clamps from
 * to the largest possible start position.
 */
static i64 mal_builtin_string_reverse_find(
    const MalString *string,
    const MalString *search,
    usize from
) {
    MAL_PERF_COUNT(string_reverse_search_calls);
    usize search_length = mal_string_length(search);
    if (search_length == 0) {
        return (i64) from;
    }
    if (string == search) {
        return 0;
    }

    const c16 *string_units = mal_string_code_units(string);
    const c16 *search_units = mal_string_code_units(search);
    c16 first_unit = search_units[0];
    if (search_length == 1) {
        usize position = mal_builtin_string_reverse_find_unit(
            string_units, from + 1, first_unit
        );
        if (position == MAL_STRING_UNIT_NOT_FOUND) {
            MAL_PERF_ADD(string_reverse_search_candidates, from + 1);
            MAL_PERF_ADD(string_reverse_search_first_unit_rejects, from + 1);
            return -1;
        }
        MAL_PERF_ADD(string_reverse_search_candidates, from - position + 1);
        MAL_PERF_ADD(string_reverse_search_first_unit_rejects, from - position);
        return (i64) position;
    }

    usize last_offset = search_length - 1;
    usize interior_length = search_length - 2;
    c16 last_unit = search_units[last_offset];
    usize end = from + 1;
    while (end > 0) {
        usize position = mal_builtin_string_reverse_find_unit(
            string_units, end, first_unit
        );
        if (position == MAL_STRING_UNIT_NOT_FOUND) {
            MAL_PERF_ADD(string_reverse_search_candidates, end);
            MAL_PERF_ADD(string_reverse_search_first_unit_rejects, end);
            return -1;
        }
        MAL_PERF_ADD(string_reverse_search_candidates, end - position);
        MAL_PERF_ADD(string_reverse_search_first_unit_rejects, end - position - 1);
        end = position;
        if (string_units[position + last_offset] != last_unit) {
            MAL_PERF_COUNT(string_reverse_search_last_unit_rejects);
        } else if (interior_length == 0) {
            return (i64) position;
        } else {
            MAL_PERF_COUNT(string_reverse_search_memcmp_calls);
            MAL_PERF_ADD(string_reverse_search_memcmp_code_units, interior_length);
            if (memcmp(
                    string_units + position + 1,
                    search_units + 1,
                    sizeof(c16) * interior_length
                ) == 0) {
                return (i64) position;
            }
        }
    }
    return -1;
}

static MalValue mal_builtin_string_symbol_descriptive_string(
    MalVm *vm, MalValue symbol_value
) {
    MalValue symbol_root = symbol_value;
    MalRootSpan root_span;
    mal_gc_root(&root_span, &symbol_root, 1);

    MalString *description = mal_symbol_description(
        mal_value_to_symbol(symbol_root));
    usize description_length = description == nullptr
        ? 0
        : mal_string_length(description);
    usize length;
    if (!mal_checked_size_add(
            description_length, 8, MAL_STRING_MAX_CODE_UNITS, &length)) {
        mal_builtin_string_throw_length(vm);
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }

    c16 *code_units = mal_heap_alloc_raw_profiled(
        &vm->heap, sizeof(c16) * length,
        MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    static const byte prefix[] = "Symbol(";
    for (usize i = 0; i < sizeof(prefix) - 1; i++) {
        code_units[i] = prefix[i];
    }
    description = mal_symbol_description(mal_value_to_symbol(symbol_root));
    if (description_length != 0) {
        memcpy(
            code_units + sizeof(prefix) - 1,
            mal_string_code_units(description),
            sizeof(c16) * description_length);
    }
    code_units[length - 1] = ')';

    MalValue result = mal_value_from_string(
        mal_string_new_owned(&vm->heap, code_units, length));
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue mal_builtin_string_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;

    MalString *string;
    if (arg_count == 0) {
        string = mal_intrinsic_ascii(vm, "");
    } else if (mal_value_is_symbol(args[0]) && mal_value_is_undefined(new_target)) {
        // String(symbol) (call, not construct) yields SymbolDescriptiveString.
        return mal_builtin_string_symbol_descriptive_string(vm, args[0]);
    } else {
        string = mal_builtin_string_coerce(vm, args[0]);
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    if (mal_value_is_undefined(new_target)) {
        return mal_value_from_string(string);
    }

    MalValue roots[2] = {
        mal_value_from_string(string),
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_STRING_PROTOTYPE, &prototype)) {
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    roots[1] = mal_value_from_object(prototype);

    MalValue result = mal_value_from_primitive_wrapper(mal_primitive_wrapper_object_new(
        &vm->heap,
        mal_value_to_object(roots[1]),
        MAL_PRIMITIVE_WRAPPER_STRING,
        roots[0]
    ));
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue mal_builtin_string_from_char_code(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    usize length = (usize) arg_count;
    if (length == 0) {
        return mal_builtin_string_empty(vm);
    }
    usize bytes;
    if (length > MAL_STRING_MAX_CODE_UNITS ||
        !mal_checked_size_multiply(sizeof(c16), length, SIZE_MAX, &bytes)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }

    if (length == 1) {
        f64 code = mal_builtin_string_arg_to_number(vm, args[0]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
        return mal_value_from_string(mal_intrinsic_code_unit(
            vm, (c16) mal_ops_number_to_uint_width(code, 16)));
    }

    if (length <= MAL_STRING_INLINE_CODE_UNITS) {
        c16 inline_code_units[MAL_STRING_INLINE_CODE_UNITS];
        for (i32 i = 0; i < arg_count; i++) {
            f64 code = mal_builtin_string_arg_to_number(vm, args[i]);
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
            inline_code_units[i] =
                (c16) mal_ops_number_to_uint_width(code, 16);
        }
        return mal_builtin_string_from_units(
            vm, inline_code_units, length);
    }

    c16 *code_units = mal_heap_alloc_raw_profiled(
        &vm->heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    for (i32 i = 0; i < arg_count; i++) {
        // VM ToNumber before ToUint16: runs a user valueOf/toString (and unwraps
        // a primitive wrapper), and throws TypeError on a Symbol/BigInt.
        f64 code = mal_builtin_string_arg_to_number(vm, args[i]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            gc_free_raw(&vm->heap, code_units);
            return mal_value_new_undefined();
        }
        code_units[i] = (c16) mal_ops_number_to_uint_width(code, 16);
    }

    return mal_value_from_string(
        mal_string_new_owned(&vm->heap, code_units, length));
}

static bool mal_builtin_string_to_code_point(
    MalVm *vm, MalValue value, u32 *code_point_out
) {
    f64 raw = mal_builtin_string_arg_to_number(vm, value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return false;
    }
    if (isnan(raw) || raw < 0 || raw > 0x10FFFF || raw != trunc(raw)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid code point");
        return false;
    }
    *code_point_out = (u32) raw;
    return true;
}

static MalValue mal_builtin_string_from_code_point(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    // Each code point expands to at most two code units.
    usize input_count = (usize) arg_count;
    if (input_count == 0) {
        return mal_builtin_string_empty(vm);
    }
    if (input_count == 1) {
        u32 code_point;
        if (!mal_builtin_string_to_code_point(vm, args[0], &code_point)) {
            return mal_value_new_undefined();
        }
        if (code_point <= 0xFFFF) {
            return mal_value_from_string(
                mal_intrinsic_code_unit(vm, (c16) code_point));
        }
        c16 pair[2];
        mal_utf16_emit_pair(code_point, pair);
        return mal_value_from_string(
            mal_string_new_copy(&vm->heap, pair, 2));
    }

    usize capacity;
    usize bytes;
    if (input_count > MAL_STRING_MAX_CODE_UNITS) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    capacity = input_count > MAL_STRING_MAX_CODE_UNITS / 2
        ? MAL_STRING_MAX_CODE_UNITS
        : input_count * 2;
    if (!mal_checked_size_multiply(sizeof(c16), capacity, SIZE_MAX, &bytes)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    c16 inline_code_units[MAL_STRING_INLINE_CODE_UNITS];
    bool inline_buffer = input_count <= MAL_STRING_INLINE_CODE_UNITS;
    c16 *code_units = inline_buffer
        ? inline_code_units
        : mal_heap_alloc_raw_profiled(
            &vm->heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    usize length = 0;
    for (i32 i = 0; i < arg_count; i++) {
        u32 code_point;
        if (!mal_builtin_string_to_code_point(vm, args[i], &code_point)) {
            if (!inline_buffer) gc_free_raw(&vm->heap, code_units);
            return mal_value_new_undefined();
        }

        usize width = code_point <= 0xFFFF ? 1 : 2;
        if (length > MAL_STRING_MAX_CODE_UNITS - width) {
            if (!inline_buffer) gc_free_raw(&vm->heap, code_units);
            mal_builtin_string_throw_length(vm);
            return mal_value_new_undefined();
        }
        if (inline_buffer &&
            length + width > MAL_STRING_INLINE_CODE_UNITS) {
            c16 *grown = mal_heap_alloc_raw_profiled(
                &vm->heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
            memcpy(grown, inline_code_units, sizeof(c16) * length);
            code_units = grown;
            inline_buffer = false;
        }

        if (width == 1) {
            code_units[length++] = (c16) code_point;
        } else {
            mal_utf16_emit_pair(code_point, code_units + length);
            length += 2;
        }
    }

    if (inline_buffer) {
        return mal_builtin_string_from_units(
            vm, inline_code_units, length);
    }
    return mal_value_from_string(
        mal_string_new_owned(&vm->heap, code_units, length));
}

static bool mal_builtin_string_raw_index_key(
    MalVm *vm, u64 index, MalKey *key_out
) {
    if (index < UINT32_MAX) {
        *key_out = mal_key_index(index);
        return true;
    }
    // 2^32-1 and larger integer names are ordinary string keys, not array
    // indices. The ToLength domain is exactly representable through 2^53-1.
    return mal_vm_value_to_property_key(
        vm, mal_value_from_f64((f64) index), key_out);
}

static bool mal_builtin_string_raw_append(
    MalVm *vm, MalRootedValueList *parts, usize *total_length,
    MalValue value
) {
    MalString *string;
    if (!mal_vm_to_string(vm, value, &string)) {
        return false;
    }
    usize length = mal_string_length(string);
    if (!mal_checked_size_add(
            *total_length, length, MAL_STRING_MAX_CODE_UNITS,
            total_length)) {
        return mal_builtin_string_throw_length(vm);
    }
    if (length != 0) {
        // The root list uses native malloc only while growing, so the freshly
        // coerced string cannot be collected before this append publishes it.
        mal_rooted_value_list_append(
            parts, mal_value_from_string(string));
    }
    return true;
}

static MalValue mal_builtin_string_raw_flatten(
    MalVm *vm, const MalRootedValueList *parts, usize total_length
) {
    if (total_length == 0) {
        return mal_builtin_string_empty(vm);
    }
    if (parts->count == 1) {
        return parts->values[0];
    }

    usize bytes;
    if (!mal_checked_size_multiply(
            sizeof(c16), total_length, SIZE_MAX, &bytes)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    c16 *code_units = mal_heap_alloc_raw_profiled(
        &vm->heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    usize offset = 0;
    for (usize i = 0; i < parts->count; i++) {
        MalString *part = mal_value_to_string(parts->values[i]);
        usize length = mal_string_length(part);
        memcpy(
            code_units + offset, mal_string_code_units(part),
            sizeof(c16) * length);
        offset += length;
    }
    assert(offset == total_length);
    return mal_value_from_string(
        mal_string_new_owned(&vm->heap, code_units, total_length));
}

static MalValue mal_builtin_string_raw(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;

    // Get(template, "raw"), then LengthOfArrayLike(raw). The raw object and
    // every coerced non-empty part remain rooted across later getters and user
    // coercions; the final exact managed buffer is adopted without another copy.
    MalValue raw;
    if (!mal_vm_get_property(
            vm,
            arg_count >= 1 ? args[0] : mal_value_new_undefined(),
            mal_intrinsic_string_key(vm, "raw"), &raw)) {
        return mal_value_new_undefined();
    }
    MalValue raw_roots[2] = {
        raw,
        mal_value_new_undefined(),
    };
    MalRootSpan raw_span;
    mal_gc_root(&raw_span, raw_roots, 2);
    MalRootedValueList parts;
    mal_rooted_value_list_init(&parts);
    mal_gc_native_rooted_begin(vm);
    MalValue result = mal_value_new_undefined();

    MalValue length_value;
    if (!mal_vm_get_property(
            vm, raw_roots[0], mal_intrinsic_string_key(vm, "length"),
            &length_value)) {
        goto done;
    }
    raw_roots[1] = length_value;
    f64 length_number;
    if (!mal_vm_to_number(vm, raw_roots[1], &length_number)) {
        goto done;
    }
    raw_roots[1] = mal_value_new_undefined();
    f64 safe_length = mal_ops_number_to_length(length_number);
    if (!(safe_length > 0)) {
        result = mal_builtin_string_empty(vm);
        goto done;
    }

    u64 literal_count = (u64) safe_length;
    u64 substitution_count = (u64) (arg_count - 1);
    usize total_length = 0;
    for (u64 index = 0;; index++) {
        MalKey key;
        if (!mal_builtin_string_raw_index_key(vm, index, &key)) {
            goto done;
        }
        MalValue segment;
        if (!mal_vm_get_property(vm, raw_roots[0], key, &segment)) {
            goto done;
        }
        raw_roots[1] = segment;
        if (
            !mal_builtin_string_raw_append(
                vm, &parts, &total_length, raw_roots[1])) {
            goto done;
        }
        raw_roots[1] = mal_value_new_undefined();

        if (index + 1 == literal_count) {
            break;
        }
        if (index < substitution_count) {
            raw_roots[1] = args[index + 1];
            if (!mal_builtin_string_raw_append(
                    vm, &parts, &total_length, raw_roots[1])) {
                goto done;
            }
            raw_roots[1] = mal_value_new_undefined();
        }
    }

    result = mal_builtin_string_raw_flatten(vm, &parts, total_length);

done:
    mal_gc_native_rooted_end(vm);
    mal_rooted_value_list_dispose(&parts);
    mal_gc_unroot(&raw_span);
    return result;
}

static MalValue mal_builtin_string_prototype_code_point_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    f64 primitive_position;
    if (mal_builtin_string_is_flat_value(this_value) &&
        mal_builtin_string_primitive_number_arg(
            args, arg_count, 0, 0.0, &primitive_position)) {
        primitive_position = mal_ops_number_to_integer_or_infinity(primitive_position);
        MalString *primitive_string = mal_value_to_string(this_value);
        usize primitive_length = mal_string_length(primitive_string);
        if (primitive_position < 0 || primitive_position >= (f64) primitive_length) {
            return mal_value_new_undefined();
        }
        u32 code_point;
        mal_utf16_read_scalar(
            mal_string_code_units(primitive_string), primitive_length,
            (usize) primitive_position, &code_point, nullptr);
        return mal_value_from_i32((i32) code_point);
    }

    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    // ToIntegerOrInfinity(pos): NaN → 0, else truncate (runs a user valueOf).
    f64 position = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    position = mal_ops_number_to_integer_or_infinity(position);
    string = mal_builtin_string_root_get(&string_root);
    if (position < 0 || position >= (f64) mal_string_length(string)) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }

    const c16 *code_units;
    string = mal_builtin_string_flatten_for_scan(string, &code_units);
    usize index = (usize) position;
    u32 code_point;
    mal_utf16_read_scalar(
        code_units, mal_string_length(string), index, &code_point, nullptr);
    MalValue result = mal_value_from_i32((i32) code_point);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

static MalValue mal_builtin_string_prototype_char_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    f64 primitive_position;
    if (mal_builtin_string_is_flat_value(this_value) &&
        mal_builtin_string_primitive_number_arg(
            args, arg_count, 0, 0.0, &primitive_position)) {
        primitive_position = mal_ops_number_to_integer_or_infinity(primitive_position);
        MalString *primitive_string = mal_value_to_string(this_value);
        if (primitive_position < 0 ||
            primitive_position >= (f64) mal_string_length(primitive_string)) {
            return mal_builtin_string_empty(vm);
        }
        c16 unit = mal_string_code_units(primitive_string)[(usize) primitive_position];
        return mal_value_from_string(mal_intrinsic_code_unit(vm, unit));
    }

    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    // ToIntegerOrInfinity(pos): NaN → 0, else truncate (a Symbol throws via the
    // VM ToNumber, surfaced at the call boundary).
    f64 position = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    position = mal_ops_number_to_integer_or_infinity(position);
    string = mal_builtin_string_root_get(&string_root);
    if (position < 0 || position >= (f64) mal_string_length(string)) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_builtin_string_empty(vm);
    }

    MalValue result = mal_builtin_string_slice(vm, string, (usize) position, 1);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

static MalValue mal_builtin_string_prototype_char_code_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    f64 primitive_position;
    if (mal_builtin_string_is_flat_value(this_value) &&
        mal_builtin_string_primitive_number_arg(
            args, arg_count, 0, 0.0, &primitive_position)) {
        return mal_builtin_string_char_code_at_number(this_value, primitive_position);
    }

    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    // ToIntegerOrInfinity(pos): NaN → 0, else truncate.
    f64 position = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    position = mal_ops_number_to_integer_or_infinity(position);
    string = mal_builtin_string_root_get(&string_root);
    if (position < 0 || position >= (f64) mal_string_length(string)) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_nan();
    }

    MalValue result = mal_value_from_i32(
        mal_string_code_units(string)[(usize) position]);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

MalCompletion mal_builtin_string_char_code_at_direct(
    MalVm *vm,
    MalCallCache *fallback_cache,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count
) {
    if (arg_count >= 0 && mal_value_is_string(this_value) &&
        mal_value_is_native_function_object(callee) &&
        mal_native_function_object_callback(mal_value_to_native_function_object(callee)) ==
            mal_builtin_string_prototype_char_code_at &&
        (arg_count == 0 || mal_ops_is_number(args[0]))) {
        f64 position = arg_count == 0
            ? 0
            : mal_ops_number_as_f64(args[0]);
        MalValue result = mal_builtin_string_char_code_at_number(this_value, position);
        return (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = result,
        };
    }

    MAL_PERF_COUNT(string_char_code_at_direct_fallbacks);
    return mal_vm_call_cached(
        vm, fallback_cache, callee, this_value, args, arg_count);
}

MalCompletion mal_builtin_string_char_code_at_direct_in_bounds(
    MalVm *vm,
    MalCallCache *fallback_cache,
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    f64 position
) {
    if (arg_count == 1 && mal_value_is_string(this_value) &&
        mal_value_is_native_function_object(callee) &&
        mal_native_function_object_callback(mal_value_to_native_function_object(callee)) ==
            mal_builtin_string_prototype_char_code_at) {
        assert(position >= 0 &&
               position < (f64) mal_string_length(mal_value_to_string(this_value)) &&
               trunc(position) == position);
        MalValue result = mal_builtin_string_char_code_at_in_bounds(
            this_value, (usize) position);
        return (MalCompletion) {
            .kind = MAL_COMPLETION_NORMAL,
            .value = result,
        };
    }

    MAL_PERF_COUNT(string_char_code_at_direct_fallbacks);
    return mal_vm_call_cached(
        vm, fallback_cache, callee, this_value, args, arg_count);
}

MalValue mal_builtin_string_char_code_at_known(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count
) {
    if (arg_count >= 0 && mal_value_is_string(this_value) &&
        (arg_count == 0 || mal_ops_is_number(args[0]))) {
        f64 position = arg_count == 0 ? 0 : mal_ops_number_as_f64(args[0]);
        return mal_builtin_string_char_code_at_number(this_value, position);
    }
    MAL_PERF_COUNT(string_char_code_at_direct_fallbacks);
    return mal_builtin_string_prototype_char_code_at(
        vm, this_value, args, arg_count, MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED);
}

static MalValue mal_builtin_string_prototype_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    f64 primitive_relative;
    if (mal_builtin_string_is_flat_value(this_value) &&
        mal_builtin_string_primitive_number_arg(
            args, arg_count, 0, 0.0, &primitive_relative)) {
        primitive_relative = mal_ops_number_to_integer_or_infinity(primitive_relative);
        MalString *primitive_string = mal_value_to_string(this_value);
        usize primitive_length = mal_string_length(primitive_string);
        if (primitive_relative < 0) {
            primitive_relative += (f64) primitive_length;
        }
        if (primitive_relative < 0 || primitive_relative >= (f64) primitive_length) {
            return mal_value_new_undefined();
        }
        c16 unit = mal_string_code_units(primitive_string)[(usize) primitive_relative];
        return mal_value_from_string(mal_intrinsic_code_unit(vm, unit));
    }

    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    f64 relative = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    relative = mal_ops_number_to_integer_or_infinity(relative);
    string = mal_builtin_string_root_get(&string_root);
    if (relative < 0) {
        relative += (f64) mal_string_length(string);
    }
    if (relative < 0 || relative >= (f64) mal_string_length(string)) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }

    MalValue result = mal_builtin_string_slice(vm, string, (usize) relative, 1);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

static MalValue mal_builtin_string_prototype_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    f64 primitive_position;
    if (mal_builtin_string_is_flat_value(this_value) && arg_count >= 1 &&
        mal_builtin_string_is_flat_value(args[0]) &&
        mal_builtin_string_primitive_number_arg(
            args, arg_count, 1, 0.0, &primitive_position)) {
        MalString *primitive_string = mal_value_to_string(this_value);
        usize primitive_length = mal_string_length(primitive_string);
        primitive_position = mal_ops_number_to_length(primitive_position);
        usize from = primitive_position > (f64) primitive_length
            ? primitive_length
            : (usize) primitive_position;
        return mal_value_from_i32((i32) mal_builtin_string_find(
            primitive_string, mal_value_to_string(args[0]), from));
    }

    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    MalString *search = mal_builtin_string_coerce(
        vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString search_root;
    mal_builtin_string_root_init(&search_root, search);
    usize from = 0;
    if (arg_count >= 2) {
        f64 position = mal_builtin_string_arg_to_number(vm, args[1]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_builtin_string_root_dispose(&search_root);
            mal_builtin_string_root_dispose(&string_root);
            return mal_value_new_undefined();
        }
        string = mal_builtin_string_root_get(&string_root);
        f64 length = (f64) mal_string_length(string);
        position = mal_ops_number_to_length(position);
        from = (usize) (position > length ? length : position);
    }

    string = mal_builtin_string_root_get(&string_root);
    search = mal_builtin_string_root_get(&search_root);
    MalValue result = mal_value_from_i32(
        (i32) mal_builtin_string_find(string, search, from));
    mal_builtin_string_root_dispose(&search_root);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

static MalValue mal_builtin_string_prototype_last_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    f64 primitive_position;
    if (mal_builtin_string_is_flat_value(this_value) && arg_count >= 1 &&
        mal_builtin_string_is_flat_value(args[0]) &&
        mal_builtin_string_primitive_number_arg(
            args, arg_count, 1, NAN, &primitive_position)) {
        MalString *primitive_string = mal_value_to_string(this_value);
        MalString *primitive_search = mal_value_to_string(args[0]);
        usize primitive_length = mal_string_length(primitive_string);
        usize primitive_search_length = mal_string_length(primitive_search);
        if (primitive_search_length > primitive_length) {
            return mal_value_from_i32(-1);
        }
        usize max_start = primitive_length - primitive_search_length;
        usize start;
        if (isnan(primitive_position)) {
            start = max_start;
        } else {
            primitive_position = mal_ops_number_to_integer_or_infinity(
                primitive_position);
            if (primitive_position <= 0) {
                start = 0;
            } else if (primitive_position >= (f64) max_start) {
                start = max_start;
            } else {
                start = (usize) primitive_position;
            }
        }
        return mal_value_from_i32((i32) mal_builtin_string_reverse_find(
            primitive_string, primitive_search, start));
    }

    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    MalString *search = mal_builtin_string_coerce(
        vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString search_root;
    mal_builtin_string_root_init(&search_root, search);
    f64 raw_position = arg_count >= 2
        ? mal_builtin_string_arg_to_number(vm, args[1])
        : NAN;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&search_root);
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    string = mal_builtin_string_root_get(&string_root);
    search = mal_builtin_string_root_get(&search_root);
    usize length = mal_string_length(string);
    usize search_length = mal_string_length(search);
    if (search_length > length) {
        mal_builtin_string_root_dispose(&search_root);
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_from_i32(-1);
    }

    usize max_start = length - search_length;
    usize start;
    if (isnan(raw_position)) {
        start = max_start;
    } else {
        f64 position = mal_ops_number_to_integer_or_infinity(raw_position);
        if (position <= 0) {
            start = 0;
        } else if (position >= (f64) max_start) {
            start = max_start;
        } else {
            start = (usize) position;
        }
    }
    MalValue result = mal_value_from_i32(
        (i32) mal_builtin_string_reverse_find(string, search, start)
    );
    mal_builtin_string_root_dispose(&search_root);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

// Defined later (near the @@-protocol dispatch); forward-declared so the
// regexp-rejecting methods below can use it.
static bool mal_builtin_string_is_regexp(MalVm *vm, MalValue arg);

// Spec guard shared by includes/startsWith/endsWith after the caller has already
// run RequireObjectCoercible + ToString(this): reject a RegExp first argument
// before ToString(searchString), so these methods cannot be used as matchers.
static bool mal_builtin_string_reject_regexp(
    MalVm *vm, const MalValue *args, i32 arg_count
) {
    bool is_regexp = mal_builtin_string_is_regexp(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return true;
    }
    if (is_regexp) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "First argument must not be a regular expression");
        return true;
    }
    return false;
}

static MalValue mal_builtin_string_prototype_includes(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    f64 primitive_position;
    if (mal_builtin_string_is_flat_value(this_value) && arg_count >= 1 &&
        mal_builtin_string_is_flat_value(args[0]) &&
        mal_builtin_string_primitive_number_arg(
            args, arg_count, 1, 0.0, &primitive_position)) {
        MalString *primitive_string = mal_value_to_string(this_value);
        usize primitive_length = mal_string_length(primitive_string);
        primitive_position = mal_ops_number_to_length(primitive_position);
        usize start = primitive_position > (f64) primitive_length
            ? primitive_length
            : (usize) primitive_position;
        return mal_value_new_boolean(mal_builtin_string_find(
            primitive_string, mal_value_to_string(args[0]), start) >= 0);
    }

    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    if (mal_builtin_string_reject_regexp(vm, args, arg_count)) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    MalString *search = mal_builtin_string_coerce(
        vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString search_root;
    mal_builtin_string_root_init(&search_root, search);
    // ToIntegerOrInfinity(position) clamped to [0, len] (no count-from-end).
    usize start = 0;
    if (arg_count >= 2 && !mal_value_is_undefined(args[1])) {
        f64 pos = mal_builtin_string_arg_to_number(vm, args[1]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_builtin_string_root_dispose(&search_root);
            mal_builtin_string_root_dispose(&string_root);
            return mal_value_new_undefined();
        }
        string = mal_builtin_string_root_get(&string_root);
        u32 length = mal_string_length(string);
        pos = mal_ops_number_to_length(pos);
        start = pos > (f64) length ? length : (usize) pos;
    }
    string = mal_builtin_string_root_get(&string_root);
    search = mal_builtin_string_root_get(&search_root);
    MalValue result = mal_value_new_boolean(
        mal_builtin_string_find(string, search, start) >= 0);
    mal_builtin_string_root_dispose(&search_root);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

static MalValue mal_builtin_string_prototype_starts_with(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    f64 primitive_position;
    if (mal_builtin_string_is_flat_value(this_value) && arg_count >= 1 &&
        mal_builtin_string_is_flat_value(args[0]) &&
        mal_builtin_string_primitive_number_arg(
            args, arg_count, 1, 0.0, &primitive_position)) {
        MalString *primitive_string = mal_value_to_string(this_value);
        usize primitive_length = mal_string_length(primitive_string);
        primitive_position = mal_ops_number_to_length(primitive_position);
        usize position = primitive_position > (f64) primitive_length
            ? primitive_length
            : (usize) primitive_position;
        return mal_value_new_boolean(mal_builtin_string_matches_at(
            primitive_string, mal_value_to_string(args[0]), position));
    }

    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    if (mal_builtin_string_reject_regexp(vm, args, arg_count)) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    MalString *search = mal_builtin_string_coerce(
        vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString search_root;
    mal_builtin_string_root_init(&search_root, search);
    usize position = 0;
    if (arg_count >= 2) {
        f64 raw = mal_builtin_string_arg_to_number(vm, args[1]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_builtin_string_root_dispose(&search_root);
            mal_builtin_string_root_dispose(&string_root);
            return mal_value_new_undefined();
        }
        string = mal_builtin_string_root_get(&string_root);
        f64 length = (f64) mal_string_length(string);
        raw = mal_ops_number_to_length(raw);
        position = (usize) (raw > length ? length : raw);
    }
    string = mal_builtin_string_root_get(&string_root);
    search = mal_builtin_string_root_get(&search_root);
    MalValue result = mal_value_new_boolean(
        mal_builtin_string_matches_at(string, search, position));
    mal_builtin_string_root_dispose(&search_root);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

static MalValue mal_builtin_string_prototype_ends_with(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (mal_builtin_string_is_flat_value(this_value) && arg_count >= 1 &&
        mal_builtin_string_is_flat_value(args[0])) {
        MalString *primitive_string = mal_value_to_string(this_value);
        usize primitive_length = mal_string_length(primitive_string);
        f64 primitive_position = (f64) primitive_length;
        bool primitive_position_ok = arg_count < 2 ||
            mal_value_is_undefined(args[1]) ||
            mal_builtin_string_primitive_number(args[1], &primitive_position);
        if (primitive_position_ok) {
            primitive_position = mal_ops_number_to_length(primitive_position);
            usize end = primitive_position > (f64) primitive_length
                ? primitive_length
                : (usize) primitive_position;
            MalString *primitive_search = mal_value_to_string(args[0]);
            usize primitive_search_length = mal_string_length(primitive_search);
            return mal_value_new_boolean(
                primitive_search_length <= end &&
                mal_builtin_string_matches_at(
                    primitive_string, primitive_search,
                    end - primitive_search_length));
        }
    }

    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    if (mal_builtin_string_reject_regexp(vm, args, arg_count)) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    MalString *search = mal_builtin_string_coerce(
        vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString search_root;
    mal_builtin_string_root_init(&search_root, search);
    string = mal_builtin_string_root_get(&string_root);
    usize end = mal_string_length(string);
    if (arg_count >= 2 && !mal_value_is_undefined(args[1])) {
        f64 raw = mal_builtin_string_arg_to_number(vm, args[1]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_builtin_string_root_dispose(&search_root);
            mal_builtin_string_root_dispose(&string_root);
            return mal_value_new_undefined();
        }
        raw = mal_ops_number_to_length(raw);
        end = (usize) (raw > (f64) end ? (f64) end : raw);
    }
    search = mal_builtin_string_root_get(&search_root);
    usize search_length = mal_string_length(search);
    if (search_length > end) {
        mal_builtin_string_root_dispose(&search_root);
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_boolean(false);
    }

    string = mal_builtin_string_root_get(&string_root);
    MalValue result = mal_value_new_boolean(
        mal_builtin_string_matches_at(string, search, end - search_length));
    mal_builtin_string_root_dispose(&search_root);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

static MalValue mal_builtin_string_prototype_slice(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    usize length = mal_string_length(string);
    usize start = arg_count >= 1 ? mal_builtin_string_clamp_relative(vm, args[0], 0, length) : 0;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    usize end = arg_count >= 2 ? mal_builtin_string_clamp_relative(vm, args[1], (f64) length, length) : length;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    if (end <= start) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_builtin_string_empty(vm);
    }

    string = mal_builtin_string_root_get(&string_root);
    MalValue result = mal_builtin_string_slice(vm, string, start, end - start);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

static bool mal_builtin_string_slice_to_number_direct_impl(
    MalVm *vm,
    MalValue slice_callee,
    MalValue number_callee,
    MalValue receiver,
    f64 relative_start,
    f64 *number_out,
    bool identities_locked
) {
    if (!mal_value_is_string(receiver) ||
        (!identities_locked &&
         (!mal_value_is_native_function_object(slice_callee) ||
          mal_native_function_object_callback(
              mal_value_to_native_function_object(slice_callee)) !=
              mal_builtin_string_prototype_slice ||
          number_callee != vm->intrinsics[MAL_INTRINSIC_NUMBER_CONSTRUCTOR]))) {
        return false;
    }

    MalString *string = mal_value_to_string(receiver);
    usize length = mal_string_length(string);
    usize start = (usize) mal_ops_number_clamp_relative(
        relative_start, (f64) length);
    MalValue number = mal_ops_string_units_to_number(
        mal_string_code_units(string) + start, length - start);
    *number_out = mal_ops_number_as_f64(number);
    return true;
}

bool mal_builtin_string_slice_to_number_direct(
    MalVm *vm,
    MalValue slice_callee,
    MalValue number_callee,
    MalValue receiver,
    f64 relative_start,
    f64 *number_out
) {
    return mal_builtin_string_slice_to_number_direct_impl(
        vm, slice_callee, number_callee, receiver, relative_start, number_out, false);
}

bool mal_builtin_string_slice_to_number_direct_locked(
    MalVm *vm,
    MalValue receiver,
    f64 relative_start,
    f64 *number_out
) {
    return mal_builtin_string_slice_to_number_direct_impl(
        vm, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, receiver, relative_start, number_out,
        true);
}

static MalValue mal_builtin_string_prototype_substring(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    usize length = mal_string_length(string);

    // substring clamps to [0, length] without relative indexing and swaps
    // out-of-order bounds.
    f64 raw_start = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    f64 raw_end = arg_count >= 2 && !mal_value_is_undefined(args[1]) ? mal_builtin_string_arg_to_number(vm, args[1]) : (f64) length;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    raw_start = mal_ops_number_to_length(raw_start);
    raw_end = mal_ops_number_to_length(raw_end);

    usize start = raw_start > (f64) length ? length : (usize) raw_start;
    usize end = raw_end > (f64) length ? length : (usize) raw_end;
    if (start > end) {
        usize swap = start;
        start = end;
        end = swap;
    }

    string = mal_builtin_string_root_get(&string_root);
    MalValue result = mal_builtin_string_slice(vm, string, start, end - start);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

/**
 * Legacy String.prototype.substr(start, length): start counts back from the end
 * when negative; length is clamped to the remaining code units.
 */
static MalValue mal_builtin_string_prototype_substr(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    usize source_length = mal_string_length(string);

    f64 raw_start = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    raw_start = mal_ops_number_clamp_relative(raw_start, (f64) source_length);

    f64 raw_length = arg_count >= 2 && !mal_value_is_undefined(args[1]) ? mal_builtin_string_arg_to_number(vm, args[1]) : (f64) source_length;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_builtin_string_root_dispose(&string_root);
        return mal_value_new_undefined();
    }
    raw_length = mal_ops_number_to_length(raw_length);

    usize start = (usize) raw_start;
    usize remaining = source_length - start;
    usize count = raw_length > (f64) remaining ? remaining : (usize) raw_length;

    string = mal_builtin_string_root_get(&string_root);
    MalValue result = mal_builtin_string_slice(vm, string, start, count);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

/**
 * String.prototype.localeCompare(that, locales, options): RequireObjectCoercible
 * + ToString the receiver, then defer to Intl.Collator-backed collation.
 */
static MalValue mal_builtin_string_prototype_locale_compare(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue that = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue locales = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    MalValue options = arg_count >= 3 ? args[2] : mal_value_new_undefined();
    MalValue string_value = mal_value_from_string(string);
    return mal_intl_locale_compare(
        vm, string_value, that, locales, options);
}

/**
 * Basic String.prototype.normalize: validates the form argument and returns the
 * receiver unchanged (no actual Unicode normalization is performed yet).
 */
static MalValue mal_builtin_string_prototype_normalize(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    if (arg_count >= 1 && !mal_value_is_undefined(args[0])) {
        MalValue roots[2] = {
            mal_value_from_string(string),
            mal_value_new_undefined(),
        };
        MalRootSpan root_span;
        mal_gc_root(&root_span, roots, 2);
        // ToString(form) precedes the form validation: a Symbol throws TypeError
        // before any RangeError. VM ToString also runs a user toString/valueOf.
        MalString *form;
        if (!mal_vm_to_string(vm, args[0], &form)) {
            mal_gc_unroot(&root_span);
            return mal_value_new_undefined();
        }
        roots[1] = mal_value_from_string(form);
        form = mal_value_to_string(roots[1]);
        const c16 *units = mal_string_code_units(form);
        usize length = mal_string_length(form);
        bool valid =
            (length == 3 && units[0] == 'N' && units[1] == 'F' && (units[2] == 'C' || units[2] == 'D')) ||
            (length == 4 && units[0] == 'N' && units[1] == 'F' && units[2] == 'K' && (units[3] == 'C' || units[3] == 'D'));
        if (!valid) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "The normalization form should be one of NFC, NFD, NFKC, NFKD");
            mal_gc_unroot(&root_span);
            return mal_value_new_undefined();
        }
        string = mal_value_to_string(roots[0]);
        mal_gc_unroot(&root_span);
    }

    return mal_value_from_string(string);
}

static MalValue mal_builtin_string_prototype_concat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (arg_count == 0) {
        MalString *string = mal_builtin_string_this_to_string(vm, this_value);
        return vm->completion.kind == MAL_COMPLETION_THROW
            ? mal_value_new_undefined()
            : mal_value_from_string(string);
    }

    // Primitive strings require no observable coercion. Build their exact flat
    // result directly, avoiding the malloc-backed root-part vector used by the
    // generic path for object arguments whose ToString hooks may re-enter.
    if (mal_builtin_string_is_flat_value(this_value)) {
        usize total_length = mal_string_length(mal_value_to_string(this_value));
        bool primitive = true;
        for (i32 i = 0; i < arg_count; i++) {
            if (!mal_builtin_string_is_flat_value(args[i]) ||
                !mal_checked_size_add(
                    total_length, mal_string_length(mal_value_to_string(args[i])),
                    MAL_STRING_MAX_CODE_UNITS, &total_length)) {
                primitive = false;
                break;
            }
        }
        if (primitive) {
            if (total_length == mal_string_length(mal_value_to_string(this_value))) {
                return this_value;
            }
            if (total_length <= MAL_STRING_INLINE_CODE_UNITS) {
                c16 units[MAL_STRING_INLINE_CODE_UNITS];
                usize offset = 0;
                MalString *part = mal_value_to_string(this_value);
                usize part_length = mal_string_length(part);
                memcpy(units, mal_string_code_units(part), sizeof(c16) * part_length);
                offset += part_length;
                for (i32 i = 0; i < arg_count; i++) {
                    part = mal_value_to_string(args[i]);
                    part_length = mal_string_length(part);
                    memcpy(units + offset, mal_string_code_units(part), sizeof(c16) * part_length);
                    offset += part_length;
                }
                return mal_builtin_string_from_units(vm, units, total_length);
            }
            usize bytes;
            if (!mal_checked_size_multiply(
                    sizeof(c16), total_length, SIZE_MAX, &bytes)) {
                mal_builtin_string_throw_length(vm);
                return mal_value_new_undefined();
            }
            c16 *units = mal_heap_try_alloc_raw_profiled(
                &vm->heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
            if (units == nullptr) {
                mal_vm_throw_allocation_error(vm);
                return mal_value_new_undefined();
            }
            usize offset = 0;
            MalString *part = mal_value_to_string(this_value);
            usize part_length = mal_string_length(part);
            memcpy(units, mal_string_code_units(part), sizeof(c16) * part_length);
            offset += part_length;
            for (i32 i = 0; i < arg_count; i++) {
                part = mal_value_to_string(args[i]);
                part_length = mal_string_length(part);
                memcpy(units + offset, mal_string_code_units(part), sizeof(c16) * part_length);
                offset += part_length;
            }
            return mal_value_from_string(
                mal_string_new_owned(&vm->heap, units, total_length));
        }
    }

    usize part_count;
    if (!mal_checked_size_add((usize) arg_count, 1, INT32_MAX, &part_count)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    MalRootedStringParts parts;
    if (!mal_rooted_string_parts_init(
            &parts, mal_intrinsic_ascii(vm, ""), part_count)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    mal_gc_native_rooted_begin(vm);
    MalValue result = mal_value_new_undefined();

    MalString *part = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    if (!mal_rooted_string_parts_append(&parts, part)) {
        mal_builtin_string_throw_length(vm);
        goto done;
    }
    for (i32 i = 0; i < arg_count; i++) {
        part = mal_builtin_string_coerce(vm, args[i]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            goto done;
        }
        if (!mal_rooted_string_parts_append(&parts, part)) {
            mal_builtin_string_throw_length(vm);
            goto done;
        }
    }

    MalString *flattened;
    if (!mal_rooted_string_parts_flatten(vm, &parts, &flattened)) {
        mal_builtin_string_throw_length(vm);
        goto done;
    }
    result = mal_value_from_string(flattened);

done:
    mal_gc_native_rooted_end(vm);
    mal_rooted_string_parts_dispose(&parts);
    return result;
}

/** Annex B CreateHTML, including the legacy quote-only attribute escaping. */
static MalValue mal_builtin_string_create_html(
    MalVm *vm,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    const byte *tag,
    const byte *attribute
) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue roots[2] = {
        mal_value_from_string(string),
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);

    MalString *attribute_value = nullptr;
    usize attribute_value_length = 0;
    usize quote_count = 0;
    if (attribute != nullptr) {
        attribute_value = mal_builtin_string_coerce(
            vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            mal_gc_unroot(&root_span);
            return mal_value_new_undefined();
        }
        roots[1] = mal_value_from_string(attribute_value);
        attribute_value_length = mal_string_length(attribute_value);
        const c16 *source = mal_string_code_units(attribute_value);
        for (usize i = 0; i < attribute_value_length; i++) {
            quote_count += source[i] == '"';
        }
    }

    // Attribute coercion can run user code and collect. Keep the converted
    // receiver rooted above and reacquire it before reading its metadata.
    string = mal_value_to_string(roots[0]);
    usize tag_length = strlen((const char *) tag);
    usize body_length = mal_string_length(string);
    usize tag_framing;
    usize total_length;
    if (!mal_checked_size_multiply(
            tag_length, 2, MAL_STRING_MAX_CODE_UNITS, &tag_framing) ||
        !mal_checked_size_add(
            body_length, tag_framing, MAL_STRING_MAX_CODE_UNITS,
            &total_length) ||
        !mal_checked_size_add(
            total_length, attribute == nullptr ? 5 : 9,
            MAL_STRING_MAX_CODE_UNITS, &total_length)) {
        mal_builtin_string_throw_length(vm);
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    if (attribute != nullptr) {
        usize escaped_extra;
        usize escaped_length;
        usize attribute_name_length = strlen((const char *) attribute);
        if (!mal_checked_size_multiply(
                quote_count, 5, MAL_STRING_MAX_CODE_UNITS,
                &escaped_extra) ||
            !mal_checked_size_add(
                attribute_value_length, escaped_extra,
                MAL_STRING_MAX_CODE_UNITS, &escaped_length) ||
            !mal_checked_size_add(
                total_length, attribute_name_length,
                MAL_STRING_MAX_CODE_UNITS, &total_length) ||
            !mal_checked_size_add(
                total_length, escaped_length,
                MAL_STRING_MAX_CODE_UNITS, &total_length)) {
            mal_builtin_string_throw_length(vm);
            mal_gc_unroot(&root_span);
            return mal_value_new_undefined();
        }
    }

    usize bytes;
    if (!mal_checked_size_multiply(
            total_length, sizeof(c16), SIZE_MAX, &bytes)) {
        mal_builtin_string_throw_length(vm);
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    c16 *code_units = mal_heap_alloc_raw_profiled(
        &vm->heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    string = mal_value_to_string(roots[0]);
    if (attribute != nullptr) {
        attribute_value = mal_value_to_string(roots[1]);
    }

    usize out = 0;
#define MAL_APPEND_HTML_ASCII(text)                                                       \
    do {                                                                                  \
        const byte *ascii = (const byte *) (text);                                        \
        for (usize i = 0; ascii[i] != '\0'; i++) code_units[out++] = ascii[i];           \
    } while (0)

    MAL_APPEND_HTML_ASCII("<");
    MAL_APPEND_HTML_ASCII(tag);
    if (attribute != nullptr) {
        MAL_APPEND_HTML_ASCII(" ");
        MAL_APPEND_HTML_ASCII(attribute);
        MAL_APPEND_HTML_ASCII("=\"");
        const c16 *source = mal_string_code_units(attribute_value);
        static const c16 replacement[] = {'&', 'q', 'u', 'o', 't', ';'};
        for (usize i = 0; i < attribute_value_length; i++) {
            if (source[i] == '"') {
                memcpy(code_units + out, replacement, sizeof(replacement));
                out += sizeof(replacement) / sizeof(replacement[0]);
            } else {
                code_units[out++] = source[i];
            }
        }
        MAL_APPEND_HTML_ASCII("\"");
    }
    MAL_APPEND_HTML_ASCII(">");
    if (body_length != 0) {
        memcpy(
            code_units + out, mal_string_code_units(string),
            sizeof(c16) * body_length);
        out += body_length;
    }
    MAL_APPEND_HTML_ASCII("</");
    MAL_APPEND_HTML_ASCII(tag);
    MAL_APPEND_HTML_ASCII(">");

#undef MAL_APPEND_HTML_ASCII

    assert(out == total_length);
    MalValue result = mal_value_from_string(
        mal_string_new_owned(&vm->heap, code_units, total_length));
    mal_gc_unroot(&root_span);
    return result;
}

#define MAL_DEFINE_CREATE_HTML_METHOD(name, tag, attribute)                              \
    static MalValue mal_builtin_string_prototype_##name(                                 \
        MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count,              \
        MalValue new_target, MalValue callee                                               \
    ) {                                                                                   \
        return mal_builtin_string_create_html(                                             \
            vm, this_value, args, arg_count, tag, attribute);                             \
    }

MAL_DEFINE_CREATE_HTML_METHOD(anchor, "a", "name")
MAL_DEFINE_CREATE_HTML_METHOD(big, "big", nullptr)
MAL_DEFINE_CREATE_HTML_METHOD(blink, "blink", nullptr)
MAL_DEFINE_CREATE_HTML_METHOD(bold, "b", nullptr)
MAL_DEFINE_CREATE_HTML_METHOD(fixed, "tt", nullptr)
MAL_DEFINE_CREATE_HTML_METHOD(fontcolor, "font", "color")
MAL_DEFINE_CREATE_HTML_METHOD(fontsize, "font", "size")
MAL_DEFINE_CREATE_HTML_METHOD(italics, "i", nullptr)
MAL_DEFINE_CREATE_HTML_METHOD(link, "a", "href")
MAL_DEFINE_CREATE_HTML_METHOD(small, "small", nullptr)
MAL_DEFINE_CREATE_HTML_METHOD(strike, "strike", nullptr)
MAL_DEFINE_CREATE_HTML_METHOD(sub, "sub", nullptr)
MAL_DEFINE_CREATE_HTML_METHOD(sup, "sup", nullptr)

#undef MAL_DEFINE_CREATE_HTML_METHOD

#define MAL_STRING_REPEAT_LAZY_MIN_CODE_UNITS ((usize) 65536)

static MalValue mal_builtin_string_prototype_repeat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue string_root = mal_value_from_string(string);
    MalRootSpan string_span;
    mal_gc_root(&string_span, &string_root, 1);
    MalValue result_value = mal_value_new_undefined();

    f64 count = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    count = mal_ops_number_to_integer_or_infinity(count);
    if (count < 0 || isinf(count)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid count value");
        goto done;
    }
    string = mal_value_to_string(string_root);
    usize length = mal_string_length(string);
    // Repeating an empty string (or zero times) is empty regardless of count;
    // short-circuit so a huge count can't spin a multi-billion-iteration loop.
    if (length == 0 || count < 1) {
        result_value = mal_builtin_string_empty(vm);
        goto done;
    }
    if (count > (f64) (MAL_STRING_MAX_CODE_UNITS / length)) {
        mal_builtin_string_throw_length(vm);
        goto done;
    }
    usize repeat = (usize) count;
    usize result_length;
    usize bytes;
    if (!mal_checked_size_multiply(length, repeat, MAL_STRING_MAX_CODE_UNITS, &result_length) ||
        !mal_checked_size_multiply(sizeof(c16), result_length, SIZE_MAX, &bytes)) {
        mal_builtin_string_throw_length(vm);
        goto done;
    }
    if (repeat == 1) {
        result_value = string_root;
        goto done;
    }

    MalStringStorage storage = mal_string_storage(string);
    if (result_length >= MAL_STRING_REPEAT_LAZY_MIN_CODE_UNITS &&
        (storage == MAL_STRING_STORAGE_OWNED ||
         storage == MAL_STRING_STORAGE_INLINE ||
         storage == MAL_STRING_STORAGE_EXTERNAL)) {
        MalValue result_root = string_root;
        MalRootSpan result_span;
        mal_gc_root(&result_span, &result_root, 1);
        mal_gc_native_rooted_begin(vm);

        // Consume the count below its highest bit, doubling the completed prefix
        // and appending one source copy for each set bit.
        usize bit = 1;
        while (bit <= repeat / 2) bit <<= 1;

        MalString *result = string;
        while ((bit >>= 1) != 0) {
            if (!mal_string_new_cons_checked(&vm->heap, result, result, &result)) {
                mal_builtin_string_throw_length(vm);
                goto lazy_done;
            }
            result_root = mal_value_from_string(result);

            if ((repeat & bit) != 0) {
                string = mal_value_to_string(string_root);
                if (!mal_string_new_cons_checked(&vm->heap, result, string, &result)) {
                    mal_builtin_string_throw_length(vm);
                    goto lazy_done;
                }
                result_root = mal_value_from_string(result);
            }
        }
        result_value = result_root;

lazy_done:
        mal_gc_native_rooted_end(vm);
        mal_gc_unroot(&result_span);
        goto done;
    }

    c16 *code_units = mal_heap_alloc_raw_profiled(
        &vm->heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    string = mal_value_to_string(string_root);
    const c16 *source = mal_string_code_units(string);
    usize filled = length;
    memcpy(code_units, source, sizeof(c16) * length);
    while (filled < result_length) {
        usize remaining = result_length - filled;
        usize copy_length = filled < remaining ? filled : remaining;
        memcpy(code_units + filled, code_units, sizeof(c16) * copy_length);
        filled += copy_length;
    }

    result_value = mal_value_from_string(
        mal_string_new_owned(&vm->heap, code_units, result_length));

done:
    mal_gc_unroot(&string_span);
    return result_value;
}

static MalValue mal_builtin_string_trim_impl(MalVm *vm, MalValue this_value, bool trim_start, bool trim_end) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    const c16 *code_units;
    string = mal_builtin_string_flatten_for_scan(string, &code_units);
    usize start = 0;
    usize end = mal_string_length(string);

    while (trim_start && start < end && mal_ecma_is_string_whitespace(code_units[start])) {
        start++;
    }
    while (trim_end && end > start && mal_ecma_is_string_whitespace(code_units[end - 1])) {
        end--;
    }

    usize result_length = end - start;
    if (start == 0 && result_length == mal_string_length(string)) {
        return mal_value_from_string(string);
    }
    if (result_length == 0) {
        return mal_builtin_string_empty(vm);
    }
    if (result_length == 1) {
        return mal_value_from_string(
            mal_intrinsic_code_unit(vm, code_units[start]));
    }

    // Only a dependent result can allocate while still needing its parent.
    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    MalValue result = mal_builtin_string_slice(
        vm, mal_builtin_string_root_get(&string_root), start, result_length);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

static MalValue mal_builtin_string_prototype_trim(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_string_trim_impl(vm, this_value, true, true);
}

static MalValue mal_builtin_string_prototype_trim_start(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_string_trim_impl(vm, this_value, true, false);
}

static MalValue mal_builtin_string_prototype_trim_end(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_string_trim_impl(vm, this_value, false, true);
}

static MalValue mal_builtin_string_case_impl(MalVm *vm, MalValue this_value, bool to_upper) {
    // Case mapping is currently ASCII-only.
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    usize length = mal_string_length(string);
    const c16 *source;
    string = mal_builtin_string_flatten_for_scan(string, &source);
    MAL_PERF_COUNT(string_case_calls);
    MAL_PERF_ADD(string_case_input_code_units, length);

    usize changed_at = 0;
    while (length - changed_at >= 4) {
        bool unchanged = true;
        for (usize lane = 0; lane < 4; lane++) {
            c16 source_unit = source[changed_at + lane];
            c16 mapped_unit = to_upper
                ? mal_ascii_to_upper(source_unit)
                : mal_ascii_to_lower(source_unit);
            if (mapped_unit != source_unit) {
                unchanged = false;
                break;
            }
        }
        if (!unchanged) break;
        changed_at += 4;
    }
    while (changed_at < length) {
        c16 source_unit = source[changed_at];
        c16 mapped_unit =
            to_upper ? mal_ascii_to_upper(source_unit) : mal_ascii_to_lower(source_unit);
        if (mapped_unit != source_unit) break;
        changed_at++;
    }
    if (changed_at == length) {
        MAL_PERF_COUNT(string_case_reuses);
        return mal_value_from_string(string);
    }

    MAL_PERF_COUNT(string_case_changed_allocations);
    MAL_PERF_ADD(string_case_changed_code_units, length);
    if (length <= MAL_STRING_INLINE_CODE_UNITS) {
        c16 code_units[MAL_STRING_INLINE_CODE_UNITS];
        if (changed_at > 0) {
            memcpy(code_units, source, sizeof(c16) * changed_at);
        }
        usize i = changed_at;
        while (length - i >= 4) {
            for (usize lane = 0; lane < 4; lane++) {
                code_units[i + lane] = to_upper
                    ? mal_ascii_to_upper(source[i + lane])
                    : mal_ascii_to_lower(source[i + lane]);
            }
            i += 4;
        }
        for (; i < length; i++) {
            code_units[i] =
                to_upper ? mal_ascii_to_upper(source[i]) : mal_ascii_to_lower(source[i]);
        }
        MalValue result = mal_builtin_string_from_units(vm, code_units, length);
        return result;
    }

    MalValue string_root = mal_value_from_string(string);
    MalRootSpan root_span;
    mal_gc_root(&root_span, &string_root, 1);
    c16 *code_units = mal_heap_alloc_raw_profiled(
        &vm->heap, sizeof(c16) * length, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    string = mal_value_to_string(string_root);
    source = mal_string_code_units(string);
    if (changed_at > 0) {
        memcpy(code_units, source, sizeof(c16) * changed_at);
    }
    usize i = changed_at;
    while (length - i >= 4) {
        for (usize lane = 0; lane < 4; lane++) {
            code_units[i + lane] = to_upper
                ? mal_ascii_to_upper(source[i + lane])
                : mal_ascii_to_lower(source[i + lane]);
        }
        i += 4;
    }
    for (; i < length; i++) {
        code_units[i] =
            to_upper ? mal_ascii_to_upper(source[i]) : mal_ascii_to_lower(source[i]);
    }
    MalValue result = mal_value_from_string(
        mal_string_new_owned(&vm->heap, code_units, length)
    );
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue mal_builtin_string_prototype_to_upper_case(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_string_case_impl(vm, this_value, true);
}

static MalValue mal_builtin_string_prototype_to_lower_case(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_string_case_impl(vm, this_value, false);
}

static bool mal_builtin_string_ascii_case_chain_length_span_impl(
    MalVm *vm,
    MalValue upper_callee,
    MalValue lower_callee,
    MalValue subject,
    i32 start,
    i32 end,
    u32 *length_out,
    bool authority_invariant
) {
    if ((!authority_invariant &&
         (!mal_value_is_native_function_object(upper_callee) ||
          !mal_value_is_native_function_object(lower_callee) ||
          mal_native_function_object_callback(
              mal_value_to_native_function_object(upper_callee)) !=
              mal_builtin_string_prototype_to_upper_case ||
          mal_native_function_object_callback(
              mal_value_to_native_function_object(lower_callee)) !=
              mal_builtin_string_prototype_to_lower_case)) ||
        !mal_value_is_string(subject) || start < 0 || end < start || end - start > 64) {
        return false;
    }
#if MAL_REALMS
    if (!authority_invariant &&
        (mal_vm_callee_realm(vm, upper_callee) != vm->current_realm ||
         mal_vm_callee_realm(vm, lower_callee) != vm->current_realm)) {
        return false;
    }
#else
    (void) vm;
#endif
    MalString *string = mal_value_to_string(subject);
    if (mal_string_storage(string) == MAL_STRING_STORAGE_CONS ||
        (usize) end > mal_string_length(string)) {
        return false;
    }
    const c16 *units = mal_string_code_units(string);
    i32 index = start;
    while (end - index >= 4) {
        u64 word;
        memcpy(&word, units + index, sizeof(word));
        if ((word & 0xff80ff80ff80ff80ULL) != 0) return false;
        index += 4;
    }
    for (; index < end; index++) {
        if (units[index] > 0x7f) {
            return false;
        }
    }
    *length_out = (u32) (end - start);
    return true;
}

bool mal_builtin_string_ascii_case_chain_length_span(
    MalVm *vm,
    MalValue upper_callee,
    MalValue lower_callee,
    MalValue subject,
    i32 start,
    i32 end,
    u32 *length_out
) {
    return mal_builtin_string_ascii_case_chain_length_span_impl(
        vm, upper_callee, lower_callee, subject, start, end, length_out, false);
}

bool mal_builtin_string_ascii_case_chain_length_span_locked(
    MalVm *vm,
    MalValue subject,
    i32 start,
    i32 end,
    u32 *length_out
) {
    return mal_builtin_string_ascii_case_chain_length_span_impl(
        vm,
        MAL_VALUE_UNDEFINED,
        MAL_VALUE_UNDEFINED,
        subject,
        start,
        end,
        length_out,
        true);
}

static usize mal_builtin_string_find_invalid_utf16(
    const c16 *units, usize length
) {
    usize index = 0;
    while (index < length) {
        while (length - index >= 4 &&
               !mal_utf16_is_surrogate(units[index]) &&
               !mal_utf16_is_surrogate(units[index + 1]) &&
               !mal_utf16_is_surrogate(units[index + 2]) &&
               !mal_utf16_is_surrogate(units[index + 3])) {
            index += 4;
        }
        if (index == length) break;
        usize width;
        if (!mal_utf16_read_scalar(units, length, index, nullptr, &width)) {
            return index;
        }
        index += width;
    }
    return length;
}

// A code unit is a surrogate paired with its neighbour, a lone surrogate, or an
// ordinary unit. isWellFormed is false when any lone surrogate is present.
static MalValue mal_builtin_string_prototype_is_well_formed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    usize length = mal_string_length(string);
    const c16 *units;
    string = mal_builtin_string_flatten_for_scan(string, &units);
    return mal_value_new_boolean(
        mal_builtin_string_find_invalid_utf16(units, length) == length);
}

// Replace each lone surrogate with U+FFFD (the replacement character), leaving
// valid surrogate pairs and ordinary units intact.
static MalValue mal_builtin_string_prototype_to_well_formed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    usize length = mal_string_length(string);
    const c16 *source;
    string = mal_builtin_string_flatten_for_scan(string, &source);
    usize first_invalid = mal_builtin_string_find_invalid_utf16(source, length);
    if (first_invalid == length) {
        return mal_value_from_string(string);
    }

    usize bytes;
    if (!mal_checked_size_multiply(sizeof(c16), length, SIZE_MAX, &bytes)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    MalValue string_root = mal_value_from_string(string);
    MalRootSpan root_span;
    mal_gc_root(&root_span, &string_root, 1);
    c16 *code_units = mal_heap_alloc_raw_profiled(
        &vm->heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    string = mal_value_to_string(string_root);
    source = mal_string_code_units(string);
    if (first_invalid != 0) {
        memcpy(code_units, source, sizeof(c16) * first_invalid);
    }
    for (usize i = first_invalid; i < length;) {
        usize width;
        bool valid = mal_utf16_read_scalar(source, length, i, nullptr, &width);
        if (valid) {
            memcpy(code_units + i, source + i, sizeof(c16) * width);
        } else {
            code_units[i] = 0xFFFD;
        }
        i += width;
    }
    MalValue result = mal_value_from_string(
        mal_string_new_owned(&vm->heap, code_units, length));
    mal_gc_unroot(&root_span);
    return result;
}

// For an Object argument, GetMethod(arg, @@symbol) and, when present,
// Call(method, arg, [this, ...extra]). Primitive arguments do not dispatch.
// Returns 1 when dispatched (result in *out; a throw is left on the completion),
// 0 when there is no method (caller runs the string fallback), -1 on a throw.
static int mal_builtin_string_regex_dispatch(
    MalVm *vm, MalValue this_value, MalValue arg, MalIntrinsic symbol_slot, const MalValue *extra, i32 extra_count, MalValue *out
) {
    if (!mal_value_is_object(arg)) {
        return 0;
    }
    if (mal_regexp_try_exact_string_dispatch(
            vm, arg, symbol_slot, this_value, extra, extra_count, out)) {
        return 1;
    }
    MalValue method;
    if (!mal_vm_get_property(vm, arg, mal_intrinsic_symbol_key(vm, symbol_slot), &method)) {
        *out = mal_value_new_undefined();
        return -1;
    }
    if (mal_value_is_nil(method)) {
        return 0;
    }
    if (!mal_value_is_callable(method)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Symbol method is not callable");
        *out = mal_value_new_undefined();
        return -1;
    }
    MalValue call_args[3];
    i32 n = 0;
    call_args[n++] = this_value;
    for (i32 i = 0; i < extra_count && n < 3; i++) {
        call_args[n++] = extra[i];
    }
    MalCompletion completion = mal_vm_call_value(vm, method, arg, call_args, n);
    *out = completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : completion.value;
    return 1;
}

// IsRegExp(arg): @@match overrides the [[RegExpMatcher]] brand. Returns false on
// a pending throw (which the caller propagates).
static bool mal_builtin_string_is_regexp(MalVm *vm, MalValue arg) {
    if (!mal_value_is_object(arg)) {
        return false;
    }
    MalValue matcher;
    if (!mal_vm_get_property(vm, arg, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_MATCH), &matcher)) {
        return false;
    }
    if (!mal_value_is_undefined(matcher)) {
        return mal_value_is_truthy(matcher);
    }
    return mal_value_is_regexp_object(arg);
}

/** ToString(flags) and scan it while both the source value and converted String
 * remain rooted. A flags getter may return a fresh object whose coercion runs
 * arbitrary user code, and flattening the resulting String may allocate. */
static bool mal_builtin_string_flags_have_global(
    MalVm *vm, MalValue flags_value, bool *has_global_out
) {
    MalValue roots[2] = {flags_value, mal_value_new_undefined()};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);

    MalString *flags_string;
    if (!mal_vm_to_string(vm, roots[0], &flags_string)) {
        mal_gc_unroot(&root_span);
        return false;
    }
    roots[1] = mal_value_from_string(flags_string);
    flags_string = mal_value_to_string(roots[1]);
    usize length = mal_string_length(flags_string);
    const c16 *units = mal_string_code_units(flags_string);
    bool has_global = false;
    for (usize i = 0; i < length; i++) {
        if (units[i] == 'g') {
            has_global = true;
            break;
        }
    }

    *has_global_out = has_global;
    mal_gc_unroot(&root_span);
    return true;
}

// String.prototype.match / .search: dispatch to the argument's @@match/@@search;
// otherwise coerce the argument to a fresh RegExp and invoke that.
static MalValue mal_builtin_string_match_like(MalVm *vm, MalValue this_value, MalValue regexp, MalIntrinsic symbol_slot) {
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "String.prototype method called on null or undefined");
        return mal_value_new_undefined();
    }
    MalValue out;
    int dispatched = mal_builtin_string_regex_dispatch(vm, this_value, regexp, symbol_slot, nullptr, 0, &out);
    if (dispatched != 0) {
        return out;
    }
    // No @@match/@@search on the argument, so the spec coerces it to a fresh RegExp
    // (new RegExp(arg)) and dispatches to that — inherently a regex operation, so
    // under engine.regexp:false (regress gone) it throws rather than compiling one.
#if MAL_REGEXP
    MalString *s = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue roots[3] = {
        mal_value_from_string(s),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 3);
    MalValue result = mal_value_new_undefined();
    MalString *pattern;
    if (mal_value_is_undefined(regexp)) {
        pattern = mal_intrinsic_ascii(vm, "");
    } else if (!mal_vm_to_string(vm, regexp, &pattern)) {
        goto match_like_done;
    }
    roots[1] = mal_value_from_string(pattern);
    MalString *flags = mal_intrinsic_ascii(vm, "");
    pattern = mal_value_to_string(roots[1]);
    MalValue rx = mal_regexp_create(vm, pattern, flags);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto match_like_done;
    }
    roots[2] = rx;
    MalValue s_value = roots[0];
    rx = roots[2];
    if (mal_regexp_try_exact_string_dispatch(
            vm, rx, symbol_slot, s_value, nullptr, 0, &out)) {
        result = out;
        goto match_like_done;
    }
    MalValue method;
    if (!mal_vm_get_property(vm, rx, mal_intrinsic_symbol_key(vm, symbol_slot), &method)) {
        goto match_like_done;
    }
    MalCompletion completion = mal_vm_call_value(vm, method, rx, &s_value, 1);
    if (completion.kind != MAL_COMPLETION_THROW) {
        result = completion.value;
    }

match_like_done:
    mal_gc_unroot(&root_span);
    return result;
#else
    (void) symbol_slot;
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "String.prototype.match/matchAll/search requires RegExp, which is disabled (engine.regexp is false)");
    return mal_value_new_undefined();
#endif
}

static MalValue mal_builtin_string_prototype_match(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_builtin_string_match_like(vm, this_value, arg_count >= 1 ? args[0] : mal_value_new_undefined(), MAL_INTRINSIC_SYMBOL_MATCH);
}

static MalValue mal_builtin_string_prototype_search(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    return mal_builtin_string_match_like(vm, this_value, arg_count >= 1 ? args[0] : mal_value_new_undefined(), MAL_INTRINSIC_SYMBOL_SEARCH);
}

static MalValue mal_builtin_string_prototype_match_all(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "String.prototype.matchAll called on null or undefined");
        return mal_value_new_undefined();
    }
    MalValue regexp = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_object(regexp)) {
        MalValue out;
        if (mal_regexp_try_canonical_match_all(vm, regexp, this_value, &out)) {
            return out;
        }
        // A non-global RegExp argument is a TypeError (matchAll iterates globally).
        bool is_regexp = mal_builtin_string_is_regexp(vm, regexp);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
        if (is_regexp) {
            MalValue flags_value;
            if (!mal_vm_get_property(vm, regexp, mal_intrinsic_string_key(vm, "flags"), &flags_value)) {
                return mal_value_new_undefined();
            }
            if (mal_value_is_nil(flags_value)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp flags is null or undefined");
                return mal_value_new_undefined();
            }
            bool has_global;
            if (!mal_builtin_string_flags_have_global(
                    vm, flags_value, &has_global)) {
                return mal_value_new_undefined();
            }
            if (!has_global) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "matchAll must be called with a global RegExp");
                return mal_value_new_undefined();
            }
        }
        int dispatched = mal_builtin_string_regex_dispatch(vm, this_value, regexp, MAL_INTRINSIC_SYMBOL_MATCH_ALL, nullptr, 0, &out);
        if (dispatched != 0) {
            return out;
        }
    }
    // Coerce the argument to a fresh global RegExp — a regex op, so gated on regexp.
#if MAL_REGEXP
    MalString *s = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue roots[3] = {
        mal_value_from_string(s),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 3);
    MalValue result = mal_value_new_undefined();
    MalString *pattern;
    if (mal_value_is_undefined(regexp)) {
        pattern = mal_intrinsic_ascii(vm, "");
    } else if (!mal_vm_to_string(vm, regexp, &pattern)) {
        goto match_all_done;
    }
    roots[1] = mal_value_from_string(pattern);
    MalString *flags = mal_intrinsic_ascii(vm, "g");
    pattern = mal_value_to_string(roots[1]);
    MalValue rx = mal_regexp_create(vm, pattern, flags);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto match_all_done;
    }
    roots[2] = rx;
    MalValue s_value = roots[0];
    rx = roots[2];
    MalValue out;
    if (mal_regexp_try_exact_string_dispatch(
            vm, rx, MAL_INTRINSIC_SYMBOL_MATCH_ALL, s_value, nullptr, 0, &out)) {
        result = out;
        goto match_all_done;
    }
    MalValue method;
    if (!mal_vm_get_property(vm, rx, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_MATCH_ALL), &method)) {
        goto match_all_done;
    }
    MalCompletion completion = mal_vm_call_value(vm, method, rx, &s_value, 1);
    if (completion.kind != MAL_COMPLETION_THROW) {
        result = completion.value;
    }

match_all_done:
    mal_gc_unroot(&root_span);
    return result;
#else
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "String.prototype.matchAll requires RegExp, which is disabled (engine.regexp is false)");
    return mal_value_new_undefined();
#endif
}

static void mal_builtin_string_split_append(MalArrayObject *result, MalValue value) {
    if (!mal_array_object_fresh_dense_append(result, value)) {
        mal_array_object_store(result, mal_key_index(mal_array_object_length(result)), value);
    }
}

#define MAL_STRING_SPLIT_MATCH_PLAN_CAPACITY 64u

static bool mal_builtin_string_split_plan_matches(
    MalString *string, MalString *separator, u32 limit,
    usize *match_offsets, u32 *match_count, usize *overflow_match_position
) {
    usize length = mal_string_length(string);
    usize separator_length = mal_string_length(separator);
    usize position = 0;
    *match_count = 0;
    *overflow_match_position = length;

    if (separator_length > length) return true;

    if (separator_length == 1) {
        const c16 separator_unit = mal_string_code_units(separator)[0];
        const c16 *string_units = mal_string_code_units(string);
        while (position < length) {
            position = mal_builtin_string_find_unit(
                string_units, position, length, separator_unit
            );
            if (position == length) break;
            if (*match_count == MAL_STRING_SPLIT_MATCH_PLAN_CAPACITY) {
                MAL_PERF_COUNT(string_split_plan_overflows);
                *overflow_match_position = position;
                return false;
            }
            match_offsets[(*match_count)++] = position++;
            MAL_PERF_COUNT(string_split_planned_matches);
            if (*match_count == limit) return true;
        }
        return true;
    }

    while (position <= length - separator_length) {
        i64 match_position = mal_builtin_string_find(string, separator, position);
        if (match_position < 0) break;
        if (*match_count == MAL_STRING_SPLIT_MATCH_PLAN_CAPACITY) {
            MAL_PERF_COUNT(string_split_plan_overflows);
            *overflow_match_position = (usize) match_position;
            return false;
        }
        match_offsets[(*match_count)++] = (usize) match_position;
        MAL_PERF_COUNT(string_split_planned_matches);
        if (*match_count == limit) return true;
        position = (usize) match_position + separator_length;
    }
    return true;
}

static MalValue mal_builtin_string_prototype_split(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    // @@split dispatch — only when the separator is an Object (the spec accesses
    // @@split solely "if separator is an Object", never on a string primitive).
    // RequireObjectCoercible(this) first, before any property access.
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "String.prototype.split called on null or undefined");
        return mal_value_new_undefined();
    }
    MalValue separator_value = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_object(separator_value)) {
        MalValue extra[1] = {arg_count >= 2 ? args[1] : mal_value_new_undefined()};
        MalValue out;
        int dispatched = mal_builtin_string_regex_dispatch(vm, this_value, separator_value, MAL_INTRINSIC_SYMBOL_SPLIT, extra, 1, &out);
        if (dispatched != 0) {
            return out;
        }
    }
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue roots[3] = {
        mal_value_from_string(string),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 3);

    // lim = ToUint32(limit) (spec step 6, after ToString(this) at step 3). Skip
    // it if ToString(this) already threw so that first completion is preserved
    // (native builtins compute through a pending throw and it is detected at the
    // call boundary). An absent/undefined limit is 2^32-1.
    u32 lim = UINT32_MAX;
    if (arg_count >= 2 && !mal_value_is_undefined(args[1])) {
        f64 lim_number;
        if (mal_vm_to_number(vm, args[1], &lim_number)) {
            lim = mal_ops_number_to_uint32(lim_number);
        }
    }

    // R = ToString(separator) (spec step 7) runs BEFORE the lim = 0 check
    // (step 8), so an observable/throwing separator.toString is exercised even
    // when the limit is 0. (coerce is a no-op when a throw is already pending.)
    bool separator_undefined = arg_count == 0 || mal_value_is_undefined(args[0]);
    MalString *separator = separator_undefined ? nullptr : mal_builtin_string_coerce(vm, args[0]);
    if (!separator_undefined && vm->completion.kind != MAL_COMPLETION_THROW) {
        roots[1] = mal_value_from_string(separator);
    }

    // Any coercion above (this / limit / separator) may have thrown. Result creation
    // follows all observable coercions in this fallback.
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }

    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    roots[2] = mal_value_from_array_object(result);
    u32 result_length = 0;

    // Spec step 8: a zero limit yields the empty array.
    if (lim == 0) {
        MalValue empty_result = roots[2];
        mal_gc_unroot(&root_span);
        return empty_result;
    }

    string = mal_value_to_string(roots[0]);
    if (!separator_undefined) {
        separator = mal_value_to_string(roots[1]);
    }
    mal_gc_native_rooted_begin(vm);

    // Spec step 9: an undefined separator yields the whole string.
    if (separator_undefined) {
        (void) mal_array_object_fresh_dense_reserve_exact(result, 1);
        mal_builtin_string_split_append(result, mal_value_from_string(string));
        goto split_done;
    }

    usize length = mal_string_length(string);
    usize separator_length = mal_string_length(separator);

    if (separator_length == 0) {
        u32 exact_count = length < (usize) lim ? (u32) length : lim;
        (void) mal_array_object_fresh_dense_reserve_exact(result, exact_count);
        // Split into individual code units, stopping at the limit.
        for (usize i = 0; i < length; i++) {
            if (result_length == lim) {
                goto split_done;
            }
            MalValue segment = mal_builtin_string_slice(vm, string, i, 1);
            mal_builtin_string_split_append(result, segment);
            result_length++;
        }
        goto split_done;
    }

    // 64 offsets use 512 bytes on 64-bit targets and cover common structured-text
    // splits while keeping worst-case native stack use fixed. A larger split keeps
    // the staged offsets and resumes at the first unplanned match.
    usize match_offsets[MAL_STRING_SPLIT_MATCH_PLAN_CAPACITY];
    u32 match_count;
    usize overflow_match_position;
    bool plan_complete = mal_builtin_string_split_plan_matches(
        string, separator, lim, match_offsets, &match_count, &overflow_match_position);
    if (plan_complete) {
        u32 exact_count = match_count == lim ? lim : match_count + 1;
        (void) mal_array_object_fresh_dense_reserve_exact(result, exact_count);
    } else {
        // This is an exact lower bound: the staged segments plus the first match
        // that did not fit. Remaining elements continue through geometric growth.
        (void) mal_array_object_fresh_dense_reserve_exact(result, match_count + 1);
    }

    usize segment_start = 0;
    for (u32 i = 0; i < match_count; i++) {
        usize match_position = match_offsets[i];
        MalValue segment = mal_builtin_string_slice(
            vm, string, segment_start, match_position - segment_start);
        mal_builtin_string_split_append(result, segment);
        result_length++;
        if (result_length == lim) goto split_done;
        segment_start = match_position + separator_length;
    }

    if (plan_complete) {
        MalValue segment =
            mal_builtin_string_slice(vm, string, segment_start, length - segment_start);
        mal_builtin_string_split_append(result, segment);
        goto split_done;
    }

    usize position = overflow_match_position;
    while (true) {
        MalValue segment =
            mal_builtin_string_slice(vm, string, segment_start, position - segment_start);
        mal_builtin_string_split_append(result, segment);
        result_length++;
        if (result_length == lim) {
            goto split_done;
        }
        position += separator_length;
        segment_start = position;
        if (position + separator_length > length) break;
        i64 match_position = mal_builtin_string_find(string, separator, position);
        if (match_position < 0) break;
        position = (usize) match_position;
    }

    MalValue segment =
        mal_builtin_string_slice(vm, string, segment_start, length - segment_start);
    mal_builtin_string_split_append(result, segment);

split_done:
    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&root_span);
    return roots[2];
}

MalValue mal_builtin_string_split_direct(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 arg_count
) {
    return mal_builtin_string_prototype_split(
        vm, receiver, args, arg_count, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED);
}

static bool mal_builtin_string_split_projection_impl(
    MalVm *vm,
    MalValue callee,
    MalValue receiver,
    MalValue separator_value,
    const u32 *indices,
    MalValue **outputs,
    u32 output_count,
    u32 *length_out,
    bool identity_locked
) {
    if (output_count == 0 || output_count > MAL_STRING_SPLIT_PROJECTION_MAX_OUTPUTS ||
        !mal_value_is_string(receiver) || !mal_value_is_string(separator_value) ||
        (!identity_locked &&
         (!mal_value_is_native_function_object(callee) ||
          mal_native_function_object_callback(mal_value_to_native_function_object(callee)) !=
              mal_builtin_string_prototype_split))) {
        return false;
    }
    for (u32 i = 1; i < output_count; i++) {
        if (indices[i - 1] >= indices[i]) return false;
    }

    MalString *string = mal_value_to_string(receiver);
    MalString *separator = mal_value_to_string(separator_value);
    usize separator_length = mal_string_length(separator);
    if (separator_length == 0) return false;

    MalValue roots[2 + MAL_STRING_SPLIT_PROJECTION_MAX_OUTPUTS];
    roots[0] = receiver;
    roots[1] = separator_value;
    for (u32 i = 0; i < output_count; i++) roots[2 + i] = MAL_VALUE_UNDEFINED;
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2 + output_count);
    mal_gc_native_rooted_begin(vm);

    usize match_offsets[MAL_STRING_SPLIT_MATCH_PLAN_CAPACITY];
    u32 match_count;
    usize overflow_match_position;
    bool plan_complete = mal_builtin_string_split_plan_matches(
        string, separator, UINT32_MAX, match_offsets, &match_count,
        &overflow_match_position);

    usize length = mal_string_length(string);
    usize segment_start = 0;
    u32 total_match_count = 0;
    u32 next_output = 0;
    for (u32 i = 0; i < match_count; i++) {
        usize match_position = match_offsets[i];
        if (next_output < output_count && indices[next_output] == total_match_count) {
            roots[2 + next_output] = mal_builtin_string_slice(
                vm, string, segment_start, match_position - segment_start);
            next_output++;
        }
        total_match_count++;
        segment_start = match_position + separator_length;
    }

    if (!plan_complete) {
        usize match_position = overflow_match_position;
        while (true) {
            if (next_output < output_count && indices[next_output] == total_match_count) {
                roots[2 + next_output] = mal_builtin_string_slice(
                    vm, string, segment_start, match_position - segment_start);
                next_output++;
            }
            total_match_count++;
            segment_start = match_position + separator_length;
            if (segment_start + separator_length > length) break;
            i64 next_match = mal_builtin_string_find(
                string, separator, segment_start);
            if (next_match < 0) break;
            match_position = (usize) next_match;
        }
    }

    if (next_output < output_count && indices[next_output] == total_match_count) {
        roots[2 + next_output] = mal_builtin_string_slice(
            vm, string, segment_start, length - segment_start);
    }
    *length_out = total_match_count + 1;
    for (u32 i = 0; i < output_count; i++) *outputs[i] = roots[2 + i];

    mal_gc_native_rooted_end(vm);
    mal_gc_unroot(&root_span);
    return true;
}

bool mal_builtin_string_split_projection(
    MalVm *vm,
    MalValue callee,
    MalValue receiver,
    MalValue separator_value,
    const u32 *indices,
    MalValue **outputs,
    u32 output_count,
    u32 *length_out
) {
    return mal_builtin_string_split_projection_impl(
        vm, callee, receiver, separator_value, indices, outputs, output_count, length_out, false);
}

bool mal_builtin_string_split_projection_locked(
    MalVm *vm,
    MalValue receiver,
    MalValue separator_value,
    const u32 *indices,
    MalValue **outputs,
    u32 output_count,
    u32 *length_out
) {
    return mal_builtin_string_split_projection_impl(
        vm, MAL_VALUE_UNDEFINED, receiver, separator_value, indices, outputs, output_count,
        length_out, true);
}

typedef MalU16Buffer StrBuf;

static bool strbuf_append(MalVm *vm, StrBuf *b, const c16 *units, usize n) {
    return mal_u16_buffer_append_units(b, units, n) == MAL_U16_BUFFER_OK ||
        mal_builtin_string_throw_length(vm);
}

// GetSubstitution for a string searchValue (no capture groups, no named groups):
// expands $$, $&, $`, $' in `replacement`; $n and $<name> stay literal (there are
// no captures to reference). matched is the search string; [match_start,match_end)
// is its span in `string`.
static bool mal_builtin_string_append_substitution(
    MalVm *vm, StrBuf *out, MalString *replacement, MalString *matched, MalString *string,
    usize match_start, usize match_end
) {
    const c16 *r = mal_string_code_units(replacement);
    usize rn = mal_string_length(replacement);
    const c16 *su = mal_string_code_units(string);
    usize sn = mal_string_length(string);
    usize i = 0;
    while (i < rn) {
        usize literal_start = i;
        while (i < rn && (r[i] != '$' || i + 1 >= rn)) {
            i++;
        }
        if (i != literal_start &&
            !strbuf_append(vm, out, r + literal_start, i - literal_start)) {
            return false;
        }
        if (i == rn) {
            break;
        }

        c16 c = r[i];
        c16 next = r[i + 1];
        if (next == '$') {
            c16 dollar = '$';
            if (!strbuf_append(vm, out, &dollar, 1)) return false;
            i += 2;
            continue;
        }
        if (next == '&') {
            usize matched_length = mal_string_length(matched);
            const c16 *matched_units = mal_string_code_units(matched);
            if (!strbuf_append(vm, out, matched_units, matched_length)) return false;
            i += 2;
        } else if (next == '`') {
            if (!strbuf_append(vm, out, su, match_start)) return false;
            i += 2;
        } else if (next == '\'') {
            if (match_end < sn) {
                if (!strbuf_append(vm, out, su + match_end, sn - match_end)) return false;
            }
            i += 2;
        } else {
            // $n / $<name> with no captures or named groups: kept literal.
            if (!strbuf_append(vm, out, &c, 1)) return false;
            i++;
        }
    }
    return true;
}

static bool mal_builtin_string_replacement_is_literal(const MalString *replacement) {
    const c16 *units = mal_string_code_units(replacement);
    usize length = mal_string_length(replacement);
    for (usize i = 0; i < length; i++) {
        if (units[i] == '$') return false;
    }
    return true;
}

/** Exact native replacement for the common non-callable, no-$ template case.
 * All observable receiver/search/replacement coercions have already completed. */
static MalValue mal_builtin_string_replace_literal(
    MalVm *vm,
    MalString *string,
    MalString *search,
    MalString *replacement,
    usize first_match,
    bool all
) {
    usize length = mal_string_length(string);
    usize search_length = mal_string_length(search);
    usize replacement_length = mal_string_length(replacement);
    if (mal_string_equals(search, replacement)) {
        return mal_value_from_string(string);
    }

    usize match_count = 1;
    if (all) {
        if (search_length == 0) {
            match_count = length + 1;
        } else {
            usize position = first_match + search_length;
            while (position <= length - search_length) {
                i64 match = mal_builtin_string_find(string, search, position);
                if (match < 0) break;
                match_count++;
                position = (usize) match + search_length;
            }
        }
    }

    usize removed;
    usize added;
    usize result_length;
    usize bytes;
    if (!mal_checked_size_multiply(
            match_count, search_length, length, &removed) ||
        !mal_checked_size_multiply(
            match_count, replacement_length, MAL_STRING_MAX_CODE_UNITS,
            &added) ||
        !mal_checked_size_add(
            length - removed, added, MAL_STRING_MAX_CODE_UNITS,
            &result_length) ||
        !mal_checked_size_multiply(
            sizeof(c16), result_length, SIZE_MAX, &bytes)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    if (result_length == 0) {
        return mal_builtin_string_empty(vm);
    }
    c16 *output = mal_heap_try_alloc_raw_profiled(
        &vm->heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    if (output == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }

    const c16 *source = mal_string_code_units(string);
    const c16 *replacement_units = mal_string_code_units(replacement);
    usize source_position = 0;
    usize offset = 0;
    usize match_position = first_match;
    for (usize match_index = 0; match_index < match_count; match_index++) {
        usize gap = match_position - source_position;
        if (gap != 0) {
            memcpy(output + offset, source + source_position, sizeof(c16) * gap);
            offset += gap;
        }
        if (replacement_length != 0) {
            memcpy(
                output + offset, replacement_units,
                sizeof(c16) * replacement_length);
            offset += replacement_length;
        }
        source_position = match_position + search_length;
        if (search_length == 0 && match_position < length) {
            output[offset++] = source[match_position];
            source_position++;
        }
        if (match_index + 1 < match_count) {
            if (search_length == 0) {
                match_position++;
            } else {
                i64 next = mal_builtin_string_find(
                    string, search, source_position);
                if (next < 0) abort();
                match_position = (usize) next;
            }
        }
    }
    if (source_position < length) {
        usize tail = length - source_position;
        memcpy(output + offset, source + source_position, sizeof(c16) * tail);
        offset += tail;
    }
    assert(offset == result_length);
    return mal_value_from_string(
        mal_string_new_owned(&vm->heap, output, result_length));
}

static MalValue mal_builtin_string_replace_impl(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool all) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue replace_value = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    MalValue roots[4] = {
        mal_value_from_string(string),
        mal_value_new_undefined(),
        replace_value,
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 4);
    StrBuf out = {0};
    MalValue result = mal_value_new_undefined();

    MalString *search = mal_builtin_string_coerce(
        vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    roots[1] = mal_value_from_string(search);

    // A callable replaceValue is invoked with (matched, position, string); else
    // it is ToString'd and used as a $-substitution template.
    bool functional = mal_value_is_callable(roots[2]);
    MalString *replacement = nullptr;
    if (!functional) {
        replacement = mal_builtin_string_coerce(vm, roots[2]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            goto done;
        }
        roots[2] = mal_value_from_string(replacement);
    }

    string = mal_value_to_string(roots[0]);
    search = mal_value_to_string(roots[1]);
    usize length = mal_string_length(string);
    usize search_length = mal_string_length(search);
    const c16 *su = mal_string_code_units(string);

    i64 first_match = -1;
    if (search_length != 0) {
        first_match = mal_builtin_string_find(string, search, 0);
        if (first_match < 0) {
            result = roots[0];
            goto done;
        }
    }

    if (!functional && mal_builtin_string_replacement_is_literal(replacement)) {
        result = mal_builtin_string_replace_literal(
            vm, string, search, replacement,
            first_match < 0 ? 0 : (usize) first_match, all);
        goto done;
    }

    usize seg_start = 0;
    usize position = 0;
    bool first_match_pending = search_length != 0;
    bool replace_once_done = false;
    while (position <= length && !replace_once_done) {
        if (search_length != 0) {
            if (first_match_pending) {
                position = (usize) first_match;
                first_match_pending = false;
            } else {
                i64 match_position = mal_builtin_string_find(string, search, position);
                if (match_position < 0) {
                    break;
                }
                position = (usize) match_position;
            }
        }

        // Gap before the match, then the (substituted or functional) replacement.
        if (!strbuf_append(vm, &out, su + seg_start, position - seg_start)) {
            goto done;
        }
        if (functional) {
            MalValue call_args[3] = {
                roots[1], mal_value_from_f64((f64) position), roots[0]
            };
            MalCompletion completion = mal_vm_call_value(
                vm, roots[2], mal_value_new_undefined(), call_args, 3);
            if (completion.kind == MAL_COMPLETION_THROW) {
                goto done;
            }
            roots[3] = completion.value;
            MalString *rep;
            if (!mal_vm_to_string(vm, roots[3], &rep)) {
                goto done;
            }
            roots[3] = mal_value_from_string(rep);
            // Flattening can allocate. Reacquire the rooted string before reading
            // both the final length and code-unit pointer used by the append.
            (void) mal_string_code_units(rep);
            rep = mal_value_to_string(roots[3]);
            usize rep_length = mal_string_length(rep);
            const c16 *rep_units = mal_string_code_units(rep);
            if (!strbuf_append(vm, &out, rep_units, rep_length)) {
                goto done;
            }
            roots[3] = mal_value_new_undefined();
            string = mal_value_to_string(roots[0]);
            search = mal_value_to_string(roots[1]);
            su = mal_string_code_units(string);
        } else {
            replacement = mal_value_to_string(roots[2]);
            search = mal_value_to_string(roots[1]);
            string = mal_value_to_string(roots[0]);
            if (!mal_builtin_string_append_substitution(
                    vm, &out, replacement, search, string, position, position + search_length)) {
                goto done;
            }
            string = mal_value_to_string(roots[0]);
            search = mal_value_to_string(roots[1]);
            su = mal_string_code_units(string);
        }

        if (search_length == 0) {
            // Empty match: copy the straddled code unit and advance one, or we'd
            // loop forever.
            if (position < length) {
                if (!strbuf_append(vm, &out, su + position, 1)) {
                    goto done;
                }
            }
            position += 1;
        } else {
            position += search_length;
        }
        seg_start = position;
        if (!all) {
            replace_once_done = true;
        }
    }

    // Trailing segment after the last match.
    if (seg_start < length) {
        if (!strbuf_append(vm, &out, su + seg_start, length - seg_start)) {
            goto done;
        }
    }

    result = mal_builtin_string_from_units(
        vm, out.length > 0 ? out.data : su, out.length);

done:
    mal_u16_buffer_dispose(&out);
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue mal_builtin_string_prototype_replace(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "String.prototype.replace called on null or undefined");
        return mal_value_new_undefined();
    }
    // The spec accesses @@replace only "if searchValue is an Object" — never on a
    // string (or other primitive) searchValue.
    MalValue search = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_object(search)) {
        MalValue extra[1] = {arg_count >= 2 ? args[1] : mal_value_new_undefined()};
        MalValue out;
        int dispatched = mal_builtin_string_regex_dispatch(vm, this_value, search, MAL_INTRINSIC_SYMBOL_REPLACE, extra, 1, &out);
        if (dispatched != 0) {
            return out;
        }
    }
    return mal_builtin_string_replace_impl(vm, this_value, args, arg_count, false);
}

static MalValue mal_builtin_string_prototype_replace_all(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "String.prototype.replaceAll called on null or undefined");
        return mal_value_new_undefined();
    }
    // The IsRegExp/global check and @@replace dispatch happen only "if searchValue
    // is an Object" — never on a string (or other primitive) searchValue.
    MalValue search = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (mal_value_is_object(search)) {
        // A non-global RegExp searchValue is a TypeError.
        bool is_regexp = mal_builtin_string_is_regexp(vm, search);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
        if (is_regexp) {
            MalValue flags_value;
            if (!mal_vm_get_property(vm, search, mal_intrinsic_string_key(vm, "flags"), &flags_value)) {
                return mal_value_new_undefined();
            }
            if (mal_value_is_nil(flags_value)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "RegExp flags is null or undefined");
                return mal_value_new_undefined();
            }
            bool has_global;
            if (!mal_builtin_string_flags_have_global(
                    vm, flags_value, &has_global)) {
                return mal_value_new_undefined();
            }
            if (!has_global) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "replaceAll must be called with a global RegExp");
                return mal_value_new_undefined();
            }
        }
        MalValue extra[1] = {arg_count >= 2 ? args[1] : mal_value_new_undefined()};
        MalValue out;
        int dispatched = mal_builtin_string_regex_dispatch(vm, this_value, search, MAL_INTRINSIC_SYMBOL_REPLACE, extra, 1, &out);
        if (dispatched != 0) {
            return out;
        }
    }
    return mal_builtin_string_replace_impl(vm, this_value, args, arg_count, true);
}

static MalValue mal_builtin_string_pad_impl(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool pad_start) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue roots[2] = {
        mal_value_from_string(string),
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);
    MalValue result = mal_value_new_undefined();
    usize length = mal_string_length(string);
    f64 raw_target = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    raw_target = mal_ops_number_to_length(raw_target);
    if (raw_target <= (f64) length) {
        result = roots[0];
        goto done;
    }
    if (raw_target > (f64) MAL_STRING_MAX_CODE_UNITS) {
        mal_builtin_string_throw_length(vm);
        goto done;
    }

    MalString *pad = arg_count >= 2 && !mal_value_is_undefined(args[1])
        ? mal_builtin_string_coerce(vm, args[1])
        : mal_intrinsic_ascii(vm, " ");
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        goto done;
    }
    roots[1] = mal_value_from_string(pad);
    usize pad_length = mal_string_length(pad);
    if (pad_length == 0) {
        result = roots[0];
        goto done;
    }

    usize target = (usize) raw_target;
    if (length == 0 && target == pad_length) {
        result = roots[1];
        goto done;
    }
    usize bytes;
    if (!mal_checked_size_multiply(sizeof(c16), target, SIZE_MAX, &bytes)) {
        mal_builtin_string_throw_length(vm);
        goto done;
    }
    c16 *code_units = mal_heap_alloc_raw_profiled(
        &vm->heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    string = mal_value_to_string(roots[0]);
    pad = mal_value_to_string(roots[1]);
    usize fill_length = target - length;
    usize fill_offset = pad_start ? 0 : length;

    if (!pad_start) {
        memcpy(code_units, mal_string_code_units(string), (usize) sizeof(c16) * length);
    }
    c16 *fill = code_units + fill_offset;
    usize filled = pad_length < fill_length ? pad_length : fill_length;
    memcpy(fill, mal_string_code_units(pad), sizeof(c16) * filled);
    while (filled < fill_length) {
        usize remaining = fill_length - filled;
        usize copy_length = filled < remaining ? filled : remaining;
        memcpy(fill + filled, fill, sizeof(c16) * copy_length);
        filled += copy_length;
    }
    if (pad_start) {
        memcpy(code_units + fill_length, mal_string_code_units(string), (usize) sizeof(c16) * length);
    }

    result = mal_value_from_string(
        mal_string_new_owned(&vm->heap, code_units, target));

done:
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue mal_builtin_string_prototype_pad_start(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_string_pad_impl(vm, this_value, args, arg_count, true);
}

static MalValue mal_builtin_string_prototype_pad_end(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_string_pad_impl(vm, this_value, args, arg_count, false);
}

/**
 * String.prototype.{toString,valueOf}: spec thisStringValue. A String primitive
 * or String wrapper unwraps to its [[StringData]]; any other receiver is a
 * TypeError (unlike the other prototype methods, these do not ToString a
 * foreign receiver).
 */
static MalValue mal_builtin_string_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    if (mal_value_is_string(this_value)) {
        return this_value;
    }
    MalValue primitive;
    if (!mal_value_this_string_value(this_value, &primitive)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "String.prototype.toString called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return primitive;
}

static MalValue mal_builtin_string_prototype_iterator(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;

    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot iterate null or undefined");
        return mal_value_new_undefined();
    }

    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue string_value = mal_value_from_string(string);
    MalRootSpan root_span;
    mal_gc_root(&root_span, &string_value, 1);
    MalValue iterator = mal_vm_new_builtin_iterator(
        vm, MAL_ITERATOR_STRING_VALUES, string_value);
    mal_gc_unroot(&root_span);
    return iterator;
}

static bool mal_builtin_string_split_cursor_init_impl(
    MalVm *vm,
    MalValue callee,
    MalValue receiver,
    MalValue separator,
    MalValue *subject_out,
    MalValue *separator_out,
    MalStringSplitCursor *cursor_out,
    bool identity_locked
) {
    *subject_out = MAL_VALUE_UNDEFINED;
    *separator_out = MAL_VALUE_UNDEFINED;
    cursor_out->position = 0;
    cursor_out->done = false;
    if (!mal_value_is_string(receiver) || !mal_value_is_string(separator) ||
        (!identity_locked &&
         (!mal_value_is_native_function_object(callee) ||
          mal_native_function_object_callback(
              mal_value_to_native_function_object(callee)) !=
              mal_builtin_string_prototype_split)) ||
        mal_string_length(mal_value_to_string(separator)) == 0) {
        return false;
    }
#if MAL_REALMS
    if (!identity_locked && mal_vm_callee_realm(vm, callee) != vm->current_realm) return false;
#else
    (void) vm;
#endif
    *subject_out = receiver;
    *separator_out = separator;
    return true;
}

bool mal_builtin_string_split_cursor_init(
    MalVm *vm,
    MalValue callee,
    MalValue receiver,
    MalValue separator,
    MalValue *subject_out,
    MalValue *separator_out,
    MalStringSplitCursor *cursor_out
) {
    return mal_builtin_string_split_cursor_init_impl(
        vm, callee, receiver, separator, subject_out, separator_out, cursor_out, false);
}

bool mal_builtin_string_split_cursor_init_locked(
    MalVm *vm,
    MalValue receiver,
    MalValue separator,
    MalValue *subject_out,
    MalValue *separator_out,
    MalStringSplitCursor *cursor_out
) {
    return mal_builtin_string_split_cursor_init_impl(
        vm, MAL_VALUE_UNDEFINED, receiver, separator, subject_out, separator_out, cursor_out,
        true);
}

bool mal_builtin_string_split_cursor_next(
    MalValue subject_value,
    MalValue separator_value,
    MalStringSplitCursor *cursor,
    usize *start_out,
    usize *end_out
) {
    if (cursor->done || !mal_value_is_string(subject_value) ||
        !mal_value_is_string(separator_value)) {
        return false;
    }
    MalString *subject = mal_value_to_string(subject_value);
    MalString *separator = mal_value_to_string(separator_value);
    usize length = mal_string_length(subject);
    usize separator_length = mal_string_length(separator);
    if (separator_length == 0 || cursor->position > length) return false;

    usize start = cursor->position;
    i64 match = mal_builtin_string_find(subject, separator, start);
    *start_out = start;
    if (match < 0) {
        *end_out = length;
        cursor->done = true;
    } else {
        *end_out = (usize) match;
        cursor->position = (usize) match + separator_length;
    }
    return true;
}

MalValue mal_builtin_string_split_cursor_materialize(
    MalVm *vm, MalValue subject_value, usize start, usize end
) {
    if (!mal_value_is_string(subject_value)) return MAL_VALUE_UNDEFINED;
    MalString *subject = mal_value_to_string(subject_value);
    usize length = mal_string_length(subject);
    if (start > end || end > length) return MAL_VALUE_UNDEFINED;
    return mal_builtin_string_slice(vm, subject, start, end - start);
}

bool mal_builtin_string_trim_identity(MalVm *vm, MalValue callee) {
    if (!mal_value_is_native_function_object(callee) ||
        mal_native_function_object_callback(
            mal_value_to_native_function_object(callee)) !=
            mal_builtin_string_prototype_trim) {
        return false;
    }
#if MAL_REALMS
    return mal_vm_callee_realm(vm, callee) == vm->current_realm;
#else
    (void) vm;
    return true;
#endif
}

static bool mal_builtin_string_trim_span_direct_impl(
    MalVm *vm,
    MalValue callee,
    MalValue subject_value,
    usize start,
    usize end,
    MalValue *out,
    bool identity_locked
) {
    if (!mal_value_is_string(subject_value) ||
        (!identity_locked && !mal_builtin_string_trim_identity(vm, callee))) {
        return false;
    }
    MalString *subject = mal_value_to_string(subject_value);
    usize length = mal_string_length(subject);
    if (start > end || end > length) return false;
    const c16 *units = mal_string_code_units(subject);
    while (start < end && mal_ecma_is_string_whitespace(units[start])) start++;
    while (end > start && mal_ecma_is_string_whitespace(units[end - 1])) end--;
    *out = mal_builtin_string_slice(vm, subject, start, end - start);
    return true;
}

bool mal_builtin_string_trim_span_direct(
    MalVm *vm,
    MalValue callee,
    MalValue subject_value,
    usize start,
    usize end,
    MalValue *out
) {
    return mal_builtin_string_trim_span_direct_impl(
        vm, callee, subject_value, start, end, out, false);
}

bool mal_builtin_string_trim_span_direct_locked(
    MalVm *vm,
    MalValue subject_value,
    usize start,
    usize end,
    MalValue *out
) {
    return mal_builtin_string_trim_span_direct_impl(
        vm, MAL_VALUE_UNDEFINED, subject_value, start, end, out, true);
}

bool mal_builtin_string_trim_span_direct_licensed(
    MalVm *vm,
    MalValue subject_value,
    usize start,
    usize end,
    MalValue *out
) {
    return mal_builtin_string_trim_span_direct_impl(
        vm, MAL_VALUE_UNDEFINED, subject_value, start, end, out, true);
}

void mal_builtin_string_install(MalVm *vm) {
    // %String.prototype% is itself a String object with [[StringData]] = "", so
    // String.prototype.valueOf()/toString() work on the prototype and its
    // exotic `length` own property reads as 0.
    MalObject *prototype = (MalObject *) mal_primitive_wrapper_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]),
        MAL_PRIMITIVE_WRAPPER_STRING,
        mal_value_from_string(mal_intrinsic_ascii(vm, ""))
    );
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "String"),
        1,
        mal_builtin_string_constructor
    );

    vm->intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_STRING_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_STRING_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "fromCharCode", 1, mal_builtin_string_from_char_code);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "fromCodePoint", 1, mal_builtin_string_from_code_point);
    mal_intrinsic_define_method_n(vm, (MalObject *) constructor, "raw", 1, mal_builtin_string_raw);

    mal_intrinsic_define_method_n(vm, prototype, "charAt", 1, mal_builtin_string_prototype_char_at);
    mal_intrinsic_define_method_n(vm, prototype, "charCodeAt", 1, mal_builtin_string_prototype_char_code_at);
    mal_intrinsic_define_method_n(vm, prototype, "codePointAt", 1, mal_builtin_string_prototype_code_point_at);
    mal_intrinsic_define_method_n(vm, prototype, "at", 1, mal_builtin_string_prototype_at);
    mal_intrinsic_define_method_n(vm, prototype, "indexOf", 1, mal_builtin_string_prototype_index_of);
    mal_intrinsic_define_method_n(vm, prototype, "lastIndexOf", 1, mal_builtin_string_prototype_last_index_of);
    mal_intrinsic_define_method_n(vm, prototype, "includes", 1, mal_builtin_string_prototype_includes);
    mal_intrinsic_define_method_n(vm, prototype, "startsWith", 1, mal_builtin_string_prototype_starts_with);
    mal_intrinsic_define_method_n(vm, prototype, "endsWith", 1, mal_builtin_string_prototype_ends_with);
    mal_intrinsic_define_method_n(vm, prototype, "slice", 2, mal_builtin_string_prototype_slice);
    mal_intrinsic_define_method_n(vm, prototype, "substring", 2, mal_builtin_string_prototype_substring);
    mal_intrinsic_define_method_n(vm, prototype, "substr", 2, mal_builtin_string_prototype_substr);
    mal_intrinsic_define_method_n(vm, prototype, "anchor", 1, mal_builtin_string_prototype_anchor);
    mal_intrinsic_define_method_n(vm, prototype, "big", 0, mal_builtin_string_prototype_big);
    mal_intrinsic_define_method_n(vm, prototype, "blink", 0, mal_builtin_string_prototype_blink);
    mal_intrinsic_define_method_n(vm, prototype, "bold", 0, mal_builtin_string_prototype_bold);
    mal_intrinsic_define_method_n(vm, prototype, "fixed", 0, mal_builtin_string_prototype_fixed);
    mal_intrinsic_define_method_n(vm, prototype, "fontcolor", 1, mal_builtin_string_prototype_fontcolor);
    mal_intrinsic_define_method_n(vm, prototype, "fontsize", 1, mal_builtin_string_prototype_fontsize);
    mal_intrinsic_define_method_n(vm, prototype, "italics", 0, mal_builtin_string_prototype_italics);
    mal_intrinsic_define_method_n(vm, prototype, "link", 1, mal_builtin_string_prototype_link);
    mal_intrinsic_define_method_n(vm, prototype, "small", 0, mal_builtin_string_prototype_small);
    mal_intrinsic_define_method_n(vm, prototype, "strike", 0, mal_builtin_string_prototype_strike);
    mal_intrinsic_define_method_n(vm, prototype, "sub", 0, mal_builtin_string_prototype_sub);
    mal_intrinsic_define_method_n(vm, prototype, "sup", 0, mal_builtin_string_prototype_sup);
    mal_intrinsic_define_method_n(vm, prototype, "concat", 1, mal_builtin_string_prototype_concat);
    mal_intrinsic_define_method_n(vm, prototype, "localeCompare", 1, mal_builtin_string_prototype_locale_compare);
    mal_intrinsic_define_method_n(vm, prototype, "normalize", 0, mal_builtin_string_prototype_normalize);
    mal_intrinsic_define_method_n(vm, prototype, "repeat", 1, mal_builtin_string_prototype_repeat);
    mal_intrinsic_define_method_n(vm, prototype, "trim", 0, mal_builtin_string_prototype_trim);
    MalValue trim_start = mal_intrinsic_define_method_n(
        vm, prototype, "trimStart", 0, mal_builtin_string_prototype_trim_start);
    MalValue trim_end = mal_intrinsic_define_method_n(
        vm, prototype, "trimEnd", 0, mal_builtin_string_prototype_trim_end);
    mal_intrinsic_define_data(
        vm, prototype, "trimLeft", trim_start,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(
        vm, prototype, "trimRight", trim_end,
        MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_method_n(vm, prototype, "toUpperCase", 0, mal_builtin_string_prototype_to_upper_case);
    mal_intrinsic_define_method_n(vm, prototype, "toLowerCase", 0, mal_builtin_string_prototype_to_lower_case);
    // Without ICU the locale-aware case methods behave as the default-locale ones
    // (extra locale arguments are ignored); each gets its own name.
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleUpperCase", 0, mal_builtin_string_prototype_to_upper_case);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleLowerCase", 0, mal_builtin_string_prototype_to_lower_case);
    mal_intrinsic_define_method_n(vm, prototype, "isWellFormed", 0, mal_builtin_string_prototype_is_well_formed);
    mal_intrinsic_define_method_n(vm, prototype, "toWellFormed", 0, mal_builtin_string_prototype_to_well_formed);
    mal_intrinsic_define_method_n(vm, prototype, "match", 1, mal_builtin_string_prototype_match);
    mal_intrinsic_define_method_n(vm, prototype, "matchAll", 1, mal_builtin_string_prototype_match_all);
    mal_intrinsic_define_method_n(vm, prototype, "search", 1, mal_builtin_string_prototype_search);
    mal_intrinsic_define_method_n(vm, prototype, "split", 2, mal_builtin_string_prototype_split);
    mal_intrinsic_define_method_n(vm, prototype, "replace", 2, mal_builtin_string_prototype_replace);
    mal_intrinsic_define_method_n(vm, prototype, "replaceAll", 2, mal_builtin_string_prototype_replace_all);
    mal_intrinsic_define_method_n(vm, prototype, "padStart", 1, mal_builtin_string_prototype_pad_start);
    mal_intrinsic_define_method_n(vm, prototype, "padEnd", 1, mal_builtin_string_prototype_pad_end);
    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, mal_builtin_string_prototype_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0, mal_builtin_string_prototype_to_string);
    mal_intrinsic_define_symbol_method(vm, prototype, MAL_INTRINSIC_SYMBOL_ITERATOR, "[Symbol.iterator]", mal_builtin_string_prototype_iterator);
}

#include "generated/known_native_builtin_string_c.inc"
