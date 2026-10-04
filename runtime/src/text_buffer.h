#pragma once

#include <string.h>

#include "heap_string.h"
#include "value.h"

typedef enum MalTextBufferStatus : u8 {
    MAL_TEXT_BUFFER_OK,
    MAL_TEXT_BUFFER_LENGTH_OVERFLOW,
    MAL_TEXT_BUFFER_ALLOCATION_FAILURE,
} MalTextBufferStatus;

/** GC-accounted output storage. Zero initialization starts in Latin-1; lengths
 * and capacities count UTF-16 code units. Capacity may be an allocation hint
 * while data is null; direct writers must call eager reserve before writing. */
typedef struct MalTextBuffer {
    MalHeap *heap;
    void *data;
    usize length;
    usize capacity;
    MalTextBufferStatus status;
    bool utf16;
} MalTextBuffer;

/** Reserve code units in the current encoding without changing length. */
MalTextBufferStatus mal_text_buffer_reserve(MalTextBuffer *buffer, usize extra);

/** Promote existing content and reserve UTF-16 space for direct writers. */
MalTextBufferStatus mal_text_buffer_reserve_utf16(MalTextBuffer *buffer, usize extra);

/** Delay an empty buffer's allocation until the first append determines its
 * encoding. With existing storage this has the same contract as reserve. */
MalTextBufferStatus mal_text_buffer_hint_capacity(MalTextBuffer *buffer, usize extra);

/** Whether `extra` code units fit the current storage without growth. Allocated
 * storage never exceeds the engine length limit, so a fit cannot overflow it. */
static inline bool mal_text_buffer_fits(const MalTextBuffer *buffer, usize extra) {
    return buffer->status == MAL_TEXT_BUFFER_OK && buffer->data != nullptr &&
        extra <= buffer->capacity - buffer->length;
}

MalTextBufferStatus mal_text_buffer_push_slow(MalTextBuffer *buffer, c16 code_unit);

static inline MalTextBufferStatus mal_text_buffer_push(MalTextBuffer *buffer, c16 code_unit) {
    if (mal_text_buffer_fits(buffer, 1)) {
        if (buffer->utf16) {
            ((c16 *) buffer->data)[buffer->length++] = code_unit;
            return MAL_TEXT_BUFFER_OK;
        }
        if (code_unit <= UINT8_MAX) {
            ((u8 *) buffer->data)[buffer->length++] = (u8) code_unit;
            return MAL_TEXT_BUFFER_OK;
        }
    }
    return mal_text_buffer_push_slow(buffer, code_unit);
}

MalTextBufferStatus mal_text_buffer_append_units_slow(
    MalTextBuffer *buffer, const c16 *code_units, usize length);

/** Source ranges must not alias buffer storage. Use append_buffer for self-copy. */
static inline MalTextBufferStatus mal_text_buffer_append_units(
    MalTextBuffer *buffer, const c16 *code_units, usize length
) {
    if (buffer->utf16 && mal_text_buffer_fits(buffer, length)) {
        if (length != 0) {
            memcpy((c16 *) buffer->data + buffer->length, code_units, sizeof(c16) * length);
        }
        buffer->length += length;
        return MAL_TEXT_BUFFER_OK;
    }
    return mal_text_buffer_append_units_slow(buffer, code_units, length);
}

MalTextBufferStatus mal_text_buffer_append_latin1_slow(
    MalTextBuffer *buffer, const u8 *code_units, usize length);

static inline MalTextBufferStatus mal_text_buffer_append_latin1(
    MalTextBuffer *buffer, const u8 *code_units, usize length
) {
    if (!buffer->utf16 && mal_text_buffer_fits(buffer, length)) {
        if (length != 0) memcpy((u8 *) buffer->data + buffer->length, code_units, length);
        buffer->length += length;
        return MAL_TEXT_BUFFER_OK;
    }
    return mal_text_buffer_append_latin1_slow(buffer, code_units, length);
}

MalTextBufferStatus mal_text_buffer_append_string(
    MalTextBuffer *buffer, const MalString *string);

/** Append an in-bounds range without flattening its source string. */
MalTextBufferStatus mal_text_buffer_append_range(
    MalTextBuffer *buffer, const MalString *string, usize offset, usize length);

MalTextBufferStatus mal_text_buffer_append_buffer(
    MalTextBuffer *buffer, const MalTextBuffer *source);

/** Append a NUL-terminated ASCII byte string. */
MalTextBufferStatus mal_text_buffer_append_ascii(
    MalTextBuffer *buffer, const byte *ascii);

MalTextBufferStatus mal_text_buffer_append_i32(MalTextBuffer *buffer, i32 value);

/** Requires a Number primitive; preserves Number::toString spelling without a heap string. */
MalTextBufferStatus mal_text_buffer_append_number(MalTextBuffer *buffer, MalValue value);

static inline c16 mal_text_buffer_code_unit_at(const MalTextBuffer *buffer, usize index) {
    return buffer->utf16 ? ((const c16 *) buffer->data)[index]
        : ((const u8 *) buffer->data)[index];
}

/** Roll back output to an earlier length; retains capacity, encoding and errors. */
void mal_text_buffer_truncate(MalTextBuffer *buffer, usize length);

/** Copy without consuming the buffer. */
MalString *mal_text_buffer_copy(MalHeap *heap, const MalTextBuffer *buffer);

/** Transfer RAW ownership into a heap string and reset the buffer. */
MalString *mal_text_buffer_finish(MalHeap *heap, MalTextBuffer *buffer);

void mal_text_buffer_dispose(MalTextBuffer *buffer);
