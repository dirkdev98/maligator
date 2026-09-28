#pragma once

#include "heap_string.h"

typedef enum MalTextBufferStatus : u8 {
    MAL_TEXT_BUFFER_OK,
    MAL_TEXT_BUFFER_LENGTH_OVERFLOW,
    MAL_TEXT_BUFFER_ALLOCATION_FAILURE,
} MalTextBufferStatus;

/** GC-accounted output storage. Zero initialization starts in Latin-1; lengths
 * and capacities always count UTF-16 code units, including lone surrogates. */
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

MalTextBufferStatus mal_text_buffer_push(MalTextBuffer *buffer, c16 code_unit);

/** Source ranges must not alias buffer storage. Use append_buffer for self-copy. */
MalTextBufferStatus mal_text_buffer_append_units(
    MalTextBuffer *buffer, const c16 *code_units, usize length);

MalTextBufferStatus mal_text_buffer_append_latin1(
    MalTextBuffer *buffer, const u8 *code_units, usize length);

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
