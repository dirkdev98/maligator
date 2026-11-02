#include "math.h"
#include <string.h>
unsigned int effects_mix(unsigned int value) { return value * 1664525u + 1013904223u; }
size_t effects_length(const char *value) { return strlen(value); }
unsigned long long effects_wide(unsigned long long value) { return value; }
long long effects_signed(long long value) { return value; }
void effects_touch(unsigned char *bytes, size_t length) {
    for (size_t index = 0; index < length; index++) bytes[index] = 42;
}
int effects_point(EffectPoint point) { return point.x + point.y; }
int effects_points(const EffectPoint *points, size_t count) {
    int sum = 0;
    for (size_t index = 0; index < count; index++) sum += effects_point(points[index]);
    return sum;
}
EffectPoint effects_new(int value) { return (EffectPoint) {value, value + 1}; }
int effects_tick(void) { static int tick; return ++tick; }
