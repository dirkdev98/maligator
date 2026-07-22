#include "value.h"
#include "value_ops.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "bigint128.h"
#include "ecma_whitespace.h"
#include "heap_bigint.h"
#include "heap_string.h"

f64 mal_ops_number_to_integer_or_infinity(f64 number) {
    if (isnan(number) || number == 0.0) {
        return 0.0;
    }
    return trunc(number);
}

f64 mal_ops_number_to_length(f64 number) {
    f64 integer = mal_ops_number_to_integer_or_infinity(number);
    if (integer <= 0.0) {
        return 0.0;
    }
    return integer > MAL_NUMBER_MAX_SAFE_INTEGER ? MAL_NUMBER_MAX_SAFE_INTEGER : integer;
}

f64 mal_ops_number_clamp_relative(f64 number, f64 length) {
    f64 relative = mal_ops_number_to_integer_or_infinity(number);
    if (relative < 0.0) {
        relative += length;
    }
    if (relative <= 0.0) {
        return 0.0;
    }
    return relative > length ? length : relative;
}

u64 mal_ops_number_to_uint_width(f64 number, u32 width) {
    if (!isfinite(number) || number == 0.0) {
        return 0;
    }
    // Callers use integer element widths no larger than 32 bits, for which both
    // the modulus and every remainder are represented exactly by f64.
    f64 modulus = ldexp(1.0, (i32) width);
    f64 remainder = fmod(trunc(number), modulus);
    if (remainder < 0.0) {
        remainder += modulus;
    }
    return (u64) remainder;
}

u32 mal_ops_number_to_uint32(f64 number) {
    return (u32) mal_ops_number_to_uint_width(number, 32);
}

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

static int mal_ops_string_number_digit(char c) {
    if (c >= '0' && c <= '9') {
        return c - '0';
    }
    if (c >= 'a' && c <= 'f') {
        return c - 'a' + 10;
    }
    if (c >= 'A' && c <= 'F') {
        return c - 'A' + 10;
    }
    return -1;
}

// StringToNumber (7.1.4.1) over the StrNumericLiteral grammar — deliberately NOT
// strtod, which would wrongly accept "inf"/"nan" and reject 0b/0o literals.
static MalValue mal_ops_string_to_number(MalValue value) {
    MalString *string = mal_value_to_string(value);
    usize length = mal_string_length(string);
    const c16 *code_units = mal_string_code_units(string);
    usize unit_start = 0;
    usize unit_end = length;
    while (unit_start < unit_end && mal_ecma_is_string_whitespace(code_units[unit_start])) {
        unit_start++;
    }
    while (unit_end > unit_start && mal_ecma_is_string_whitespace(code_units[unit_end - 1])) {
        unit_end--;
    }
    usize token_length = unit_end - unit_start;
    byte *bytes = malloc(token_length + 1);

    for (usize i = 0; i < token_length; i++) {
        if (code_units[unit_start + i] > 0x7F) {
            free(bytes);
            return mal_value_new_nan();
        }
        bytes[i] = (byte) code_units[unit_start + i];
    }
    bytes[token_length] = '\0';

    char *start = bytes;
    char *end = bytes + token_length;

    // Empty (or all-whitespace) string is +0.
    if (token_length == 0) {
        free(bytes);
        return mal_value_from_i32(0);
    }

    // Infinity literals (signed); the bare tokens only — no "inf"/"infinity".
    if (strcmp(start, "Infinity") == 0 || strcmp(start, "+Infinity") == 0) {
        free(bytes);
        return mal_ops_number_value((f64) INFINITY);
    }
    if (strcmp(start, "-Infinity") == 0) {
        free(bytes);
        return mal_ops_number_value((f64) -INFINITY);
    }

    // NonDecimalIntegerLiteral: 0x/0X (hex), 0o/0O (octal), 0b/0B (binary), no sign.
    if (token_length > 2 && start[0] == '0') {
        int base = 0;
        if (start[1] == 'x' || start[1] == 'X') {
            base = 16;
        } else if (start[1] == 'o' || start[1] == 'O') {
            base = 8;
        } else if (start[1] == 'b' || start[1] == 'B') {
            base = 2;
        }
        if (base != 0) {
            f64 number = 0;
            for (char *p = start + 2; p < end; p++) {
                int digit = mal_ops_string_number_digit(*p);
                if (digit < 0 || digit >= base) {
                    free(bytes);
                    return mal_value_new_nan();
                }
                number = number * (f64) base + (f64) digit;
            }
            free(bytes);
            return mal_ops_number_value(number);
        }
    }

    // StrDecimalLiteral: restrict to its character set so strtod cannot fall back
    // to recognizing "inf"/"nan" (a genuine overflow like "1e400" stays Infinity).
    for (char *p = start; p < end; p++) {
        char c = *p;
        if (!((c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-')) {
            free(bytes);
            return mal_value_new_nan();
        }
    }

    char *parsed_end = start;
    f64 number = strtod(start, &parsed_end);
    if (parsed_end != end) {
        free(bytes);
        return mal_value_new_nan();
    }

    free(bytes);
    return mal_ops_number_value(number);
}

// Render a finite, non-zero f64 per ECMAScript Number::toString (7.1.12.1) into
// `out`, which must hold at least 32 bytes. Produces the shortest decimal digit
// string that round-trips to the same double (found by trying increasing
// precision against a correctly-rounded strtod), then places the decimal point
// / exponent exactly as the spec's cases 5-10 require.
static void mal_ops_f64_to_ecma_string(f64 value, byte *out) {
    byte *p = out;
    if (signbit(value)) {
        *p++ = '-';
        value = -value;
    }

    // Shortest significant digits: the smallest precision whose decimal rounds
    // back to `value`. 17 significant digits always suffice for a double.
    char formatted[40];
    for (int prec = 1; prec <= 17; prec++) {
        snprintf(formatted, sizeof(formatted), "%.*e", prec - 1, value);
        if (strtod(formatted, nullptr) == value) {
            break;
        }
    }

    // formatted is "d.ddde±XX" (or "de±XX" at precision 1); split it into the
    // significant digit run and the base-10 exponent of the leading digit.
    char digits[20];
    int k = 0;
    char *cursor = formatted;
    digits[k++] = *cursor++;
    if (*cursor == '.') {
        cursor++;
        while (*cursor != 'e' && *cursor != 'E') {
            digits[k++] = *cursor++;
        }
    }
    int exponent = (int) strtol(cursor + 1, nullptr, 10);

    // Trailing zeros are never significant for round-tripping (defensive).
    while (k > 1 && digits[k - 1] == '0') {
        k--;
    }

    // n is the position of the decimal point counted from before the first
    // significant digit (value == digits × 10^(n-k)).
    int n = exponent + 1;

    if (k <= n && n <= 21) {
        for (int i = 0; i < k; i++) {
            *p++ = (byte) digits[i];
        }
        for (int i = 0; i < n - k; i++) {
            *p++ = '0';
        }
    } else if (0 < n && n <= 21) {
        for (int i = 0; i < n; i++) {
            *p++ = (byte) digits[i];
        }
        *p++ = '.';
        for (int i = n; i < k; i++) {
            *p++ = (byte) digits[i];
        }
    } else if (-6 < n && n <= 0) {
        *p++ = '0';
        *p++ = '.';
        for (int i = 0; i < -n; i++) {
            *p++ = '0';
        }
        for (int i = 0; i < k; i++) {
            *p++ = (byte) digits[i];
        }
    } else {
        *p++ = (byte) digits[0];
        if (k > 1) {
            *p++ = '.';
            for (int i = 1; i < k; i++) {
                *p++ = (byte) digits[i];
            }
        }
        *p++ = 'e';
        int e = n - 1;
        *p++ = e >= 0 ? '+' : '-';
        if (e < 0) {
            e = -e;
        }
        char exp_digits[8];
        snprintf(exp_digits, sizeof(exp_digits), "%d", e);
        for (int i = 0; exp_digits[i] != '\0'; i++) {
            *p++ = (byte) exp_digits[i];
        }
    }

    *p = '\0';
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
        // Number::toString(±0) is "0".
        if (number == 0.0) {
            return mal_ops_string_from_ascii(heap, "0");
        }
        byte buffer[32];
        mal_ops_f64_to_ecma_string(number, buffer);
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

    return mal_ops_number_to_i32(mal_ops_to_number(value));
}

// mal_ops_number_value is now static inline in value_ops.h (inlined into the
// emitted native-C backend's boundary boxing).

bool mal_ops_add_checked(MalHeap *heap, MalValue left, MalValue right, MalValue *out) {
    if (mal_value_is_string(left) || mal_value_is_string(right)) {
        MalString *left_string = mal_ops_to_string(heap, left);
        MalString *right_string = mal_ops_to_string(heap, right);
        usize left_length = mal_string_length(left_string);
        usize right_length = mal_string_length(right_string);
        if (left_length == 0) {
            *out = mal_value_from_string(right_string);
            return true;
        }
        if (right_length == 0) {
            *out = mal_value_from_string(left_string);
            return true;
        }
        MalString *result;
        if (!mal_string_new_cons_checked(heap, left_string, right_string, &result)) {
            return false;
        }
        *out = mal_value_from_string(result);
        return true;
    }

    if (mal_value_is_int32(left) && mal_value_is_int32(right)) {
        // f64 sum keeps the result exact in int32 range and promotes to double
        // on overflow (spec ToNumber arithmetic), instead of wrapping.
        *out = mal_ops_number_value((f64) mal_value_to_i32(left) + (f64) mal_value_to_i32(right));
        return true;
    }

    *out = mal_ops_number_value(mal_ops_to_number(left) + mal_ops_to_number(right));
    return true;
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
        i128 parsed = mal_bigint128_parse(mal_string_code_units(string), mal_string_length(string), &ok);
        return ok && mal_ops_bigint_of(left) == parsed;
    }
    if (mal_value_is_string(left) && mal_value_is_bigint(right)) {
        bool ok;
        MalString *string = mal_value_to_string(left);
        i128 parsed = mal_bigint128_parse(mal_string_code_units(string), mal_string_length(string), &ok);
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
    return mal_ops_number_value(
        mal_number_remainder(mal_ops_to_number(left), mal_ops_to_number(right)));
}

MalValue mal_ops_exponentiate(MalValue left, MalValue right) {
    return mal_ops_number_value(
        mal_number_exponentiate(mal_ops_to_number(left), mal_ops_to_number(right)));
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
    u32 result = (u32) mal_ops_to_i32(left) << (mal_ops_to_i32(right) & 0x1F);
    return mal_value_from_i32(mal_ops_u32_to_i32(result));
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
