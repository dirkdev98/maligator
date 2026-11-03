#include "dispatch.h"
#include <stdarg.h>
#include <string.h>
static int calls;
int dispatch_calls(void) { return calls; }
double dispatch_apply(int marker, ...) {
    calls++;
    if (marker != DISPATCH_MARKER) return -999;
    va_list args;
    va_start(args, marker);
    int mode = va_arg(args, int);
    double result = -1;
    switch (mode) {
        case DISPATCH_SMALL: {
            int first = va_arg(args, int);
            int second = va_arg(args, int);
            double third = va_arg(args, double);
            result = first + second + third;
            break;
        }
        case DISPATCH_MIXED: {
            const char *text = va_arg(args, const char *);
            double weight = va_arg(args, double);
            long long integer = va_arg(args, long long);
            result = strlen(text) + weight + (double)integer;
            break;
        }
        case DISPATCH_ARRAY: {
            const int *values = va_arg(args, const int *);
            size_t count = va_arg(args, size_t);
            result = 0;
            for (size_t index = 0; index < count; index++) result += values[index];
            break;
        }
        case DISPATCH_OUT: {
            int *out = va_arg(args, int *);
            *out = 91;
            result = 3.5;
            break;
        }
        case DISPATCH_CALLBACK: {
            int (*callback)(int, void *) = va_arg(args, int (*)(int, void *));
            void *data = va_arg(args, void *);
            result = callback(8, data);
            break;
        }
    }
    va_end(args);
    return result;
}
int dispatch_empty(int count, ...) {
    calls++;
    va_list args;
    va_start(args, count);
    int result = count == 0 ? 19 : va_arg(args, int);
    va_end(args);
    return result;
}
