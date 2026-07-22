#include "builtin_string.h"

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
    return mal_value_from_string(mal_string_new_copy(&vm->heap, code_units, length));
}

static MalValue mal_builtin_string_empty(MalVm *vm) {
    return mal_value_from_string(mal_intrinsic_ascii(vm, ""));
}

static MalValue mal_builtin_string_slice(MalVm *vm, MalString *string, usize offset, usize length) {
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

/**
 * Find the first occurrence of search at or after from. Returns -1 when not
 * found. An empty search matches immediately.
 */
static i64 mal_builtin_string_find(const MalString *string, const MalString *search, usize from) {
    usize length = mal_string_length(string);
    usize search_length = mal_string_length(search);
    if (search_length > length || from > length - search_length) {
        return -1;
    }

    if (search_length == 1) {
        const c16 *string_units = mal_string_code_units(string);
        c16 search_unit = mal_string_code_units(search)[0];
        for (usize position = from; position < length; position++) {
            if (string_units[position] == search_unit) {
                return (i64) position;
            }
        }
        return -1;
    }

    for (usize position = from; position + search_length <= length; position++) {
        if (mal_builtin_string_matches_at(string, search, position)) {
            return (i64) position;
        }
    }

    return -1;
}

static MalValue mal_builtin_string_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;

    MalString *string;
    if (arg_count == 0) {
        string = mal_intrinsic_ascii(vm, "");
    } else if (mal_value_is_symbol(args[0]) && mal_value_is_undefined(new_target)) {
        // String(symbol) (call, not construct) yields SymbolDescriptiveString.
        MalString *description = mal_symbol_description(mal_value_to_symbol(args[0]));
        MalValue text = mal_value_from_string(mal_intrinsic_ascii(vm, "Symbol("));
        if (description != nullptr) {
            text = mal_builtin_string_add(vm, text, mal_value_from_string(description));
        }
        text = mal_builtin_string_add(vm, text, mal_value_from_string(mal_intrinsic_ascii(vm, ")")));
        return text;
    } else {
        string = mal_builtin_string_coerce(vm, args[0]);
    }

    if (mal_value_is_undefined(new_target)) {
        return mal_value_from_string(string);
    }

    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_STRING_PROTOTYPE, &prototype)) {
        return mal_value_new_undefined();
    }

    return mal_value_from_primitive_wrapper(mal_primitive_wrapper_object_new(
        &vm->heap,
        prototype,
        MAL_PRIMITIVE_WRAPPER_STRING,
        mal_value_from_string(string)
    ));
}

static MalValue mal_builtin_string_from_char_code(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    usize length = (usize) arg_count;
    usize bytes;
    if (length > MAL_STRING_MAX_CODE_UNITS ||
        !mal_checked_size_multiply(sizeof(c16), length, SIZE_MAX, &bytes)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    c16 *code_units = length == 0 ? nullptr : malloc(bytes);
    if (length != 0 && code_units == nullptr) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    for (i32 i = 0; i < arg_count; i++) {
        // VM ToNumber before ToUint16: runs a user valueOf/toString (and unwraps
        // a primitive wrapper), and throws TypeError on a Symbol/BigInt.
        f64 code = mal_builtin_string_arg_to_number(vm, args[i]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            free(code_units);
            return mal_value_new_undefined();
        }
        code_units[i] = (c16) mal_ops_number_to_uint_width(code, 16);
    }

    MalValue result = mal_builtin_string_from_units(vm, code_units, length);
    free(code_units);
    return result;
}

static MalValue mal_builtin_string_from_code_point(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    // Each code point expands to at most two code units.
    usize input_count = (usize) arg_count;
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
    c16 *code_units = capacity == 0 ? nullptr : malloc(bytes);
    if (capacity != 0 && code_units == nullptr) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
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
            if (length >= MAL_STRING_MAX_CODE_UNITS) {
                free(code_units);
                mal_builtin_string_throw_length(vm);
                return mal_value_new_undefined();
            }
            code_units[length++] = (c16) code_point;
        } else {
            if (length > MAL_STRING_MAX_CODE_UNITS - 2) {
                free(code_units);
                mal_builtin_string_throw_length(vm);
                return mal_value_new_undefined();
            }
            mal_utf16_emit_pair(code_point, code_units + length);
            length += 2;
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
        if (!mal_vm_get_property(vm, raw, mal_key_index(index), &segment)) {
            return mal_value_new_undefined();
        }

        if (mal_value_is_symbol(segment)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol to a string");
            return mal_value_new_undefined();
        }

        result = mal_builtin_string_add(vm, result, mal_value_from_string(mal_ops_to_string(&vm->heap, segment)));
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }

        if ((f64) index + 1 < length && (i32) index + 1 < arg_count) {
            if (mal_value_is_symbol(args[index + 1])) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol to a string");
                return mal_value_new_undefined();
            }

            result = mal_builtin_string_add(vm, result, mal_value_from_string(mal_ops_to_string(&vm->heap, args[index + 1])));
            if (vm->completion.kind == MAL_COMPLETION_THROW) {
                return mal_value_new_undefined();
            }
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

    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    // ToIntegerOrInfinity(pos): NaN → 0, else truncate (runs a user valueOf).
    f64 position = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    position = mal_ops_number_to_integer_or_infinity(position);
    if (position < 0 || position >= (f64) mal_string_length(string)) {
        return mal_value_new_undefined();
    }

    const c16 *code_units = mal_string_code_units(string);
    usize index = (usize) position;
    u32 code_point;
    mal_utf16_read_scalar(
        code_units, mal_string_length(string), index, &code_point, nullptr);
    return mal_value_from_i32((i32) code_point);
}

static MalValue mal_builtin_string_prototype_char_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    // ToIntegerOrInfinity(pos): NaN → 0, else truncate (a Symbol throws via the
    // VM ToNumber, surfaced at the call boundary).
    f64 position = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    position = mal_ops_number_to_integer_or_infinity(position);
    if (position < 0 || position >= (f64) mal_string_length(string)) {
        return mal_builtin_string_empty(vm);
    }

    return mal_builtin_string_slice(vm, string, (usize) position, 1);
}

static MalValue mal_builtin_string_prototype_char_code_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    // ToIntegerOrInfinity(pos): NaN → 0, else truncate.
    f64 position = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    position = mal_ops_number_to_integer_or_infinity(position);
    if (position < 0 || position >= (f64) mal_string_length(string)) {
        return mal_value_new_nan();
    }

    return mal_value_from_i32(mal_string_code_units(string)[(usize) position]);
}

static MalValue mal_builtin_string_prototype_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    f64 relative = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    relative = mal_ops_number_to_integer_or_infinity(relative);
    if (relative < 0) {
        relative += (f64) mal_string_length(string);
    }
    if (relative < 0 || relative >= (f64) mal_string_length(string)) {
        return mal_value_new_undefined();
    }

    return mal_builtin_string_slice(vm, string, (usize) relative, 1);
}

static MalValue mal_builtin_string_prototype_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    usize from = 0;
    if (arg_count >= 2) {
        f64 position = mal_builtin_string_arg_to_number(vm, args[1]);
        f64 length = (f64) mal_string_length(string);
        position = mal_ops_number_to_length(position);
        from = (usize) (position > length ? length : position);
    }

    return mal_value_from_i32((i32) mal_builtin_string_find(string, search, from));
}

static MalValue mal_builtin_string_prototype_last_index_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
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

// Defined later (near the @@-protocol dispatch); forward-declared so the
// regexp-rejecting methods below can use it.
static bool mal_builtin_string_is_regexp(MalVm *vm, MalValue arg);

// Spec guard shared by includes/startsWith/endsWith: RequireObjectCoercible(this)
// then reject a RegExp first argument with a TypeError (so these can't be misused
// as matchers). Returns true if it set a pending throw.
static bool mal_builtin_string_reject_regexp(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count) {
    if (mal_value_is_nil(this_value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "String.prototype method called on null or undefined");
        return true;
    }
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
    if (mal_builtin_string_reject_regexp(vm, this_value, args, arg_count)) {
        return mal_value_new_undefined();
    }
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    // ToIntegerOrInfinity(position) clamped to [0, len] (no count-from-end).
    usize start = 0;
    if (arg_count >= 2 && !mal_value_is_undefined(args[1])) {
        f64 pos = mal_builtin_string_arg_to_number(vm, args[1]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
        u32 length = mal_string_length(string);
        pos = mal_ops_number_to_length(pos);
        start = pos > (f64) length ? length : (usize) pos;
    }
    return mal_value_new_boolean(mal_builtin_string_find(string, search, start) >= 0);
}

static MalValue mal_builtin_string_prototype_starts_with(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (mal_builtin_string_reject_regexp(vm, this_value, args, arg_count)) {
        return mal_value_new_undefined();
    }
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    usize position = 0;
    if (arg_count >= 2) {
        f64 raw = mal_builtin_string_arg_to_number(vm, args[1]);
        f64 length = (f64) mal_string_length(string);
        raw = mal_ops_number_to_length(raw);
        position = (usize) (raw > length ? length : raw);
    }
    return mal_value_new_boolean(mal_builtin_string_matches_at(string, search, position));
}

static MalValue mal_builtin_string_prototype_ends_with(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    if (mal_builtin_string_reject_regexp(vm, this_value, args, arg_count)) {
        return mal_value_new_undefined();
    }
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    usize end = mal_string_length(string);
    if (arg_count >= 2 && !mal_value_is_undefined(args[1])) {
        f64 raw = mal_builtin_string_arg_to_number(vm, args[1]);
        raw = mal_ops_number_to_length(raw);
        end = (usize) (raw > (f64) end ? (f64) end : raw);
    }
    usize search_length = mal_string_length(search);
    if (search_length > end) {
        return mal_value_new_boolean(false);
    }

    return mal_value_new_boolean(mal_builtin_string_matches_at(string, search, end - search_length));
}

static MalValue mal_builtin_string_prototype_slice(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    usize length = mal_string_length(string);
    usize start = arg_count >= 1 ? mal_builtin_string_clamp_relative(vm, args[0], 0, length) : 0;
    usize end = arg_count >= 2 ? mal_builtin_string_clamp_relative(vm, args[1], (f64) length, length) : length;
    if (end <= start) {
        return mal_builtin_string_empty(vm);
    }

    return mal_builtin_string_slice(vm, string, start, end - start);
}

static MalValue mal_builtin_string_prototype_substring(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    usize length = mal_string_length(string);

    // substring clamps to [0, length] without relative indexing and swaps
    // out-of-order bounds.
    f64 raw_start = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    f64 raw_end = arg_count >= 2 && !mal_value_is_undefined(args[1]) ? mal_builtin_string_arg_to_number(vm, args[1]) : (f64) length;
    raw_start = mal_ops_number_to_length(raw_start);
    raw_end = mal_ops_number_to_length(raw_end);

    usize start = raw_start > (f64) length ? length : (usize) raw_start;
    usize end = raw_end > (f64) length ? length : (usize) raw_end;
    if (start > end) {
        usize swap = start;
        start = end;
        end = swap;
    }

    return mal_builtin_string_slice(vm, string, start, end - start);
}

/**
 * Legacy String.prototype.substr(start, length): start counts back from the end
 * when negative; length is clamped to the remaining code units.
 */
static MalValue mal_builtin_string_prototype_substr(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    usize source_length = mal_string_length(string);

    f64 raw_start = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    raw_start = mal_ops_number_clamp_relative(raw_start, (f64) source_length);

    f64 raw_length = arg_count >= 2 && !mal_value_is_undefined(args[1]) ? mal_builtin_string_arg_to_number(vm, args[1]) : (f64) source_length;
    raw_length = mal_ops_number_to_length(raw_length);

    usize start = (usize) raw_start;
    usize remaining = source_length - start;
    usize count = raw_length > (f64) remaining ? remaining : (usize) raw_length;

    return mal_builtin_string_slice(vm, string, start, count);
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
    return mal_intl_locale_compare(vm, mal_value_from_string(string), that, locales, options);
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
        // ToString(form) precedes the form validation: a Symbol throws TypeError
        // before any RangeError. VM ToString also runs a user toString/valueOf.
        MalString *form;
        if (!mal_vm_to_string(vm, args[0], &form)) {
            return mal_value_new_undefined();
        }
        const c16 *units = mal_string_code_units(form);
        usize length = mal_string_length(form);
        bool valid =
            (length == 3 && units[0] == 'N' && units[1] == 'F' && (units[2] == 'C' || units[2] == 'D')) ||
            (length == 4 && units[0] == 'N' && units[1] == 'F' && units[2] == 'K' && (units[3] == 'C' || units[3] == 'D'));
        if (!valid) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "The normalization form should be one of NFC, NFD, NFKC, NFKD");
            return mal_value_new_undefined();
        }
    }

    return mal_value_from_string(string);
}

static MalValue mal_builtin_string_prototype_concat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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

static MalValue mal_builtin_string_prototype_repeat(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    f64 count = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    count = mal_ops_number_to_integer_or_infinity(count);
    if (count < 0 || isinf(count)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid count value");
        return mal_value_new_undefined();
    }
    usize length = mal_string_length(string);
    // Repeating an empty string (or zero times) is empty regardless of count;
    // short-circuit so a huge count can't spin a multi-billion-iteration loop.
    if (length == 0 || count < 1) {
        return mal_value_from_string(mal_string_new_ascii(&vm->heap, "", 0));
    }
    if (count > (f64) (MAL_STRING_MAX_CODE_UNITS / length)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    usize repeat = (usize) count;
    usize result_length;
    usize bytes;
    if (!mal_checked_size_multiply(length, repeat, MAL_STRING_MAX_CODE_UNITS, &result_length) ||
        !mal_checked_size_multiply(sizeof(c16), result_length, SIZE_MAX, &bytes)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    c16 *code_units = malloc(bytes);
    if (code_units == nullptr) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    for (usize i = 0; i < repeat; i++) {
        memcpy(code_units + i * length, mal_string_code_units(string), (usize) sizeof(c16) * length);
    }

    MalValue result = mal_builtin_string_from_units(vm, code_units, result_length);
    free(code_units);
    return result;
}

static MalValue mal_builtin_string_trim_impl(MalVm *vm, MalValue this_value, bool trim_start, bool trim_end) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    const c16 *code_units = mal_string_code_units(string);
    usize start = 0;
    usize end = mal_string_length(string);

    while (trim_start && start < end && mal_ecma_is_string_whitespace(code_units[start])) {
        start++;
    }
    while (trim_end && end > start && mal_ecma_is_string_whitespace(code_units[end - 1])) {
        end--;
    }

    return mal_builtin_string_slice(vm, string, start, end - start);
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
    usize length = mal_string_length(string);
    const c16 *source = mal_string_code_units(string);
    c16 *code_units = malloc(sizeof(c16) * length);

    for (usize i = 0; i < length; i++) {
        c16 code_unit = source[i];
        code_unit = to_upper ? mal_ascii_to_upper(code_unit) : mal_ascii_to_lower(code_unit);
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
    const c16 *units = mal_string_code_units(string);
    for (usize i = 0; i < length;) {
        usize width;
        if (!mal_utf16_read_scalar(units, length, i, nullptr, &width)) {
            return mal_value_new_boolean(false);
        }
        i += width;
    }
    return mal_value_new_boolean(true);
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
    const c16 *source = mal_string_code_units(string);
    c16 *code_units = malloc(sizeof(c16) * (length == 0 ? 1 : length));
    for (usize i = 0; i < length;) {
        usize width;
        bool valid = mal_utf16_read_scalar(source, length, i, nullptr, &width);
        if (valid) {
            for (usize j = 0; j < width; j++) code_units[i + j] = source[i + j];
        } else {
            code_units[i] = 0xFFFD;
        }
        i += width;
    }
    MalValue result = mal_builtin_string_from_units(vm, code_units, length);
    free(code_units);
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
    MalString *pattern;
    if (mal_value_is_undefined(regexp)) {
        pattern = mal_intrinsic_ascii(vm, "");
    } else if (!mal_vm_to_string(vm, regexp, &pattern)) {
        return mal_value_new_undefined();
    }
    MalValue rx = mal_regexp_create(vm, pattern, mal_intrinsic_ascii(vm, ""));
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue s_value = mal_value_from_string(s);
    if (mal_regexp_try_exact_string_dispatch(
            vm, rx, symbol_slot, s_value, nullptr, 0, &out)) {
        return out;
    }
    MalValue method;
    if (!mal_vm_get_property(vm, rx, mal_intrinsic_symbol_key(vm, symbol_slot), &method)) {
        return mal_value_new_undefined();
    }
    MalCompletion completion = mal_vm_call_value(vm, method, rx, &s_value, 1);
    return completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : completion.value;
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
            MalString *flags_string;
            if (!mal_vm_to_string(vm, flags_value, &flags_string)) {
                return mal_value_new_undefined();
            }
            bool has_global = false;
            for (usize i = 0; i < mal_string_length(flags_string); i++) {
                if (mal_string_code_units(flags_string)[i] == 'g') {
                    has_global = true;
                    break;
                }
            }
            if (!has_global) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "matchAll must be called with a global RegExp");
                return mal_value_new_undefined();
            }
        }
        MalValue out;
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
    MalString *pattern;
    if (mal_value_is_undefined(regexp)) {
        pattern = mal_intrinsic_ascii(vm, "");
    } else if (!mal_vm_to_string(vm, regexp, &pattern)) {
        return mal_value_new_undefined();
    }
    MalValue rx = mal_regexp_create(vm, pattern, mal_intrinsic_ascii(vm, "g"));
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }
    MalValue s_value = mal_value_from_string(s);
    MalValue out;
    if (mal_regexp_try_exact_string_dispatch(
            vm, rx, MAL_INTRINSIC_SYMBOL_MATCH_ALL, s_value, nullptr, 0, &out)) {
        return out;
    }
    MalValue method;
    if (!mal_vm_get_property(vm, rx, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_MATCH_ALL), &method)) {
        return mal_value_new_undefined();
    }
    MalCompletion completion = mal_vm_call_value(vm, method, rx, &s_value, 1);
    return completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : completion.value;
#else
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
        "String.prototype.matchAll requires RegExp, which is disabled (engine.regexp is false)");
    return mal_value_new_undefined();
#endif
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
    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 result_length = 0;

    // lim = ToUint32(limit) (spec step 6, after ToString(this) at step 3). Skip
    // it if ToString(this) already threw so that first completion is preserved
    // (native builtins compute through a pending throw and it is detected at the
    // call boundary). An absent/undefined limit is 2^32-1.
    u32 lim = UINT32_MAX;
    if (vm->completion.kind != MAL_COMPLETION_THROW && arg_count >= 2 && !mal_value_is_undefined(args[1])) {
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

    // Any coercion above (this / limit / separator) may have thrown; return a
    // harmless empty array so the call boundary observes the first pending throw.
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_from_array_object(result);
    }

    // Spec step 8: a zero limit yields the empty array.
    if (lim == 0) {
        return mal_value_from_array_object(result);
    }

    // Spec step 9: an undefined separator yields the whole string.
    if (separator_undefined) {
        mal_array_object_store(result, mal_key_index(0), mal_value_from_string(string));
        return mal_value_from_array_object(result);
    }

    usize length = mal_string_length(string);
    usize separator_length = mal_string_length(separator);

    if (separator_length == 0) {
        // Split into individual code units, stopping at the limit.
        for (usize i = 0; i < length; i++) {
            if (result_length == lim) {
                return mal_value_from_array_object(result);
            }
            mal_array_object_store(
                result,
                mal_key_index(result_length++),
                mal_builtin_string_slice(vm, string, i, 1)
            );
        }
        return mal_value_from_array_object(result);
    }

    usize segment_start = 0;
    usize position = 0;
    while (position + separator_length <= length) {
        i64 match_position = mal_builtin_string_find(string, separator, position);
        if (match_position < 0) {
            break;
        }
        position = (usize) match_position;

        mal_array_object_store(
            result,
            mal_key_index(result_length++),
            mal_builtin_string_slice(vm, string, segment_start, position - segment_start)
        );
        if (result_length == lim) {
            return mal_value_from_array_object(result);
        }
        position += separator_length;
        segment_start = position;
    }

    mal_array_object_store(
        result,
        mal_key_index(result_length),
        mal_builtin_string_slice(vm, string, segment_start, length - segment_start)
    );
    return mal_value_from_array_object(result);
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
        c16 c = r[i];
        if (c != '$' || i + 1 >= rn) {
            if (!strbuf_append(vm, out, &c, 1)) return false;
            i++;
            continue;
        }
        c16 next = r[i + 1];
        if (next == '$') {
            c16 dollar = '$';
            if (!strbuf_append(vm, out, &dollar, 1)) return false;
            i += 2;
        } else if (next == '&') {
            if (!strbuf_append(vm, out, mal_string_code_units(matched), mal_string_length(matched))) return false;
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

static MalValue mal_builtin_string_replace_impl(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool all) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    MalValue replace_value = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        return mal_value_new_undefined();
    }

    // A callable replaceValue is invoked with (matched, position, string); else
    // it is ToString'd and used as a $-substitution template.
    bool functional = mal_value_is_callable(replace_value);
    MalString *replacement = nullptr;
    if (!functional) {
        replacement = mal_builtin_string_coerce(vm, replace_value);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            return mal_value_new_undefined();
        }
    }

    usize length = mal_string_length(string);
    usize search_length = mal_string_length(search);
    const c16 *su = mal_string_code_units(string);

    StrBuf out = {0};
    usize seg_start = 0;
    usize position = 0;
    bool done = false;
    while (position <= length && !done) {
        if (search_length != 0) {
            i64 match_position = mal_builtin_string_find(string, search, position);
            if (match_position < 0) {
                break;
            }
            position = (usize) match_position;
        }

        // Gap before the match, then the (substituted or functional) replacement.
        if (!strbuf_append(vm, &out, su + seg_start, position - seg_start)) {
            mal_u16_buffer_dispose(&out);
            return mal_value_new_undefined();
        }
        if (functional) {
            MalValue call_args[3] = {
                mal_value_from_string(search), mal_value_from_f64((f64) position), mal_value_from_string(string)
            };
            MalCompletion completion = mal_vm_call_value(vm, replace_value, mal_value_new_undefined(), call_args, 3);
            if (completion.kind == MAL_COMPLETION_THROW) {
                mal_u16_buffer_dispose(&out);
                return mal_value_new_undefined();
            }
            MalString *rep;
            if (!mal_vm_to_string(vm, completion.value, &rep)) {
                mal_u16_buffer_dispose(&out);
                return mal_value_new_undefined();
            }
            if (!strbuf_append(vm, &out, mal_string_code_units(rep), mal_string_length(rep))) {
                mal_u16_buffer_dispose(&out);
                return mal_value_new_undefined();
            }
        } else {
            if (!mal_builtin_string_append_substitution(
                    vm, &out, replacement, search, string, position, position + search_length)) {
                mal_u16_buffer_dispose(&out);
                return mal_value_new_undefined();
            }
        }

        if (search_length == 0) {
            // Empty match: copy the straddled code unit and advance one, or we'd
            // loop forever.
            if (position < length) {
                if (!strbuf_append(vm, &out, su + position, 1)) {
                    mal_u16_buffer_dispose(&out);
                    return mal_value_new_undefined();
                }
            }
            position += 1;
        } else {
            position += search_length;
        }
        seg_start = position;
        if (!all) {
            done = true;
        }
    }

    // Trailing segment after the last match.
    if (seg_start < length) {
        if (!strbuf_append(vm, &out, su + seg_start, length - seg_start)) {
            mal_u16_buffer_dispose(&out);
            return mal_value_new_undefined();
        }
    }

    MalValue result = mal_builtin_string_from_units(
        vm, out.length > 0 ? out.data : su, out.length);
    mal_u16_buffer_dispose(&out);
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
            MalString *flags_string;
            if (!mal_vm_to_string(vm, flags_value, &flags_string)) {
                return mal_value_new_undefined();
            }
            bool has_global = false;
            for (usize i = 0; i < mal_string_length(flags_string); i++) {
                if (mal_string_code_units(flags_string)[i] == 'g') {
                    has_global = true;
                    break;
                }
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
    usize length = mal_string_length(string);
    f64 raw_target = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    raw_target = mal_ops_number_to_length(raw_target);
    if (raw_target <= (f64) length) {
        return mal_value_from_string(string);
    }
    if (raw_target > (f64) MAL_STRING_MAX_CODE_UNITS) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }

    MalString *pad = arg_count >= 2 && !mal_value_is_undefined(args[1])
        ? mal_builtin_string_coerce(vm, args[1])
        : mal_intrinsic_ascii(vm, " ");
    usize pad_length = mal_string_length(pad);
    if (pad_length == 0) {
        return mal_value_from_string(string);
    }

    usize target = (usize) raw_target;
    usize bytes;
    if (!mal_checked_size_multiply(sizeof(c16), target, SIZE_MAX, &bytes)) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
    c16 *code_units = malloc(bytes);
    if (code_units == nullptr) {
        mal_builtin_string_throw_length(vm);
        return mal_value_new_undefined();
    }
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

/**
 * String.prototype.{toString,valueOf}: spec thisStringValue. A String primitive
 * or String wrapper unwraps to its [[StringData]]; any other receiver is a
 * TypeError (unlike the other prototype methods, these do not ToString a
 * foreign receiver).
 */
static MalValue mal_builtin_string_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
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

    MalValue string_value = mal_value_from_string(mal_builtin_string_this_to_string(vm, this_value));
    return mal_vm_new_builtin_iterator(vm, MAL_ITERATOR_STRING_VALUES, string_value);
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
    mal_intrinsic_define_method_n(vm, prototype, "concat", 1, mal_builtin_string_prototype_concat);
    mal_intrinsic_define_method_n(vm, prototype, "localeCompare", 1, mal_builtin_string_prototype_locale_compare);
    mal_intrinsic_define_method_n(vm, prototype, "normalize", 0, mal_builtin_string_prototype_normalize);
    mal_intrinsic_define_method_n(vm, prototype, "repeat", 1, mal_builtin_string_prototype_repeat);
    mal_intrinsic_define_method_n(vm, prototype, "trim", 0, mal_builtin_string_prototype_trim);
    mal_intrinsic_define_method_n(vm, prototype, "trimStart", 0, mal_builtin_string_prototype_trim_start);
    mal_intrinsic_define_method_n(vm, prototype, "trimEnd", 0, mal_builtin_string_prototype_trim_end);
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
