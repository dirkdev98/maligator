#include "scalar.h"
#include <string.h>
static volatile uint64_t calls;
static int32_t last;
int32_t scalar_i32(int32_t value) { calls++; return value; }
uint32_t scalar_u32(uint32_t value) { calls++; return value; }
uint8_t scalar_u8(uint8_t value) { calls++; return value; }
bool scalar_not(bool value) { return !value; }
double scalar_float(double value) { return value; }
float scalar_float32(float value) { return value; }
double scalar_nan(void) {
    uint64_t bits = UINT64_C(0xfff8123400000042);
    double value;
    memcpy(&value, &bits, sizeof(value));
    return value;
}
uint32_t scalar_high(double value) {
    uint64_t bits;
    memcpy(&bits, &value, sizeof(bits));
    return (uint32_t) (bits >> 32);
}
uint64_t scalar_u64(uint64_t value) { return value; }
uint64_t scalar_calls(void) { return calls; }
void scalar_touch(int32_t value) { last = value; }
int32_t scalar_last(void) { return last; }
double scalar_dot(const double *left, const double *right, int32_t count) {
    calls++;
    double sum = 0;
    for (int32_t index = 0; index < count; index++) sum += left[index] * right[index];
    return sum;
}
void scalar_scale(double *values, int32_t count, double factor) {
    for (int32_t index = 0; index < count; index++) values[index] *= factor;
}
uint32_t scalar_sum_u8(const uint8_t *bytes, uint32_t count) {
    uint32_t sum = 0;
    for (uint32_t index = 0; index < count; index++) sum += bytes[index];
    return sum;
}
bool scalar_empty(const double *values, int32_t count) { return values == NULL && count == 0; }
