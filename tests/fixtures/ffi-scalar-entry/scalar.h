#ifndef SCALAR_H
#define SCALAR_H
#include <stdint.h>
#include <stdbool.h>
int32_t scalar_i32(int32_t value);
uint32_t scalar_u32(uint32_t value);
uint8_t scalar_u8(uint8_t value);
bool scalar_not(bool value);
double scalar_float(double value);
float scalar_float32(float value);
double scalar_nan(void);
uint32_t scalar_high(double value);
uint64_t scalar_u64(uint64_t value);
uint64_t scalar_calls(void);
void scalar_touch(int32_t value);
int32_t scalar_last(void);
double scalar_dot(const double *left, const double *right, int32_t count);
void scalar_scale(double *values, int32_t count, double factor);
uint32_t scalar_sum_u8(const uint8_t *bytes, uint32_t count);
bool scalar_empty(const double *values, int32_t count);
double scalar_at(const double *values, int32_t count, int32_t index);
#endif
