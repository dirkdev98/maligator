#include "number_format.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#define MAL_DECIMAL_BASE 1000000000u
#define MAL_DECIMAL_LIMBS 96
#define MAL_DECIMAL_DIGITS 800

typedef struct {
    u32 limbs[MAL_DECIMAL_LIMBS];
    usize length;
} MalDecimalBigInt;

typedef struct {
    byte digits[MAL_DECIMAL_DIGITS];
    i32 length;
    i32 scale;
    i32 exponent;
} MalExactDecimal;

typedef struct {
    byte digits[110];
    i32 length;
    i32 exponent;
} MalRoundedDecimal;

static void mal_decimal_big_init(MalDecimalBigInt *value, u64 initial) {
    value->length = 0;
    do {
        value->limbs[value->length++] = (u32) (initial % MAL_DECIMAL_BASE);
        initial /= MAL_DECIMAL_BASE;
    } while (initial != 0);
}

static void mal_decimal_big_multiply(MalDecimalBigInt *value, u32 factor) {
    u64 carry = 0;
    for (usize i = 0; i < value->length; i++) {
        u64 product = (u64) value->limbs[i] * factor + carry;
        value->limbs[i] = (u32) (product % MAL_DECIMAL_BASE);
        carry = product / MAL_DECIMAL_BASE;
    }
    while (carry != 0) {
        value->limbs[value->length++] = (u32) (carry % MAL_DECIMAL_BASE);
        carry /= MAL_DECIMAL_BASE;
    }
}

static void mal_decimal_big_multiply_power_two(MalDecimalBigInt *value, i32 exponent) {
    while (exponent >= 29) {
        mal_decimal_big_multiply(value, 1u << 29);
        exponent -= 29;
    }
    if (exponent > 0) {
        mal_decimal_big_multiply(value, 1u << exponent);
    }
}

static void mal_decimal_big_multiply_power_five(MalDecimalBigInt *value, i32 exponent) {
    while (exponent >= 13) {
        mal_decimal_big_multiply(value, 1220703125u); // 5^13
        exponent -= 13;
    }
    static const u32 powers[] = {
        1u, 5u, 25u, 125u, 625u, 3125u, 15625u,
        78125u, 390625u, 1953125u, 9765625u, 48828125u, 244140625u,
    };
    if (exponent > 0) {
        mal_decimal_big_multiply(value, powers[exponent]);
    }
}

static usize mal_decimal_write_u32(u32 value, byte *out) {
    byte reversed[10];
    usize length = 0;
    do {
        reversed[length++] = (byte) ('0' + value % 10u);
        value /= 10u;
    } while (value != 0);
    for (usize i = 0; i < length; i++) {
        out[i] = reversed[length - i - 1];
    }
    return length;
}

static void mal_decimal_exact(f64 number, MalExactDecimal *out) {
    u64 bits;
    memcpy(&bits, &number, sizeof(bits));
    u64 fraction = bits & 0x000FFFFFFFFFFFFFull;
    i32 raw_exponent = (i32) ((bits >> 52) & 0x7FFu);
    u64 significand;
    i32 exponent_two;
    if (raw_exponent == 0) {
        significand = fraction;
        exponent_two = -1074;
    } else {
        significand = fraction | 0x0010000000000000ull;
        exponent_two = raw_exponent - 1023 - 52;
    }

    if (significand == 0) {
        out->digits[0] = '0';
        out->digits[1] = '\0';
        out->length = 1;
        out->scale = 0;
        out->exponent = 0;
        return;
    }

    MalDecimalBigInt integer;
    mal_decimal_big_init(&integer, significand);
    i32 scale = 0;
    if (exponent_two >= 0) {
        mal_decimal_big_multiply_power_two(&integer, exponent_two);
    } else {
        scale = -exponent_two;
        mal_decimal_big_multiply_power_five(&integer, scale);
    }

    usize write = 0;
    write += mal_decimal_write_u32(integer.limbs[integer.length - 1], out->digits + write);
    for (usize i = integer.length - 1; i-- > 0;) {
        u32 limb = integer.limbs[i];
        for (i32 digit = 8; digit >= 0; digit--) {
            out->digits[write + digit] = (byte) ('0' + limb % 10u);
            limb /= 10u;
        }
        write += 9;
    }

    while (scale > 0 && write > 1 && out->digits[write - 1] == '0') {
        write--;
        scale--;
    }
    out->digits[write] = '\0';
    out->length = (i32) write;
    out->scale = scale;
    out->exponent = out->length - scale - 1;
}

static bool mal_decimal_should_round_up(
    const MalExactDecimal *exact,
    i32 keep,
    bool ties_to_even
) {
    if (keep >= exact->length) return false;
    byte first = exact->digits[keep];
    if (first > '5') return true;
    if (first < '5') return false;
    for (i32 i = keep + 1; i < exact->length; i++) {
        if (exact->digits[i] != '0') return true;
    }
    return ties_to_even ? ((exact->digits[keep - 1] - '0') & 1u) != 0 : true;
}

static void mal_decimal_increment(byte *digits, i32 length, i32 *exponent) {
    for (i32 i = length - 1; i >= 0; i--) {
        if (digits[i] != '9') {
            digits[i]++;
            return;
        }
        digits[i] = '0';
    }
    digits[0] = '1';
    for (i32 i = 1; i < length; i++) digits[i] = '0';
    (*exponent)++;
}

static void mal_decimal_round_significant(
    const MalExactDecimal *exact,
    i32 precision,
    bool ties_to_even,
    MalRoundedDecimal *out
) {
    out->length = precision;
    out->exponent = exact->exponent;
    i32 copy = exact->length < precision ? exact->length : precision;
    memcpy(out->digits, exact->digits, (usize) copy);
    for (i32 i = copy; i < precision; i++) out->digits[i] = '0';
    if (mal_decimal_should_round_up(exact, precision, ties_to_even)) {
        mal_decimal_increment(out->digits, precision, &out->exponent);
    }
    out->digits[precision] = '\0';
}

static usize mal_decimal_write_exponent(i32 exponent, byte *out) {
    usize write = 0;
    out[write++] = 'e';
    if (exponent < 0) {
        out[write++] = '-';
        exponent = -exponent;
    } else {
        out[write++] = '+';
    }
    write += mal_decimal_write_u32((u32) exponent, out + write);
    return write;
}

static usize mal_decimal_render_scientific(
    const byte *digits,
    i32 length,
    i32 exponent,
    byte *out
) {
    usize write = 0;
    out[write++] = digits[0];
    if (length > 1) {
        out[write++] = '.';
        memcpy(out + write, digits + 1, (usize) (length - 1));
        write += (usize) (length - 1);
    }
    write += mal_decimal_write_exponent(exponent, out + write);
    out[write] = '\0';
    return write;
}

static void mal_decimal_trim(MalRoundedDecimal *decimal) {
    while (decimal->length > 1 && decimal->digits[decimal->length - 1] == '0') {
        decimal->length--;
    }
    decimal->digits[decimal->length] = '\0';
}

static bool mal_decimal_roundtrips(
    f64 number,
    const MalRoundedDecimal *decimal,
    byte *candidate
) {
    mal_decimal_render_scientific(
        decimal->digits, decimal->length, decimal->exponent, candidate);
    char *end = nullptr;
    f64 parsed = strtod((char *) candidate, &end);
    return end != (char *) candidate && *end == '\0' && parsed == number;
}

static void mal_decimal_shortest(f64 number, MalRoundedDecimal *out) {
    MalExactDecimal exact;
    mal_decimal_exact(number, &exact);
    byte candidate[64];
    // For a fixed precision, the decimal candidates that round to `number` form
    // an interval. The closest candidate to the exact value is therefore in that
    // interval whenever any candidate at that precision is; ties select an even
    // final digit as required by Number::toString.
    for (i32 precision = 1; precision <= 17; precision++) {
        MalRoundedDecimal rounded;
        mal_decimal_round_significant(&exact, precision, true, &rounded);
        mal_decimal_trim(&rounded);
        if (mal_decimal_roundtrips(number, &rounded, candidate)) {
            *out = rounded;
            return;
        }
    }
    mal_decimal_round_significant(&exact, 17, true, out);
    mal_decimal_trim(out);
}

usize mal_number_format_shortest(f64 number, byte *out) {
    bool negative = number < 0.0;
    if (negative) number = -number;
    MalRoundedDecimal decimal;
    mal_decimal_shortest(number, &decimal);
    usize write = 0;
    if (negative) out[write++] = '-';
    i32 point = decimal.exponent + 1;
    if (decimal.length <= point && point <= 21) {
        memcpy(out + write, decimal.digits, (usize) decimal.length);
        write += (usize) decimal.length;
        for (i32 i = decimal.length; i < point; i++) out[write++] = '0';
    } else if (0 < point && point <= 21) {
        memcpy(out + write, decimal.digits, (usize) point);
        write += (usize) point;
        out[write++] = '.';
        memcpy(out + write, decimal.digits + point, (usize) (decimal.length - point));
        write += (usize) (decimal.length - point);
    } else if (-6 < point && point <= 0) {
        out[write++] = '0';
        out[write++] = '.';
        for (i32 i = 0; i < -point; i++) out[write++] = '0';
        memcpy(out + write, decimal.digits, (usize) decimal.length);
        write += (usize) decimal.length;
    } else {
        write += mal_decimal_render_scientific(
            decimal.digits, decimal.length, decimal.exponent, out + write);
    }
    out[write] = '\0';
    return write;
}

static i32 mal_decimal_round_fixed_integer(
    const MalExactDecimal *exact,
    i32 fraction_digits,
    byte *digits
) {
    if (exact->scale <= fraction_digits) {
        memcpy(digits, exact->digits, (usize) exact->length);
        i32 length = exact->length;
        for (i32 i = exact->scale; i < fraction_digits; i++) digits[length++] = '0';
        digits[length] = '\0';
        return length;
    }

    i32 discarded = exact->scale - fraction_digits;
    i32 keep = exact->length - discarded;
    if (keep <= 0) {
        bool round_up = keep == 0 && exact->digits[0] >= '5';
        digits[0] = round_up ? '1' : '0';
        digits[1] = '\0';
        return 1;
    }

    memcpy(digits, exact->digits, (usize) keep);
    i32 exponent = 0;
    if (mal_decimal_should_round_up(exact, keep, false)) {
        mal_decimal_increment(digits, keep, &exponent);
        if (exponent != 0) {
            // A carry from 99.. rounds to 100.. and increases the integer length.
            digits[keep] = '0';
            keep++;
        }
    }
    digits[keep] = '\0';
    return keep;
}

usize mal_number_format_fixed(f64 number, i32 fraction_digits, byte *out) {
    bool negative = number < 0.0;
    if (negative) number = -number;
    MalExactDecimal exact;
    mal_decimal_exact(number, &exact);
    byte integer[140];
    i32 integer_length = mal_decimal_round_fixed_integer(&exact, fraction_digits, integer);

    usize write = 0;
    if (negative) out[write++] = '-';
    if (fraction_digits == 0) {
        memcpy(out + write, integer, (usize) integer_length);
        write += (usize) integer_length;
        out[write] = '\0';
        return write;
    }

    if (integer_length <= fraction_digits) {
        out[write++] = '0';
        out[write++] = '.';
        for (i32 i = integer_length; i < fraction_digits; i++) out[write++] = '0';
        memcpy(out + write, integer, (usize) integer_length);
        write += (usize) integer_length;
    } else {
        i32 whole = integer_length - fraction_digits;
        memcpy(out + write, integer, (usize) whole);
        write += (usize) whole;
        out[write++] = '.';
        memcpy(out + write, integer + whole, (usize) fraction_digits);
        write += (usize) fraction_digits;
    }
    out[write] = '\0';
    return write;
}

usize mal_number_format_exponential(
    f64 number,
    i32 fraction_digits,
    bool shortest,
    byte *out
) {
    bool negative = number < 0.0;
    if (negative) number = -number;
    MalRoundedDecimal decimal;
    if (number == 0.0) {
        decimal.exponent = 0;
        decimal.length = shortest ? 1 : fraction_digits + 1;
        for (i32 i = 0; i < decimal.length; i++) decimal.digits[i] = '0';
        decimal.digits[decimal.length] = '\0';
    } else if (shortest) {
        mal_decimal_shortest(number, &decimal);
    } else {
        MalExactDecimal exact;
        mal_decimal_exact(number, &exact);
        mal_decimal_round_significant(&exact, fraction_digits + 1, false, &decimal);
    }
    usize write = 0;
    if (negative) out[write++] = '-';
    write += mal_decimal_render_scientific(
        decimal.digits, decimal.length, decimal.exponent, out + write);
    out[write] = '\0';
    return write;
}

usize mal_number_format_precision(f64 number, i32 precision, byte *out) {
    bool negative = number < 0.0;
    if (negative) number = -number;
    MalRoundedDecimal decimal;
    if (number == 0.0) {
        decimal.exponent = 0;
        decimal.length = precision;
        for (i32 i = 0; i < precision; i++) decimal.digits[i] = '0';
        decimal.digits[precision] = '\0';
    } else {
        MalExactDecimal exact;
        mal_decimal_exact(number, &exact);
        mal_decimal_round_significant(&exact, precision, false, &decimal);
    }

    usize write = 0;
    if (negative) out[write++] = '-';
    if (decimal.exponent < -6 || decimal.exponent >= precision) {
        write += mal_decimal_render_scientific(
            decimal.digits, decimal.length, decimal.exponent, out + write);
    } else if (decimal.exponent == precision - 1) {
        memcpy(out + write, decimal.digits, (usize) decimal.length);
        write += (usize) decimal.length;
    } else if (decimal.exponent >= 0) {
        i32 whole = decimal.exponent + 1;
        memcpy(out + write, decimal.digits, (usize) whole);
        write += (usize) whole;
        out[write++] = '.';
        memcpy(out + write, decimal.digits + whole, (usize) (precision - whole));
        write += (usize) (precision - whole);
    } else {
        out[write++] = '0';
        out[write++] = '.';
        for (i32 i = 0; i < -decimal.exponent - 1; i++) out[write++] = '0';
        memcpy(out + write, decimal.digits, (usize) precision);
        write += (usize) precision;
    }
    out[write] = '\0';
    return write;
}
