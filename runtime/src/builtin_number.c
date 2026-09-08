#include "builtin_number.h"

#include <float.h>
#include <math.h>
#include <stdlib.h>

#include "builtin_intl.h"
#include "ecma_whitespace.h"
#include "gc.h"
#include "heap_string.h"
#include "mal_number_format.h"
#include "primitive_wrapper_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static f64 mal_builtin_parse_int_units(const c16 *code_units, usize length, f64 raw_radix) {
    usize i = 0;
    while (i < length && mal_ecma_is_string_whitespace(code_units[i])) {
        i++;
    }

    f64 sign = 1;
    if (i < length && (code_units[i] == '+' || code_units[i] == '-')) {
        sign = code_units[i] == '-' ? -1 : 1;
        i++;
    }

    i32 radix = mal_ops_number_to_i32(raw_radix);
    bool strip_prefix = true;
    if (radix != 0) {
        if (radix < 2 || radix > 36) {
            return NAN;
        }
        strip_prefix = radix == 16;
    } else {
        radix = 10;
    }

    if (strip_prefix && i + 1 < length && code_units[i] == '0' &&
        (code_units[i + 1] == 'x' || code_units[i + 1] == 'X')) {
        i += 2;
        radix = 16;
    }

    f64 value = 0;
    bool any_digit = false;
    for (; i < length; i++) {
        c16 code_unit = code_units[i];
        i32 digit;
        if (code_unit >= '0' && code_unit <= '9') {
            digit = code_unit - '0';
        } else if (code_unit >= 'a' && code_unit <= 'z') {
            digit = code_unit - 'a' + 10;
        } else if (code_unit >= 'A' && code_unit <= 'Z') {
            digit = code_unit - 'A' + 10;
        } else {
            break;
        }

        if (digit >= radix) {
            break;
        }

        value = value * radix + digit;
        any_digit = true;
    }

    return any_digit ? sign * value : NAN;
}

static f64 mal_builtin_parse_float_units(const c16 *code_units, usize length) {
    usize start = 0;
    while (start < length && mal_ecma_is_string_whitespace(code_units[start])) {
        start++;
    }

    usize cursor = start;
    if (cursor < length &&
        (code_units[cursor] == '+' || code_units[cursor] == '-')) {
        cursor++;
    }

    static const byte infinity[] = "Infinity";
    if (length - cursor >= sizeof(infinity) - 1) {
        bool matches = true;
        for (usize i = 0; i < sizeof(infinity) - 1; i++) {
            if (code_units[cursor + i] != infinity[i]) {
                matches = false;
                break;
            }
        }
        if (matches) {
            return cursor > start && code_units[start] == '-'
                ? -INFINITY
                : INFINITY;
        }
    }

    bool any_digit = false;
    while (cursor < length &&
           code_units[cursor] >= '0' && code_units[cursor] <= '9') {
        any_digit = true;
        cursor++;
    }
    if (cursor < length && code_units[cursor] == '.') {
        cursor++;
        while (cursor < length &&
               code_units[cursor] >= '0' && code_units[cursor] <= '9') {
            any_digit = true;
            cursor++;
        }
    }
    if (!any_digit) {
        return NAN;
    }

    if (cursor < length &&
        (code_units[cursor] == 'e' || code_units[cursor] == 'E')) {
        usize exponent_start = cursor++;
        if (cursor < length &&
            (code_units[cursor] == '+' || code_units[cursor] == '-')) {
            cursor++;
        }
        usize exponent_digits = cursor;
        while (cursor < length &&
               code_units[cursor] >= '0' && code_units[cursor] <= '9') {
            cursor++;
        }
        if (cursor == exponent_digits) {
            cursor = exponent_start;
        }
    }

    // Copy only the grammar-recognized prefix. Trailing ASCII text used to
    // force a proportional allocation even though strtod immediately ignored
    // it; ordinary source tokens stay on this local buffer.
    usize token_length = cursor - start;
    byte stack_buffer[64];
    bool heap_allocated = token_length >= sizeof(stack_buffer);
    byte *buffer = heap_allocated ? malloc(token_length + 1) : stack_buffer;
    for (usize i = 0; i < token_length; i++) {
        buffer[i] = (byte) code_units[start + i];
    }
    buffer[token_length] = '\0';

    f64 value = strtod(buffer, nullptr);
    if (heap_allocated) {
        free(buffer);
    }
    return value;
}

/**
 * Number(value): ToNumeric the argument (BigInt folds to its numeric value,
 * Symbol throws), boxing into a wrapper when constructed with new.
 */
static MalValue mal_builtin_number_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    MalValue number;
    if (arg_count == 0) {
        number = mal_value_from_i32(0);
    } else if (mal_value_is_symbol(args[0])) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Cannot convert a Symbol value to a number");
        return mal_value_new_undefined();
    } else if (mal_value_is_object(args[0])) {
        // Number(object) uses ToNumeric, not ToNumber: an object whose numeric
        // primitive is a BigInt is accepted by the Number constructor. Preserve
        // the exact Number primitive returned by the shared coercion path, and
        // convert only a BigInt result to its f64 numeric value.
        MalValue numeric;
        if (!mal_vm_to_numeric(vm, args[0], &numeric)) {
            return mal_value_new_undefined();
        }
        number = mal_value_is_bigint(numeric)
            ? mal_ops_number_value(mal_ops_to_number(numeric))
            : numeric;
    } else if (mal_ops_is_number(args[0])) {
        // Number(number) is an exact primitive identity, including NaN, -0,
        // and infinities. Construction still stores that primitive in a fresh
        // wrapper below.
        number = args[0];
    } else {
        number = mal_ops_number_value(mal_ops_to_number(args[0]));
    }

    if (mal_value_is_undefined(new_target)) {
        return number;
    }

    MalValue roots[2] = {
        number,
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);
    MalObject *prototype;
    if (!mal_vm_get_prototype_from_constructor(
            vm, new_target, MAL_INTRINSIC_NUMBER_PROTOTYPE, &prototype)) {
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    roots[1] = mal_value_from_object(prototype);

    MalValue result = mal_value_from_primitive_wrapper(mal_primitive_wrapper_object_new(
        &vm->heap,
        mal_value_to_object(roots[1]),
        MAL_PRIMITIVE_WRAPPER_NUMBER,
        roots[0]
    ));
    mal_gc_unroot(&root_span);
    return result;
}

/**
 * Spec thisNumberValue: unwrap a Number primitive or Number wrapper receiver to
 * its f64, throwing a TypeError on a foreign receiver.
 */
static bool mal_builtin_number_this(MalVm *vm, MalValue this_value, f64 *out) {
    MalValue primitive;
    if (!mal_value_this_number_value(this_value, &primitive)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Number.prototype method called on incompatible receiver");
        return false;
    }
    *out = mal_ops_to_number(primitive);
    return true;
}

static bool mal_builtin_number_to_number(MalVm *vm, MalValue value, f64 *out) {
    if (mal_ops_is_number(value)) {
        *out = mal_ops_number_as_f64(value);
        return true;
    }
    return mal_vm_to_number(vm, value, out);
}

MalValue mal_builtin_number_is_nan_known(const MalValue *args, i32 arg_count) {
    if (arg_count < 1) {
        return mal_value_new_boolean(false);
    }

    return mal_value_new_boolean(
        mal_value_is_nan(args[0]) || (mal_value_is_f64(args[0]) && isnan(mal_value_to_f64(args[0])))
    );
}

static MalValue mal_builtin_number_is_nan(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    return mal_builtin_number_is_nan_known(args, arg_count);
}

static bool mal_builtin_number_value_is_finite(MalValue value) {
    if (mal_value_is_int32(value) || value == MAL_VALUE_NEGATIVE_ZERO) {
        return true;
    }

    return mal_value_is_f64(value) && isfinite(mal_value_to_f64(value));
}

MalValue mal_builtin_number_is_finite_known(const MalValue *args, i32 arg_count) {
    return mal_value_new_boolean(arg_count >= 1 && mal_builtin_number_value_is_finite(args[0]));
}

static MalValue mal_builtin_number_is_finite(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    return mal_builtin_number_is_finite_known(args, arg_count);
}

static bool mal_builtin_number_value_is_integer(MalValue value) {
    if (mal_value_is_int32(value) || value == MAL_VALUE_NEGATIVE_ZERO) {
        return true;
    }

    if (!mal_value_is_f64(value)) {
        return false;
    }

    f64 number = mal_value_to_f64(value);
    return isfinite(number) && trunc(number) == number;
}

MalValue mal_builtin_number_is_integer_known(const MalValue *args, i32 arg_count) {
    return mal_value_new_boolean(arg_count >= 1 && mal_builtin_number_value_is_integer(args[0]));
}

static MalValue mal_builtin_number_is_integer(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    return mal_builtin_number_is_integer_known(args, arg_count);
}

MalValue mal_builtin_number_is_safe_integer_known(const MalValue *args, i32 arg_count) {
    if (arg_count < 1 || !mal_builtin_number_value_is_integer(args[0])) {
        return mal_value_new_boolean(false);
    }

    return mal_value_new_boolean(fabs(mal_ops_to_number(args[0])) <= MAL_NUMBER_MAX_SAFE_INTEGER);
}

static MalValue mal_builtin_number_is_safe_integer(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    return mal_builtin_number_is_safe_integer_known(args, arg_count);
}

static MalValue mal_builtin_parse_int(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    // ToString(arg) and ToNumber(radix) run a user toString/valueOf (and unwrap
    // a primitive wrapper), and propagate any abrupt completion.
    MalValue input = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalString *string;
    if (mal_value_is_string(input)) {
        string = mal_value_to_string(input);
    } else if (!mal_vm_to_string(vm, input, &string)) {
        return mal_value_new_undefined();
    }
    MalValue string_root = mal_value_from_string(string);
    MalRootSpan root_span;
    mal_gc_root(&root_span, &string_root, 1);
    f64 radix = 0;
    if (arg_count >= 2) {
        if (mal_ops_is_number(args[1])) {
            radix = mal_ops_number_as_f64(args[1]);
        } else {
            // Radix coercion can run arbitrary user code and collect the fresh
            // ToString result. Keep it rooted through any later flattening too.
            if (!mal_vm_to_number(vm, args[1], &radix)) {
                mal_gc_unroot(&root_span);
                return mal_value_new_undefined();
            }
        }
    }
    string = mal_value_to_string(string_root);
    usize length = mal_string_length(string);
    const c16 *code_units = mal_string_code_units(string);
    MalValue result = mal_ops_number_value(
        mal_builtin_parse_int_units(code_units, length, radix));
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue mal_builtin_parse_float(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    MalValue input = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalString *string;
    if (mal_value_is_string(input)) {
        string = mal_value_to_string(input);
    } else if (!mal_vm_to_string(vm, input, &string)) {
        return mal_value_new_undefined();
    }
    MalValue string_root = mal_value_from_string(string);
    MalRootSpan root_span;
    mal_gc_root(&root_span, &string_root, 1);
    string = mal_value_to_string(string_root);
    usize length = mal_string_length(string);
    const c16 *code_units = mal_string_code_units(string);
    MalValue result = mal_ops_number_value(
        mal_builtin_parse_float_units(code_units, length));
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue mal_builtin_global_is_nan(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    // isNaN(number): num = ? ToNumber(number). ToNumber invokes @@toPrimitive /
    // valueOf / toString, whose abrupt completions must propagate (VM-aware).
    MalValue input = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    f64 number;
    if (!mal_builtin_number_to_number(vm, input, &number)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(isnan(number));
}

static MalValue mal_builtin_global_is_finite(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    // isFinite(number): num = ? ToNumber(number) — same abrupt-propagation rule.
    MalValue input = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    f64 number;
    if (!mal_builtin_number_to_number(vm, input, &number)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(isfinite(number));
}

/* Exact integer division is the lowest-overhead path for common IDs and masks. */
static MalString *mal_builtin_number_safe_integer_radix_string(MalHeap *heap, f64 number, i32 radix) {
    static const byte digits[] = "0123456789abcdefghijklmnopqrstuvwxyz";
    byte buffer[56];
    byte *end = buffer + sizeof(buffer);
    byte *cursor = end;
    bool negative = number < 0.0;
    u64 magnitude = (u64) fabs(number);
    i32 shift = radix == 2 ? 1 :
        radix == 4 ? 2 :
        radix == 8 ? 3 :
        radix == 16 ? 4 :
        radix == 32 ? 5 : 0;
    if (shift != 0) {
        u64 mask = (u64) radix - 1;
        do {
            *--cursor = digits[magnitude & mask];
            magnitude >>= shift;
        } while (magnitude != 0);
    } else {
        do {
            *--cursor = digits[magnitude % (u64) radix];
            magnitude /= (u64) radix;
        } while (magnitude != 0);
    }
    if (negative) {
        *--cursor = '-';
    }
    return mal_string_new_ascii(heap, cursor, (usize) (end - cursor));
}

static MalValue mal_builtin_number_prototype_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    f64 number;
    if (!mal_builtin_number_this(vm, this_value, &number)) {
        return mal_value_new_undefined();
    }

    // ToIntegerOrInfinity(radix) via the VM ToNumber, so a poisoned valueOf runs
    // (and a Symbol/BigInt throws TypeError) before the range check. NaN -> 0.
    f64 radix = 10;
    if (arg_count >= 1 && !mal_value_is_undefined(args[0])) {
        f64 raw;
        if (!mal_builtin_number_to_number(vm, args[0], &raw)) {
            return mal_value_new_undefined();
        }
        radix = mal_ops_number_to_integer_or_infinity(raw);
    }
    if (radix < 2 || radix > 36) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "toString() radix must be between 2 and 36");
        return mal_value_new_undefined();
    }

    i32 int_radix = (i32) radix;
    if (int_radix == 10 || !isfinite(number)) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, mal_ops_number_value(number)));
    }

    // Every safe integer has an exact u64 magnitude, so common IDs, masks, and
    // counters use integer division rather than the general f64 expansion.
    if (trunc(number) == number && fabs(number) <= MAL_NUMBER_MAX_SAFE_INTEGER) {
        return mal_value_from_string(
            mal_builtin_number_safe_integer_radix_string(&vm->heap, number, int_radix)
        );
    }

    byte buffer[1200];
    i32 length = mal_number_format_radix(
        number, int_radix, buffer, (i32) sizeof(buffer)
    );
    if (length <= 0 || (usize) length > sizeof(buffer)) {
        abort();
    }
    return mal_value_from_string(
        mal_string_new_ascii(&vm->heap, buffer, (usize) length)
    );
}

static MalValue mal_builtin_number_prototype_to_locale_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    f64 number;
    if (!mal_builtin_number_this(vm, this_value, &number)) {
        return mal_value_new_undefined();
    }
    MalValue locales = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    return mal_intl_number_to_locale_string(vm, number, locales, options);
}

static MalValue mal_builtin_number_format_result(
    MalVm *vm, const byte *buffer, i32 length, usize capacity
) {
    if (length <= 0 || (usize) length > capacity) {
        abort();
    }
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, buffer, (usize) length));
}

static i32 mal_builtin_number_format_safe_integer_fixed(
    f64 number, i32 fraction_digits, byte *out, usize capacity
) {
    byte reverse_digits[24];
    usize digit_count = 0;
    u64 magnitude = (u64) fabs(number);
    do {
        reverse_digits[digit_count++] = (byte) ('0' + magnitude % 10);
        magnitude /= 10;
    } while (magnitude != 0);

    usize required = digit_count + (number < 0.0 ? 1 : 0) +
        (fraction_digits > 0 ? (usize) fraction_digits + 1 : 0);
    if (required > capacity) {
        abort();
    }

    usize length = 0;
    if (number < 0.0) {
        out[length++] = '-';
    }
    while (digit_count > 0) {
        out[length++] = reverse_digits[--digit_count];
    }
    if (fraction_digits > 0) {
        out[length++] = '.';
        for (i32 i = 0; i < fraction_digits; i++) {
            out[length++] = '0';
        }
    }
    return (i32) length;
}

static i32 mal_builtin_number_format_zero_exponential(
    i32 fraction_digits, byte *out
) {
    usize length = 0;
    out[length++] = '0';
    if (fraction_digits > 0) {
        out[length++] = '.';
        for (i32 i = 0; i < fraction_digits; i++) {
            out[length++] = '0';
        }
    }
    out[length++] = 'e';
    out[length++] = '+';
    out[length++] = '0';
    return (i32) length;
}

static i32 mal_builtin_number_format_zero_precision(
    i32 precision, byte *out
) {
    usize length = 0;
    out[length++] = '0';
    if (precision > 1) {
        out[length++] = '.';
        for (i32 i = 1; i < precision; i++) {
            out[length++] = '0';
        }
    }
    return (i32) length;
}

static MalValue mal_builtin_number_prototype_to_fixed(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    f64 number;
    if (!mal_builtin_number_this(vm, this_value, &number)) {
        return mal_value_new_undefined();
    }

    // ToIntegerOrInfinity(fractionDigits) via the VM ToNumber, so a Symbol/BigInt
    // throws TypeError (and a user valueOf runs) before the range check.
    f64 digits = 0;
    if (arg_count >= 1 && !mal_value_is_undefined(args[0])) {
        f64 raw;
        if (!mal_builtin_number_to_number(vm, args[0], &raw)) {
            return mal_value_new_undefined();
        }
        digits = mal_ops_number_to_integer_or_infinity(raw);
    }
    if (digits < 0 || digits > 100) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "toFixed() digits argument must be between 0 and 100");
        return mal_value_new_undefined();
    }

    if (isnan(number)) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, "NaN"));
    }
    // For magnitudes >= 1e21 the spec falls back to ToString(number).
    if (fabs(number) >= 1e21) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, mal_ops_number_value(number)));
    }

    byte buffer[160];
    i32 length;
    if (trunc(number) == number &&
        fabs(number) <= MAL_NUMBER_MAX_SAFE_INTEGER) {
        length = mal_builtin_number_format_safe_integer_fixed(
            number, (i32) digits, buffer, sizeof(buffer));
    } else {
        length = mal_number_format_fixed(
            number, (i32) digits, buffer, (i32) sizeof(buffer));
    }
    return mal_builtin_number_format_result(vm, buffer, length, sizeof(buffer));
}

static MalValue mal_builtin_number_prototype_to_exponential(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    f64 number;
    if (!mal_builtin_number_this(vm, this_value, &number)) {
        return mal_value_new_undefined();
    }

    // ToIntegerOrInfinity(fractionDigits) precedes the finite short-circuit and
    // the range check: a Symbol argument throws TypeError before any RangeError.
    bool digits_undefined = arg_count < 1 || mal_value_is_undefined(args[0]);
    f64 digits = 0;
    if (!digits_undefined) {
        f64 raw;
        if (!mal_builtin_number_to_number(vm, args[0], &raw)) {
            return mal_value_new_undefined();
        }
        digits = mal_ops_number_to_integer_or_infinity(raw);
    }

    if (!isfinite(number)) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, mal_ops_number_value(number)));
    }

    if (!digits_undefined && (digits < 0 || digits > 100)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "toExponential() argument must be between 0 and 100");
        return mal_value_new_undefined();
    }

    if (number == 0.0) {
        byte out[105];
        i32 length = mal_builtin_number_format_zero_exponential(
            digits_undefined ? 0 : (i32) digits, out);
        return mal_builtin_number_format_result(
            vm, out, length, sizeof(out));
    }

    if (digits_undefined) {
        byte buffer[32];
        i32 length = mal_number_format_shortest_exponential(
            number, buffer, (i32) sizeof(buffer)
        );
        return mal_builtin_number_format_result(vm, buffer, length, sizeof(buffer));
    }

    byte out[256];
    i32 length = mal_number_format_exponential(
        number, (i32) digits, out, (i32) sizeof(out)
    );
    return mal_builtin_number_format_result(vm, out, length, sizeof(out));
}

static MalValue mal_builtin_number_prototype_to_precision(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) new_target;
    (void) callee;
    f64 number;
    if (!mal_builtin_number_this(vm, this_value, &number)) {
        return mal_value_new_undefined();
    }

    // Undefined precision behaves exactly like Number.prototype.toString().
    if (arg_count < 1 || mal_value_is_undefined(args[0])) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, mal_ops_number_value(number)));
    }

    // ToIntegerOrInfinity(precision) precedes the finite short-circuit and the
    // range check: a Symbol argument throws TypeError before any RangeError.
    f64 raw;
    if (!mal_builtin_number_to_number(vm, args[0], &raw)) {
        return mal_value_new_undefined();
    }
    f64 precision = mal_ops_number_to_integer_or_infinity(raw);
    if (!isfinite(number)) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, mal_ops_number_value(number)));
    }
    if (precision < 1 || precision > 100) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "toPrecision() argument must be between 1 and 100");
        return mal_value_new_undefined();
    }

    if (number == 0.0) {
        byte out[102];
        i32 length = mal_builtin_number_format_zero_precision(
            (i32) precision, out);
        return mal_builtin_number_format_result(
            vm, out, length, sizeof(out));
    }

    byte out[256];
    i32 length = mal_number_format_precision(
        number, (i32) precision, out, (i32) sizeof(out)
    );
    return mal_builtin_number_format_result(vm, out, length, sizeof(out));
}

static MalValue mal_builtin_number_prototype_value_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    MalValue primitive;
    if (!mal_value_this_number_value(this_value, &primitive)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Number.prototype method called on incompatible receiver");
        return mal_value_new_undefined();
    }
    return primitive;
}

MalValue mal_builtin_number_value_of_known(MalValue this_value) {
    return this_value;
}

void mal_builtin_number_install(MalVm *vm) {
    // %Number.prototype% is itself a Number object with [[NumberData]] = +0, so
    // Number.prototype.valueOf()/toString() and friends work on the prototype.
    MalObject *prototype = (MalObject *) mal_primitive_wrapper_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]),
        MAL_PRIMITIVE_WRAPPER_NUMBER,
        mal_value_from_i32(0)
    );
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "Number"),
        1,
        mal_builtin_number_constructor
    );
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_NUMBER_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_NUMBER_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_NUMBER_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_NUMBER_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);

    mal_intrinsic_define_data(vm, constructor_object, "MAX_SAFE_INTEGER", mal_value_from_f64(MAL_NUMBER_MAX_SAFE_INTEGER), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "MIN_SAFE_INTEGER", mal_value_from_f64(MAL_NUMBER_MIN_SAFE_INTEGER), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "EPSILON", mal_value_from_f64(DBL_EPSILON), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "MAX_VALUE", mal_value_from_f64(DBL_MAX), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "MIN_VALUE", mal_value_from_f64(5e-324), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "POSITIVE_INFINITY", mal_value_from_f64_convert_nan(INFINITY), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "NEGATIVE_INFINITY", mal_value_from_f64_convert_nan(-INFINITY), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "NaN", mal_value_new_nan(), MAL_PROPERTY_NONE);

    mal_intrinsic_define_method_n(vm, constructor_object, "isNaN", 1, mal_builtin_number_is_nan);
    mal_intrinsic_define_method_n(vm, constructor_object, "isFinite", 1, mal_builtin_number_is_finite);
    mal_intrinsic_define_method_n(vm, constructor_object, "isInteger", 1, mal_builtin_number_is_integer);
    mal_intrinsic_define_method_n(vm, constructor_object, "isSafeInteger", 1, mal_builtin_number_is_safe_integer);
    vm->intrinsics[MAL_INTRINSIC_PARSE_INT] = mal_intrinsic_define_method_n(vm, constructor_object, "parseInt", 2, mal_builtin_parse_int);
    vm->intrinsics[MAL_INTRINSIC_PARSE_FLOAT] = mal_intrinsic_define_method_n(vm, constructor_object, "parseFloat", 1, mal_builtin_parse_float);

    mal_intrinsic_define_method_n(vm, prototype, "toString", 1, mal_builtin_number_prototype_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "toLocaleString", 0, mal_builtin_number_prototype_to_locale_string);
    mal_intrinsic_define_method_n(vm, prototype, "toFixed", 1, mal_builtin_number_prototype_to_fixed);
    mal_intrinsic_define_method_n(vm, prototype, "toExponential", 1, mal_builtin_number_prototype_to_exponential);
    mal_intrinsic_define_method_n(vm, prototype, "toPrecision", 1, mal_builtin_number_prototype_to_precision);
    mal_intrinsic_define_method_n(vm, prototype, "valueOf", 0, mal_builtin_number_prototype_value_of);

    // The global function flavors coerce their argument, unlike the statics.
    MalNativeFunctionObject *global_is_nan = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "isNaN"),
        mal_builtin_global_is_nan
    );
    MalNativeFunctionObject *global_is_finite = mal_native_function_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, "isFinite"),
        mal_builtin_global_is_finite
    );
    vm->intrinsics[MAL_INTRINSIC_IS_NAN] = mal_value_from_native_function_object(global_is_nan);
    vm->intrinsics[MAL_INTRINSIC_IS_FINITE] = mal_value_from_native_function_object(global_is_finite);
}

#include "generated/known_native_builtin_number_c.inc"
