#include "u16_buffer.h"

#include <stdlib.h>
#include <string.h>

#include "checked_size.h"
#include "gc.h"
#include "profile.h"

#define MAL_U16_BUFFER_INITIAL_CAPACITY ((usize) 16)

MalU16BufferStatus mal_u16_buffer_reserve(MalU16Buffer *buffer, usize extra) {
    if (buffer->status != MAL_U16_BUFFER_OK) {
        return buffer->status;
    }

    usize required;
    if (!mal_checked_size_add(
            buffer->length, extra, MAL_STRING_MAX_CODE_UNITS, &required)) {
        buffer->status = MAL_U16_BUFFER_LENGTH_OVERFLOW;
        return buffer->status;
    }
    if (required <= buffer->capacity) {
        return MAL_U16_BUFFER_OK;
    }

    usize capacity;
    usize bytes;
    if (!mal_checked_size_growth(
            buffer->capacity, required, MAL_U16_BUFFER_INITIAL_CAPACITY,
            MAL_STRING_MAX_CODE_UNITS, &capacity) ||
        !mal_checked_size_multiply(sizeof(c16), capacity, SIZE_MAX, &bytes)) {
        buffer->status = MAL_U16_BUFFER_LENGTH_OVERFLOW;
        return buffer->status;
    }

    MalHeap *heap = buffer->heap;
    if (heap == nullptr) {
        heap = mal_gc_current_heap();
        buffer->heap = heap;
    }
    c16 *grown = mal_heap_try_alloc_raw_profiled(
        heap, bytes, MAL_PROFILE_ALLOCATION_FAMILY_STRING);
    if (grown == nullptr) {
        buffer->status = MAL_U16_BUFFER_ALLOCATION_FAILURE;
        return buffer->status;
    }
    if (buffer->length != 0) {
        memcpy(grown, buffer->data, sizeof(c16) * buffer->length);
    }
    gc_free_raw(heap, buffer->data);
    buffer->data = grown;
    buffer->capacity = capacity;
    return MAL_U16_BUFFER_OK;
}

MalU16BufferStatus mal_u16_buffer_push(MalU16Buffer *buffer, c16 code_unit) {
    MalU16BufferStatus status = mal_u16_buffer_reserve(buffer, 1);
    if (status == MAL_U16_BUFFER_OK) {
        buffer->data[buffer->length++] = code_unit;
    }
    return status;
}

MalU16BufferStatus mal_u16_buffer_append_units(
    MalU16Buffer *buffer, const c16 *code_units, usize length
) {
    if (length == 0) {
        return buffer->status;
    }
    MalU16BufferStatus status = mal_u16_buffer_reserve(buffer, length);
    if (status == MAL_U16_BUFFER_OK) {
        memcpy(buffer->data + buffer->length, code_units, sizeof(c16) * length);
        buffer->length += length;
    }
    return status;
}

MalU16BufferStatus mal_u16_buffer_append_string(
    MalU16Buffer *buffer, const MalString *string
) {
    return mal_u16_buffer_append_units(
        buffer, mal_string_code_units(string), mal_string_length(string));
}

MalU16BufferStatus mal_u16_buffer_append_ascii(
    MalU16Buffer *buffer, const byte *ascii
) {
    usize length = strlen((const char *) ascii);
    MalU16BufferStatus status = mal_u16_buffer_reserve(buffer, length);
    if (status == MAL_U16_BUFFER_OK) {
        for (usize i = 0; i < length; i++) {
            buffer->data[buffer->length++] = (c16) (u8) ascii[i];
        }
    }
    return status;
}

MalU16BufferStatus mal_u16_buffer_append_i32(
    MalU16Buffer *buffer, i32 value
) {
    c16 reversed[11];
    usize count = 0;
    bool negative = value < 0;
    u32 magnitude = negative ? (u32) -(i64) value : (u32) value;
    do {
        reversed[count++] = (c16) ('0' + magnitude % 10);
        magnitude /= 10;
    } while (magnitude != 0);

    MalU16BufferStatus status = mal_u16_buffer_reserve(
        buffer, count + (negative ? 1 : 0));
    if (status != MAL_U16_BUFFER_OK) {
        return status;
    }
    if (negative) {
        buffer->data[buffer->length++] = '-';
    }
    while (count > 0) {
        buffer->data[buffer->length++] = reversed[--count];
    }
    return MAL_U16_BUFFER_OK;
}

MalString *mal_u16_buffer_copy(MalHeap *heap, const MalU16Buffer *buffer) {
    if (buffer->status != MAL_U16_BUFFER_OK) {
        return nullptr;
    }
    return mal_string_new_copy(heap, buffer->data, buffer->length);
}

MalString *mal_u16_buffer_finish(MalHeap *heap, MalU16Buffer *buffer) {
    if (buffer->status != MAL_U16_BUFFER_OK) {
        mal_u16_buffer_dispose(buffer);
        return nullptr;
    }
    if (buffer->heap != nullptr && buffer->heap != heap) abort();
    c16 *data = buffer->data;
    usize length = buffer->length;
    *buffer = (MalU16Buffer) {0};
    return mal_string_new_owned(heap, data, length);
}

void mal_u16_buffer_dispose(MalU16Buffer *buffer) {
    if (buffer->data != nullptr) {
        if (buffer->heap == nullptr) abort();
        gc_free_raw(buffer->heap, buffer->data);
    }
    *buffer = (MalU16Buffer) {0};
}
