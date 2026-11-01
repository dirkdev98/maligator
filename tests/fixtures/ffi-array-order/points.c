#include "points.h"
static int calls;
double array_sum(const ArrayPoint *points, int length) {
    calls++;
    double sum = 0;
    for (int index = 0; index < length; index++) sum += points[index].x + points[index].y;
    return sum;
}
int array_calls(void) { return calls; }
void array_reset(void) { calls = 0; }
int array_scalar(int value) { return value + 1; }
