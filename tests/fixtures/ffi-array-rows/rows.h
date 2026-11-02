#pragma once
#include <stddef.h>
#include <stdint.h>

typedef int Row[3];
typedef struct __attribute__((aligned(64))) Cell { const int value; int writable; } Cell;
typedef Cell CellRow[2];
typedef union Choice { const int integer; const int samples[2]; } Choice;
typedef Choice ChoiceRow[2];
typedef struct TaggedCell { const int kind; union { int integer; } payload; } TaggedCell;
typedef TaggedCell TaggedRow[2];
typedef struct __attribute__((aligned(64))) RowToken { const int id; int value; } RowToken;
typedef RowToken TokenRow[2];
RowToken row_token_make(int id);
void row_token_destroy(RowToken value);
int row_token_destroyed(void);
int rows_sum(const Row *values, size_t count);
int rows_bump(Row *values, size_t count);
int grids_sum(const int (*values)[2][3], size_t count);
int cells_sum(const CellRow *values, size_t count);
int choices_sum(const ChoiceRow *values, size_t count);
int tokens_sum(const TokenRow *values, size_t count);
Row *rows_make(size_t count);
CellRow *cells_make(size_t count);
TaggedRow *tags_make(int invalid, size_t count);
void rows_free(void *values);
int rows_freed(void);
int rows_taken(void);
void rows_visit(const Row *values, size_t count, void (*callback)(const Row *, size_t, void *), void *data);

void rows_fill(Row *values, size_t capacity, size_t *written);
void rows_full(Row *values, size_t capacity);
void rows_inout(Row *values, size_t *count);
void rows_bad_count(Row *values, size_t capacity, int mode, int64_t *written);
void cells_inout(CellRow *values, size_t *count);
void cells_fill(CellRow *values, size_t capacity, size_t *written);
void rows_created(size_t requested, Row **values, size_t *written);
void ints_fill(int *values, size_t capacity, size_t *written);

void rows_fill_visit(Row *values, size_t capacity, size_t *written, void (*callback)(void *), void *data);

void rows_notify(int mode, void (*callback)(const Row *, int64_t, const CellRow *, int64_t, void *), void *data, void (*release)(void *));

typedef const char *const TextRow[3];
void texts_notify(int mode, void (*callback)(const TextRow *, int64_t, void *), void *data, void (*release)(void *));

typedef char CharRow[8];
typedef const char ConstCharRow[8];
typedef unsigned char ByteRow[4];
int char_rows_sum(const CharRow *values, size_t count);
int const_char_rows_sum(const ConstCharRow *values, size_t count);
int char_grids_sum(const CharRow (*values)[2], size_t count);
int byte_rows_sum(const ByteRow *values, size_t count);
CharRow *char_rows_make(int invalid, size_t count);
ByteRow *byte_rows_make(size_t count);
void char_rows_inout(CharRow *values, size_t *count);
void byte_rows_inout(ByteRow *values, size_t *count);
void char_rows_fill(CharRow *values, size_t capacity, size_t *written);
void char_rows_visit(const CharRow *values, size_t count, void (*callback)(const CharRow *, size_t, void *), void *data);
void char_rows_notify(int invalid, void (*callback)(const CharRow *, size_t, void *), void *data, void (*release)(void *));
