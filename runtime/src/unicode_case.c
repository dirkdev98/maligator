#include "unicode.h"

#include <stdlib.h>
#include <string.h>

#include "checked_size.h"
#include "heap_string.h"
#define MAL_UNICODE_CASE_DATA
#include "unicode_data.h"
#include "utf16.h"

#define UNICODE_COUNT(table) (sizeof(table) / sizeof((table)[0]))

static_assert(
    sizeof(mal_unicode_cased) + sizeof(mal_unicode_ignorable) + sizeof(mal_unicode_soft_dotted) +
    sizeof(mal_unicode_case_class_blocks) + sizeof(mal_unicode_case_class_entries) +
    sizeof(mal_unicode_lower_blocks) + sizeof(mal_unicode_lower_entries) + sizeof(mal_unicode_lower_mappings) +
    sizeof(mal_unicode_upper_blocks) + sizeof(mal_unicode_upper_entries) + sizeof(mal_unicode_upper_mappings) +
    sizeof(mal_unicode_case_expansions) <= 30000,
    "Unicode case tables exceed their native size budget");

static bool unicode_property(const u32 *table, usize length, u32 cp) {
    usize low = 0, high = length / 2;
    while (low < high) {
        usize middle = low + (high - low) / 2;
        if (table[middle * 2 + 1] < cp) low = middle + 1;
        else high = middle;
    }
    return low * 2 < length && table[low * 2] <= cp;
}

enum { UNICODE_CASE_CLASS_ABOVE = 2 };

static u32 unicode_case_class(u32 cp) {
    usize block = cp >> MAL_UNICODE_CASE_BLOCK_BITS;
    if (block >= UNICODE_COUNT(mal_unicode_case_class_blocks)) return 0;
    usize offset = ((usize) mal_unicode_case_class_blocks[block] << MAL_UNICODE_CASE_BLOCK_BITS) |
        (cp & ((1u << MAL_UNICODE_CASE_BLOCK_BITS) - 1));
    return (mal_unicode_case_class_entries[offset >> 2] >> ((offset & 3) * 2)) & 3;
}

typedef enum UnicodeContext : u8 {
    UNICODE_CONTEXT_CASED,
    UNICODE_CONTEXT_AFTER_I,
    UNICODE_CONTEXT_BEFORE_DOT,
    UNICODE_CONTEXT_SOFT_DOTTED,
    UNICODE_CONTEXT_MORE_ABOVE,
} UnicodeContext;

static bool unicode_case_context(const c16 *source, usize length, usize index, bool backwards, UnicodeContext context) {
    usize cursor = backwards ? index : index + mal_utf16_code_point_width(source, length, index);
    while (backwards ? cursor > 0 : cursor < length) {
        if (backwards) {
            cursor--;
            if (cursor > 0 && mal_utf16_is_pair(source[cursor - 1], source[cursor])) cursor--;
        }
        u32 cp;
        usize width;
        (void) mal_utf16_read_scalar(source, length, cursor, &cp, &width);
        if (context == UNICODE_CONTEXT_CASED) {
            if (!unicode_property(mal_unicode_ignorable, UNICODE_COUNT(mal_unicode_ignorable), cp))
                return unicode_property(mal_unicode_cased, UNICODE_COUNT(mal_unicode_cased), cp);
        } else {
            u32 ccc = unicode_case_class(cp);
            if (context == UNICODE_CONTEXT_BEFORE_DOT && cp == 0x307) return true;
            if (ccc == 0 || ccc == UNICODE_CASE_CLASS_ABOVE) {
                if (context == UNICODE_CONTEXT_AFTER_I) return cp == 0x49;
                if (context == UNICODE_CONTEXT_SOFT_DOTTED)
                    return unicode_property(mal_unicode_soft_dotted, UNICODE_COUNT(mal_unicode_soft_dotted), cp);
                return context == UNICODE_CONTEXT_MORE_ABOVE && ccc == UNICODE_CASE_CLASS_ABOVE;
            }
        }
        if (!backwards) cursor += width;
    }
    return false;
}

typedef struct UnicodeCaseTable {
    const i32 *mappings;
    const u8 *blocks;
    usize block_count;
    const u8 *entries;
} UnicodeCaseTable;

static const UnicodeCaseTable unicode_case_tables[2] = {
    {mal_unicode_lower_mappings, mal_unicode_lower_blocks, UNICODE_COUNT(mal_unicode_lower_blocks), mal_unicode_lower_entries},
    {mal_unicode_upper_mappings, mal_unicode_upper_blocks, UNICODE_COUNT(mal_unicode_upper_blocks), mal_unicode_upper_entries},
};

// Deltas fit below the expansion range, whose low two bits store the scalar count.
static inline i32 unicode_case_entry(const UnicodeCaseTable *table, u32 cp) {
    usize block = cp >> MAL_UNICODE_CASE_BLOCK_BITS;
    if (block >= table->block_count) return 0;
    u8 entry = table->entries[((usize) table->blocks[block] << MAL_UNICODE_CASE_BLOCK_BITS) |
        (cp & ((1u << MAL_UNICODE_CASE_BLOCK_BITS) - 1))];
    return table->mappings[entry];
}

typedef struct UnicodeCaseInput {
    const c16 *source;
    usize length;
    const UnicodeCaseTable *table;
    bool upper;
    MalUnicodeLocale locale;
} UnicodeCaseInput;

static UnicodeCaseInput unicode_case_input(
    const c16 *source, usize length, bool upper, MalUnicodeLocale locale
) {
    return (UnicodeCaseInput) {
        .source = source, .length = length, .table = &unicode_case_tables[upper],
        .upper = upper, .locale = locale,
    };
}

static inline __attribute__((always_inline)) const u32 *unicode_case_mapping(
    const UnicodeCaseInput *input, usize index, u32 cp, u32 special[3], usize *output_count
) {
    const u32 *mapping = nullptr;
    usize count = 0;
    if (!input->upper && cp == 0x3a3 &&
        unicode_case_context(input->source, input->length, index, true, UNICODE_CONTEXT_CASED) &&
        !unicode_case_context(input->source, input->length, index, false, UNICODE_CONTEXT_CASED)) {
        special[0] = 0x3c2; mapping = special; count = 1;
    }
    if (input->locale == MAL_UNICODE_LOCALE_TURKIC) {
        if (input->upper && cp == 0x69) { special[0] = 0x130; mapping = special; count = 1; }
        else if (!input->upper && cp == 0x130) { special[0] = 0x69; mapping = special; count = 1; }
        else if (!input->upper && cp == 0x307 && unicode_case_context(input->source, input->length, index, true, UNICODE_CONTEXT_AFTER_I)) { mapping = special; count = 0; }
        else if (!input->upper && cp == 0x49 && !unicode_case_context(input->source, input->length, index, false, UNICODE_CONTEXT_BEFORE_DOT)) { special[0] = 0x131; mapping = special; count = 1; }
    } else if (input->locale == MAL_UNICODE_LOCALE_LITHUANIAN) {
        if (input->upper && cp == 0x307 && unicode_case_context(input->source, input->length, index, true, UNICODE_CONTEXT_SOFT_DOTTED)) { mapping = special; count = 0; }
        else if (!input->upper && (cp == 0x49 || cp == 0x4a || cp == 0x12e) && unicode_case_context(input->source, input->length, index, false, UNICODE_CONTEXT_MORE_ABOVE)) {
            special[0] = cp == 0x12e ? 0x12f : cp + 32; special[1] = 0x307; mapping = special; count = 2;
        } else if (!input->upper && (cp == 0xcc || cp == 0xcd || cp == 0x128)) {
            special[0] = 0x69; special[1] = 0x307; special[2] = cp == 0xcc ? 0x300 : cp == 0xcd ? 0x301 : 0x303; mapping = special; count = 3;
        }
    }
    if (mapping == nullptr && cp < 0x80) {
        special[0] = input->upper && cp >= 'a' && cp <= 'z' ? cp - 32
            : !input->upper && cp >= 'A' && cp <= 'Z' ? cp + 32 : cp;
        mapping = special;
        count = 1;
    }
    if (mapping == nullptr) {
        i32 entry = unicode_case_entry(input->table, cp);
        if (entry < MAL_UNICODE_CASE_EXPANSION_BASE) {
            special[0] = (u32) ((i32) cp + entry);
            mapping = special;
            count = 1;
        } else {
            u32 expansion = (u32) (entry - MAL_UNICODE_CASE_EXPANSION_BASE);
            mapping = mal_unicode_case_expansions + (expansion >> 2);
            count = expansion & 3;
        }
    }
    *output_count = count;
    return mapping;
}

MalTextBufferStatus mal_unicode_case(
    const c16 *source, usize length, bool upper, MalUnicodeLocale locale,
    MalTextBuffer *output, bool *changed
) {
    UnicodeCaseInput input = unicode_case_input(source, length, upper, locale);
    *changed = false;
    if (mal_text_buffer_hint_capacity(output, length) != MAL_TEXT_BUFFER_OK) return output->status;
    for (usize index = 0; index < length;) {
        if (*changed && locale == MAL_UNICODE_LOCALE_ROOT && source[index] < 0x80) {
            usize end = index + 1;
            while (end < length && source[end] < 0x80) end++;
            if (mal_text_buffer_reserve(output, end - index) != MAL_TEXT_BUFFER_OK) return output->status;
            if (output->utf16) {
                c16 *units = (c16 *) output->data + output->length;
                for (usize i = index; i < end; i++) {
                    c16 unit = source[i];
                    units[i - index] = upper && unit >= 'a' && unit <= 'z' ? unit - 32
                        : !upper && unit >= 'A' && unit <= 'Z' ? unit + 32 : unit;
                }
            } else {
                u8 *units = (u8 *) output->data + output->length;
                for (usize i = index; i < end; i++) {
                    c16 unit = source[i];
                    units[i - index] = (u8) (upper && unit >= 'a' && unit <= 'z' ? unit - 32
                        : !upper && unit >= 'A' && unit <= 'Z' ? unit + 32 : unit);
                }
            }
            output->length += end - index;
            index = end;
            continue;
        }
        u32 cp, special[3];
        usize width, count;
        (void) mal_utf16_read_scalar(source, length, index, &cp, &width);
        const u32 *mapping = unicode_case_mapping(&input, index, cp, special, &count);
        if (!*changed && (count != 1 || mapping[0] != cp)) {
            *changed = true;
            if (mal_text_buffer_append_units(output, source, index) != MAL_TEXT_BUFFER_OK) return output->status;
        }
        if (*changed) {
            for (usize mapped = 0; mapped < count; mapped++) {
                u32 point = mapping[mapped];
                if (point > 0xffff) {
                    c16 pair[2];
                    mal_utf16_emit_pair(point, pair);
                    if (mal_text_buffer_append_units(output, pair, countof(pair)) != MAL_TEXT_BUFFER_OK) return output->status;
                } else if (mal_text_buffer_push(output, (c16) point) != MAL_TEXT_BUFFER_OK) return output->status;
            }
        }
        index += width;
    }
    return output->status;
}

static inline c16 unicode_ascii_case(c16 unit, bool upper) {
    return (c16) (unit ^ ((c16) (unit - (upper ? 'a' : 'A')) < 26 ? 0x20 : 0));
}

// Root-locale U+0080..U+00FF; U+00DF uppercases to "SS" and reports the expansion sentinel.
static inline u32 unicode_latin1_case(c16 unit, bool upper) {
    if (upper) {
        if (unit == 0xdf) return UINT32_MAX;
        if (unit == 0xb5) return 0x39c;
        if (unit == 0xff) return 0x178;
        return unit >= 0xe0 && unit != 0xf7 ? unit - 0x20u : unit;
    }
    return unit >= 0xc0 && unit <= 0xde && unit != 0xd7 ? unit + 0x20u : unit;
}

// A single-scalar mapping never changes the UTF-16 width; longer ones report UINT32_MAX.
static inline u32 unicode_simple_case(const UnicodeCaseTable *table, u32 cp) {
    i32 entry = unicode_case_entry(table, cp);
    return entry < MAL_UNICODE_CASE_EXPANSION_BASE ? (u32) ((i32) cp + entry) : UINT32_MAX;
}

bool mal_unicode_case_fixed(
    const c16 *source, usize length, bool upper, c16 *output, bool *changed, c16 *aggregate
) {
    const UnicodeCaseTable *table = &unicode_case_tables[upper];
    c16 written = 0, difference = 0;
    usize index = 0;
    while (index < length) {
        usize block_end = length - index >= 8 ? index + 8 : length;
        if (block_end - index == 8) {
            c16 block = 0;
            for (usize lane = 0; lane < 8; lane++) block |= source[index + lane];
            if (block < 0x80) {
                for (usize lane = 0; lane < 8; lane++) {
                    c16 unit = source[index + lane];
                    c16 mapped = unicode_ascii_case(unit, upper);
                    output[index + lane] = mapped;
                    difference |= unit ^ mapped;
                }
                written |= block;
                index += 8;
                continue;
            }
        }
        // A pair may straddle the block end; the next block then starts after it.
        while (index < block_end) {
            c16 unit = source[index];
            u32 mapped;
            if (unit < 0x80) mapped = unicode_ascii_case(unit, upper);
            else if (unit < 0x100) mapped = unicode_latin1_case(unit, upper);
            else if (mal_utf16_is_lead_surrogate(unit) && index + 1 < length &&
                mal_utf16_is_trail_surrogate(source[index + 1])) {
                u32 cp = mal_utf16_compose_pair(unit, source[index + 1]);
                mapped = unicode_simple_case(table, cp);
                if (mapped == UINT32_MAX) return false;
                if (mapped == cp) {
                    output[index] = unit;
                    output[index + 1] = source[index + 1];
                } else mal_utf16_emit_pair(mapped, output + index);
                written |= output[index] | output[index + 1];
                difference |= (c16) (mapped != cp);
                index += 2;
                continue;
            } else if (mal_utf16_is_surrogate(unit)) mapped = unit;
            else if (!upper && unit == 0x3a3) {
                mapped = unicode_case_context(source, length, index, true, UNICODE_CONTEXT_CASED) &&
                    !unicode_case_context(source, length, index, false, UNICODE_CONTEXT_CASED)
                    ? 0x3c2 : 0x3c3;
            } else mapped = unicode_simple_case(table, unit);
            if (mapped == UINT32_MAX) return false;
            output[index] = (c16) mapped;
            written |= (c16) mapped;
            difference |= unit ^ (c16) mapped;
            index++;
        }
    }
    *changed = difference != 0;
    *aggregate = written;
    return true;
}
