#include "numeric.h"
#include <math.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>
static _Atomic int calls;
#define DEFINE_SUM(name, type) \
    type name(const type *values, int count) { \
        calls++; \
        type result = 0; \
        for (int i = 0; i < count; i++) result += values[i]; \
        return result; \
    }
DEFINE_SUM(numeric_i8, int8_t)
DEFINE_SUM(numeric_u8, uint8_t)
DEFINE_SUM(numeric_i16, int16_t)
DEFINE_SUM(numeric_u16, uint16_t)
DEFINE_SUM(numeric_i32, int32_t)
DEFINE_SUM(numeric_u32, uint32_t)
DEFINE_SUM(numeric_i64, int64_t)
DEFINE_SUM(numeric_u64, uint64_t)
DEFINE_SUM(numeric_f32, float)
DEFINE_SUM(numeric_f64, double)
double numeric_dot(const double *left, const double *right, int count) {
    calls++;
    double result = 0;
    for (int i = 0; i < count; i++) result += left[i] * right[i];
    return result;
}
double numeric_independent(double *left, int left_count, const double *right, int right_count) {
    calls++;
    if (left_count > 0) left[0] += 7;
    return (left_count > 0 ? left[0] : 0) + (right_count > 0 ? right[0] : 0);
}
double numeric_visit(const double *values, int count, NumericVisit visit, void *data) {
    calls++;
    double before = count > 0 ? values[0] : 0;
    visit(data);
    return before + (count > 0 ? values[0] : 0);
}
double numeric_mutable(double *values, int count) {
    calls++;
    if (count == 0) return 0;
    return values[0] += 1;
}
bool numeric_bool(const bool *values, int count) {
    calls++;
    return count > 0 && values[0];
}
int numeric_calls(void) { return calls; }
void numeric_reset(void) { calls = 0; }

static _Atomic int live;
#define DEFINE_OUT(name, type, ...) \
    type *name(int *count) { \
        static const type values[] = {__VA_ARGS__}; \
        type *copy = malloc(sizeof(values)); \
        if (copy == NULL) abort(); \
        memcpy(copy, values, sizeof(values)); \
        live++; \
        *count = (int)(sizeof(values) / sizeof(values[0])); \
        return copy; \
    }
DEFINE_OUT(numeric_out_i8, int8_t, INT8_MIN, -1, INT8_MAX)
DEFINE_OUT(numeric_out_u8, uint8_t, 0, 128, UINT8_MAX)
DEFINE_OUT(numeric_out_i16, int16_t, INT16_MIN, -1, INT16_MAX)
DEFINE_OUT(numeric_out_u16, uint16_t, 0, 32768, UINT16_MAX)
DEFINE_OUT(numeric_out_i32, int32_t, INT32_MIN, -1, INT32_MAX)
DEFINE_OUT(numeric_out_u32, uint32_t, 0, 2147483648u, UINT32_MAX)
float *numeric_out_f32(int *count) {
    float *values = malloc(4 * sizeof(float));
    if (values == NULL) abort();
    values[0] = 0.5f; values[1] = -0.0f; values[2] = NAN; values[3] = -INFINITY;
    live++;
    *count = 4;
    return values;
}
double *numeric_out_f64(int *count) {
    // The NaN's payload would read as a tagged object value if copied verbatim.
    uint64_t tagged = UINT64_C(0xFFFD000000001234);
    double *values = malloc(4 * sizeof(double));
    if (values == NULL) abort();
    values[0] = 0.1; values[1] = -0.0; memcpy(&values[2], &tagged, sizeof(tagged)); values[3] = 1e308;
    live++;
    *count = 4;
    return values;
}
int32_t *numeric_out_empty(int *count) { *count = 0; live++; return malloc(1); }
int32_t *numeric_out_null(int *count) { *count = 3; return NULL; }
void numeric_out_free(void *values) { if (values != NULL) { live--; free(values); } }
void numeric_fill(int16_t *values, int capacity, int *written) {
    int count = capacity < 2 ? capacity : capacity - 1;
    for (int i = 0; i < count; i++) values[i] = (int16_t)(INT16_MIN + i);
    *written = count;
}
void numeric_emit(void (*visit)(void *data, const float *values, int count), void *data) {
    float values[300];
    for (int i = 0; i < 300; i++) values[i] = (float)i * 0.25f;
    visit(data, values, 300);
    memset(values, 0, sizeof(values));
}
void numeric_negate(int16_t *values, size_t *count) {
    calls++;
    for (size_t i = 0; i < *count; i++) values[i] = (int16_t) -values[i];
}
double numeric_scale(double *values, int count, double factor) {
    calls++;
    double total = 0;
    for (int i = 0; i < count; i++) total += values[i] *= factor;
    return total;
}
void numeric_sequence(uint64_t *values, int count, uint64_t start) {
    calls++;
    for (int i = 0; i < count; i++) values[i] = start + (uint64_t) i;
}
int numeric_live(void) { return live; }

uint16_t numeric_short(const uint16_t *values, uint16_t count) {
    uint16_t sum = 0;
    for (uint16_t index = 0; index < count; index++) sum += values[index];
    return sum;
}
