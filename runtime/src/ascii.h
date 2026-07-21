#pragma once

#include <string.h>

#include "heap_string.h"

static inline bool mal_ascii_is_alpha(c16 unit) {
    return (unit >= 'A' && unit <= 'Z') || (unit >= 'a' && unit <= 'z');
}

static inline bool mal_ascii_is_digit(c16 unit) {
    return unit >= '0' && unit <= '9';
}

static inline bool mal_ascii_is_alphanumeric(c16 unit) {
    return mal_ascii_is_alpha(unit) || mal_ascii_is_digit(unit);
}

static inline c16 mal_ascii_to_lower(c16 unit) {
    return unit >= 'A' && unit <= 'Z' ? (c16) (unit + ('a' - 'A')) : unit;
}

static inline c16 mal_ascii_to_upper(c16 unit) {
    return unit >= 'a' && unit <= 'z' ? (c16) (unit - ('a' - 'A')) : unit;
}

static inline bool mal_ascii_units_equal(
    const c16 *units, usize length, const char *ascii
) {
    if (length != strlen(ascii)) return false;
    for (usize i = 0; i < length; i++) {
        if (units[i] != (c16) (u8) ascii[i]) return false;
    }
    return true;
}

static inline bool mal_ascii_units_equal_ci(
    const c16 *units, usize length, const char *ascii
) {
    if (length != strlen(ascii)) return false;
    for (usize i = 0; i < length; i++) {
        if (mal_ascii_to_lower(units[i]) !=
            mal_ascii_to_lower((c16) (u8) ascii[i])) return false;
    }
    return true;
}

static inline bool mal_string_equals_ascii(const MalString *string, const char *ascii) {
    return mal_ascii_units_equal(
        mal_string_code_units(string), mal_string_length(string), ascii);
}

static inline bool mal_string_equals_ascii_ci(const MalString *string, const char *ascii) {
    return mal_ascii_units_equal_ci(
        mal_string_code_units(string), mal_string_length(string), ascii);
}
