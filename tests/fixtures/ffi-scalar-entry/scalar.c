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
