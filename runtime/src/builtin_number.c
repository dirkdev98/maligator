#include "builtin_number.h"

#include <float.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "builtin_intl.h"
#include "heap_string.h"
#include "primitive_wrapper_object.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"
#include "vm_ops.h"

static bool mal_builtin_number_is_whitespace(c16 code_unit) {
    return (code_unit >= 0x09 && code_unit <= 0x0D) ||
        code_unit == 0x20 ||
        code_unit == 0xA0 ||
        code_unit == 0x2028 ||
        code_unit == 0x2029 ||
        code_unit == 0xFEFF;
}

static f64 mal_builtin_parse_int_units(const c16 *code_units, usize length, f64 raw_radix) {
    usize i = 0;
    while (i < length && mal_builtin_number_is_whitespace(code_units[i])) {
        i++;
    }

    f64 sign = 1;
    if (i < length && (code_units[i] == '+' || code_units[i] == '-')) {
        sign = code_units[i] == '-' ? -1 : 1;
        i++;
    }

    i32 radix = isnan(raw_radix) ? 0 : (i32) raw_radix;
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
    while (start < length && mal_builtin_number_is_whitespace(code_units[start])) {
        start++;
    }

    // Collect the ASCII prefix and let strtod handle the float grammar.
    byte *buffer = malloc(length - start + 1);
    usize buffer_length = 0;
    for (usize i = start; i < length; i++) {
        if (code_units[i] > 0x7F) {
            break;
        }
        buffer[buffer_length++] = (byte) code_units[i];
    }
    buffer[buffer_length] = '\0';

    // JS parseFloat has no hex or "inf" forms; strtod would accept both.
    usize digits_start = buffer_length > 0 && (buffer[0] == '+' || buffer[0] == '-') ? 1 : 0;
    if (buffer_length >= digits_start + 2 && buffer[digits_start] == '0' &&
        (buffer[digits_start + 1] == 'x' || buffer[digits_start + 1] == 'X')) {
        buffer[digits_start + 1] = '\0';
    }
    // parseFloat accepts a leading "Infinity" (exact spelling, after an optional
    // sign); strtod would otherwise also accept "inf"/"infinity"/"nan", which
    // the StrDecimalLiteral grammar does not.
    if (buffer_length >= digits_start + 8 && memcmp(buffer + digits_start, "Infinity", 8) == 0) {
        bool negative = digits_start == 1 && buffer[0] == '-';
        free(buffer);
        return negative ? -INFINITY : INFINITY;
    }
    if (buffer_length > digits_start && (buffer[digits_start] == 'i' || buffer[digits_start] == 'I' || buffer[digits_start] == 'n' || buffer[digits_start] == 'N')) {
        buffer[digits_start] = '\0';
    }

    byte *end = buffer;
    f64 value = strtod(buffer, (char **) &end);
    bool parsed = end != buffer;
    free(buffer);
    return parsed ? value : NAN;
}

/**
 * Resolve the prototype for a construct call (OrdinaryCreateFromConstructor
 * flavored): new_target's prototype property when it is an object, the given
 * intrinsic slot otherwise.
 */
static MalObject *mal_builtin_number_resolve_prototype(MalVm *vm, MalValue new_target, MalIntrinsic fallback) {
    MalValue prototype;
    if (!mal_vm_get_property(vm, new_target, mal_intrinsic_string_key(vm, "prototype"), &prototype)) {
        return nullptr;
    }
    if (mal_value_is_object(prototype)) {
        return mal_value_to_object(prototype);
    }
    return mal_value_to_object(vm->intrinsics[fallback]);
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
        // ToNumber on an object first runs ToPrimitive(number) through the
        // shared coercion path (valueOf/toString/@@toPrimitive), which may throw.
        f64 primitive;
        if (!mal_vm_to_number(vm, args[0], &primitive)) {
            return mal_value_new_undefined();
        }
        number = mal_ops_number_value(primitive);
    } else if (mal_value_is_int32(args[0])) {
        number = args[0];
    } else {
        number = mal_ops_number_value(mal_ops_to_number(args[0]));
    }

    if (mal_value_is_undefined(new_target)) {
        return number;
    }

    MalObject *prototype = mal_builtin_number_resolve_prototype(vm, new_target, MAL_INTRINSIC_NUMBER_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }

    return mal_value_from_primitive_wrapper(mal_primitive_wrapper_object_new(
        &vm->heap,
        prototype,
        MAL_PRIMITIVE_WRAPPER_NUMBER,
        number
    ));
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

static MalValue mal_builtin_number_is_nan(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    if (arg_count < 1) {
        return mal_value_new_boolean(false);
    }

    return mal_value_new_boolean(
        mal_value_is_nan(args[0]) || (mal_value_is_f64(args[0]) && isnan(mal_value_to_f64(args[0])))
    );
}

static bool mal_builtin_number_value_is_finite(MalValue value) {
    if (mal_value_is_int32(value) || value == MAL_VALUE_NEGATIVE_ZERO) {
        return true;
    }

    return mal_value_is_f64(value) && isfinite(mal_value_to_f64(value));
}

static MalValue mal_builtin_number_is_finite(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    return mal_value_new_boolean(arg_count >= 1 && mal_builtin_number_value_is_finite(args[0]));
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

static MalValue mal_builtin_number_is_integer(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    return mal_value_new_boolean(arg_count >= 1 && mal_builtin_number_value_is_integer(args[0]));
}

static MalValue mal_builtin_number_is_safe_integer(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    if (arg_count < 1 || !mal_builtin_number_value_is_integer(args[0])) {
        return mal_value_new_boolean(false);
    }

    return mal_value_new_boolean(fabs(mal_ops_to_number(args[0])) <= 9007199254740991.0);
}

static MalValue mal_builtin_parse_int(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    // ToString(arg) and ToNumber(radix) run a user toString/valueOf (and unwrap
    // a primitive wrapper), and propagate any abrupt completion.
    MalString *string;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &string)) {
        return mal_value_new_undefined();
    }
    f64 radix = 0;
    if (arg_count >= 2 && !mal_vm_to_number(vm, args[1], &radix)) {
        return mal_value_new_undefined();
    }
    return mal_ops_number_value(mal_builtin_parse_int_units(mal_string_code_units(string), mal_string_length(string), radix));
}

static MalValue mal_builtin_parse_float(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    MalString *string;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &string)) {
        return mal_value_new_undefined();
    }
    return mal_ops_number_value(mal_builtin_parse_float_units(mal_string_code_units(string), mal_string_length(string)));
}

static MalValue mal_builtin_global_is_nan(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    // isNaN(number): num = ? ToNumber(number). ToNumber invokes @@toPrimitive /
    // valueOf / toString, whose abrupt completions must propagate (VM-aware).
    f64 number;
    if (!mal_vm_to_number(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &number)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(isnan(number));
}

static MalValue mal_builtin_global_is_finite(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    // isFinite(number): num = ? ToNumber(number) — same abrupt-propagation rule.
    f64 number;
    if (!mal_vm_to_number(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &number)) {
        return mal_value_new_undefined();
    }
    return mal_value_new_boolean(isfinite(number));
}

/**
 * Number::toString in a radix 2..36 for a finite value. Renders the integer
 * part by repeated division and up to ~1100 fractional digits by repeated
 * multiplication (enough to round-trip any double in any radix).
 */
static MalString *mal_builtin_number_radix_string(MalHeap *heap, f64 number, i32 radix) {
    static const char digits[] = "0123456789abcdefghijklmnopqrstuvwxyz";

    bool negative = number < 0;
    if (negative) {
        number = -number;
    }

    f64 integer = floor(number);
    f64 fraction = number - integer;

    byte buffer[1200];
    usize length = 0;
    if (negative) {
        buffer[length++] = '-';
    }

    // Integer part, produced least-significant first then reversed.
    byte int_digits[64];
    usize int_length = 0;
    if (integer == 0) {
        int_digits[int_length++] = '0';
    } else {
        while (integer >= 1 && int_length < sizeof(int_digits)) {
            f64 quotient = floor(integer / radix);
            i32 digit = (i32) (integer - quotient * radix);
            int_digits[int_length++] = (byte) digits[digit];
            integer = quotient;
        }
    }
    for (usize i = 0; i < int_length; i++) {
        buffer[length++] = int_digits[int_length - 1 - i];
    }

    if (fraction > 0) {
        buffer[length++] = '.';
        i32 max_fraction = 1100;
        while (fraction > 0 && max_fraction-- > 0 && length < sizeof(buffer) - 1) {
            fraction *= radix;
            i32 digit = (i32) floor(fraction);
            if (digit >= radix) {
                digit = radix - 1;
            }
            buffer[length++] = (byte) digits[digit];
            fraction -= digit;
        }
    }

    return mal_string_new_ascii(heap, buffer, length);
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
        if (!mal_vm_to_number(vm, args[0], &raw)) {
            return mal_value_new_undefined();
        }
        radix = isnan(raw) ? 0 : trunc(raw);
    }
    if (radix < 2 || radix > 36) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "toString() radix must be between 2 and 36");
        return mal_value_new_undefined();
    }

    i32 int_radix = (i32) radix;
    if (int_radix == 10 || !isfinite(number)) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, mal_ops_number_value(number)));
    }

    return mal_value_from_string(mal_builtin_number_radix_string(&vm->heap, number, int_radix));
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
        if (!mal_vm_to_number(vm, args[0], &raw)) {
            return mal_value_new_undefined();
        }
        digits = isnan(raw) ? 0 : trunc(raw);
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
    snprintf(buffer, sizeof(buffer), "%.*f", (i32) digits, number);
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, buffer, strlen(buffer)));
}

/**
 * Rewrite a C printf-formatted number (from "%g"/"%#g"/"%e") into the JS
 * Number::toString shape: a "eXX" exponent becomes "e+X"/"e-X" with no leading
 * zeros and a mandatory sign, and (when strip_trailing_zeros) trailing zeros in
 * a fractional mantissa plus any dangling "." are removed. Returns the length
 * written to out (which must hold at least sizeof(buffer) + a few bytes).
 */
static usize mal_builtin_number_normalize(const byte *buffer, byte *out, bool strip_trailing_zeros) {
    usize mantissa_end = 0;
    while (buffer[mantissa_end] != '\0' && buffer[mantissa_end] != 'e' && buffer[mantissa_end] != 'E') {
        mantissa_end++;
    }

    usize end = mantissa_end;
    bool has_dot = false;
    for (usize j = 0; j < mantissa_end; j++) {
        if (buffer[j] == '.') {
            has_dot = true;
        }
    }
    if (has_dot && strip_trailing_zeros) {
        while (end > 0 && buffer[end - 1] == '0') {
            end--;
        }
    }
    // A trailing "." with no fractional digits ("3." -> "3") is never valid JS.
    if (end > 0 && buffer[end - 1] == '.') {
        end--;
    }

    usize w = 0;
    for (usize j = 0; j < end; j++) {
        out[w++] = buffer[j];
    }

    if (buffer[mantissa_end] == '\0') {
        return w;
    }

    out[w++] = 'e';
    usize i = mantissa_end + 1;
    char sign = '+';
    if (buffer[i] == '+' || buffer[i] == '-') {
        sign = (char) buffer[i];
        i++;
    }
    out[w++] = (byte) sign;
    while (buffer[i] == '0' && buffer[i + 1] >= '0' && buffer[i + 1] <= '9') {
        i++;
    }
    if (buffer[i] == '\0') {
        out[w++] = '0';
    }
    while (buffer[i] != '\0') {
        out[w++] = buffer[i++];
    }

    return w;
}

/**
 * Exact significant digits of a positive, finite, nonzero double. macOS/glibc
 * printf is correctly rounded, and 767 significant digits exceed the longest
 * exact decimal expansion of any double, so "%.766e" yields the EXACT digits
 * with no rounding. Fills `sig` with the leading-nonzero digit string and sets
 * *exp10 so that value == sig[0].sig[1]sig[2]... * 10^(*exp10).
 */
static void mal_number_exact_digits(f64 x, byte *sig, i32 *exp10) {
    byte buffer[800];
    snprintf(buffer, sizeof(buffer), "%.766e", x);
    usize w = 0;
    usize i = 0;
    sig[w++] = buffer[i++];
    if (buffer[i] == '.') {
        i++;
        while (buffer[i] >= '0' && buffer[i] <= '9') {
            sig[w++] = buffer[i++];
        }
    }
    sig[w] = '\0';
    *exp10 = (i32) strtol((char *) buffer + i + 1, nullptr, 10);
}

/**
 * Round the significant-digit string `sig` to `keep` digits using
 * round-half-away-from-zero. For a positive magnitude this is round-half-up:
 * round up iff the first discarded digit is >= '5' (an exact .5 tie picks the
 * larger value per the spec's "pick the larger n"). A carry out of the leading
 * digit (999..9 -> 1000..0) bumps *exp10. Leaves exactly `keep` digits.
 */
static void mal_number_round_sig(byte *sig, i32 keep, i32 *exp10) {
    i32 len = (i32) strlen((char *) sig);
    if (keep >= len) {
        for (i32 j = len; j < keep; j++) {
            sig[j] = '0';
        }
        sig[keep] = '\0';
        return;
    }
    bool round_up = sig[keep] >= '5';
    sig[keep] = '\0';
    if (!round_up) {
        return;
    }
    i32 j = keep - 1;
    while (j >= 0) {
        if (sig[j] != '9') {
            sig[j]++;
            return;
        }
        sig[j] = '0';
        j--;
    }
    // Carried out of the leading digit: keep "1" + (keep-1) zeros, bump exponent.
    memmove(sig + 1, sig, (usize) (keep - 1));
    sig[0] = '1';
    sig[keep] = '\0';
    (*exp10)++;
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
        if (!mal_vm_to_number(vm, args[0], &raw)) {
            return mal_value_new_undefined();
        }
        digits = isnan(raw) ? 0 : trunc(raw);
    }

    if (!isfinite(number)) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, mal_ops_number_value(number)));
    }

    if (!digits_undefined && (digits < 0 || digits > 100)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "toExponential() argument must be between 0 and 100");
        return mal_value_new_undefined();
    }

    if (digits_undefined) {
        // Shortest exponential that round-trips; auto-precision strips trailing
        // fractional zeros during normalization.
        byte buffer[160];
        snprintf(buffer, sizeof(buffer), "%e", number);
        byte normalized[176];
        usize out = mal_builtin_number_normalize(buffer, normalized, true);
        return mal_value_from_string(mal_string_new_ascii(&vm->heap, normalized, out));
    }

    // Explicit fractionDigits: produce f+1 significant digits with the spec's
    // round-half-away-from-zero (printf's %e rounds half-to-even, which disagrees
    // at exact ties such as (25).toExponential(0) == "3e+1").
    i32 f = (i32) digits;
    bool neg = number < 0.0;
    f64 ax = fabs(number);

    byte out[256];
    usize w = 0;
    if (neg) {
        out[w++] = '-';
    }
    byte sig[820];
    i32 e10 = 0;
    if (ax == 0.0) {
        sig[0] = '0';
        sig[1] = '\0';
        mal_number_round_sig(sig, f + 1, &e10);
    } else {
        mal_number_exact_digits(ax, sig, &e10);
        mal_number_round_sig(sig, f + 1, &e10);
    }
    out[w++] = sig[0];
    if (f > 0) {
        out[w++] = '.';
        for (i32 j = 1; j <= f; j++) {
            out[w++] = sig[j];
        }
    }
    w += (usize) snprintf((char *) out + w, sizeof(out) - w, "e%+d", e10);
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, out, w));
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
    if (!mal_vm_to_number(vm, args[0], &raw)) {
        return mal_value_new_undefined();
    }
    f64 precision = isnan(raw) ? 0 : trunc(raw);
    if (!isfinite(number)) {
        return mal_value_from_string(mal_ops_to_string(&vm->heap, mal_ops_number_value(number)));
    }
    if (precision < 1 || precision > 100) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "toPrecision() argument must be between 1 and 100");
        return mal_value_new_undefined();
    }

    // Round to p significant digits half-away-from-zero (exact-expansion based),
    // then choose exponential vs fixed exactly as the spec does. -0 renders with
    // no sign (number < 0 is false for -0).
    i32 p = (i32) precision;
    bool neg = number < 0.0;
    f64 ax = fabs(number);

    byte sig[820];
    i32 e = 0;
    if (ax == 0.0) {
        for (i32 j = 0; j < p; j++) {
            sig[j] = '0';
        }
        sig[p] = '\0';
    } else {
        mal_number_exact_digits(ax, sig, &e);
        mal_number_round_sig(sig, p, &e);
    }

    byte out[256];
    usize w = 0;
    if (neg) {
        out[w++] = '-';
    }
    if (e < -6 || e >= p) {
        // Exponential form: one digit, optional fraction, signed exponent.
        out[w++] = sig[0];
        if (p > 1) {
            out[w++] = '.';
            for (i32 j = 1; j < p; j++) {
                out[w++] = sig[j];
            }
        }
        w += (usize) snprintf((char *) out + w, sizeof(out) - w, "e%+d", e);
    } else if (e >= 0) {
        // Fixed form, e+1 integer digits then any remaining as fraction.
        for (i32 j = 0; j <= e; j++) {
            out[w++] = sig[j];
        }
        if (p > e + 1) {
            out[w++] = '.';
            for (i32 j = e + 1; j < p; j++) {
                out[w++] = sig[j];
            }
        }
    } else {
        // -6 <= e < 0: "0." then -e-1 leading zeros then all p digits.
        out[w++] = '0';
        out[w++] = '.';
        for (i32 j = 0; j < -e - 1; j++) {
            out[w++] = '0';
        }
        for (i32 j = 0; j < p; j++) {
            out[w++] = sig[j];
        }
    }
    return mal_value_from_string(mal_string_new_ascii(&vm->heap, out, w));
}

static MalValue mal_builtin_number_prototype_value_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;
    f64 number;
    if (!mal_builtin_number_this(vm, this_value, &number)) {
        return mal_value_new_undefined();
    }
    return mal_ops_number_value(number);
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

    mal_intrinsic_define_data(vm, constructor_object, "MAX_SAFE_INTEGER", mal_value_from_f64(9007199254740991.0), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, constructor_object, "MIN_SAFE_INTEGER", mal_value_from_f64(-9007199254740991.0), MAL_PROPERTY_NONE);
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
