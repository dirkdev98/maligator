#pragma once

#include "heap_string.h"

typedef enum MalU16BufferStatus : u8 {
    MAL_U16_BUFFER_OK,
    MAL_U16_BUFFER_LENGTH_OVERFLOW,
    MAL_U16_BUFFER_ALLOCATION_FAILURE,
} MalU16BufferStatus;

/** Growable UTF-16 storage in GC-accounted RAW space. */
typedef struct MalU16Buffer {
    MalHeap *heap;
    c16 *data;
    usize length;
    usize capacity;
    MalU16BufferStatus status;
} MalU16Buffer;

/** Reserve space for `extra` code units without changing length. */
MalU16BufferStatus mal_u16_buffer_reserve(MalU16Buffer *buffer, usize extra);

MalU16BufferStatus mal_u16_buffer_push(MalU16Buffer *buffer, c16 code_unit);

MalU16BufferStatus mal_u16_buffer_append_units(
    MalU16Buffer *buffer, const c16 *code_units, usize length);

MalU16BufferStatus mal_u16_buffer_append_string(
    MalU16Buffer *buffer, const MalString *string);

/** Append a NUL-terminated ASCII byte string as UTF-16 code units. */
MalU16BufferStatus mal_u16_buffer_append_ascii(
    MalU16Buffer *buffer, const byte *ascii);

/** Append the base-10 spelling of a signed 32-bit integer. */
MalU16BufferStatus mal_u16_buffer_append_i32(
    MalU16Buffer *buffer, i32 value);

/** Copy the current contents into a heap string without consuming the buffer. */
MalString *mal_u16_buffer_copy(MalHeap *heap, const MalU16Buffer *buffer);

/** Adopt the current contents into a heap string and reset the buffer. */
MalString *mal_u16_buffer_finish(MalHeap *heap, MalU16Buffer *buffer);

void mal_u16_buffer_dispose(MalU16Buffer *buffer);
