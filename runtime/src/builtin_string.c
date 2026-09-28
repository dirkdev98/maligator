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
#include "text_buffer.h"
#include "utf16.h"
#include "unicode.h"
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

static MalString *mal_builtin_string_this_to_string(MalVm *vm, MalValue this_value) {
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "String.prototype method called on null or undefined");
        return mal_intrinsic_ascii(vm, "");
    }
    if (mal_value_is_string(this_value)) {
        return mal_value_to_string(this_value);
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
            mal_intrinsic_code_unit(vm, mal_string_code_unit_at(string, offset))
        );
    }
    return mal_value_from_string(mal_string_new_slice(&vm->heap, string, offset, length));
}

static bool mal_builtin_string_segments_equal(
    const MalStringSegment *left, usize left_offset,
    const MalStringSegment *right, usize right_offset, usize length
) {
    if (left->latin1 == right->latin1) {
        const void *a = left->latin1
            ? (const void *) (left->latin1_units + left_offset)
            : (const void *) (left->utf16_units + left_offset);
        const void *b = right->latin1
            ? (const void *) (right->latin1_units + right_offset)
            : (const void *) (right->utf16_units + right_offset);
        return memcmp(a, b, length * (left->latin1 ? 1 : sizeof(c16))) == 0;
    }
    for (usize i = 0; i < length; i++) {
        if (mal_string_segment_code_unit_at(left, left_offset + i) !=
            mal_string_segment_code_unit_at(right, right_offset + i)) return false;
    }
    return true;
}

static bool mal_builtin_string_matches_at(const MalString *string, const MalString *search, usize position) {
    usize search_length = mal_string_length(search);
    if (position + search_length > mal_string_length(string)) {
        return false;
    }
    if (search_length == 0 || (position == 0 && string == search)) {
        return true;
    }

    MalStringSegment left, right;
    if (mal_string_try_get_segment(string, position, search_length, &left) &&
        mal_string_try_get_segment(search, 0, search_length, &right)) {
        return mal_builtin_string_segments_equal(&left, 0, &right, 0, search_length);
    }
    MalStringIterator haystack, needle;
    mal_string_iterator_init(&haystack, string, position, search_length);
    mal_string_iterator_init(&needle, search, 0, search_length);
    usize left_offset = 0, right_offset = 0, remaining = search_length;
    bool equal = true;
    mal_string_iterator_next(&haystack, &left);
    mal_string_iterator_next(&needle, &right);
    while (remaining != 0) {
        usize count = left.length - left_offset;
        if (count > right.length - right_offset) count = right.length - right_offset;
        equal = mal_builtin_string_segments_equal(
            &left, left_offset, &right, right_offset, count);
        if (!equal) break;
        remaining -= count;
        left_offset += count;
        right_offset += count;
        if (remaining != 0 && left_offset == left.length) {
            mal_string_iterator_next(&haystack, &left);
            left_offset = 0;
        }
        if (remaining != 0 && right_offset == right.length) {
            mal_string_iterator_next(&needle, &right);
            right_offset = 0;
        }
    }
    mal_string_iterator_dispose(&haystack);
    mal_string_iterator_dispose(&needle);
    return equal;
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
static usize mal_builtin_string_find_unit_words(
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

[[gnu::noinline]]
static usize mal_builtin_string_find_unit_bytes(
    const c16 *units, usize from, usize end, c16 unit
) {
    u8 needle[sizeof(c16)];
    memcpy(needle, &unit, sizeof(unit));
    usize lane = needle[0] == 0 ? 1 : 0;
    usize rejected = 0;
    while (from < end) {
        const u8 *bytes = (const u8 *) (units + from);
        const u8 *match = memchr(bytes + lane, needle[lane],
            (end - from) * sizeof(c16) - lane);
        if (match == nullptr) return end;
        usize offset = (usize) (match - bytes);
        usize position = from + offset / sizeof(c16);
        if (offset % sizeof(c16) == lane) {
            MAL_PERF_COUNT(string_unit_scan_scalar_code_units);
            if (units[position] == unit) return position;
        }
        // A hit in the other byte cannot establish a unit match. Bound these
        // false hits so dense byte aliases fall back to the word scanner.
        from = position + 1;
        if (++rejected == 4) break;
    }
    return mal_builtin_string_find_unit_words(units, from, end, unit);
}

static usize mal_builtin_string_find_unit(
    const c16 *units, usize from, usize end, c16 unit
) {
    // Avoid the zero high byte in ASCII UTF-16; memchr can scan long spans with
    // the platform's vector implementation while complete units verify hits.
    if (unit != 0 && end - from >= 64) {
        return mal_builtin_string_find_unit_bytes(units, from, end, unit);
    }
    return mal_builtin_string_find_unit_words(units, from, end, unit);
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
static usize mal_builtin_string_segment_find_unit(
    const MalStringSegment *segment, usize start, c16 unit
) {
    if (!segment->latin1) {
        return mal_builtin_string_find_unit(segment->utf16_units, start, segment->length, unit);
    }
    if (unit > 0xff) return segment->length;
    const u8 *match = memchr(segment->latin1_units + start, (u8) unit, segment->length - start);
    return match == nullptr ? segment->length : (usize) (match - segment->latin1_units);
}

#define MAL_STRING_SEARCH_INLINE_UNITS 32u

typedef struct MalBuiltinStringSearch {
    MalStringIterator iterator;
    MalStringSegment segment;
    c16 *needle;
    u32 *prefix;
    usize length;
    usize local;
    usize position;
    bool reverse;
    c16 inline_needle[MAL_STRING_SEARCH_INLINE_UNITS];
    u32 inline_prefix[MAL_STRING_SEARCH_INLINE_UNITS];
} MalBuiltinStringSearch;

// KMP owns its pattern so a split can allocate results between matches without
// borrowing the needle's representation. The haystack cursor still must not
// cross JS reentry or a UTF-16 bridge that can materialize its leaves.
static void mal_builtin_string_search_cursor_init(
    MalBuiltinStringSearch *cursor, const MalString *string,
    const MalString *search, usize from, bool reverse
) {
    cursor->length = mal_string_length(search);
    assert(cursor->length != 0);
    cursor->needle = cursor->inline_needle;
    cursor->prefix = cursor->inline_prefix;
    if (cursor->length > MAL_STRING_SEARCH_INLINE_UNITS) {
        cursor->prefix = malloc(cursor->length * (sizeof(u32) + sizeof(c16)));
        if (cursor->prefix == nullptr) abort();
        cursor->needle = (c16 *) (cursor->prefix + cursor->length);
    }
    mal_string_copy_range_to((MalString *) search, 0, cursor->length, cursor->needle);
    if (reverse) {
        for (usize i = 0; i < cursor->length / 2; i++) {
            c16 unit = cursor->needle[i];
            cursor->needle[i] = cursor->needle[cursor->length - i - 1];
            cursor->needle[cursor->length - i - 1] = unit;
        }
    }
    cursor->prefix[0] = 0;
    for (usize i = 1, matched = 0; i < cursor->length; i++) {
        while (matched != 0 && cursor->needle[i] != cursor->needle[matched]) {
            MAL_PERF_COUNT(string_search_linear_comparisons);
            matched = cursor->prefix[matched - 1];
        }
        MAL_PERF_COUNT(string_search_linear_comparisons);
        if (cursor->needle[i] == cursor->needle[matched]) matched++;
        cursor->prefix[i] = (u32) matched;
    }
    cursor->reverse = reverse;
    cursor->segment.length = 0;
    cursor->local = 0;
    cursor->position = reverse ? from + cursor->length : from;
    if (reverse) {
        mal_string_iterator_init_reverse(&cursor->iterator, string, 0, cursor->position);
    } else {
        mal_string_iterator_init(&cursor->iterator, string, from, mal_string_length(string) - from);
    }
}

// Matches do not overlap: split/replace resume after the complete previous match.
static i64 mal_builtin_string_search_cursor_next(MalBuiltinStringSearch *cursor) {
    usize matched = 0;
    for (;;) {
        if (cursor->local == cursor->segment.length) {
            if (!mal_string_iterator_next(&cursor->iterator, &cursor->segment)) return -1;
            cursor->local = 0;
        }
        if (matched == 0 && !cursor->reverse) {
            usize next = mal_builtin_string_segment_find_unit(
                &cursor->segment, cursor->local, cursor->needle[0]);
            cursor->position += next - cursor->local;
            cursor->local = next;
            if (next == cursor->segment.length) continue;
        }
        usize index = cursor->reverse
            ? cursor->segment.length - cursor->local - 1 : cursor->local;
        c16 unit = mal_string_segment_code_unit_at(&cursor->segment, index);
        cursor->local++;
        if (cursor->reverse) cursor->position--;
        else cursor->position++;
        while (matched != 0 && unit != cursor->needle[matched]) {
            MAL_PERF_COUNT(string_search_linear_comparisons);
            matched = cursor->prefix[matched - 1];
        }
        MAL_PERF_COUNT(string_search_linear_comparisons);
        if (unit == cursor->needle[matched]) matched++;
        if (matched == cursor->length) {
            return (i64) (cursor->reverse ? cursor->position : cursor->position - cursor->length);
        }
    }
}

static void mal_builtin_string_search_cursor_dispose(MalBuiltinStringSearch *cursor) {
    mal_string_iterator_dispose(&cursor->iterator);
    if (cursor->prefix != cursor->inline_prefix) free(cursor->prefix);
}

typedef struct MalBuiltinStringCopyCursor {
    MalStringIterator iterator;
    MalStringSegment segment;
    usize local;
    usize position;
} MalBuiltinStringCopyCursor;

static void mal_builtin_string_copy_cursor_init(
    MalBuiltinStringCopyCursor *cursor, const MalString *string
) {
    mal_string_iterator_init(&cursor->iterator, string, 0, mal_string_length(string));
    cursor->segment.length = 0;
    cursor->local = 0;
    cursor->position = 0;
}

static void mal_builtin_string_copy_cursor_advance(
    MalBuiltinStringCopyCursor *cursor, usize end, MalTextBuffer *output
) {
    while (cursor->position < end) {
        if (cursor->local == cursor->segment.length) {
            if (!mal_string_iterator_next(&cursor->iterator, &cursor->segment)) abort();
            cursor->local = 0;
        }
        usize count = cursor->segment.length - cursor->local;
        if (count > end - cursor->position) count = end - cursor->position;
        if (output != nullptr) {
            if (cursor->segment.latin1) {
                mal_text_buffer_append_latin1(output, cursor->segment.latin1_units + cursor->local, count);
            } else {
                mal_text_buffer_append_units(output, cursor->segment.utf16_units + cursor->local, count);
            }
        }
        cursor->local += count;
        cursor->position += count;
    }
}

static i64 mal_builtin_string_find(const MalString *string, const MalString *search, usize from) {
    MAL_PERF_COUNT(string_search_calls);
    usize length = mal_string_length(string);
    usize search_length = mal_string_length(search);
    if (search_length > length || from > length - search_length) return -1;
    if (search_length == 0) return (i64) from;
    if (string == search) return 0;

    if (search_length > 1) MAL_PERF_COUNT(string_search_multi_unit_calls);
    if (search_length >= MAL_STRING_SEARCH_INLINE_UNITS) {
        MalBuiltinStringSearch cursor;
        mal_builtin_string_search_cursor_init(&cursor, string, search, from, false);
        i64 result = mal_builtin_string_search_cursor_next(&cursor);
        mal_builtin_string_search_cursor_dispose(&cursor);
        return result;
    }
    MalStringSegment needle;
    bool contiguous_needle = mal_string_try_get_segment(search, 0, search_length, &needle);
    c16 first = contiguous_needle ? mal_string_segment_code_unit_at(&needle, 0)
        : mal_string_code_unit_at((MalString *) search, 0);
    c16 last = contiguous_needle ? mal_string_segment_code_unit_at(&needle, search_length - 1)
        : mal_string_code_unit_at((MalString *) search, search_length - 1);
    usize end = length - search_length + 1;
    MalStringSegment segment;
    bool contiguous = mal_string_try_get_segment(string, from, length - from, &segment);
    MalStringIterator iterator;
    if (!contiguous) mal_string_iterator_init(&iterator, string, from, length - from);
    usize offset = from;
    i64 result = -1;
    while (offset < end && (contiguous || mal_string_iterator_next(&iterator, &segment))) {
        // Keep the complete leaf for match verification, limiting only candidate starts.
        MalStringSegment candidates = segment;
        if (candidates.length > end - offset) candidates.length = end - offset;
        usize local = 0;
        while (local < candidates.length) {
            usize candidate = mal_builtin_string_segment_find_unit(&candidates, local, first);
            MAL_PERF_ADD(string_search_candidates, candidate - local + (candidate != candidates.length));
            MAL_PERF_ADD(string_search_first_unit_rejects, candidate - local);
            if (candidate == candidates.length) break;
            usize position = offset + candidate;
            if (search_length == 1) {
                result = (i64) position;
                goto done;
            }
            bool contained = search_length <= segment.length - candidate;
            c16 actual_last = contained
                ? mal_string_segment_code_unit_at(&segment, candidate + search_length - 1)
                : mal_string_code_unit_at((MalString *) string, position + search_length - 1);
            if (actual_last != last) {
                MAL_PERF_COUNT(string_search_last_unit_rejects);
            } else {
                usize interior_length = search_length - 2;
                bool equal = interior_length == 0;
                if (!equal) {
                    MAL_PERF_COUNT(string_search_memcmp_calls);
                    MAL_PERF_ADD(string_search_memcmp_code_units, interior_length);
                    equal = contained && contiguous_needle
                        ? mal_builtin_string_segments_equal(&segment, candidate + 1, &needle, 1, interior_length)
                        : mal_builtin_string_matches_at(string, search, position);
                }
                if (equal) {
                    result = (i64) position;
                    goto done;
                }
            }
            local = candidate + 1;
        }
        offset += segment.length;
    }
done:
    if (!contiguous) mal_string_iterator_dispose(&iterator);
    return result;
}

static i64 mal_builtin_string_reverse_find(
    const MalString *string, const MalString *search, usize from
) {
    MAL_PERF_COUNT(string_reverse_search_calls);
    usize search_length = mal_string_length(search);
    if (search_length == 0) return (i64) from;
    if (string == search) return 0;
    if (search_length >= MAL_STRING_SEARCH_INLINE_UNITS) {
        MalBuiltinStringSearch cursor;
        mal_builtin_string_search_cursor_init(&cursor, string, search, from, true);
        i64 result = mal_builtin_string_search_cursor_next(&cursor);
        mal_builtin_string_search_cursor_dispose(&cursor);
        return result;
    }
    c16 first = mal_string_code_unit_at((MalString *) search, 0);
    MalStringIterator iterator;
    mal_string_iterator_init_reverse(&iterator, string, 0, from + 1);
    MalStringSegment segment;
    usize offset = from + 1;
    i64 result = -1;
    while (mal_string_iterator_next(&iterator, &segment)) {
        offset -= segment.length;
        usize end = segment.length;
        while (end != 0) {
            usize position = MAL_STRING_UNIT_NOT_FOUND;
            if (!segment.latin1) {
                position = mal_builtin_string_reverse_find_unit(segment.utf16_units, end, first);
            } else if (first <= 0xff) {
                for (usize i = end; i > 0; i--) {
                    if (segment.latin1_units[i - 1] == first) { position = i - 1; break; }
                }
            }
            if (position == MAL_STRING_UNIT_NOT_FOUND) break;
            MAL_PERF_COUNT(string_reverse_search_candidates);
            if (search_length == 1 || mal_builtin_string_matches_at(string, search, offset + position)) {
                result = (i64) (offset + position);
                goto done;
            }
            end = position;
        }
    }
done:
    mal_string_iterator_dispose(&iterator);
    return result;
}

static MalValue mal_builtin_string_search_impl(
    MalString *string, MalString *search, f64 position, MalStringSearchOp operation
) {
    MalValue result;
    usize length = mal_string_length(string);
    usize search_length = mal_string_length(search);
    if (operation == MAL_STRING_SEARCH_LAST_INDEX_OF) {
        if (search_length > length) {
            result = mal_value_from_i32(-1);
            return result;
        }
        usize max_start = length - search_length;
        position = isnan(position) ? INFINITY : mal_ops_number_to_integer_or_infinity(position);
        usize start = position <= 0 ? 0 : position >= (f64) max_start ? max_start : (usize) position;
        result = mal_value_from_i32((i32) mal_builtin_string_reverse_find(string, search, start));
        return result;
    }
    position = mal_ops_number_to_length(position);
    usize start = position >= (f64) length ? length : (usize) position;
    switch (operation) {
        case MAL_STRING_SEARCH_INDEX_OF:
            result = mal_value_from_i32((i32) mal_builtin_string_find(string, search, start));
            break;
        case MAL_STRING_SEARCH_INCLUDES:
            result = mal_value_new_boolean(mal_builtin_string_find(string, search, start) >= 0);
            break;
        case MAL_STRING_SEARCH_STARTS_WITH:
            result = mal_value_new_boolean(mal_builtin_string_matches_at(string, search, start));
            break;
        case MAL_STRING_SEARCH_ENDS_WITH:
            result = mal_value_new_boolean(search_length <= start &&
                mal_builtin_string_matches_at(string, search, start - search_length));
            break;
        default:
            abort();
    }
    return result;
}

bool mal_builtin_string_search_direct(
    MalValue receiver, MalValue needle, f64 position,
    MalStringSearchOp operation, MalValue *result
) {
    if (!mal_value_is_string(receiver) || !mal_value_is_string(needle)) {
        return false;
    }
    *result = mal_builtin_string_search_impl(
        mal_value_to_string(receiver), mal_value_to_string(needle), position, operation);
    return true;
}

MalValue mal_builtin_string_search_strings(
    MalString *string, MalString *search, f64 position, MalStringSearchOp operation
) {
    return mal_builtin_string_search_impl(string, search, position, operation);
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

static bool mal_builtin_string_code_input(
    MalVm *vm, const MalValue *values, const f64 *numbers, i32 index,
    bool code_points, u32 *code_out
) {
    f64 raw = numbers != nullptr ? numbers[index] : mal_builtin_string_arg_to_number(vm, values[index]);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return false;
    if (!code_points) {
        *code_out = mal_ops_number_to_uint_width(raw, 16);
        return true;
    }
    if (isnan(raw) || raw < 0 || raw > 0x10FFFF || raw != trunc(raw)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid code point");
        return false;
    }
    *code_out = (u32) raw;
    return true;
}

static MalValue mal_builtin_string_from_codes(
    MalVm *vm, const MalValue *values, const f64 *numbers, i32 count, bool code_points
) {
    usize input_count = (usize) count;
    if (input_count == 0) return mal_builtin_string_empty(vm);
    if (input_count == 1) {
        u32 code;
        if (!mal_builtin_string_code_input(vm, values, numbers, 0, code_points, &code)) return mal_value_new_undefined();
        if (code <= 0xFFFF) return mal_value_from_string(mal_intrinsic_code_unit(vm, (c16) code));
        c16 pair[2];
        mal_utf16_emit_pair(code, pair);
        return mal_builtin_string_from_units(vm, pair, 2);
    }
    if (input_count > MAL_STRING_MAX_CODE_UNITS) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    usize capacity = code_points
        ? (input_count > MAL_STRING_MAX_CODE_UNITS / 2 ? MAL_STRING_MAX_CODE_UNITS : input_count * 2)
        : input_count;
    usize bytes;
    if (!mal_checked_size_multiply(sizeof(c16), capacity, SIZE_MAX, &bytes)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    c16 inline_code_units[MAL_STRING_INLINE_CODE_UNITS];
    bool inline_buffer = input_count <= MAL_STRING_INLINE_CODE_UNITS;
    c16 *code_units = inline_buffer ? inline_code_units : mal_heap_alloc_raw_profiled(
        &vm->heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    usize length = 0;
    for (i32 i = 0; i < count; i++) {
        u32 code;
        if (!mal_builtin_string_code_input(vm, values, numbers, i, code_points, &code)) {
            if (!inline_buffer) gc_free_raw(&vm->heap, code_units);
            return mal_value_new_undefined();
        }
        usize width = code <= 0xFFFF ? 1 : 2;
        if (length > MAL_STRING_MAX_CODE_UNITS - width) {
            if (!inline_buffer) gc_free_raw(&vm->heap, code_units);
            mal_builtin_string_throw_length(vm);
            return mal_value_new_undefined();
        }
        if (inline_buffer && length + width > MAL_STRING_INLINE_CODE_UNITS) {
            c16 *grown = mal_heap_alloc_raw_profiled(&vm->heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
            memcpy(grown, inline_code_units, sizeof(c16) * length);
            code_units = grown;
            inline_buffer = false;
        }
        if (width == 1) code_units[length++] = (c16) code;
        else {
            mal_utf16_emit_pair(code, code_units + length);
            length += 2;
        }
    }
    if (inline_buffer) return mal_builtin_string_from_units(vm, inline_code_units, length);
    return mal_value_from_string(mal_string_new_owned(&vm->heap, code_units, length));
}

MalValue mal_builtin_string_from_codes_numbers(MalVm *vm, const f64 *numbers, i32 count, bool code_points) {
    return mal_builtin_string_from_codes(vm, nullptr, numbers, count, code_points);
}

static MalValue mal_builtin_string_from_char_code(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_string_from_codes(vm, args, nullptr, arg_count, false);
}

static MalValue mal_builtin_string_from_code_point(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_string_from_codes(vm, args, nullptr, arg_count, true);
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

static MalValue mal_builtin_string_finish_text(MalVm *vm, MalTextBuffer *buffer) {
    if (buffer->status == MAL_TEXT_BUFFER_OK) {
        return mal_value_from_string(mal_text_buffer_finish(&vm->heap, buffer));
    }
    if (buffer->status == MAL_TEXT_BUFFER_LENGTH_OVERFLOW) mal_builtin_string_throw_length(vm);
    else mal_vm_throw_allocation_error(vm);
    mal_text_buffer_dispose(buffer);
    return mal_value_new_undefined();
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

    MalTextBuffer buffer = {.heap = &vm->heap};
    mal_text_buffer_reserve(&buffer, total_length);
    for (usize i = 0; i < parts->count && buffer.status == MAL_TEXT_BUFFER_OK; i++) {
        mal_text_buffer_append_string(&buffer, mal_value_to_string(parts->values[i]));
    }
    return mal_builtin_string_finish_text(vm, &buffer);
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

bool mal_builtin_string_character_direct(
    MalVm *vm, MalValue receiver, f64 position,
    MalStringCharacterOp operation, MalValue *result
) {
    if (!mal_builtin_string_is_flat_value(receiver)) return false;
    *result = mal_builtin_string_character_numeric(
        vm, mal_value_to_string(receiver), position, operation);
    return true;
}

static MalValue mal_builtin_string_prototype_code_point_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    f64 primitive_position;
    MalValue primitive_result;
    if (mal_builtin_string_primitive_number_arg(args, arg_count, 0, 0.0, &primitive_position) &&
        mal_builtin_string_character_direct(vm, this_value, primitive_position,
            MAL_STRING_CHARACTER_CODE_POINT_AT, &primitive_result)) {
        return primitive_result;
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
    MalValue primitive_result;
    if (mal_builtin_string_primitive_number_arg(args, arg_count, 0, 0.0, &primitive_position) &&
        mal_builtin_string_character_direct(vm, this_value, primitive_position,
            MAL_STRING_CHARACTER_CHAR_AT, &primitive_result)) {
        return primitive_result;
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
        mal_string_code_unit_at(string, (usize) position));
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
    f64 primitive_position;
    MalValue primitive_result;
    if (mal_builtin_string_primitive_number_arg(args, arg_count, 0, 0.0, &primitive_position) &&
        mal_builtin_string_character_direct(vm, this_value, primitive_position,
            MAL_STRING_CHARACTER_AT, &primitive_result)) {
        return primitive_result;
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
    f64 primitive_position = 0.0;
    MalValue primitive_result;
    if (arg_count >= 1 && mal_builtin_string_primitive_number_arg(
            args, arg_count, 1, 0.0, &primitive_position) &&
        mal_builtin_string_search_direct(this_value, args[0], primitive_position,
            MAL_STRING_SEARCH_INDEX_OF, &primitive_result)) {
        return primitive_result;
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
    f64 primitive_position = NAN;
    MalValue primitive_result;
    if (arg_count >= 1 && mal_builtin_string_primitive_number_arg(
            args, arg_count, 1, NAN, &primitive_position) &&
        mal_builtin_string_search_direct(this_value, args[0], primitive_position,
            MAL_STRING_SEARCH_LAST_INDEX_OF, &primitive_result)) {
        return primitive_result;
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
    f64 primitive_position = 0.0;
    MalValue primitive_result;
    if (arg_count >= 1 && mal_builtin_string_primitive_number_arg(
            args, arg_count, 1, 0.0, &primitive_position) &&
        mal_builtin_string_search_direct(this_value, args[0], primitive_position,
            MAL_STRING_SEARCH_INCLUDES, &primitive_result)) {
        return primitive_result;
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
    f64 primitive_position = 0.0;
    MalValue primitive_result;
    if (arg_count >= 1 && mal_builtin_string_primitive_number_arg(
            args, arg_count, 1, 0.0, &primitive_position) &&
        mal_builtin_string_search_direct(this_value, args[0], primitive_position,
            MAL_STRING_SEARCH_STARTS_WITH, &primitive_result)) {
        return primitive_result;
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
    f64 primitive_position = INFINITY;
    MalValue primitive_result;
    if (arg_count >= 1 && (arg_count < 2 || mal_value_is_undefined(args[1]) ||
            mal_builtin_string_primitive_number(args[1], &primitive_position)) &&
        mal_builtin_string_search_direct(this_value, args[0], primitive_position,
            MAL_STRING_SEARCH_ENDS_WITH, &primitive_result)) {
        return primitive_result;
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

MalValue mal_builtin_string_range_numeric(
    MalVm *vm, MalString *string, f64 raw_start, f64 raw_end, MalStringRangeOp operation
) {
    usize length = mal_string_length(string);
    usize start;
    usize end;
    if (operation == MAL_STRING_RANGE_SUBSTRING) {
        raw_start = mal_ops_number_to_length(raw_start);
        raw_end = mal_ops_number_to_length(raw_end);
        start = raw_start > (f64) length ? length : (usize) raw_start;
        end = raw_end > (f64) length ? length : (usize) raw_end;
        if (start > end) {
            usize swap = start;
            start = end;
            end = swap;
        }
    } else {
        start = (usize) mal_ops_number_clamp_relative(raw_start, (f64) length);
        if (operation == MAL_STRING_RANGE_SUBSTR) {
            f64 count = mal_ops_number_to_length(raw_end);
            usize remaining = length - start;
            end = start + (count > (f64) remaining ? remaining : (usize) count);
        } else {
            end = (usize) mal_ops_number_clamp_relative(raw_end, (f64) length);
            if (end < start) end = start;
        }
    }
    MalBuiltinRootedString root;
    mal_builtin_string_root_init(&root, string);
    MalValue result = mal_builtin_string_slice(vm, mal_builtin_string_root_get(&root), start, end - start);
    mal_builtin_string_root_dispose(&root);
    return result;
}

static MalValue mal_builtin_string_range(
    MalVm *vm, MalValue receiver, const MalValue *args, i32 count, MalStringRangeOp operation
) {
    MalString *string = mal_builtin_string_this_to_string(vm, receiver);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalBuiltinRootedString root;
    mal_builtin_string_root_init(&root, string);
    MalValue result = mal_value_new_undefined();
    f64 start = count > 0 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0.0;
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    f64 end = count > 1 && !mal_value_is_undefined(args[1])
        ? mal_builtin_string_arg_to_number(vm, args[1]) : INFINITY;
    if (vm->completion.kind == MAL_COMPLETION_THROW) goto done;
    result = mal_builtin_string_range_numeric(vm, mal_builtin_string_root_get(&root), start, end, operation);
done:
    mal_builtin_string_root_dispose(&root);
    return result;
}

static MalValue mal_builtin_string_prototype_slice(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_string_range(vm, this_value, args, arg_count, MAL_STRING_RANGE_SLICE);
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
    return mal_builtin_string_range(vm, this_value, args, arg_count, MAL_STRING_RANGE_SUBSTRING);
}

static MalValue mal_builtin_string_prototype_substr(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_string_range(vm, this_value, args, arg_count, MAL_STRING_RANGE_SUBSTR);
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

MalValue mal_builtin_string_locale_compare_prepared(MalVm *vm, MalValue receiver, MalValue that, const byte *locale, usize locale_length, u8 options) {
    MalValue roots[2] = {receiver, that};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);
    MalString *string = mal_builtin_string_this_to_string(vm, roots[0]);
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined()
        : mal_intl_locale_compare_prepared(vm, mal_value_from_string(string), roots[1], locale, locale_length, options);
    mal_gc_unroot(&root_span);
    return result;
}

static bool mal_builtin_string_ascii_units(const c16 *source, usize length) {
    usize index = 0;
    while (length - index >= 4) {
        u64 word;
        memcpy(&word, source + index, sizeof(word));
        if ((word & 0xff80ff80ff80ff80ULL) != 0) return false;
        index += 4;
    }
    while (index < length) if (source[index++] > 0x7f) return false;
    return true;
}

static MalValue mal_builtin_string_unicode_result(MalVm *vm, MalString *source, MalUnicodeStatus status, c16 *units, usize length, bool case_transform) {
    if (status != MAL_UNICODE_OK) {
        free(units);
        if (status == MAL_UNICODE_LENGTH_OVERFLOW) mal_builtin_string_throw_length(vm);
        else mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    bool unchanged = length == mal_string_length(source) && (length == 0 || memcmp(units, mal_string_code_units(source), length * sizeof(c16)) == 0);
    if (case_transform) {
        if (unchanged) MAL_PERF_COUNT(string_case_reuses);
        else {
            MAL_PERF_COUNT(string_case_changed_allocations);
            MAL_PERF_ADD(string_case_changed_code_units, length);
        }
    }
    MalValue result = unchanged ? mal_value_from_string(source) : mal_builtin_string_from_units(vm, units, length);
    free(units);
    return result;
}

MalValue mal_builtin_string_normalize_known(MalVm *vm, MalString *string, bool compatibility, bool compose) {
    const c16 *source;
    string = mal_builtin_string_flatten_for_scan(string, &source);
    if (mal_builtin_string_ascii_units(source, mal_string_length(string))) return mal_value_from_string(string);
    c16 *output = nullptr;
    usize length = 0;
    MalUnicodeStatus status = mal_unicode_normalize(source, mal_string_length(string), compatibility, compose, &output, &length);
    return mal_builtin_string_unicode_result(vm, string, status, output, length, false);
}

static MalValue mal_builtin_string_prototype_normalize(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalBuiltinRootedString root;
    mal_builtin_string_root_init(&root, string);
    bool compatibility = false, compose = true;
    if (arg_count >= 1 && !mal_value_is_undefined(args[0])) {
        MalString *form;
        if (!mal_vm_to_string(vm, args[0], &form)) {
            mal_builtin_string_root_dispose(&root);
            return mal_value_new_undefined();
        }
        const c16 *units;
        form = mal_builtin_string_flatten_for_scan(form, &units);
        usize length = mal_string_length(form);
        bool valid = (length == 3 && units[0] == 'N' && units[1] == 'F' && (units[2] == 'C' || units[2] == 'D')) ||
            (length == 4 && units[0] == 'N' && units[1] == 'F' && units[2] == 'K' && (units[3] == 'C' || units[3] == 'D'));
        if (!valid) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "The normalization form should be one of NFC, NFD, NFKC, NFKD");
            mal_builtin_string_root_dispose(&root);
            return mal_value_new_undefined();
        }
        compatibility = length == 4;
        compose = units[length - 1] == 'C';
    }
    MalValue result = mal_builtin_string_normalize_known(vm, mal_builtin_string_root_get(&root), compatibility, compose);
    mal_builtin_string_root_dispose(&root);
    return result;
}

bool mal_builtin_string_concat_direct(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue *result) {
    if (!mal_value_is_string(this_value)) return false;
    usize total_length = mal_string_length(mal_value_to_string(this_value));
    MalValue nonempty = this_value;
    usize nonempty_count = total_length != 0;
    for (i32 i = 0; i < arg_count; i++) {
        if (!mal_value_is_string(args[i])) return false;
        usize length = mal_string_length(mal_value_to_string(args[i]));
        if (!mal_checked_size_add(total_length, length, MAL_STRING_MAX_CODE_UNITS, &total_length)) return false;
        if (length != 0) {
            nonempty = args[i];
            nonempty_count++;
        }
    }
    if (nonempty_count <= 1) {
        *result = nonempty;
        return true;
    }
    if (total_length <= MAL_STRING_INLINE_LATIN1_CODE_UNITS) {
        c16 units[MAL_STRING_INLINE_LATIN1_CODE_UNITS];
        MalString *part = mal_value_to_string(this_value);
        usize offset = mal_string_length(part);
        mal_string_copy_range_to(part, 0, offset, units);
        for (i32 i = 0; i < arg_count; i++) {
            part = mal_value_to_string(args[i]);
            usize length = mal_string_length(part);
            mal_string_copy_range_to(part, 0, length, units + offset);
            offset += length;
        }
        *result = mal_builtin_string_from_units(vm, units, total_length);
        return true;
    }
    if (arg_count == 1) {
        MalString *concatenated;
        if (!mal_string_new_cons_checked(&vm->heap, mal_value_to_string(this_value),
                mal_value_to_string(args[0]), &concatenated)) abort();
        *result = mal_value_from_string(concatenated);
        return true;
    }
    MalTextBuffer output = {.heap = &vm->heap};
    mal_text_buffer_hint_capacity(&output, total_length);
    mal_text_buffer_append_string(&output, mal_value_to_string(this_value));
    for (i32 i = 0; i < arg_count; i++) {
        mal_text_buffer_append_string(&output, mal_value_to_string(args[i]));
    }
    *result = mal_builtin_string_finish_text(vm, &output);
    return true;
}

static MalValue mal_builtin_string_prototype_concat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (arg_count == 0) {
        MalString *string = mal_builtin_string_this_to_string(vm, this_value);
        return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : mal_value_from_string(string);
    }
    MalValue primitive_result;
    if (mal_builtin_string_concat_direct(vm, this_value, args, arg_count, &primitive_result)) return primitive_result;

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

    if (arg_count == 1 && mal_builtin_string_concat_direct(vm, parts.roots[0], parts.roots + 1, 1, &result)) {
        goto done;
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

MalValue mal_builtin_string_html_known(
    MalVm *vm, MalString *string, MalValue attribute_value_input,
    const byte *tag, const byte *attribute
) {
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
            vm, attribute_value_input);
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
        MalString *string = mal_builtin_string_this_to_string(vm, this_value);             \
        if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined(); \
        return mal_builtin_string_html_known(vm, string,                                  \
            arg_count > 0 ? args[0] : mal_value_new_undefined(), tag, attribute);            \
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

// Repeat an initialized prefix without expanding its physical encoding. Reacquire
// both addresses after reserve because RAW growth may move the output buffer.
static void mal_builtin_string_repeat_buffer(
    MalTextBuffer *buffer, usize start, usize target
) {
    while (buffer->length < target && buffer->status == MAL_TEXT_BUFFER_OK) {
        usize count = buffer->length - start;
        if (count > target - buffer->length) count = target - buffer->length;
        assert(count != 0);
        if (mal_text_buffer_reserve(buffer, count) != MAL_TEXT_BUFFER_OK) break;
        usize width = buffer->utf16 ? sizeof(c16) : sizeof(u8);
        memcpy((u8 *) buffer->data + buffer->length * width,
            (u8 *) buffer->data + start * width, count * width);
        buffer->length += count;
    }
}

#define MAL_STRING_REPEAT_LAZY_MIN_CODE_UNITS ((usize) 65536)

static MalValue mal_builtin_string_prototype_repeat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalBuiltinRootedString root;
    mal_builtin_string_root_init(&root, string);
    f64 count = arg_count > 0 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined()
        : mal_builtin_string_repeat_numeric(vm, mal_builtin_string_root_get(&root), count);
    mal_builtin_string_root_dispose(&root);
    return result;
}

MalValue mal_builtin_string_repeat_numeric(MalVm *vm, MalString *string, f64 count) {
    MalValue string_root = mal_value_from_string(string);
    MalRootSpan string_span;
    mal_gc_root(&string_span, &string_root, 1);
    MalValue result_value = mal_value_new_undefined();
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
    if (!mal_checked_size_multiply(length, repeat, MAL_STRING_MAX_CODE_UNITS, &result_length)) {
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

    MalTextBuffer output = {.heap = &vm->heap};
    mal_text_buffer_hint_capacity(&output, result_length);
    mal_text_buffer_append_string(&output, mal_value_to_string(string_root));
    mal_builtin_string_repeat_buffer(&output, 0, result_length);
    result_value = mal_builtin_string_finish_text(vm, &output);

done:
    mal_gc_unroot(&string_span);
    return result_value;
}

static usize mal_builtin_string_edge_whitespace(
    const MalString *string, usize offset, usize length, bool reverse
) {
    MalStringIterator iterator;
    if (reverse) mal_string_iterator_init_reverse(&iterator, string, offset, length);
    else mal_string_iterator_init(&iterator, string, offset, length);
    MalStringSegment segment;
    usize count = 0;
    while (mal_string_iterator_next(&iterator, &segment)) {
        usize local = 0;
        while (local < segment.length) {
            usize index = reverse ? segment.length - local - 1 : local;
            if (!mal_ecma_is_string_whitespace(mal_string_segment_code_unit_at(&segment, index))) break;
            local++;
        }
        count += local;
        if (local != segment.length) break;
    }
    mal_string_iterator_dispose(&iterator);
    return count;
}

MalValue mal_builtin_string_trim_known(MalVm *vm, MalString *string, bool trim_start, bool trim_end) {
    usize end = mal_string_length(string);
    usize start = trim_start ? mal_builtin_string_edge_whitespace(string, 0, end, false) : 0;
    if (trim_end) end -= mal_builtin_string_edge_whitespace(string, start, end - start, true);
    if (start == 0 && end == mal_string_length(string)) return mal_value_from_string(string);

    MalBuiltinRootedString string_root;
    mal_builtin_string_root_init(&string_root, string);
    MalValue result = mal_builtin_string_slice(
        vm, mal_builtin_string_root_get(&string_root), start, end - start);
    mal_builtin_string_root_dispose(&string_root);
    return result;
}

static MalValue mal_builtin_string_trim_impl(MalVm *vm, MalValue receiver, bool start, bool end) {
    MalString *string = mal_builtin_string_this_to_string(vm, receiver);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    return mal_builtin_string_trim_known(vm, string, start, end);
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

static bool mal_builtin_string_ascii_case_scan(
    const MalString *string, bool to_upper, bool *changed
) {
    MalStringIterator iterator;
    mal_string_iterator_init(&iterator, string, 0, mal_string_length(string));
    MalStringSegment segment;
    *changed = false;
    bool ascii = true;
    while (mal_string_iterator_next(&iterator, &segment)) {
        c16 aggregate = 0;
        bool mapped_any = false;
        for (usize i = 0; i < segment.length; i++) {
            c16 unit = mal_string_segment_code_unit_at(&segment, i);
            aggregate |= unit;
            c16 mapped = to_upper ? mal_ascii_to_upper(unit) : mal_ascii_to_lower(unit);
            mapped_any |= mapped != unit;
        }
        *changed |= mapped_any;
        if (aggregate > 0x7f) {
            ascii = false;
            break;
        }
    }
    mal_string_iterator_dispose(&iterator);
    return ascii;
}

MalValue mal_builtin_string_case_known(MalVm *vm, MalString *string, bool to_upper, MalUnicodeLocale locale) {
    usize length = mal_string_length(string);
    MAL_PERF_COUNT(string_case_calls);
    MAL_PERF_ADD(string_case_input_code_units, length);
    bool changed;
    if (locale != MAL_UNICODE_LOCALE_ROOT || !mal_builtin_string_ascii_case_scan(string, to_upper, &changed)) {
        const c16 *source;
        string = mal_builtin_string_flatten_for_scan(string, &source);
        c16 *output = nullptr;
        usize output_length = 0;
        MalUnicodeStatus status = mal_unicode_case(source, length, to_upper, locale, &output, &output_length);
        return mal_builtin_string_unicode_result(vm, string, status, output, output_length, true);
    }
    if (!changed) {
        MAL_PERF_COUNT(string_case_reuses);
        return mal_value_from_string(string);
    }

    MAL_PERF_COUNT(string_case_changed_allocations);
    MAL_PERF_ADD(string_case_changed_code_units, length);
    MalBuiltinRootedString root;
    mal_builtin_string_root_init(&root, string);
    u8 inline_units[MAL_STRING_INLINE_LATIN1_CODE_UNITS];
    u8 *units = length <= sizeof(inline_units) ? inline_units
        : mal_heap_alloc_raw_profiled(&vm->heap, length, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    MalStringIterator iterator;
    mal_string_iterator_init(&iterator, mal_builtin_string_root_get(&root), 0, length);
    MalStringSegment segment;
    usize position = 0;
    while (mal_string_iterator_next(&iterator, &segment)) {
        for (usize i = 0; i < segment.length; i++) {
            c16 unit = mal_string_segment_code_unit_at(&segment, i);
            units[position++] = (u8) (to_upper ? mal_ascii_to_upper(unit) : mal_ascii_to_lower(unit));
        }
    }
    mal_string_iterator_dispose(&iterator);
    MalValue result = mal_value_from_string(units == inline_units
        ? mal_string_new_latin1_copy(&vm->heap, units, length)
        : mal_string_new_latin1_owned(&vm->heap, units, length));
    mal_builtin_string_root_dispose(&root);
    return result;
}

static MalValue mal_builtin_string_case_impl(MalVm *vm, MalValue receiver, bool upper, bool localized, MalValue locales) {
    MalString *string = mal_builtin_string_this_to_string(vm, receiver);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalBuiltinRootedString root;
    mal_builtin_string_root_init(&root, string);
    MalUnicodeLocale locale = MAL_UNICODE_LOCALE_ROOT;
    if (localized && !mal_intl_case_locale(vm, locales, &locale)) {
        mal_builtin_string_root_dispose(&root);
        return mal_value_new_undefined();
    }
    MalValue result = mal_builtin_string_case_known(vm, mal_builtin_string_root_get(&root), upper, locale);
    mal_builtin_string_root_dispose(&root);
    return result;
}

static MalValue mal_builtin_string_prototype_to_locale_upper_case(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_string_case_impl(vm, this_value, true, true, arg_count > 0 ? args[0] : MAL_VALUE_UNDEFINED);
}

static MalValue mal_builtin_string_prototype_to_locale_lower_case(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_string_case_impl(vm, this_value, false, true, arg_count > 0 ? args[0] : MAL_VALUE_UNDEFINED);
}

static MalValue mal_builtin_string_prototype_to_upper_case(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_string_case_impl(vm, this_value, true, false, MAL_VALUE_UNDEFINED);
}

static MalValue mal_builtin_string_prototype_to_lower_case(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_builtin_string_case_impl(vm, this_value, false, false, MAL_VALUE_UNDEFINED);
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

static usize mal_builtin_string_find_invalid_utf16(const MalString *string) {
    MalStringIterator iterator;
    usize length = mal_string_length(string);
    mal_string_iterator_init(&iterator, string, 0, length);
    MalStringSegment segment;
    usize position = 0, invalid = length;
    bool pending_lead = false;
    while (mal_string_iterator_next(&iterator, &segment)) {
        if (segment.latin1) {
            if (pending_lead) {
                invalid = position - 1;
                break;
            }
            position += segment.length;
            continue;
        }
        for (usize i = 0; i < segment.length; i++, position++) {
            c16 unit = segment.utf16_units[i];
            if (pending_lead) {
                if (!mal_utf16_is_trail_surrogate(unit)) {
                    invalid = position - 1;
                    goto done;
                }
                pending_lead = false;
            } else if (mal_utf16_is_lead_surrogate(unit)) {
                pending_lead = true;
            } else if (mal_utf16_is_trail_surrogate(unit)) {
                invalid = position;
                goto done;
            }
        }
    }
    if (invalid == length && pending_lead) invalid = length - 1;
done:
    mal_string_iterator_dispose(&iterator);
    return invalid;
}

MalValue mal_builtin_string_is_well_formed_known(MalString *string) {
    return mal_value_new_boolean(
        mal_builtin_string_find_invalid_utf16(string) == mal_string_length(string));
}

MalValue mal_builtin_string_to_well_formed_known(MalVm *vm, MalString *string) {
    usize length = mal_string_length(string);
    usize first_invalid = mal_builtin_string_find_invalid_utf16(string);
    if (first_invalid == length) return mal_value_from_string(string);

    MalBuiltinRootedString root;
    mal_builtin_string_root_init(&root, string);
    c16 *units = mal_heap_alloc_raw_profiled(
        &vm->heap, sizeof(c16) * length, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    mal_string_copy_range_to(mal_builtin_string_root_get(&root), 0, length, units);
    for (usize i = first_invalid; i < length;) {
        usize width;
        if (!mal_utf16_read_scalar(units, length, i, nullptr, &width)) units[i] = 0xfffd;
        i += width;
    }
    MalValue result = mal_value_from_string(mal_string_new_owned(&vm->heap, units, length));
    mal_builtin_string_root_dispose(&root);
    return result;
}

static MalValue mal_builtin_string_prototype_is_well_formed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    return mal_builtin_string_is_well_formed_known(string);
}

static MalValue mal_builtin_string_prototype_to_well_formed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    return mal_builtin_string_to_well_formed_known(vm, string);
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
    *match_count = 0;
    *overflow_match_position = length;

    if (separator_length > length) return true;


    MalBuiltinStringSearch cursor;
    mal_builtin_string_search_cursor_init(&cursor, string, separator, 0, false);
    bool complete = true;
    for (;;) {
        i64 match_position = mal_builtin_string_search_cursor_next(&cursor);
        if (match_position < 0) break;
        if (*match_count == MAL_STRING_SPLIT_MATCH_PLAN_CAPACITY) {
            MAL_PERF_COUNT(string_split_plan_overflows);
            *overflow_match_position = (usize) match_position;
            complete = false;
            break;
        }
        match_offsets[(*match_count)++] = (usize) match_position;
        MAL_PERF_COUNT(string_split_planned_matches);
        if (*match_count == limit) break;
    }
    mal_builtin_string_search_cursor_dispose(&cursor);
    return complete;
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
        MalStringIterator iterator;
        mal_string_iterator_init(&iterator, string, 0, exact_count);
        MalStringSegment units;
        while (mal_string_iterator_next(&iterator, &units)) {
            for (usize i = 0; i < units.length; i++) {
                MalValue unit = mal_value_from_string(mal_intrinsic_code_unit(
                    vm, mal_string_segment_code_unit_at(&units, i)));
                mal_builtin_string_split_append(result, unit);
            }
        }
        mal_string_iterator_dispose(&iterator);
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
    MalBuiltinStringSearch cursor;
    mal_builtin_string_search_cursor_init(
        &cursor, string, separator, position + separator_length, false);
    while (true) {
        MalValue segment =
            mal_builtin_string_slice(vm, string, segment_start, position - segment_start);
        mal_builtin_string_split_append(result, segment);
        result_length++;
        if (result_length == lim) {
            mal_builtin_string_search_cursor_dispose(&cursor);
            goto split_done;
        }
        position += separator_length;
        segment_start = position;
        if (position + separator_length > length) break;
        i64 match_position = mal_builtin_string_search_cursor_next(&cursor);
        if (match_position < 0) break;
        position = (usize) match_position;
    }
    mal_builtin_string_search_cursor_dispose(&cursor);

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
        MalBuiltinStringSearch cursor;
        mal_builtin_string_search_cursor_init(
            &cursor, string, separator, match_position + separator_length, false);
        while (true) {
            if (next_output < output_count && indices[next_output] == total_match_count) {
                roots[2 + next_output] = mal_builtin_string_slice(
                    vm, string, segment_start, match_position - segment_start);
                next_output++;
            }
            total_match_count++;
            segment_start = match_position + separator_length;
            if (segment_start + separator_length > length) break;
            i64 next_match = mal_builtin_string_search_cursor_next(&cursor);
            if (next_match < 0) break;
            match_position = (usize) next_match;
        }
        mal_builtin_string_search_cursor_dispose(&cursor);
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

typedef MalTextBuffer StrBuf;

static bool strbuf_range(
    MalVm *vm, StrBuf *buffer, const MalString *string, usize offset, usize length
) {
    MalTextBufferStatus status = mal_text_buffer_append_range(buffer, string, offset, length);
    if (status == MAL_TEXT_BUFFER_OK) return true;
    if (status == MAL_TEXT_BUFFER_LENGTH_OVERFLOW) return mal_builtin_string_throw_length(vm);
    mal_vm_throw_allocation_error(vm);
    return false;
}

// String searches have no captures, so only $$, $&, $` and $' substitute.
static bool mal_builtin_string_append_substitution(
    MalVm *vm, StrBuf *out, MalString *replacement, MalString *matched, MalString *string,
    usize match_start, usize match_end
) {
    usize length = mal_string_length(replacement);
    usize source_length = mal_string_length(string);
    usize index = 0;
    while (index < length) {
        usize literal_start = index;
        while (index < length && (mal_string_code_unit_at(replacement, index) != '$' || index + 1 == length)) index++;
        if (!strbuf_range(vm, out, replacement, literal_start, index - literal_start)) return false;
        if (index == length) break;
        c16 next = mal_string_code_unit_at(replacement, index + 1);
        if (next == '$') {
            if (!strbuf_range(vm, out, replacement, index, 1)) return false;
            index += 2;
        } else if (next == '&') {
            if (!strbuf_range(vm, out, matched, 0, mal_string_length(matched))) return false;
            index += 2;
        } else if (next == '`') {
            if (!strbuf_range(vm, out, string, 0, match_start)) return false;
            index += 2;
        } else if (next == '\'') {
            if (!strbuf_range(vm, out, string, match_end, source_length - match_end)) return false;
            index += 2;
        } else {
            if (!strbuf_range(vm, out, replacement, index, 1)) return false;
            index++;
        }
    }
    return true;
}

static bool mal_builtin_string_replacement_is_literal(const MalString *replacement) {
    MalStringIterator iterator;
    mal_string_iterator_init(&iterator, replacement, 0, mal_string_length(replacement));
    MalStringSegment segment;
    bool literal = true;
    while (mal_string_iterator_next(&iterator, &segment)) {
        if (mal_builtin_string_segment_find_unit(&segment, 0, '$') != segment.length) {
            literal = false;
            break;
        }
    }
    mal_string_iterator_dispose(&iterator);
    return literal;
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
            MalBuiltinStringSearch cursor;
            mal_builtin_string_search_cursor_init(
                &cursor, string, search, first_match + search_length, false);
            for (;;) {
                i64 match = mal_builtin_string_search_cursor_next(&cursor);
                if (match < 0) break;
                match_count++;
            }
            mal_builtin_string_search_cursor_dispose(&cursor);
        }
    }

    usize removed, added, result_length;
    if (!mal_checked_size_multiply(match_count, search_length, length, &removed) ||
        !mal_checked_size_multiply(match_count, replacement_length, MAL_STRING_MAX_CODE_UNITS, &added) ||
        !mal_checked_size_add(length - removed, added, MAL_STRING_MAX_CODE_UNITS, &result_length)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    if (result_length == 0) return mal_builtin_string_empty(vm);
    MalTextBuffer output = {.heap = &vm->heap};
    mal_text_buffer_hint_capacity(&output, result_length);
    usize source_position = 0;
    usize match_position = first_match;
    MalBuiltinStringCopyCursor source_cursor;
    mal_builtin_string_copy_cursor_init(&source_cursor, string);
    MalBuiltinStringSearch cursor;
    if (search_length != 0 && match_count > 1) {
        mal_builtin_string_search_cursor_init(
            &cursor, string, search, first_match + search_length, false);
    }
    for (usize match_index = 0; match_index < match_count && output.status == MAL_TEXT_BUFFER_OK; match_index++) {
        mal_builtin_string_copy_cursor_advance(&source_cursor, match_position, &output);
        mal_text_buffer_append_string(&output, replacement);
        source_position = match_position + search_length;
        mal_builtin_string_copy_cursor_advance(&source_cursor, source_position, nullptr);
        if (search_length == 0 && match_position < length) {
            source_position++;
            mal_builtin_string_copy_cursor_advance(&source_cursor, source_position, &output);
        }
        if (match_index + 1 < match_count) {
            if (search_length == 0) match_position++;
            else {
                i64 next = mal_builtin_string_search_cursor_next(&cursor);
                if (next < 0) abort();
                match_position = (usize) next;
            }
        }
    }
    if (search_length != 0 && match_count > 1) {
        mal_builtin_string_search_cursor_dispose(&cursor);
    }
    if (source_position < length) {
        mal_builtin_string_copy_cursor_advance(&source_cursor, length, &output);
    }
    mal_string_iterator_dispose(&source_cursor.iterator);
    return mal_builtin_string_finish_text(vm, &output);
}

MalValue mal_builtin_string_replace_known(MalVm *vm, MalString *string, MalString *search, MalValue replace_value, bool all) {
    MalValue roots[4] = {
        mal_value_from_string(string),
        mal_value_from_string(search),
        replace_value,
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 4);
    StrBuf out = {0};
    MalValue result = mal_value_new_undefined();
    MalBuiltinStringSearch match_cursor;
    bool match_cursor_active = false;
    u32 inline_matches[MAL_STRING_SPLIT_MATCH_PLAN_CAPACITY];
    u32 *matches = inline_matches;
    usize match_count = 0, match_capacity = countof(inline_matches);

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

    if (search_length != 0 && all) {
        mal_builtin_string_search_cursor_init(
            &match_cursor, string, search, (usize) first_match + search_length, false);
        match_cursor_active = true;
        if (functional) {
            // The spec collects positions before calling the replacer. Keeping
            // only offsets also allows callbacks to materialize/collect ropes.
            for (;;) {
                i64 match = mal_builtin_string_search_cursor_next(&match_cursor);
                if (match < 0) break;
                if (match_count == match_capacity) {
                    usize capacity = match_capacity * 2;
                    u32 *grown = matches == inline_matches
                        ? malloc(capacity * sizeof(u32))
                        : realloc(matches, capacity * sizeof(u32));
                    if (grown == nullptr) {
                        mal_vm_throw_allocation_error(vm);
                        goto done;
                    }
                    if (matches == inline_matches) memcpy(grown, matches, match_count * sizeof(u32));
                    matches = grown;
                    match_capacity = capacity;
                }
                matches[match_count++] = (u32) match;
            }
            mal_builtin_string_search_cursor_dispose(&match_cursor);
            match_cursor_active = false;
        }
    }

    usize seg_start = 0;
    usize position = 0;
    usize next_match = 0;
    bool first_match_pending = search_length != 0;
    bool replace_once_done = false;
    while (position <= length && !replace_once_done) {
        if (search_length != 0) {
            if (first_match_pending) {
                position = (usize) first_match;
                first_match_pending = false;
            } else {
                i64 match_position = functional
                    ? (next_match < match_count ? (i64) matches[next_match++] : -1)
                    : mal_builtin_string_search_cursor_next(&match_cursor);
                if (match_position < 0) {
                    break;
                }
                position = (usize) match_position;
            }
        }

        if (position > seg_start && !strbuf_range(vm, &out, string, seg_start, position - seg_start)) {
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
            if (!strbuf_range(vm, &out, rep, 0, mal_string_length(rep))) goto done;
            roots[3] = mal_value_new_undefined();
            string = mal_value_to_string(roots[0]);
            search = mal_value_to_string(roots[1]);
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
        }

        if (search_length == 0) {
            // Empty match: copy the straddled code unit and advance one, or we'd
            // loop forever.
            if (position < length) {
                if (!strbuf_range(vm, &out, string, position, 1)) {
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

    if (seg_start < length) {
        if (!strbuf_range(vm, &out, string, seg_start, length - seg_start)) {
            goto done;
        }
    }

    result = mal_builtin_string_finish_text(vm, &out);

done:
    if (match_cursor_active) mal_builtin_string_search_cursor_dispose(&match_cursor);
    if (matches != inline_matches) free(matches);
    mal_text_buffer_dispose(&out);
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue mal_builtin_string_replace_impl(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool all) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalValue roots[2] = {mal_value_from_string(string), arg_count > 1 ? args[1] : mal_value_new_undefined()};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);
    MalString *search = mal_builtin_string_coerce(vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined()
        : mal_builtin_string_replace_known(vm, mal_value_to_string(roots[0]), search, roots[1], all);
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
    if (vm->completion.kind == MAL_COMPLETION_THROW) return mal_value_new_undefined();
    MalBuiltinRootedString root;
    mal_builtin_string_root_init(&root, string);
    f64 target = arg_count > 0 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    MalValue result = vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined()
        : mal_builtin_string_pad_numeric(vm, mal_builtin_string_root_get(&root), target,
            arg_count > 1 ? args[1] : mal_value_new_undefined(), pad_start);
    mal_builtin_string_root_dispose(&root);
    return result;
}

MalValue mal_builtin_string_pad_numeric(MalVm *vm, MalString *string, f64 raw_target, MalValue filler, bool pad_start) {
    MalValue roots[2] = {mal_value_from_string(string), mal_value_new_undefined()};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);
    MalValue result = mal_value_new_undefined();
    usize length = mal_string_length(string);
    raw_target = mal_ops_number_to_length(raw_target);
    if (raw_target <= (f64) length) {
        result = roots[0];
        goto done;
    }

    MalString *pad = !mal_value_is_undefined(filler)
        ? mal_builtin_string_coerce(vm, filler)
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

    if (raw_target > (f64) MAL_STRING_MAX_CODE_UNITS) {
        mal_builtin_string_throw_length(vm);
        goto done;
    }

    usize target = (usize) raw_target;
    if (length == 0 && target == pad_length) {
        result = roots[1];
        goto done;
    }
    usize fill_length = target - length;
    MalTextBuffer output = {.heap = &vm->heap};
    mal_text_buffer_hint_capacity(&output, target);
    string = mal_value_to_string(roots[0]);
    pad = mal_value_to_string(roots[1]);
    if (!pad_start) mal_text_buffer_append_string(&output, string);
    usize fill_start = output.length;
    mal_text_buffer_append_range(&output, pad, 0, pad_length < fill_length ? pad_length : fill_length);
    mal_builtin_string_repeat_buffer(&output, fill_start, fill_start + fill_length);
    if (pad_start) mal_text_buffer_append_string(&output, string);
    result = mal_builtin_string_finish_text(vm, &output);

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
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleUpperCase", 0, mal_builtin_string_prototype_to_locale_upper_case);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleLowerCase", 0, mal_builtin_string_prototype_to_locale_lower_case);
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
