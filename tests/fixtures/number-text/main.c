#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "number_text.h"

#define CHECK(condition) \
    do { \
        if (!(condition)) { \
            printf("%s:%d CHECK FAIL: %s\n", __func__, __LINE__, #condition); \
            return false; \
        } \
    } while (0)

static bool same_bits(f64 left, f64 right) {
    u64 a, b;
    memcpy(&a, &left, sizeof(a));
    memcpy(&b, &right, sizeof(b));
    return a == b;
}

static bool agrees_with_strtod(const char *text) {
    usize length = strlen(text);
    if (mal_number_decimal_prefix_length(text, length) != length) {
        printf("prefix rejects %s\n", text);
        return false;
    }
    f64 expected = strtod(text, nullptr);
    f64 actual = mal_number_parse_decimal(text, length);
    if (!same_bits(actual, expected)) {
        printf("parse %s: expected %.17g got %.17g\n", text, expected, actual);
        return false;
    }
    return true;
}

static bool prefixes_follow_the_decimal_grammar(void) {
    static const struct {
        const char *text;
        usize prefix;
    } cases[] = {
        {"", 0}, {"+", 0}, {"-", 0}, {".", 0}, {"+.e1", 0}, {"e5", 0}, {"Infinity", 0},
        {"1", 1}, {"1.", 2}, {".5", 2}, {"-.5x", 3}, {"1e", 1}, {"1e+", 1}, {"1E-x", 1},
        {"1.e5x", 4}, {"-12.5E-3abc", 8}, {"00012", 5}, {"1.2.3", 3}, {"1e5e5", 3},
        {"+0.0e+0", 7},
    };
    for (usize i = 0; i < countof(cases); i++) {
        usize length = strlen(cases[i].text);
        if (mal_number_decimal_prefix_length(cases[i].text, length) != cases[i].prefix) {
            printf("prefix of \"%s\" is not %zu\n", cases[i].text, cases[i].prefix);
            return false;
        }
    }
    // Embedded terminators and bytes above ASCII end the literal.
    CHECK(mal_number_decimal_prefix_length("12\0" "3", 4) == 2);
    CHECK(mal_number_decimal_prefix_length("4\xb2", 2) == 1);
    return true;
}

static bool boundary_values_round_like_strtod(void) {
    static const char *const cases[] = {
        "0", "-0", "0.0", "-0.0e5", "1", "-1", "0.1", "0.2", "0.3", "1.5", "98.6",
        "3.14159265358979", "2.718281828459045", "1e22", "1e23", "-1e22", "1e-22",
        "1e-23", "123456789e15", "123456789e25", "9007199254740992", "9007199254740993",
        "9007199254740995", "18014398509481985", "12345678901234567890",
        "123456789012345678901234567890", "0.000000000000000000000000000001",
        "4.9e-324", "2.4703282292062327e-324", "2.4703282292062328e-324",
        "2.2250738585072014e-308", "2.2250738585072011e-308",
        "1.7976931348623157e308", "1.7976931348623158e308", "1e309", "-1e309", "1e-400",
        "00000.0001e4", "5.", ".5", "+.25", "1e+0", "1E-0", "7e0000000000000000000000001",
        "1e-99999999999", "0e99999999999", "0.5e-22", "50000000000000000e-38",
        "4503599627370496.5", "4503599627370497.5", "1.00000000000000011102230246251565",
    };
    for (usize i = 0; i < countof(cases); i++) {
        if (!agrees_with_strtod(cases[i])) return false;
    }
    return true;
}

static u64 next_random(u64 *state) {
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    return *state;
}

static bool generated_literals_round_like_strtod(void) {
    u64 state = 0x9e3779b97f4a7c15ULL;
    char text[96];
    for (usize round = 0; round < 200000; round++) {
        usize length = 0;
        u64 bits = next_random(&state);
        if (bits & 1) text[length++] = (bits & 2) ? '-' : '+';
        usize integer_digits = (bits >> 2) % 21;
        usize fraction_digits = (bits >> 8) % 21;
        if (integer_digits + fraction_digits == 0) integer_digits = 1;
        for (usize i = 0; i < integer_digits; i++) {
            u64 digit = next_random(&state);
            // Mostly short mantissas exercise the exact path; long runs of
            // nines and zeros exercise truncation and rounding boundaries.
            text[length++] = (char) ('0' + ((digit & 7) == 0 ? 9 : (digit & 7) == 1 ? 0 : digit % 10));
        }
        if (fraction_digits != 0 || (bits & 0x4000)) {
            text[length++] = '.';
            for (usize i = 0; i < fraction_digits; i++) {
                text[length++] = (char) ('0' + next_random(&state) % 10);
            }
        }
        if (bits & 0x8000) {
            text[length++] = (bits & 0x10000) ? 'e' : 'E';
            if (bits & 0x20000) text[length++] = (bits & 0x40000) ? '-' : '+';
            i64 exponent = (i64) ((bits >> 20) % 60);
            length += (usize) snprintf(text + length, sizeof(text) - length, "%lld", (long long) exponent);
        }
        text[length] = '\0';
        if (!agrees_with_strtod(text)) return false;
    }
    return true;
}

/** Number::toString through libc: the first precision whose correctly rounded
 * digits round-trip is the shortest, closest representation. */
static void reference_shortest_plain(f64 value, char *out) {
    char scientific[40];
    for (int precision = 1; precision <= 17; precision++) {
        snprintf(scientific, sizeof(scientific), "%.*e", precision - 1, value);
        if (strtod(scientific, nullptr) == value) break;
    }
    const char *cursor = scientific;
    usize length = 0;
    if (*cursor == '-') out[length++] = *cursor++;
    char digits[24];
    usize count = 0;
    for (; *cursor != 'e'; cursor++) {
        if (*cursor != '.') digits[count++] = *cursor;
    }
    while (count > 1 && digits[count - 1] == '0') count--;
    int point = atoi(cursor + 1) + 1;
    if (point <= 0) {
        out[length++] = '0';
        out[length++] = '.';
        for (int i = point; i < 0; i++) out[length++] = '0';
        for (usize i = 0; i < count; i++) out[length++] = digits[i];
    } else {
        for (int i = 0; i < point || (usize) i < count; i++) {
            if (i == point) out[length++] = '.';
            out[length++] = (usize) i < count ? digits[i] : '0';
        }
    }
    out[length] = '\0';
}

static bool formats_like_reference(f64 value) {
    char actual[33];
    usize length = mal_number_format_shortest_plain(value, actual);
    if (length == 0) return true;
    actual[length] = '\0';
    char expected[48];
    reference_shortest_plain(value, expected);
    if (strcmp(actual, expected) != 0) {
        printf("format %.17g: expected %s got %s\n", value, expected, actual);
        return false;
    }
    return true;
}

static bool plain_formatting_handles_common_values(void) {
    static const struct {
        f64 value;
        const char *text;
    } accepted[] = {
        {0.1, "0.1"}, {19.99, "19.99"}, {-42.5, "-42.5"}, {0.000123, "0.000123"},
        {0.125, "0.125"}, {1e-6, "0.000001"}, {1790978131258.0, "1790978131258"},
        {9007199254740991.0, "9007199254740991"}, {4294967296.5, "4294967296.5"},
        {123000.0, "123000"}, {3.14159265, "3.14159265"},
    };
    for (usize i = 0; i < countof(accepted); i++) {
        char actual[33];
        usize length = mal_number_format_shortest_plain(accepted[i].value, actual);
        actual[length] = '\0';
        if (strcmp(actual, accepted[i].text) != 0) {
            printf("plain %.17g: expected %s got \"%s\"\n", accepted[i].value, accepted[i].text, actual);
            return false;
        }
    }
    // Long fractions, exponent notation and inexact integers stay with the
    // general formatter.
    static const f64 declined[] = {
        0.30000000000000004, 1.0 / 3.0, 9.999999e-7, 1e21, 9007199254740992.0, 0.0, NAN, INFINITY,
    };
    char scratch[33];
    for (usize i = 0; i < countof(declined); i++) {
        CHECK(mal_number_format_shortest_plain(declined[i], scratch) == 0);
    }
    return true;
}

static bool generated_values_format_like_reference(void) {
    u64 state = 0x2545f4914f6cdd1dULL;
    char text[48];
    for (usize round = 0; round < 300000; round++) {
        u64 bits = next_random(&state);
        usize digits = 1 + bits % 15;
        usize fraction = (bits >> 4) % 10;
        if (fraction > digits) fraction = digits;
        usize length = 0;
        if (bits & 0x100) text[length++] = '-';
        for (usize i = 0; i < digits; i++) {
            if (i == digits - fraction && fraction != 0) {
                if (i == 0) text[length++] = '0';
                text[length++] = '.';
            }
            text[length++] = (char) ('0' + next_random(&state) % 10);
        }
        text[length] = '\0';
        if (!formats_like_reference(strtod(text, nullptr))) return false;

        f64 integer = (f64) (next_random(&state) >> (11 + (bits >> 9) % 40));
        if (!formats_like_reference(integer)) return false;

        u64 raw = next_random(&state);
        f64 arbitrary;
        memcpy(&arbitrary, &raw, sizeof(arbitrary));
        if (!formats_like_reference(arbitrary)) return false;
        f64 halves = (f64) (raw >> 20) / (f64) ((u64) 1 << (1 + (bits >> 13) % 20));
        if (!formats_like_reference(halves)) return false;
    }
    return true;
}

int main(void) {
    bool passed = prefixes_follow_the_decimal_grammar()
        && boundary_values_round_like_strtod()
        && generated_literals_round_like_strtod()
        && plain_formatting_handles_common_values()
        && generated_values_format_like_reference();
    if (!passed) return 1;
    puts("number-text PASS");
    return 0;
}
