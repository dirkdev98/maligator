#include "rows.h"
#include <stdint.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>

static int taken;
static int freed;
static int destroyed;
RowToken row_token_make(int id) { return (RowToken){id, id + 1}; }
void row_token_destroy(RowToken value) { (void)value; destroyed++; }
int row_token_destroyed(void) { return destroyed; }
int rows_sum(const Row *values, size_t count) {
    taken++;
    int sum = 0;
    for (size_t i = 0; i < count; i++) for (int j = 0; j < 3; j++) sum += values[i][j];
    return sum;
}
int grids_sum(const int (*values)[2][3], size_t count) {
    taken++;
    int sum = 0;
    for (size_t i = 0; i < count; i++) for (int j = 0; j < 2; j++) for (int k = 0; k < 3; k++) sum += values[i][j][k];
    return sum;
}
int cells_sum(const CellRow *values, size_t count) {
    taken++;
    if (count > 0 && (uintptr_t)values % _Alignof(CellRow) != 0) abort();
    int sum = 0;
    for (size_t i = 0; i < count; i++) for (int j = 0; j < 2; j++) sum += values[i][j].value + values[i][j].writable;
    return sum;
}
int choices_sum(const ChoiceRow *values, size_t count) {
    taken++;
    int sum = 0;
    for (size_t i = 0; i < count; i++) for (int j = 0; j < 2; j++) sum += values[i][j].samples[0] + values[i][j].samples[1];
    return sum;
}
int tokens_sum(const TokenRow *values, size_t count) {
    taken++;
    if (count > 0 && (uintptr_t)values % _Alignof(TokenRow) != 0) abort();
    int sum = 0;
    for (size_t i = 0; i < count; i++) for (int j = 0; j < 2; j++) sum += values[i][j].id + values[i][j].value;
    return sum;
}
Row *rows_make(size_t count) {
    Row *values = malloc((count == 0 ? 1 : count) * sizeof(Row));
    if (values == NULL) abort();
    for (size_t i = 0; i < count; i++) for (int j = 0; j < 3; j++) values[i][j] = (int)i * 10 + j;
    return values;
}
CellRow *cells_make(size_t count) {
    CellRow *values = aligned_alloc(_Alignof(CellRow), (count == 0 ? 1 : count) * sizeof(CellRow));
    if (values == NULL) abort();
    for (size_t i = 0; i < count; i++) {
        CellRow row = {{(int)i, 7}, {(int)i + 1, 11}};
        memcpy(&values[i], &row, sizeof(row));
    }
    return values;
}
TaggedRow *tags_make(int invalid, size_t count) {
    TaggedRow *values = malloc((count == 0 ? 1 : count) * sizeof(TaggedRow));
    if (values == NULL) abort();
    for (size_t i = 0; i < count; i++) {
        TaggedRow row = {{1, {.integer = (int)i}}, {invalid && i == 1 ? 7 : 1, {.integer = (int)i + 1}}};
        memcpy(&values[i], &row, sizeof(row));
    }
    return values;
}
void rows_free(void *values) { freed++; free(values); }
int rows_freed(void) { return freed; }
int rows_taken(void) { return taken; }
void rows_visit(const Row *values, size_t count, void (*callback)(const Row *, size_t, void *), void *data) { callback(values, count, data); }

int rows_bump(Row *values, size_t count) { for (size_t i = 0; i < count; i++) values[i][0] += 10; return rows_sum(values, count); }

void rows_fill(Row *values, size_t capacity, size_t *written) {
    taken++;
    *written = capacity > 0 ? capacity - 1 : 0;
    for (size_t i = 0; i < *written; i++) for (int j = 0; j < 3; j++) values[i][j] = (int)i * 10 + j;
}
void rows_full(Row *values, size_t capacity) {
    taken++;
    for (size_t i = 0; i < capacity; i++) for (int j = 0; j < 3; j++) values[i][j] = (int)i * 10 + j;
}
void rows_inout(Row *values, size_t *count) {
    taken++;
    for (size_t i = 0; i < *count; i++) for (int j = 0; j < 3; j++) values[i][j] += 100;
    if (*count > 0) --*count;
}
void rows_bad_count(Row *values, size_t capacity, int mode, int64_t *written) {
    (void)values;
    taken++;
    *written = mode == 0 ? -1 : (int64_t)capacity + 1;
}
void cells_inout(CellRow *values, size_t *count) {
    taken++;
    if (*count > 0 && (uintptr_t)values % _Alignof(CellRow) != 0) abort();
    for (size_t i = 0; i < *count; i++) for (int j = 0; j < 2; j++) values[i][j].writable += 100;
    if (*count > 0) --*count;
}
void cells_fill(CellRow *values, size_t capacity, size_t *written) {
    taken++;
    if (capacity > 0 && (uintptr_t)values % _Alignof(CellRow) != 0) abort();
    for (size_t i = 0; i < capacity; i++) {
        CellRow row = {{(int)i, 7}, {(int)i + 1, 11}};
        memcpy(&values[i], &row, sizeof(row));
    }
    *written = capacity;
}
void rows_created(size_t requested, Row **values, size_t *written) { *values = rows_make(requested); *written = requested; }
void ints_fill(int *values, size_t capacity, size_t *written) {
    taken++;
    for (size_t i = 0; i < capacity; i++) values[i] = (int)i + 3;
    *written = capacity;
}

void rows_fill_visit(Row *values, size_t capacity, size_t *written, void (*callback)(void *), void *data) { rows_fill(values, capacity, written); callback(data); }


typedef struct {
    int mode;
    void (*callback)(const Row *, int64_t, const CellRow *, int64_t, void *);
    void *data;
    void (*release)(void *);
} RowNotification;
static void *rows_produce_notification(void *argument) {
    RowNotification *job = argument;
    Row rows[2] = {{2, 3, 5}, {7, 11, 13}};
    CellRow *cells = cells_make(2);
    int64_t count = job->mode == 1 ? 0 : job->mode == 2 ? -1 : job->mode == 3 ? INT64_MAX : 2;
    job->callback(job->mode == 4 ? NULL : rows, count, job->mode == 4 ? NULL : cells, count, job->data);
    memset(rows, 0, sizeof(rows));
    memset(cells, 0, 2 * sizeof(CellRow));
    free(cells);
    job->release(job->data);
    return NULL;
}
void rows_notify(int mode, void (*callback)(const Row *, int64_t, const CellRow *, int64_t, void *), void *data, void (*release)(void *)) {
    RowNotification job = {mode, callback, data, release};
    pthread_t thread;
    if (pthread_create(&thread, NULL, rows_produce_notification, &job) != 0) abort();
    if (pthread_join(thread, NULL) != 0) abort();
}

typedef struct {
    int mode;
    void (*callback)(const TextRow *, int64_t, void *);
    void *data;
    void (*release)(void *);
} TextNotification;
static void *texts_produce_notification(void *argument) {
    TextNotification *job = argument;
    char first[] = "native text";
    char second[] = "caf\xc3\xa9";
    TextRow rows[2] = {{first, NULL, ""}, {second, first, NULL}};
    int64_t count = job->mode == 1 ? 0 : job->mode == 2 ? -1 : job->mode == 3 ? INT64_MAX : 2;
    job->callback(job->mode == 4 ? NULL : rows, count, job->data);
    memset(first, 'x', sizeof(first));
    memset(second, 'x', sizeof(second));
    job->release(job->data);
    return NULL;
}
void texts_notify(int mode, void (*callback)(const TextRow *, int64_t, void *), void *data, void (*release)(void *)) {
    TextNotification job = {mode, callback, data, release};
    pthread_t thread;
    if (pthread_create(&thread, NULL, texts_produce_notification, &job) != 0) abort();
    if (pthread_join(thread, NULL) != 0) abort();
}

int char_rows_sum(const CharRow *values, size_t count) {
    taken++;
    int sum = 0;
    for (size_t i = 0; i < count; i++) {
        const char *end = memchr(values[i], 0, sizeof(CharRow));
        if (end == NULL) abort();
        sum += (int)(end - values[i]);
    }
    return sum;
}
int const_char_rows_sum(const ConstCharRow *values, size_t count) { return char_rows_sum(values, count); }
int char_grids_sum(const CharRow (*values)[2], size_t count) {
    int sum = 0;
    for (size_t i = 0; i < count; i++) sum += char_rows_sum(values[i], 2);
    return sum;
}
int byte_rows_sum(const ByteRow *values, size_t count) {
    taken++;
    int sum = 0;
    for (size_t i = 0; i < count; i++) for (size_t j = 0; j < sizeof(ByteRow); j++) sum += values[i][j];
    return sum;
}
CharRow *char_rows_make(int invalid, size_t count) {
    CharRow *values = calloc(count == 0 ? 1 : count, sizeof(CharRow));
    if (values == NULL) abort();
    for (size_t i = 0; i < count; i++) memcpy(values[i], i == 0 ? "one" : "caf\xc3\xa9", i == 0 ? 4 : 6);
    if (invalid && count > 0) memset(values[count - 1], 'x', sizeof(CharRow));
    return values;
}
ByteRow *byte_rows_make(size_t count) {
    ByteRow *values = malloc((count == 0 ? 1 : count) * sizeof(ByteRow));
    if (values == NULL) abort();
    for (size_t i = 0; i < count; i++) for (size_t j = 0; j < sizeof(ByteRow); j++) values[i][j] = (unsigned char)(i * 10 + j);
    return values;
}
void char_rows_inout(CharRow *values, size_t *count) {
    taken++;
    for (size_t i = 0; i < *count; i++) values[i][0] = 'X';
    if (*count > 0) --*count;
}
void byte_rows_inout(ByteRow *values, size_t *count) {
    taken++;
    for (size_t i = 0; i < *count; i++) values[i][0] += 100;
    if (*count > 0) --*count;
}
void char_rows_fill(CharRow *values, size_t capacity, size_t *written) {
    taken++;
    *written = capacity > 2 ? 2 : capacity;
    for (size_t i = 0; i < *written; i++) memcpy(values[i], "filled", 7);
}
void char_rows_visit(const CharRow *values, size_t count, void (*callback)(const CharRow *, size_t, void *), void *data) { callback(values, count, data); }
typedef struct {
    int invalid;
    void (*callback)(const CharRow *, size_t, void *);
    void *data;
    void (*release)(void *);
} CharNotification;
static void *chars_produce_notification(void *argument) {
    CharNotification *job = argument;
    CharRow *values = char_rows_make(job->invalid, 2);
    job->callback(values, 2, job->data);
    memset(values, 0, 2 * sizeof(CharRow));
    free(values);
    job->release(job->data);
    return NULL;
}
void char_rows_notify(int invalid, void (*callback)(const CharRow *, size_t, void *), void *data, void (*release)(void *)) {
    CharNotification job = {invalid, callback, data, release};
    pthread_t thread;
    if (pthread_create(&thread, NULL, chars_produce_notification, &job) != 0) abort();
    if (pthread_join(thread, NULL) != 0) abort();
}
