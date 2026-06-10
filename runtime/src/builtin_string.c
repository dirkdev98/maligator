#include "builtin_string.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "builtin_iterator.h"
#include "heap_string.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static MalString *mal_builtin_string_coerce(MalVm *vm, MalValue value) {
    return mal_ops_to_string(&vm->heap, value);
}

static MalValue mal_builtin_string_from_units(MalVm *vm, const c16 *code_units, usize length) {
    return mal_value_from_string(mal_string_new_copy(&vm->heap, code_units, length));
}

static MalValue mal_builtin_string_empty(MalVm *vm) {
    return mal_value_from_string(mal_intrinsic_ascii(vm, ""));
}

/**
 * ToIntegerOrInfinity-flavored index handling clamped to [0, length], with
 * negative values counting back from the end.
 */
static usize mal_builtin_string_clamp_relative(MalValue value, f64 fallback, usize length) {
    f64 relative = mal_value_is_undefined(value) ? fallback : mal_ops_to_number(value);
    if (isnan(relative)) {
        relative = 0;
    }
    if (relative < 0) {
        relative += (f64) length;
    }
    if (relative < 0) {
        return 0;
    }
    if (relative > (f64) length) {
        return length;
    }

    return (usize) relative;
}

static bool mal_builtin_string_matches_at(const MalString *string, const MalString *search, usize position) {
    usize search_length = mal_string_length(search);
    if (position + search_length > mal_string_length(string)) {
        return false;
    }

    return memcmp(
        mal_string_code_units(string) + position,
        mal_string_code_units(search),
        (usize) sizeof(c16) * search_length
    ) == 0;
}

/**
 * Find the first occurrence of search at or after from. Returns -1 when not
 * found. An empty search matches immediately.
 */
static i64 mal_builtin_string_find(const MalString *string, const MalString *search, usize from) {
    usize length = mal_string_length(string);
    usize search_length = mal_string_length(search);
    if (search_length > length) {
        return -1;
    }

    for (usize position = from; position + search_length <= length; position++) {
        if (mal_builtin_string_matches_at(string, search, position)) {
            return (i64) position;
        }
    }

    return -1;
}

static bool mal_builtin_string_is_whitespace(c16 code_unit) {
    return (code_unit >= 0x09 && code_unit <= 0x0D) ||
        code_unit == 0x20 ||
        code_unit == 0xA0 ||
        code_unit == 0x2028 ||
        code_unit == 0x2029 ||
        code_unit == 0xFEFF;
}

static MalValue mal_builtin_string_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    if (arg_count == 0) {
        return mal_builtin_string_empty(vm);
    }

    // TODO(strings): no wrapper objects, constructing also returns the primitive.
    return mal_value_from_string(mal_builtin_string_coerce(vm, args[0]));
}

static MalValue mal_builtin_string_from_char_code(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    c16 *code_units = malloc(sizeof(c16) * arg_count);
    for (i32 i = 0; i < arg_count; i++) {
        f64 code = mal_ops_to_number(args[i]);
        code_units[i] = isnan(code) ? 0 : (c16) ((u64) code & 0xFFFF);
    }

    MalValue result = mal_builtin_string_from_units(vm, code_units, (usize) arg_count);
    free(code_units);
    return result;
}

static MalValue mal_builtin_string_from_code_point(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    // Each code point expands to at most two code units.
    c16 *code_units = malloc(sizeof(c16) * (usize) arg_count * 2);
    usize length = 0;
    for (i32 i = 0; i < arg_count; i++) {
        if (mal_value_is_symbol(args[i])) {
            free(code_units);
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol to a number");
            return mal_value_new_undefined();
        }

        f64 raw = mal_ops_to_number(args[i]);
        if (isnan(raw) || raw < 0 || raw > 0x10FFFF || raw != trunc(raw)) {
            free(code_units);
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid code point");
            return mal_value_new_undefined();
        }

        u32 code_point = (u32) raw;
        if (code_point <= 0xFFFF) {
            code_units[length++] = (c16) code_point;
        } else {
            code_point -= 0x10000;
            code_units[length++] = (c16) (0xD800 + (code_point >> 10));
            code_units[length++] = (c16) (0xDC00 + (code_point & 0x3FF));
        }
    }

    MalValue result = mal_builtin_string_from_units(vm, code_units, length);
    free(code_units);
    return result;
}

static MalValue mal_builtin_string_raw(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;

    if (arg_count < 1) {
        return mal_builtin_string_empty(vm);
    }

    // raw.length code-unit segments joined with the substitution values.
    MalValue raw;
    if (!mal_vm_get_property(vm, args[0], mal_intrinsic_string_key(vm, "raw"), &raw)) {
        return mal_value_new_undefined();
    }

    MalValue length_value;
    if (!mal_vm_get_property(vm, raw, mal_intrinsic_string_key(vm, "length"), &length_value)) {
        return mal_value_new_undefined();
    }

    if (mal_value_is_symbol(length_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol to a number");
        return mal_value_new_undefined();
    }

    f64 length = mal_ops_to_number(length_value);
    if (!(length > 0)) {
        return mal_builtin_string_empty(vm);
    }

    MalValue result = mal_builtin_string_empty(vm);
    for (u32 index = 0; index < (u32) length; index++) {
        MalValue segment;
        if (!mal_vm_get_property(vm, raw, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)}, &segment)) {
            return mal_value_new_undefined();
        }

        if (mal_value_is_symbol(segment)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol to a string");
            return mal_value_new_undefined();
        }

        result = mal_ops_add(&vm->heap, result, mal_value_from_string(mal_ops_to_string(&vm->heap, segment)));

        if ((f64) index + 1 < length && (i32) index + 1 < arg_count) {
            if (mal_value_is_symbol(args[index + 1])) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol to a string");
                return mal_value_new_undefined();
            }

            result = mal_ops_add(&vm->heap, result, mal_value_from_string(mal_ops_to_string(&vm->heap, args[index + 1])));
        }
    }

    return result;
}

static MalValue mal_builtin_string_prototype_code_point_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "String.prototype.codePointAt called on null or undefined");
        return mal_value_new_undefined();
    }

    if (mal_value_is_symbol(this_value) || (arg_count >= 1 && mal_value_is_symbol(args[0]))) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol");
        return mal_value_new_undefined();
    }

    MalString *string = mal_builtin_string_coerce(vm, this_value);
    f64 position = arg_count >= 1 ? mal_ops_to_number(args[0]) : 0;
    if (isnan(position) || position < 0 || position >= (f64) mal_string_length(string)) {
        return mal_value_new_undefined();
    }

    const c16 *code_units = mal_string_code_units(string);
    usize index = (usize) position;
    c16 first = code_units[index];
    if (first >= 0xD800 && first <= 0xDBFF && index + 1 < mal_string_length(string)) {
        c16 second = code_units[index + 1];
        if (second >= 0xDC00 && second <= 0xDFFF) {
            return mal_value_from_i32(0x10000 + (((i32) first - 0xD800) << 10) + ((i32) second - 0xDC00));
        }
    }

    return mal_value_from_i32(first);
}

static MalValue mal_builtin_string_prototype_char_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    f64 position = arg_count >= 1 ? mal_ops_to_number(args[0]) : 0;
    if (isnan(position) || position < 0 || position >= (f64) mal_string_length(string)) {
        return mal_builtin_string_empty(vm);
    }

    return mal_builtin_string_from_units(vm, mal_string_code_units(string) + (usize) position, 1);
}

static MalValue mal_builtin_string_prototype_char_code_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    f64 position = arg_count >= 1 ? mal_ops_to_number(args[0]) : 0;
    if (isnan(position) || position < 0 || position >= (f64) mal_string_length(string)) {
        return mal_value_new_nan();
    }

    return mal_value_from_i32(mal_string_code_units(string)[(usize) position]);
}

static MalValue mal_builtin_string_prototype_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    f64 relative = arg_count >= 1 ? mal_ops_to_number(args[0]) : 0;
    if (isnan(relative)) {
        relative = 0;
    }
    if (relative < 0) {
        relative += (f64) mal_string_length(string);
    }
    if (relative < 0 || relative >= (f64) mal_string_length(string)) {
        return mal_value_new_undefined();
    }

    return mal_builtin_string_from_units(vm, mal_string_code_units(string) + (usize) relative, 1);
}

static MalValue mal_builtin_string_prototype_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    usize from = arg_count >= 2 ? mal_builtin_string_clamp_relative(args[1], 0, mal_string_length(string)) : 0;
    // Note: indexOf does not count back from the end on negative indices.
    if (arg_count >= 2 && mal_ops_to_number(args[1]) < 0) {
        from = 0;
    }

    return mal_value_from_i32((i32) mal_builtin_string_find(string, search, from));
}

static MalValue mal_builtin_string_prototype_last_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    usize length = mal_string_length(string);
    usize search_length = mal_string_length(search);
    if (search_length > length) {
        return mal_value_from_i32(-1);
    }

    for (usize position = length - search_length;; position--) {
        if (mal_builtin_string_matches_at(string, search, position)) {
            return mal_value_from_i32((i32) position);
        }

        if (position == 0) {
            break;
        }
    }

    return mal_value_from_i32(-1);
}

static MalValue mal_builtin_string_prototype_includes(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    return mal_value_new_boolean(mal_builtin_string_find(string, search, 0) >= 0);
}

static MalValue mal_builtin_string_prototype_starts_with(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    usize position = arg_count >= 2 ? mal_builtin_string_clamp_relative(args[1], 0, mal_string_length(string)) : 0;
    return mal_value_new_boolean(mal_builtin_string_matches_at(string, search, position));
}

static MalValue mal_builtin_string_prototype_ends_with(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    usize end = arg_count >= 2 && !mal_value_is_undefined(args[1])
        ? mal_builtin_string_clamp_relative(args[1], 0, mal_string_length(string))
        : mal_string_length(string);
    usize search_length = mal_string_length(search);
    if (search_length > end) {
        return mal_value_new_boolean(false);
    }

    return mal_value_new_boolean(mal_builtin_string_matches_at(string, search, end - search_length));
}

static MalValue mal_builtin_string_prototype_slice(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    usize length = mal_string_length(string);
    usize start = arg_count >= 1 ? mal_builtin_string_clamp_relative(args[0], 0, length) : 0;
    usize end = arg_count >= 2 ? mal_builtin_string_clamp_relative(args[1], (f64) length, length) : length;
    if (end <= start) {
        return mal_builtin_string_empty(vm);
    }

    return mal_builtin_string_from_units(vm, mal_string_code_units(string) + start, end - start);
}

static MalValue mal_builtin_string_prototype_substring(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    usize length = mal_string_length(string);

    // substring clamps to [0, length] without relative indexing and swaps
    // out-of-order bounds.
    f64 raw_start = arg_count >= 1 ? mal_ops_to_number(args[0]) : 0;
    f64 raw_end = arg_count >= 2 && !mal_value_is_undefined(args[1]) ? mal_ops_to_number(args[1]) : (f64) length;
    if (isnan(raw_start) || raw_start < 0) {
        raw_start = 0;
    }
    if (isnan(raw_end) || raw_end < 0) {
        raw_end = 0;
    }

    usize start = raw_start > (f64) length ? length : (usize) raw_start;
    usize end = raw_end > (f64) length ? length : (usize) raw_end;
    if (start > end) {
        usize swap = start;
        start = end;
        end = swap;
    }

    return mal_builtin_string_from_units(vm, mal_string_code_units(string) + start, end - start);
}

static MalValue mal_builtin_string_prototype_concat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString **parts = malloc(sizeof(MalString *) * (arg_count + 1));
    parts[0] = mal_builtin_string_coerce(vm, this_value);
    usize total_length = mal_string_length(parts[0]);
    for (i32 i = 0; i < arg_count; i++) {
        parts[i + 1] = mal_builtin_string_coerce(vm, args[i]);
        total_length += mal_string_length(parts[i + 1]);
    }

    c16 *code_units = malloc(sizeof(c16) * total_length);
    usize offset = 0;
    for (i32 i = 0; i <= arg_count; i++) {
        memcpy(code_units + offset, mal_string_code_units(parts[i]), (usize) sizeof(c16) * mal_string_length(parts[i]));
        offset += mal_string_length(parts[i]);
    }

    MalValue result = mal_builtin_string_from_units(vm, code_units, total_length);
    free(code_units);
    free(parts);
    return result;
}

static MalValue mal_builtin_string_prototype_repeat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    f64 count = arg_count >= 1 ? mal_ops_to_number(args[0]) : 0;
    if (count < 0 || isinf(count)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid count value");
        return mal_value_new_undefined();
    }
    if (isnan(count)) {
        count = 0;
    }

    usize repeat = (usize) count;
    usize length = mal_string_length(string);
    // Repeating an empty string (or zero times) is empty regardless of count;
    // short-circuit so a huge count can't spin a multi-billion-iteration loop.
    if (length == 0 || repeat == 0) {
        return mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));
    }
    c16 *code_units = malloc(sizeof(c16) * length * repeat);
    for (usize i = 0; i < repeat; i++) {
        memcpy(code_units + i * length, mal_string_code_units(string), (usize) sizeof(c16) * length);
    }

    MalValue result = mal_builtin_string_from_units(vm, code_units, length * repeat);
    free(code_units);
    return result;
}

static MalValue mal_builtin_string_trim_impl(MalVm *vm, MalValue this_value, bool trim_start, bool trim_end) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    const c16 *code_units = mal_string_code_units(string);
    usize start = 0;
    usize end = mal_string_length(string);

    while (trim_start && start < end && mal_builtin_string_is_whitespace(code_units[start])) {
        start++;
    }
    while (trim_end && end > start && mal_builtin_string_is_whitespace(code_units[end - 1])) {
        end--;
    }

    return mal_builtin_string_from_units(vm, code_units + start, end - start);
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
    // TODO(unicode): ASCII-only case mapping for now.
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    usize length = mal_string_length(string);
    const c16 *source = mal_string_code_units(string);
    c16 *code_units = malloc(sizeof(c16) * length);

    for (usize i = 0; i < length; i++) {
        c16 code_unit = source[i];
        if (to_upper && code_unit >= 'a' && code_unit <= 'z') {
            code_unit = (c16) (code_unit - 'a' + 'A');
        } else if (!to_upper && code_unit >= 'A' && code_unit <= 'Z') {
            code_unit = (c16) (code_unit - 'A' + 'a');
        }
        code_units[i] = code_unit;
    }

    MalValue result = mal_builtin_string_from_units(vm, code_units, length);
    free(code_units);
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

static MalValue mal_builtin_string_prototype_split(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 result_length = 0;

    if (arg_count == 0 || mal_value_is_undefined(args[0])) {
        mal_array_object_store(result, (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)}, mal_value_from_string(string));
        return mal_value_from_array_object(result);
    }

    MalString *separator = mal_builtin_string_coerce(vm, args[0]);
    usize length = mal_string_length(string);
    usize separator_length = mal_string_length(separator);

    if (separator_length == 0) {
        // Split into individual code units.
        for (usize i = 0; i < length; i++) {
            mal_array_object_store(
                result,
                (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)},
                mal_builtin_string_from_units(vm, mal_string_code_units(string) + i, 1)
            );
        }
        return mal_value_from_array_object(result);
    }

    usize segment_start = 0;
    usize position = 0;
    while (position + separator_length <= length) {
        if (!mal_builtin_string_matches_at(string, separator, position)) {
            position++;
            continue;
        }

        mal_array_object_store(
            result,
            (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) result_length++)},
            mal_builtin_string_from_units(vm, mal_string_code_units(string) + segment_start, position - segment_start)
        );
        position += separator_length;
        segment_start = position;
    }

    mal_array_object_store(
        result,
        (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) result_length)},
        mal_builtin_string_from_units(vm, mal_string_code_units(string) + segment_start, length - segment_start)
    );
    return mal_value_from_array_object(result);
}

static MalValue mal_builtin_string_replace_impl(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool all) {
    // TODO(strings): literal replacement only, no $-patterns or regex.
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    MalString *replacement = mal_builtin_string_coerce(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined());

    usize length = mal_string_length(string);
    usize search_length = mal_string_length(search);
    usize replacement_length = mal_string_length(replacement);

    // Worst case bound: replacing an empty search inserts at every boundary.
    usize max_length = search_length == 0
        ? length + (all ? length + 1 : 1) * replacement_length
        : (replacement_length > search_length
               ? (length / search_length + 1) * replacement_length + length
               : length + replacement_length);
    c16 *code_units = malloc(sizeof(c16) * max_length);

    usize offset = 0;
    usize position = 0;
    bool replaced = false;
    while (position < length) {
        bool matches = (all || !replaced) &&
            (search_length == 0 || mal_builtin_string_matches_at(string, search, position));

        if (matches && search_length == 0) {
            memcpy(code_units + offset, mal_string_code_units(replacement), (usize) sizeof(c16) * replacement_length);
            offset += replacement_length;
            replaced = true;
            code_units[offset++] = mal_string_code_units(string)[position++];
            continue;
        }

        if (matches) {
            memcpy(code_units + offset, mal_string_code_units(replacement), (usize) sizeof(c16) * replacement_length);
            offset += replacement_length;
            position += search_length;
            replaced = true;
            continue;
        }

        code_units[offset++] = mal_string_code_units(string)[position++];
    }

    if (search_length == 0 && (all || !replaced)) {
        // The empty search also matches at the very end.
        memcpy(code_units + offset, mal_string_code_units(replacement), (usize) sizeof(c16) * replacement_length);
        offset += replacement_length;
    }

    MalValue result = mal_builtin_string_from_units(vm, code_units, offset);
    free(code_units);
    return result;
}

static MalValue mal_builtin_string_prototype_replace(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_string_replace_impl(vm, this_value, args, arg_count, false);
}

static MalValue mal_builtin_string_prototype_replace_all(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_string_replace_impl(vm, this_value, args, arg_count, true);
}

static MalValue mal_builtin_string_pad_impl(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool pad_start) {
    MalString *string = mal_builtin_string_coerce(vm, this_value);
    usize length = mal_string_length(string);
    f64 raw_target = arg_count >= 1 ? mal_ops_to_number(args[0]) : 0;
    if (isnan(raw_target) || raw_target <= (f64) length) {
        return mal_value_from_string(string);
    }

    MalString *pad = arg_count >= 2 && !mal_value_is_undefined(args[1])
        ? mal_builtin_string_coerce(vm, args[1])
        : mal_intrinsic_ascii(vm, " ");
    usize pad_length = mal_string_length(pad);
    if (pad_length == 0) {
        return mal_value_from_string(string);
    }

    usize target = (usize) raw_target;
    c16 *code_units = malloc(sizeof(c16) * target);
    usize fill_length = target - length;
    usize fill_offset = pad_start ? 0 : length;

    if (!pad_start) {
        memcpy(code_units, mal_string_code_units(string), (usize) sizeof(c16) * length);
    }
    for (usize i = 0; i < fill_length; i++) {
        code_units[fill_offset + i] = mal_string_code_units(pad)[i % pad_length];
    }
    if (pad_start) {
        memcpy(code_units + fill_length, mal_string_code_units(string), (usize) sizeof(c16) * length);
    }

    MalValue result = mal_builtin_string_from_units(vm, code_units, target);
    free(code_units);
    return result;
}

static MalValue mal_builtin_string_prototype_pad_start(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_string_pad_impl(vm, this_value, args, arg_count, true);
}

static MalValue mal_builtin_string_prototype_pad_end(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    return mal_builtin_string_pad_impl(vm, this_value, args, arg_count, false);
}

static MalValue mal_builtin_string_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    return mal_value_from_string(mal_builtin_string_coerce(vm, this_value));
}

static MalValue mal_builtin_string_prototype_iterator(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;

    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot iterate null or undefined");
        return mal_value_new_undefined();
    }

    MalValue string_value = mal_value_is_string(this_value)
        ? this_value
        : mal_value_from_string(mal_builtin_string_coerce(vm, this_value));

    return mal_vm_new_builtin_iterator(vm, MAL_ITERATOR_STRING_VALUES, string_value);
}

void mal_builtin_string_install(MalVm *vm) {
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "String"),
        mal_builtin_string_constructor
    );

    vm->intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_STRING_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_STRING_PROTOTYPE], MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_STRING_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_method(vm, (MalObject *) constructor, "fromCharCode", mal_builtin_string_from_char_code);
    mal_intrinsic_define_method(vm, (MalObject *) constructor, "fromCodePoint", mal_builtin_string_from_code_point);
    mal_intrinsic_define_method(vm, (MalObject *) constructor, "raw", mal_builtin_string_raw);

    mal_intrinsic_define_method(vm, prototype, "charAt", mal_builtin_string_prototype_char_at);
    mal_intrinsic_define_method(vm, prototype, "charCodeAt", mal_builtin_string_prototype_char_code_at);
    mal_intrinsic_define_method(vm, prototype, "codePointAt", mal_builtin_string_prototype_code_point_at);
    mal_intrinsic_define_method(vm, prototype, "at", mal_builtin_string_prototype_at);
    mal_intrinsic_define_method(vm, prototype, "indexOf", mal_builtin_string_prototype_index_of);
    mal_intrinsic_define_method(vm, prototype, "lastIndexOf", mal_builtin_string_prototype_last_index_of);
    mal_intrinsic_define_method(vm, prototype, "includes", mal_builtin_string_prototype_includes);
    mal_intrinsic_define_method(vm, prototype, "startsWith", mal_builtin_string_prototype_starts_with);
    mal_intrinsic_define_method(vm, prototype, "endsWith", mal_builtin_string_prototype_ends_with);
    mal_intrinsic_define_method(vm, prototype, "slice", mal_builtin_string_prototype_slice);
    mal_intrinsic_define_method(vm, prototype, "substring", mal_builtin_string_prototype_substring);
    mal_intrinsic_define_method(vm, prototype, "concat", mal_builtin_string_prototype_concat);
    mal_intrinsic_define_method(vm, prototype, "repeat", mal_builtin_string_prototype_repeat);
    mal_intrinsic_define_method(vm, prototype, "trim", mal_builtin_string_prototype_trim);
    mal_intrinsic_define_method(vm, prototype, "trimStart", mal_builtin_string_prototype_trim_start);
    mal_intrinsic_define_method(vm, prototype, "trimEnd", mal_builtin_string_prototype_trim_end);
    mal_intrinsic_define_method(vm, prototype, "toUpperCase", mal_builtin_string_prototype_to_upper_case);
    mal_intrinsic_define_method(vm, prototype, "toLowerCase", mal_builtin_string_prototype_to_lower_case);
    mal_intrinsic_define_method(vm, prototype, "split", mal_builtin_string_prototype_split);
    mal_intrinsic_define_method(vm, prototype, "replace", mal_builtin_string_prototype_replace);
    mal_intrinsic_define_method(vm, prototype, "replaceAll", mal_builtin_string_prototype_replace_all);
    mal_intrinsic_define_method(vm, prototype, "padStart", mal_builtin_string_prototype_pad_start);
    mal_intrinsic_define_method(vm, prototype, "padEnd", mal_builtin_string_prototype_pad_end);
    mal_intrinsic_define_method(vm, prototype, "toString", mal_builtin_string_prototype_to_string);
    mal_intrinsic_define_method(vm, prototype, "valueOf", mal_builtin_string_prototype_to_string);
    mal_intrinsic_define_symbol_method(vm, prototype, MAL_INTRINSIC_SYMBOL_ITERATOR, "[Symbol.iterator]", mal_builtin_string_prototype_iterator);
}
