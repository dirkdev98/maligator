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

static u32 unicode_class(u32 cp) {
    if (cp < 0x80 || cp >= 0x110000) return 0;
    return mal_unicode_class_values[((usize) mal_unicode_class_pages[cp >> 8] << 8) | (cp & 255)];
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

static bool unicode_decompose(MalUnicodePoints *points, u32 cp, bool compatibility) {
    if (cp < 0x80) return unicode_push(points, cp);
    if (cp >= 0xac00 && cp < 0xd7a4) {
        u32 syllable = cp - 0xac00;
        return unicode_push(points, 0x1100 + syllable / 588) &&
            unicode_push(points, 0x1161 + (syllable % 588) / 28) &&
            (syllable % 28 == 0 || unicode_push(points, 0x11a7 + syllable % 28));
    }
    size row = unicode_row(mal_unicode_decomposition, UNICODE_COUNT(mal_unicode_decomposition), 4, cp);
    if (row < 0 || (!compatibility && mal_unicode_decomposition[row + 3] != 0)) return unicode_push(points, cp);
    usize start = mal_unicode_decomposition[row + 1] - MAL_UNICODE_NORMALIZATION_POOL_OFFSET;
    usize end = start + mal_unicode_decomposition[row + 2];
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

static MalUnicodeStatus unicode_normalize(const c16 *source, usize length, bool compatibility, bool compose, c16 **output, usize *output_length) {
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

// Static embedders can enter the VM without running the host manifest.
__attribute__((constructor)) static void unicode_register_normalizer(void) {
    atomic_store_explicit(&mal_unicode_normalizer, unicode_normalize, memory_order_relaxed);
}

void mal_host_install_unicode_normalization(struct MalVm *vm,
    const struct MalHostInstallSlot *slots, i32 count,
    const struct MalHostLaunchContext *launch) {
    (void) vm;
    (void) slots;
    (void) count;
    (void) launch;
    unicode_register_normalizer();
}
