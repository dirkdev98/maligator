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
    usize length = mal_string_length(string);
    if (length != strlen(ascii)) return false;
    MalStringIterator iterator;
    MalStringSegment segment;
    mal_string_iterator_init(&iterator, string, 0, length);
    usize offset = 0;
    bool equal = true;
    while (mal_string_iterator_next(&iterator, &segment)) {
        if (segment.latin1) {
            equal = memcmp(segment.latin1_units, ascii + offset, segment.length) == 0;
        } else {
            for (usize i = 0; i < segment.length; i++) {
                if (segment.utf16_units[i] != (c16) (u8) ascii[offset + i]) {
                    equal = false;
                    break;
                }
            }
        }
        if (!equal) break;
        offset += segment.length;
    }
    mal_string_iterator_dispose(&iterator);
    return equal;
}

static inline bool mal_string_equals_ascii_ci(const MalString *string, const char *ascii) {
    usize length = mal_string_length(string);
    if (length != strlen(ascii)) return false;
    MalStringIterator iterator;
    MalStringSegment segment;
    mal_string_iterator_init(&iterator, string, 0, length);
    usize offset = 0;
    bool equal = true;
    while (mal_string_iterator_next(&iterator, &segment)) {
        for (usize i = 0; i < segment.length; i++) {
            if (mal_ascii_to_lower(mal_string_segment_code_unit_at(&segment, i)) !=
                mal_ascii_to_lower((c16) (u8) ascii[offset + i])) {
                equal = false;
                break;
            }
        }
        if (!equal) break;
        offset += segment.length;
    }
    mal_string_iterator_dispose(&iterator);
    return equal;
}
