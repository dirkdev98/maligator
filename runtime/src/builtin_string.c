#include "builtin_string.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "builtin_iterator.h"
#include "heap_string.h"
#include "heap_symbol.h"
#include "primitive_wrapper_object.h"
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
static usize mal_builtin_string_clamp_relative(MalVm *vm, MalValue value, f64 fallback, usize length) {
    f64 relative = mal_value_is_undefined(value) ? fallback : mal_builtin_string_arg_to_number(vm, value);
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

/**
 * Resolve the prototype for a construct call (OrdinaryCreateFromConstructor
 * flavored): new_target's prototype property when it is an object, the given
 * intrinsic slot otherwise.
 */
static MalObject *mal_builtin_string_resolve_prototype(MalVm *vm, MalValue new_target, MalIntrinsic fallback) {
    MalValue prototype;
    if (!mal_vm_get_property(vm, new_target, mal_intrinsic_string_key(vm, "prototype"), &prototype)) {
        return nullptr;
    }
    if (mal_value_is_object(prototype)) {
        return mal_value_to_object(prototype);
    }
    return mal_value_to_object(vm->intrinsics[fallback]);
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
            text = mal_ops_add(&vm->heap, text, mal_value_from_string(description));
        }
        text = mal_ops_add(&vm->heap, text, mal_value_from_string(mal_intrinsic_ascii(vm, ")")));
        return text;
    } else {
        string = mal_builtin_string_coerce(vm, args[0]);
    }

    if (mal_value_is_undefined(new_target)) {
        return mal_value_from_string(string);
    }

    MalObject *prototype = mal_builtin_string_resolve_prototype(vm, new_target, MAL_INTRINSIC_STRING_PROTOTYPE);
    if (prototype == nullptr) {
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
    c16 *code_units = malloc(sizeof(c16) * arg_count);
    for (i32 i = 0; i < arg_count; i++) {
        // VM ToNumber before ToUint16: runs a user valueOf/toString (and unwraps
        // a primitive wrapper), and throws TypeError on a Symbol/BigInt.
        f64 code = mal_builtin_string_arg_to_number(vm, args[i]);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            free(code_units);
            return mal_value_new_undefined();
        }
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

    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    // ToIntegerOrInfinity(pos): NaN → 0, else truncate (runs a user valueOf).
    f64 position = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    position = isnan(position) ? 0 : trunc(position);
    if (position < 0 || position >= (f64) mal_string_length(string)) {
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
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    // ToIntegerOrInfinity(pos): NaN → 0, else truncate (a Symbol throws via the
    // VM ToNumber, surfaced at the call boundary).
    f64 position = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    position = isnan(position) ? 0 : trunc(position);
    if (position < 0 || position >= (f64) mal_string_length(string)) {
        return mal_builtin_string_empty(vm);
    }

    return mal_builtin_string_from_units(vm, mal_string_code_units(string) + (usize) position, 1);
}

static MalValue mal_builtin_string_prototype_char_code_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    // ToIntegerOrInfinity(pos): NaN → 0, else truncate.
    f64 position = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    position = isnan(position) ? 0 : trunc(position);
    if (position < 0 || position >= (f64) mal_string_length(string)) {
        return mal_value_new_nan();
    }

    return mal_value_from_i32(mal_string_code_units(string)[(usize) position]);
}

static MalValue mal_builtin_string_prototype_at(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    f64 relative = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
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
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    usize from = arg_count >= 2 ? mal_builtin_string_clamp_relative(vm, args[1], 0, mal_string_length(string)) : 0;
    // Note: indexOf does not count back from the end on negative indices.
    if (arg_count >= 2 && mal_ops_to_number(args[1]) < 0) {
        from = 0;
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

static MalValue mal_builtin_string_prototype_includes(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
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
        pos = isnan(pos) ? 0 : trunc(pos);
        start = pos < 0 ? 0 : (pos > (f64) length ? length : (usize) pos);
    }
    return mal_value_new_boolean(mal_builtin_string_find(string, search, start) >= 0);
}

static MalValue mal_builtin_string_prototype_starts_with(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    usize position = arg_count >= 2 ? mal_builtin_string_clamp_relative(vm, args[1], 0, mal_string_length(string)) : 0;
    return mal_value_new_boolean(mal_builtin_string_matches_at(string, search, position));
}

static MalValue mal_builtin_string_prototype_ends_with(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    MalString *search = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    usize end = arg_count >= 2 && !mal_value_is_undefined(args[1])
        ? mal_builtin_string_clamp_relative(vm, args[1], 0, mal_string_length(string))
        : mal_string_length(string);
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

    return mal_builtin_string_from_units(vm, mal_string_code_units(string) + start, end - start);
}

static MalValue mal_builtin_string_prototype_substring(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    usize length = mal_string_length(string);

    // substring clamps to [0, length] without relative indexing and swaps
    // out-of-order bounds.
    f64 raw_start = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    f64 raw_end = arg_count >= 2 && !mal_value_is_undefined(args[1]) ? mal_builtin_string_arg_to_number(vm, args[1]) : (f64) length;
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

/**
 * Legacy String.prototype.substr(start, length): start counts back from the end
 * when negative; length is clamped to the remaining code units.
 */
static MalValue mal_builtin_string_prototype_substr(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    usize source_length = mal_string_length(string);

    f64 raw_start = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
    if (isnan(raw_start)) {
        raw_start = 0;
    }
    if (raw_start < 0) {
        raw_start = (f64) source_length + raw_start;
        if (raw_start < 0) {
            raw_start = 0;
        }
    }
    if (raw_start > (f64) source_length) {
        raw_start = (f64) source_length;
    }

    f64 raw_length = arg_count >= 2 && !mal_value_is_undefined(args[1]) ? mal_builtin_string_arg_to_number(vm, args[1]) : (f64) source_length;
    if (isnan(raw_length) || raw_length < 0) {
        raw_length = 0;
    }

    usize start = (usize) raw_start;
    usize remaining = source_length - start;
    usize count = raw_length > (f64) remaining ? remaining : (usize) raw_length;

    return mal_builtin_string_from_units(vm, mal_string_code_units(string) + start, count);
}

/**
 * Basic String.prototype.localeCompare: code-unit lexicographic order (no
 * locale-sensitive collation), returning -1 / 0 / +1.
 */
static MalValue mal_builtin_string_prototype_locale_compare(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    MalString *that = mal_builtin_string_coerce(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    i32 order = mal_string_compare(string, that);
    return mal_value_from_i32(order < 0 ? -1 : (order > 0 ? 1 : 0));
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
    MalString **parts = malloc(sizeof(MalString *) * (arg_count + 1));
    parts[0] = mal_builtin_string_this_to_string(vm, this_value);
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
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    f64 count = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
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
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
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
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
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
    for (usize i = 0; i < length; i++) {
        c16 cu = units[i];
        if (cu >= 0xD800 && cu <= 0xDBFF) {
            if (i + 1 < length && units[i + 1] >= 0xDC00 && units[i + 1] <= 0xDFFF) {
                i++;
            } else {
                return mal_value_new_boolean(false);
            }
        } else if (cu >= 0xDC00 && cu <= 0xDFFF) {
            return mal_value_new_boolean(false);
        }
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
    for (usize i = 0; i < length; i++) {
        c16 cu = source[i];
        if (cu >= 0xD800 && cu <= 0xDBFF) {
            if (i + 1 < length && source[i + 1] >= 0xDC00 && source[i + 1] <= 0xDFFF) {
                code_units[i] = cu;
                code_units[i + 1] = source[i + 1];
                i++;
            } else {
                code_units[i] = 0xFFFD;
            }
        } else if (cu >= 0xDC00 && cu <= 0xDFFF) {
            code_units[i] = 0xFFFD;
        } else {
            code_units[i] = cu;
        }
    }
    MalValue result = mal_builtin_string_from_units(vm, code_units, length);
    free(code_units);
    return result;
}

static MalValue mal_builtin_string_prototype_split(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
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
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
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
    MalString *string = mal_builtin_string_this_to_string(vm, this_value);
    usize length = mal_string_length(string);
    f64 raw_target = arg_count >= 1 ? mal_builtin_string_arg_to_number(vm, args[0]) : 0;
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

    mal_intrinsic_define_data(vm, (MalObject *) constructor, "prototype", vm->intrinsics[MAL_INTRINSIC_STRING_PROTOTYPE], MAL_PROPERTY_CONFIGURABLE);
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
    mal_intrinsic_define_method_n(vm, prototype, "split", 2, mal_builtin_string_prototype_split);
    mal_intrinsic_define_method_n(vm, prototype, "replace", 2, mal_builtin_string_prototype_replace);
    mal_intrinsic_define_method_n(vm, prototype, "replaceAll", 2, mal_builtin_string_prototype_replace_all);
    mal_intrinsic_define_method_n(vm, prototype, "padStart", 1, mal_builtin_string_prototype_pad_start);
    mal_intrinsic_define_method_n(vm, prototype, "padEnd", 1, mal_builtin_string_prototype_pad_end);
    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, mal_builtin_string_prototype_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0, mal_builtin_string_prototype_to_string);
    mal_intrinsic_define_symbol_method(vm, prototype, MAL_INTRINSIC_SYMBOL_ITERATOR, "[Symbol.iterator]", mal_builtin_string_prototype_iterator);
}
