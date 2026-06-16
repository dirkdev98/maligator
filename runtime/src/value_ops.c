#include "value.h"
#include "value_ops.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "heap_bigint.h"
#include "heap_string.h"

static i128 mal_ops_bigint_of(MalValue value) {
    return mal_bigint_value(mal_value_to_bigint(value));
}

// mal_ops_is_number lives in value_ops.h (static inline) so both the
// interpreter and the native-C backend share one definition.

static f64 mal_ops_to_f64(MalValue value) {
    // Precondition: value is a Number (every caller checks). Defers to the
    // shared inline recovery in value_ops.h.
    return mal_ops_number_as_f64(value);
}

MalValue mal_ops_number_value(f64 value);

static MalString *mal_ops_string_from_ascii(MalHeap *heap, const byte *bytes) {
    return mal_string_new_ascii(heap, bytes, strlen(bytes));
}

static MalValue mal_ops_string_to_number(MalValue value) {
    MalString *string = mal_value_to_string(value);
    usize length = mal_string_length(string);
    const c16 *code_units = mal_string_code_units(string);
    byte *bytes = malloc(length + 1);

    for (usize i = 0; i < length; i++) {
        if (code_units[i] > 0x7F) {
            free(bytes);
            return mal_value_new_nan();
        }

        bytes[i] = (byte) code_units[i];
    }
    bytes[length] = '\0';

    char *start = bytes;
    while (*start == ' ' || *start == '\t' || *start == '\n' || *start == '\r') {
        start++;
    }

    if (*start == '\0') {
        free(bytes);
        return mal_value_from_i32(0);
    }

    char *end = start;
    f64 number = strtod(start, &end);
    while (*end == ' ' || *end == '\t' || *end == '\n' || *end == '\r') {
        end++;
    }

    if (end == start || *end != '\0') {
        free(bytes);
        return mal_value_new_nan();
    }

    free(bytes);
    return mal_ops_number_value(number);
}

MalString *mal_ops_to_string(MalHeap *heap, MalValue value) {
    if (mal_value_is_string(value)) {
        return mal_value_to_string(value);
    }

    if (mal_value_is_undefined(value)) {
        return mal_ops_string_from_ascii(heap, "undefined");
    }

    if (mal_value_is_null(value)) {
        return mal_ops_string_from_ascii(heap, "null");
    }

    if (mal_value_is_boolean(value)) {
        return mal_ops_string_from_ascii(heap, mal_value_to_boolean(value) ? "true" : "false");
    }

    if (mal_value_is_nan(value)) {
        return mal_ops_string_from_ascii(heap, "NaN");
    }

    if (value == MAL_VALUE_POSITIVE_INFINITY) {
        return mal_ops_string_from_ascii(heap, "Infinity");
    }

    if (value == MAL_VALUE_NEGATIVE_INFINITY) {
        return mal_ops_string_from_ascii(heap, "-Infinity");
    }

    if (mal_value_is_int32(value)) {
        byte buffer[16];
        snprintf(buffer, sizeof(buffer), "%d", mal_value_to_i32(value));
        return mal_ops_string_from_ascii(heap, buffer);
    }

    if (mal_value_is_bigint(value)) {
        return mal_bigint_to_string(heap, mal_ops_bigint_of(value), 10);
    }

    if (mal_value_is_f64(value)) {
        f64 number = mal_value_to_f64(value);
        // Number::toString(±0) is "0"; "%.15g" would render -0.0 as "-0".
        if (number == 0.0) {
            return mal_ops_string_from_ascii(heap, "0");
        }
        byte buffer[32];
        snprintf(buffer, sizeof(buffer), "%.15g", number);
        return mal_ops_string_from_ascii(heap, buffer);
    }

    return mal_ops_string_from_ascii(heap, "[object Object]");
}

f64 mal_ops_to_number(MalValue value) {
    if (mal_value_is_int32(value)) {
        return mal_value_to_i32(value);
    }

    if (value == MAL_VALUE_POSITIVE_INFINITY) {
        return INFINITY;
    }
    if (value == MAL_VALUE_NEGATIVE_INFINITY) {
        return -INFINITY;
    }
    if (value == MAL_VALUE_NEGATIVE_ZERO) {
        return -0.0;
    }

    if (mal_value_is_f64(value)) {
        return mal_value_to_f64(value);
    }

    if (mal_value_is_nan(value)) {
        return NAN;
    }

    // Abstract ToNumber throws on BigInt, but Number(bigint) and the relational
    // operators rely on the numeric value; arithmetic/unary-plus paths that must
    // throw intercept BigInt before reaching here.
    if (mal_value_is_bigint(value)) {
        return (f64) mal_ops_bigint_of(value);
    }

    if (mal_value_is_null(value)) {
        return 0;
    }

    if (mal_value_is_boolean(value)) {
        return mal_value_to_boolean(value) ? 1 : 0;
    }

    if (mal_value_is_string(value)) {
        return mal_ops_to_f64(mal_ops_string_to_number(value));
    }

    return NAN;
}

static i32 mal_ops_to_i32(MalValue value) {
    if (mal_value_is_int32(value)) {
        return mal_value_to_i32(value);
    }

    f64 number = mal_ops_to_number(value);
    if (isnan(number) || isinf(number) || number == 0) {
        return 0;
    }

    return (i32) number;
}

MalValue mal_ops_number_value(f64 value) {
    if (isnan(value)) {
        return mal_value_new_nan();
    }

    // Negative zero is a distinct Number (Object.is, 1/x, sameValue) and must
    // not be canonicalized to the int32 +0 the next branch would produce. Keep
    // it as a raw f64 — the same encoding the interpreter stores for a `-0`
    // literal — so arithmetic that yields -0 (e.g. -1 * 0) and the compiled
    // backend's boundary boxing both preserve it.
    if (value == 0.0 && signbit(value)) {
        return mal_value_from_f64(value);
    }

    if (value >= INT32_MIN && value <= INT32_MAX && trunc(value) == value) {
        return mal_value_from_i32((i32) value);
    }

    // Also maps infinities to their static encodings.
    return mal_value_from_f64_convert_nan(value);
}

MalValue mal_ops_add(MalHeap *heap, MalValue left, MalValue right) {
    if (mal_value_is_string(left) || mal_value_is_string(right)) {
        MalString *left_string = mal_ops_to_string(heap, left);
        MalString *right_string = mal_ops_to_string(heap, right);
        usize left_length = mal_string_length(left_string);
        usize right_length = mal_string_length(right_string);
        usize length = left_length + right_length;
        c16 *code_units = mal_heap_alloc_raw(heap, sizeof(c16) * length);

        memcpy(code_units, mal_string_code_units(left_string), sizeof(c16) * left_length);
        memcpy(code_units + left_length, mal_string_code_units(right_string), sizeof(c16) * right_length);

        MalString *result = mal_string_new_copy(heap, code_units, length);
        return mal_value_from_string(result);
    }

    if (mal_value_is_int32(left) && mal_value_is_int32(right)) {
        // f64 sum keeps the result exact in int32 range and promotes to double
        // on overflow (spec ToNumber arithmetic), instead of wrapping.
        return mal_ops_number_value((f64) mal_value_to_i32(left) + (f64) mal_value_to_i32(right));
    }

    return mal_ops_number_value(mal_ops_to_number(left) + mal_ops_to_number(right));
}

static bool mal_ops_strict_equal_bool(MalValue left, MalValue right) {
    // NaN is never strictly equal to anything, including itself. This has to
    // run before the bitwise short-circuit below, since all NaNs share the
    // canonical MAL_VALUE_NAN encoding and would otherwise compare equal.
    if (mal_value_is_nan(left) || mal_value_is_nan(right)) {
        return false;
    }

    if (left == right) {
        return true;
    }

    if (mal_value_is_string(left) && mal_value_is_string(right)) {
        return mal_string_equals(mal_value_to_string(left), mal_value_to_string(right));
    }

    // BigInt is its own type: equal by value to another BigInt, never strictly
    // equal to a Number (heap pointers differ, so this must be explicit).
    if (mal_value_is_bigint(left) || mal_value_is_bigint(right)) {
        return mal_value_is_bigint(left) && mal_value_is_bigint(right) &&
            mal_ops_bigint_of(left) == mal_ops_bigint_of(right);
    }

    if (mal_value_is_f64_or_nan(left) && mal_value_is_f64_or_nan(right)) {
        return mal_ops_to_f64(left) == mal_ops_to_f64(right);
    }

    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        return mal_ops_to_f64(left) == mal_ops_to_f64(right);
    }

    return false;
}

static bool mal_ops_equal_bool(MalValue left, MalValue right) {
    if (mal_ops_strict_equal_bool(left, right)) {
        return true;
    }

    if (mal_value_is_nil(left) && mal_value_is_nil(right)) {
        return true;
    }

    if (mal_value_is_string(left) && mal_ops_is_number(right)) {
        return mal_ops_to_f64(mal_ops_string_to_number(left)) == mal_ops_to_f64(right);
    }

    if (mal_ops_is_number(left) && mal_value_is_string(right)) {
        return mal_ops_to_f64(left) == mal_ops_to_f64(mal_ops_string_to_number(right));
    }

    // BigInt loose equality across types compares mathematical values: against a
    // Number (NaN/Infinity never match), and against a String parsed as a BigInt
    // (a string that is not a valid BigInt never matches).
    if (mal_value_is_bigint(left) && mal_ops_is_number(right)) {
        return (f64) mal_ops_bigint_of(left) == mal_ops_to_f64(right);
    }
    if (mal_ops_is_number(left) && mal_value_is_bigint(right)) {
        return mal_ops_to_f64(left) == (f64) mal_ops_bigint_of(right);
    }
    if (mal_value_is_bigint(left) && mal_value_is_string(right)) {
        bool ok;
        MalString *string = mal_value_to_string(right);
        i128 parsed = mal_bigint_parse(mal_string_code_units(string), mal_string_length(string), &ok);
        return ok && mal_ops_bigint_of(left) == parsed;
    }
    if (mal_value_is_string(left) && mal_value_is_bigint(right)) {
        bool ok;
        MalString *string = mal_value_to_string(left);
        i128 parsed = mal_bigint_parse(mal_string_code_units(string), mal_string_length(string), &ok);
        return ok && parsed == mal_ops_bigint_of(right);
    }

    if (mal_value_is_boolean(left)) {
        return mal_ops_equal_bool(mal_value_from_i32(mal_value_to_boolean(left) ? 1 : 0), right);
    }

    if (mal_value_is_boolean(right)) {
        return mal_ops_equal_bool(left, mal_value_from_i32(mal_value_to_boolean(right) ? 1 : 0));
    }

    return false;
}

static bool mal_ops_relational_bool(MalValue left, MalValue right, i32 comparison) {
    if (mal_value_is_string(left) && mal_value_is_string(right)) {
        i32 string_comparison = mal_string_compare(mal_value_to_string(left), mal_value_to_string(right));
        switch (comparison) {
            case 0:
                return string_comparison < 0;
            case 1:
                return string_comparison <= 0;
            case 2:
                return string_comparison > 0;
            case 3:
                return string_comparison >= 0;
        }
    }

    // BigInt vs BigInt compares exact 128-bit values; mixed BigInt/Number falls
    // through to the f64 path below (to_number returns a BigInt's numeric value).
    if (mal_value_is_bigint(left) && mal_value_is_bigint(right)) {
        i128 l = mal_ops_bigint_of(left);
        i128 r = mal_ops_bigint_of(right);
        switch (comparison) {
            case 0:
                return l < r;
            case 1:
                return l <= r;
            case 2:
                return l > r;
            case 3:
                return l >= r;
        }
    }

    f64 left_number = mal_ops_to_number(left);
    f64 right_number = mal_ops_to_number(right);

    if (isnan(left_number) || isnan(right_number)) {
        return false;
    }

    switch (comparison) {
        case 0:
            return left_number < right_number;
        case 1:
            return left_number <= right_number;
        case 2:
            return left_number > right_number;
        case 3:
            return left_number >= right_number;
    }

    return false;
}

MalValue mal_ops_less_than(MalValue left, MalValue right) {
    return mal_value_new_boolean(mal_ops_relational_bool(left, right, 0));
}

MalValue mal_ops_less_equal(MalValue left, MalValue right) {
    return mal_value_new_boolean(mal_ops_relational_bool(left, right, 1));
}

MalValue mal_ops_greater_than(MalValue left, MalValue right) {
    return mal_value_new_boolean(mal_ops_relational_bool(left, right, 2));
}

MalValue mal_ops_greater_equal(MalValue left, MalValue right) {
    return mal_value_new_boolean(mal_ops_relational_bool(left, right, 3));
}

MalValue mal_ops_equal(MalValue left, MalValue right) {
    return mal_value_new_boolean(mal_ops_equal_bool(left, right));
}

MalValue mal_ops_not_equal(MalValue left, MalValue right) {
    return mal_value_new_boolean(!mal_ops_equal_bool(left, right));
}

MalValue mal_ops_strict_equal(MalValue left, MalValue right) {
    return mal_value_new_boolean(mal_ops_strict_equal_bool(left, right));
}

bool mal_ops_same_value(MalValue left, MalValue right) {
    // SameValue (7.2.10) differs from === only for Numbers: NaN equals NaN, and
    // +0 does not equal -0. Everything else (strings/BigInts by content, objects
    // by identity) matches strict equality.
    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        f64 x = mal_ops_number_as_f64(left);
        f64 y = mal_ops_number_as_f64(right);
        if (x != x || y != y) {
            return (x != x) && (y != y);
        }
        if (x == 0.0 && y == 0.0) {
            return signbit(x) == signbit(y);
        }
        return x == y;
    }
    return mal_ops_strict_equal_bool(left, right);
}

MalValue mal_ops_strict_not_equal(MalValue left, MalValue right) {
    return mal_value_new_boolean(!mal_ops_strict_equal_bool(left, right));
}

MalValue mal_ops_subtract(MalValue left, MalValue right) {
    if (mal_value_is_int32(left) && mal_value_is_int32(right)) {
        return mal_ops_number_value((f64) mal_value_to_i32(left) - (f64) mal_value_to_i32(right));
    }

    return mal_ops_number_value(mal_ops_to_number(left) - mal_ops_to_number(right));
}

MalValue mal_ops_multiply(MalValue left, MalValue right) {
    if (mal_value_is_int32(left) && mal_value_is_int32(right)) {
        // f64 product is the spec result (it rounds beyond 2^53 just like JS);
        // the old int32 multiply silently wrapped.
        return mal_ops_number_value((f64) mal_value_to_i32(left) * (f64) mal_value_to_i32(right));
    }

    return mal_ops_number_value(mal_ops_to_number(left) * mal_ops_to_number(right));
}

MalValue mal_ops_divide(MalValue left, MalValue right) {
    return mal_ops_number_value(mal_ops_to_number(left) / mal_ops_to_number(right));
}

MalValue mal_ops_remainder(MalValue left, MalValue right) {
    return mal_ops_number_value(fmod(mal_ops_to_number(left), mal_ops_to_number(right)));
}

MalValue mal_ops_exponentiate(MalValue left, MalValue right) {
    double base = mal_ops_to_number(left);
    double exponent = mal_ops_to_number(right);

    // Number::exponentiate deviates from C pow in two cases: a NaN exponent is
    // always NaN (C returns 1 for pow(1, NaN)), and an infinite exponent with a
    // base of magnitude 1 is NaN (C returns 1).
    if (isnan(exponent) || (isinf(exponent) && (base == 1.0 || base == -1.0))) {
        return mal_ops_number_value(NAN);
    }

    return mal_ops_number_value(pow(base, exponent));
}

MalValue mal_ops_bit_and(MalValue left, MalValue right) {
    return mal_value_from_i32(mal_ops_to_i32(left) & mal_ops_to_i32(right));
}

MalValue mal_ops_bit_or(MalValue left, MalValue right) {
    return mal_value_from_i32(mal_ops_to_i32(left) | mal_ops_to_i32(right));
}

MalValue mal_ops_bit_xor(MalValue left, MalValue right) {
    return mal_value_from_i32(mal_ops_to_i32(left) ^ mal_ops_to_i32(right));
}

MalValue mal_ops_shift_left(MalValue left, MalValue right) {
    return mal_value_from_i32(mal_ops_to_i32(left) << (mal_ops_to_i32(right) & 0x1F));
}

MalValue mal_ops_shift_right(MalValue left, MalValue right) {
    return mal_value_from_i32(mal_ops_to_i32(left) >> (mal_ops_to_i32(right) & 0x1F));
}

MalValue mal_ops_shift_right_unsigned(MalValue left, MalValue right) {
    u32 result = (u32) mal_ops_to_i32(left) >> (mal_ops_to_i32(right) & 0x1F);

    if ((result & (u32) MASK_UINT32_SIGN) == 0) {
        return mal_value_from_i32((i32) result);
    }

    return mal_value_from_f64(result);
}
