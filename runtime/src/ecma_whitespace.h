#pragma once

#include "defaults.h"

/* ECMAScript String WhiteSpace plus LineTerminator code points. Grammar-specific
 * sets such as JSON whitespace and WHATWG ASCII whitespace intentionally differ. */
static inline bool mal_ecma_is_string_whitespace(c16 unit) {
    // Comparisons instead of a switch keep the predicate inline: an out-of-line jump table
    // made every space and non-ASCII unit at a trim edge or number boundary pay a call.
    if (unit < 0x0100) return unit == 0x0020 || unit == 0x00A0 || (c16) (unit - 0x0009) <= 0x000D - 0x0009;
    if (unit < 0x1680) return false;
    return unit == 0x1680 || (unit >= 0x2000 && unit <= 0x200A) || unit == 0x2028 ||
        unit == 0x2029 || unit == 0x202F || unit == 0x205F || unit == 0x3000 || unit == 0xFEFF;
}
