#include "unicode.h"

#include <stdlib.h>
#include <string.h>

#include "checked_size.h"
#include "heap_string.h"
#include "unicode_data.h"
#include "utf16.h"

#define UNICODE_COUNT(table) (sizeof(table) / sizeof((table)[0]))

typedef struct MalUnicodePoints {
    u32 *data;
    usize length;
    usize capacity;
    usize limit;
    MalUnicodeStatus status;
} MalUnicodePoints;

static size unicode_row(const u32 *table, usize length, usize stride, u32 cp) {
    usize low = 0, high = length / stride;
    while (low < high) {
        usize middle = low + (high - low) / 2;
        if (table[middle * stride] < cp) low = middle + 1;
        else high = middle;
    }
    return low * stride < length && table[low * stride] == cp ? (size) (low * stride) : -1;
}

static bool unicode_property(const u32 *table, usize length, u32 cp) {
    usize low = 0, high = length / 2;
    while (low < high) {
        usize middle = low + (high - low) / 2;
        if (table[middle * 2 + 1] < cp) low = middle + 1;
        else high = middle;
    }
    return low * 2 < length && table[low * 2] <= cp;
}

static u32 unicode_class(u32 cp) {
    size row = unicode_row(mal_unicode_classes, UNICODE_COUNT(mal_unicode_classes), 2, cp);
    return row < 0 ? 0 : mal_unicode_classes[row + 1];
}

static bool unicode_push(MalUnicodePoints *points, u32 cp) {
    if (points->length == points->capacity) {
        usize capacity, bytes;
        if (!mal_checked_size_growth(points->capacity, points->length + 1, 32, points->limit, &capacity) ||
            !mal_checked_size_multiply(sizeof(u32), capacity, SIZE_MAX, &bytes)) {
            points->status = MAL_UNICODE_LENGTH_OVERFLOW;
            return false;
        }
        u32 *data = realloc(points->data, bytes);
        if (data == nullptr) {
            points->status = MAL_UNICODE_ALLOCATION_FAILURE;
            return false;
        }
        points->data = data;
        points->capacity = capacity;
    }
    points->data[points->length++] = cp;
    return true;
}

static MalUnicodeStatus unicode_finish(MalUnicodePoints *points, c16 **output, usize *length) {
    usize count = points->length;
    if (count > MAL_STRING_MAX_CODE_UNITS) return MAL_UNICODE_LENGTH_OVERFLOW;
    for (usize index = 0; index < points->length; index++) {
        if (points->data[index] > 0xffff &&
            !mal_checked_size_add(count, 1, MAL_STRING_MAX_CODE_UNITS, &count)) {
            return MAL_UNICODE_LENGTH_OVERFLOW;
        }
    }
    usize bytes;
    if (!mal_checked_size_multiply(count == 0 ? 1 : count, sizeof(c16), SIZE_MAX, &bytes)) return MAL_UNICODE_LENGTH_OVERFLOW;
    c16 *units = malloc(bytes);
    if (units == nullptr) return MAL_UNICODE_ALLOCATION_FAILURE;
    usize cursor = 0;
    for (usize index = 0; index < points->length; index++) {
        u32 cp = points->data[index];
        if (cp > 0xffff) {
            mal_utf16_emit_pair(cp, units + cursor);
            cursor += 2;
        } else units[cursor++] = (c16) cp;
    }
    *output = units;
    *length = count;
    return MAL_UNICODE_OK;
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
            u32 ccc = unicode_class(cp);
            if (context == UNICODE_CONTEXT_BEFORE_DOT && cp == 0x307) return true;
            if (ccc == 0 || ccc == 230) {
                if (context == UNICODE_CONTEXT_AFTER_I) return cp == 0x49;
                if (context == UNICODE_CONTEXT_SOFT_DOTTED)
                    return unicode_property(mal_unicode_soft_dotted, UNICODE_COUNT(mal_unicode_soft_dotted), cp);
                return context == UNICODE_CONTEXT_MORE_ABOVE && ccc == 230;
            }
        }
        if (!backwards) cursor += width;
    }
    return false;
}

MalUnicodeStatus mal_unicode_case(const c16 *source, usize length, bool upper, MalUnicodeLocale locale, c16 **output, usize *output_length) {
    MalUnicodePoints points = {.limit = MAL_STRING_MAX_CODE_UNITS};
    const u32 *table = upper ? mal_unicode_upper : mal_unicode_lower;
    usize table_length = upper ? UNICODE_COUNT(mal_unicode_upper) : UNICODE_COUNT(mal_unicode_lower);
    for (usize index = 0; index < length;) {
        u32 cp;
        usize width;
        (void) mal_utf16_read_scalar(source, length, index, &cp, &width);
        u32 special[3];
        const u32 *mapping = nullptr;
        usize count = 0;
        if (!upper && cp == 0x3a3 &&
            unicode_case_context(source, length, index, true, UNICODE_CONTEXT_CASED) &&
            !unicode_case_context(source, length, index, false, UNICODE_CONTEXT_CASED)) {
            special[0] = 0x3c2; mapping = special; count = 1;
        }
        if (locale == MAL_UNICODE_LOCALE_TURKIC) {
            if (upper && cp == 0x69) { special[0] = 0x130; mapping = special; count = 1; }
            else if (!upper && cp == 0x130) { special[0] = 0x69; mapping = special; count = 1; }
            else if (!upper && cp == 0x307 && unicode_case_context(source, length, index, true, UNICODE_CONTEXT_AFTER_I)) { mapping = special; count = 0; }
            else if (!upper && cp == 0x49 && !unicode_case_context(source, length, index, false, UNICODE_CONTEXT_BEFORE_DOT)) { special[0] = 0x131; mapping = special; count = 1; }
        } else if (locale == MAL_UNICODE_LOCALE_LITHUANIAN) {
            if (upper && cp == 0x307 && unicode_case_context(source, length, index, true, UNICODE_CONTEXT_SOFT_DOTTED)) { mapping = special; count = 0; }
            else if (!upper && (cp == 0x49 || cp == 0x4a || cp == 0x12e) && unicode_case_context(source, length, index, false, UNICODE_CONTEXT_MORE_ABOVE)) {
                special[0] = cp == 0x12e ? 0x12f : cp + 32; special[1] = 0x307; mapping = special; count = 2;
            } else if (!upper && (cp == 0xcc || cp == 0xcd || cp == 0x128)) {
                special[0] = 0x69; special[1] = 0x307; special[2] = cp == 0xcc ? 0x300 : cp == 0xcd ? 0x301 : 0x303; mapping = special; count = 3;
            }
        }
        if (mapping == nullptr) {
            size row = unicode_row(table, table_length, 3, cp);
            if (row < 0) { special[0] = cp; mapping = special; count = 1; }
            else { mapping = mal_unicode_pool + table[row + 1]; count = table[row + 2]; }
        }
        for (usize mapped = 0; mapped < count; mapped++) if (!unicode_push(&points, mapping[mapped])) goto done;
        index += width;
    }
    points.status = unicode_finish(&points, output, output_length);
 done:
    free(points.data);
    return points.status;
}

static bool unicode_decompose(MalUnicodePoints *points, u32 cp, bool compatibility) {
    if (cp >= 0xac00 && cp < 0xd7a4) {
        u32 syllable = cp - 0xac00;
        return unicode_push(points, 0x1100 + syllable / 588) &&
            unicode_push(points, 0x1161 + (syllable % 588) / 28) &&
            (syllable % 28 == 0 || unicode_push(points, 0x11a7 + syllable % 28));
    }
    size row = unicode_row(mal_unicode_decomposition, UNICODE_COUNT(mal_unicode_decomposition), 4, cp);
    if (row < 0 || (!compatibility && mal_unicode_decomposition[row + 3] != 0)) return unicode_push(points, cp);
    usize start = mal_unicode_decomposition[row + 1], end = start + mal_unicode_decomposition[row + 2];
    for (usize index = start; index < end; index++)
        if (!unicode_decompose(points, mal_unicode_pool[index], compatibility)) return false;
    return true;
}

static u32 unicode_composite(u32 first, u32 second) {
    if (first >= 0x1100 && first < 0x1113 && second >= 0x1161 && second < 0x1176)
        return 0xac00 + ((first - 0x1100) * 21 + second - 0x1161) * 28;
    if (first >= 0xac00 && first < 0xd7a4 && (first - 0xac00) % 28 == 0 && second > 0x11a7 && second < 0x11c3)
        return first + second - 0x11a7;
    usize low = 0, high = UNICODE_COUNT(mal_unicode_composition) / 3;
    while (low < high) {
        usize middle = low + (high - low) / 2, index = middle * 3;
        if (mal_unicode_composition[index] < first ||
            (mal_unicode_composition[index] == first && mal_unicode_composition[index + 1] < second)) low = middle + 1;
        else high = middle;
    }
    usize index = low * 3;
    return index < UNICODE_COUNT(mal_unicode_composition) &&
        mal_unicode_composition[index] == first && mal_unicode_composition[index + 1] == second ? mal_unicode_composition[index + 2] : 0;
}

static bool unicode_order(MalUnicodePoints *points) {
    u32 *scratch = nullptr;
    for (usize start = 0; start < points->length;) {
        if (unicode_class(points->data[start]) == 0) { start++; continue; }
        usize end = start + 1;
        while (end < points->length && unicode_class(points->data[end]) != 0) end++;
        if (end - start < 32) {
            for (usize index = start + 1; index < end; index++) {
                u32 cp = points->data[index], ccc = unicode_class(cp);
                usize cursor = index;
                while (cursor > start && unicode_class(points->data[cursor - 1]) > ccc) {
                    points->data[cursor] = points->data[cursor - 1]; cursor--;
                }
                points->data[cursor] = cp;
            }
        } else {
            // Stable class buckets bound work even for adversarial combining-mark runs.
            if (scratch == nullptr) {
                scratch = malloc(points->length * sizeof(u32));
                if (scratch == nullptr) { points->status = MAL_UNICODE_ALLOCATION_FAILURE; return false; }
            }
            usize offsets[256] = {0};
            for (usize index = start; index < end; index++) offsets[unicode_class(points->data[index])]++;
            usize total = 0;
            for (usize ccc = 0; ccc < 256; ccc++) { usize count = offsets[ccc]; offsets[ccc] = total; total += count; }
            for (usize index = start; index < end; index++) { u32 cp = points->data[index]; scratch[offsets[unicode_class(cp)]++] = cp; }
            memcpy(points->data + start, scratch, (end - start) * sizeof(u32));
        }
        start = end;
    }
    free(scratch);
    return true;
}

MalUnicodeStatus mal_unicode_normalize(const c16 *source, usize length, bool compatibility, bool compose, c16 **output, usize *output_length) {
    // Composition can shrink an intermediate sequence back within the string limit.
    MalUnicodePoints points = {.limit = compose ? SIZE_MAX / sizeof(u32) : MAL_STRING_MAX_CODE_UNITS};
    for (usize index = 0; index < length;) {
        u32 cp;
        usize width;
        (void) mal_utf16_read_scalar(source, length, index, &cp, &width);
        if (!unicode_decompose(&points, cp, compatibility)) goto done;
        index += width;
    }
    if (!unicode_order(&points)) goto done;
    if (compose) {
        usize count = 0, starter = SIZE_MAX;
        u32 previous_class = 0;
        for (usize index = 0; index < points.length; index++) {
            u32 cp = points.data[index], ccc = unicode_class(cp);
            u32 composite = starter != SIZE_MAX && (previous_class == 0 || previous_class < ccc) ? unicode_composite(points.data[starter], cp) : 0;
            if (composite != 0) points.data[starter] = composite;
            else {
                if (ccc == 0) starter = count;
                points.data[count++] = cp;
                previous_class = ccc;
            }
        }
        points.length = count;
    }
    points.status = unicode_finish(&points, output, output_length);
 done:
    free(points.data);
    return points.status;
}
