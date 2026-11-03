#include "pairs.h"
#include <stdatomic.h>
static _Atomic int calls;
double pair_dot(const double *left, unsigned char count, const double *right) {
    calls++;
    double result = 0;
    for (int i = 0; i < count; i++) result += left[i] * right[i];
    return result;
}
int pair_bytes(const unsigned char *left, const unsigned char *right, int count, PairVisit visit, void *data) {
    calls++;
    if (visit) visit(data);
    int result = 0;
    for (int i = 0; i < count; i++) result += left[i] * right[i];
    return result;
}
double pair_mixed(const double *values, const void *bytes, int count) {
    calls++;
    double result = 0;
    for (int i = 0; i < count; i++) result += values[i] * ((const unsigned char *) bytes)[i];
    return result;
}
double pair_reversed(const void *bytes, const double *values, int count) {
    return pair_mixed(values, bytes, count);
}
int pair_text(const char *text, const void *bytes, int count) {
    calls++;
    int result = 0;
    for (int i = 0; i < count; i++) result += (unsigned char) text[i] * ((const unsigned char *) bytes)[i];
    return result;
}
int pair_calls(void) { return calls; }
void pair_reset(void) { calls = 0; }
void pair_pointer(const double *left, const double *right, int *count) {
    (void) left; (void) right; (void) count;
}
void pair_capacity(double *output, int count, int *written, const double *left, const double *right) {
    for (int i = 0; i < count; i++) output[i] = left[i] + right[i];
    *written = count;
}
