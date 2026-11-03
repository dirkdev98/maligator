#ifndef FFI_NUMERIC_VIEWS_H
#define FFI_NUMERIC_VIEWS_H
#include <stdbool.h>
#include <stdint.h>
typedef void (*NumericVisit)(void *data);
int8_t numeric_i8(const int8_t *values, int count);
uint8_t numeric_u8(const uint8_t *values, int count);
int16_t numeric_i16(const int16_t *values, int count);
uint16_t numeric_u16(const uint16_t *values, int count);
int32_t numeric_i32(const int32_t *values, int count);
uint32_t numeric_u32(const uint32_t *values, int count);
int64_t numeric_i64(const int64_t *values, int count);
uint64_t numeric_u64(const uint64_t *values, int count);
float numeric_f32(const float *values, int count);
double numeric_f64(const double *values, int count);
double numeric_dot(const double *left, const double *right, int count);
double numeric_visit(const double *values, int count, NumericVisit visit, void *data);
double numeric_mutable(double *values, int count);
bool numeric_bool(const bool *values, int count);
int numeric_calls(void);
void numeric_reset(void);
#endif
