#include "numeric.h"
#include <stdatomic.h>
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
