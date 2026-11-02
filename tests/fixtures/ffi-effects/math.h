#ifndef FFI_EFFECTS_H
#define FFI_EFFECTS_H
#include <stddef.h>
typedef struct EffectPoint { int x; int y; } EffectPoint;
unsigned int effects_mix(unsigned int value);
size_t effects_length(const char *value);
unsigned long long effects_wide(unsigned long long value);
long long effects_signed(long long value);
void effects_touch(unsigned char *bytes, size_t length);
int effects_point(EffectPoint point);
int effects_points(const EffectPoint *points, size_t count);
EffectPoint effects_new(int value);
int effects_tick(void);
#endif
