#ifndef ARRAY_POINTS_H
#define ARRAY_POINTS_H
typedef struct ArrayPoint { float x; float y; } ArrayPoint;
double array_sum(const ArrayPoint *points, int length);
int array_calls(void);
void array_reset(void);
int array_scalar(int value);
#endif
