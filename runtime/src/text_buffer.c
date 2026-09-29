#include "text_buffer.h"

#include <assert.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "checked_size.h"
#include "gc.h"
#include "mal_number_format.h"
#include "profile.h"
#include "value_ops.h"

#define MAL_TEXT_BUFFER_INITIAL_CAPACITY ((usize) 16)

static MalTextBufferStatus mal_text_buffer_prepare(
    MalTextBuffer *buffer, usize extra, bool utf16
) {
    if (buffer->status != MAL_TEXT_BUFFER_OK) return buffer->status;

    usize required;
    if (!mal_checked_size_add(
            buffer->length, extra, MAL_STRING_MAX_CODE_UNITS, &required)) {
        return buffer->status = MAL_TEXT_BUFFER_LENGTH_OVERFLOW;
    }
    bool promote = utf16 && !buffer->utf16;
    if (required <= buffer->capacity && !promote &&
        (buffer->data != nullptr || buffer->capacity == 0)) return MAL_TEXT_BUFFER_OK;

    usize capacity = buffer->capacity;
    usize bytes;
    if ((required > capacity && !mal_checked_size_growth(
            capacity, required, MAL_TEXT_BUFFER_INITIAL_CAPACITY,
            MAL_STRING_MAX_CODE_UNITS, &capacity)) ||
        !mal_checked_size_multiply(
            utf16 || buffer->utf16 ? sizeof(c16) : sizeof(u8), capacity, SIZE_MAX, &bytes)) {
        return buffer->status = MAL_TEXT_BUFFER_LENGTH_OVERFLOW;
    }
    if (bytes == 0) {
        buffer->utf16 |= utf16;
        return MAL_TEXT_BUFFER_OK;
    }

    MalHeap *heap = buffer->heap;
    if (heap == nullptr) buffer->heap = heap = mal_gc_current_heap();
    void *grown = mal_heap_try_realloc_raw_profiled(
        heap, buffer->data, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    if (grown == nullptr) return buffer->status = MAL_TEXT_BUFFER_ALLOCATION_FAILURE;

    if (promote) {
        // Realloc can retain the address; widen backwards to preserve unread bytes.
        for (usize i = buffer->length; i > 0; --i) {
            ((c16 *) grown)[i - 1] = ((const u8 *) grown)[i - 1];
        }
    }
    buffer->data = grown;
    buffer->capacity = capacity;
    buffer->utf16 |= utf16;
    return MAL_TEXT_BUFFER_OK;
}

MalTextBufferStatus mal_text_buffer_reserve(MalTextBuffer *buffer, usize extra) {
    return mal_text_buffer_prepare(buffer, extra, false);
}

MalTextBufferStatus mal_text_buffer_reserve_utf16(MalTextBuffer *buffer, usize extra) {
    return mal_text_buffer_prepare(buffer, extra, true);
}

MalTextBufferStatus mal_text_buffer_hint_capacity(MalTextBuffer *buffer, usize extra) {
    if (buffer->status != MAL_TEXT_BUFFER_OK) return buffer->status;
    if (buffer->data != nullptr) return mal_text_buffer_reserve(buffer, extra);
    usize required;
    if (!mal_checked_size_add(
            buffer->length, extra, MAL_STRING_MAX_CODE_UNITS, &required)) {
        return buffer->status = MAL_TEXT_BUFFER_LENGTH_OVERFLOW;
    }
    if (required > buffer->capacity) {
        buffer->capacity = required < MAL_TEXT_BUFFER_INITIAL_CAPACITY
            ? MAL_TEXT_BUFFER_INITIAL_CAPACITY : required;
    }
    return MAL_TEXT_BUFFER_OK;
}

MalTextBufferStatus mal_text_buffer_push(MalTextBuffer *buffer, c16 code_unit) {
    MalTextBufferStatus status = mal_text_buffer_prepare(buffer, 1, code_unit > UINT8_MAX);
    if (status == MAL_TEXT_BUFFER_OK) {
        if (buffer->utf16) ((c16 *) buffer->data)[buffer->length++] = code_unit;
        else ((u8 *) buffer->data)[buffer->length++] = (u8) code_unit;
    }
    return status;
}

MalTextBufferStatus mal_text_buffer_append_units(
    MalTextBuffer *buffer, const c16 *code_units, usize length
) {
    if (length == 0 || buffer->status != MAL_TEXT_BUFFER_OK) return buffer->status;
    if (length > MAL_STRING_MAX_CODE_UNITS - buffer->length) {
        return buffer->status = MAL_TEXT_BUFFER_LENGTH_OVERFLOW;
    }
    bool utf16 = buffer->utf16;
    if (!utf16) {
        for (usize i = 0; i < length; i++) {
            if (code_units[i] > UINT8_MAX) {
                utf16 = true;
                break;
            }
        }
    }
    MalTextBufferStatus status = mal_text_buffer_prepare(buffer, length, utf16);
    if (status == MAL_TEXT_BUFFER_OK) {
        if (buffer->utf16) {
            memcpy((c16 *) buffer->data + buffer->length, code_units, sizeof(c16) * length);
        } else {
            u8 *destination = (u8 *) buffer->data + buffer->length;
            for (usize i = 0; i < length; i++) destination[i] = (u8) code_units[i];
        }
        buffer->length += length;
    }
    return status;
}

MalTextBufferStatus mal_text_buffer_append_latin1(
    MalTextBuffer *buffer, const u8 *code_units, usize length
) {
    if (length == 0) return buffer->status;
    MalTextBufferStatus status = mal_text_buffer_prepare(buffer, length, false);
    if (status == MAL_TEXT_BUFFER_OK) {
        if (buffer->utf16) {
            c16 *destination = (c16 *) buffer->data + buffer->length;
            for (usize i = 0; i < length; i++) destination[i] = code_units[i];
        } else {
            memcpy((u8 *) buffer->data + buffer->length, code_units, length);
        }
        buffer->length += length;
    }
    return status;
}

// Keep the rope traversal stack off the flat-string append path.
__attribute__((noinline))
static MalTextBufferStatus mal_text_buffer_append_segmented(
    MalTextBuffer *buffer, const MalString *string, usize offset, usize length
) {
    if (buffer->data == nullptr) mal_text_buffer_hint_capacity(buffer, length);
    MalStringIterator iterator;
    MalStringSegment segment;
    mal_string_iterator_init(&iterator, string, offset, length);
    while (mal_string_iterator_next(&iterator, &segment)) {
        MalTextBufferStatus status = segment.latin1
            ? mal_text_buffer_append_latin1(buffer, segment.latin1_units, segment.length)
            : mal_text_buffer_append_units(buffer, segment.utf16_units, segment.length);
        if (status != MAL_TEXT_BUFFER_OK) break;
    }
    mal_string_iterator_dispose(&iterator);
    return buffer->status;
}

MalTextBufferStatus mal_text_buffer_append_range(
    MalTextBuffer *buffer, const MalString *string, usize offset, usize length
) {
    if (length == 0 || buffer->status != MAL_TEXT_BUFFER_OK) return buffer->status;
    if (length > MAL_STRING_MAX_CODE_UNITS - buffer->length) {
        return buffer->status = MAL_TEXT_BUFFER_LENGTH_OVERFLOW;
    }
    MalStringSegment segment;
    if (mal_string_try_get_segment(string, offset, length, &segment)) {
        return segment.latin1
            ? mal_text_buffer_append_latin1(buffer, segment.latin1_units, length)
            : mal_text_buffer_append_units(buffer, segment.utf16_units, length);
    }
    return mal_text_buffer_append_segmented(buffer, string, offset, length);
}

MalTextBufferStatus mal_text_buffer_append_string(
    MalTextBuffer *buffer, const MalString *string
) {
    return mal_text_buffer_append_range(buffer, string, 0, mal_string_length(string));
}

MalTextBufferStatus mal_text_buffer_append_buffer(
    MalTextBuffer *buffer, const MalTextBuffer *source
) {
    if (buffer == source) {
        usize length = buffer->length;
        if (length == 0 || mal_text_buffer_reserve(buffer, length) != MAL_TEXT_BUFFER_OK) {
            return buffer->status;
        }
        usize bytes = length * (buffer->utf16 ? sizeof(c16) : sizeof(u8));
        memcpy((u8 *) buffer->data + bytes, buffer->data, bytes);
        buffer->length += length;
        return MAL_TEXT_BUFFER_OK;
    }
    if (source->status != MAL_TEXT_BUFFER_OK) {
        if (buffer->status == MAL_TEXT_BUFFER_OK) buffer->status = source->status;
        return buffer->status;
    }
    return source->utf16
        ? mal_text_buffer_append_units(buffer, source->data, source->length)
        : mal_text_buffer_append_latin1(buffer, source->data, source->length);
}

MalTextBufferStatus mal_text_buffer_append_ascii(
    MalTextBuffer *buffer, const byte *ascii
) {
    return mal_text_buffer_append_latin1(buffer, (const u8 *) ascii, strlen((const char *) ascii));
}

MalTextBufferStatus mal_text_buffer_append_i32(MalTextBuffer *buffer, i32 value) {
    u8 digits[11];
    usize start = sizeof(digits);
    bool negative = value < 0;
    u32 magnitude = negative ? (u32) -(i64) value : (u32) value;
    do {
        digits[--start] = (u8) ('0' + magnitude % 10);
        magnitude /= 10;
    } while (magnitude != 0);
    if (negative) digits[--start] = '-';
    return mal_text_buffer_append_latin1(buffer, digits + start, sizeof(digits) - start);
}

MalTextBufferStatus mal_text_buffer_append_number(MalTextBuffer *buffer, MalValue value) {
    assert(mal_ops_is_number(value));
    if (buffer->status != MAL_TEXT_BUFFER_OK) return buffer->status;
    if (mal_value_is_int32(value)) {
        return mal_text_buffer_append_i32(buffer, mal_value_to_i32(value));
    }
    f64 number = mal_ops_number_as_f64(value);
    if (number == 0.0) return mal_text_buffer_push(buffer, '0');
    if (isnan(number)) return mal_text_buffer_append_ascii(buffer, "NaN");
    if (isinf(number)) {
        return mal_text_buffer_append_ascii(buffer, number < 0 ? "-Infinity" : "Infinity");
    }
    u8 digits[32];
    i32 length = mal_number_format_shortest(number, digits, (i32) sizeof(digits));
    if (length <= 0 || length > (i32) sizeof(digits)) abort();
    return mal_text_buffer_append_latin1(buffer, digits, (usize) length);
}

void mal_text_buffer_truncate(MalTextBuffer *buffer, usize length) {
    if (length > buffer->length) abort();
    buffer->length = length;
}

MalString *mal_text_buffer_copy(MalHeap *heap, const MalTextBuffer *buffer) {
    if (buffer->status != MAL_TEXT_BUFFER_OK) return nullptr;
    return buffer->utf16 ? mal_string_new_copy(heap, buffer->data, buffer->length)
        : mal_string_new_latin1_copy(heap, buffer->data, buffer->length);
}

MalString *mal_text_buffer_finish(MalHeap *heap, MalTextBuffer *buffer) {
    if (buffer->status != MAL_TEXT_BUFFER_OK) {
        mal_text_buffer_dispose(buffer);
        return nullptr;
    }
    if (buffer->heap != nullptr && buffer->heap != heap) abort();
    void *data = buffer->data;
    usize length = buffer->length;
    bool utf16 = buffer->utf16;
    // RAW realloc retains its size class or large allocation on shrink. Copy
    // only disproportionate slack; failed trimming still transfers valid data.
    usize inline_length = utf16 ? MAL_STRING_INLINE_CODE_UNITS
        : MAL_STRING_INLINE_LATIN1_CODE_UNITS;
    if (length > inline_length && buffer->capacity > 1024 &&
        length < buffer->capacity / 2) {
        usize bytes = length * (utf16 ? sizeof(c16) : sizeof(u8));
        void *trimmed = mal_heap_try_alloc_raw_profiled(
            heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
        if (trimmed != nullptr) {
            memcpy(trimmed, data, bytes);
            gc_free_raw(heap, data);
            data = trimmed;
        }
    }
    *buffer = (MalTextBuffer) {0};
    return utf16 ? mal_string_new_owned(heap, data, length)
        : mal_string_new_latin1_owned(heap, data, length);
}

void mal_text_buffer_dispose(MalTextBuffer *buffer) {
    if (buffer->data != nullptr) {
        if (buffer->heap == nullptr) abort();
        gc_free_raw(buffer->heap, buffer->data);
    }
    *buffer = (MalTextBuffer) {0};
}
