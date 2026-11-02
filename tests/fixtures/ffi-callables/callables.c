#include "callables.h"

static int increment(int value) { return value + 1; }
static int negate(int value) { return -value; }
static double twice(double value) { return value * 2; }
static CallablePoint add(CallablePoint left, CallablePoint right) {
    return (CallablePoint) { left.x + right.x, left.y + right.y };
}
static const char *text(int which) { return which == 0 ? "native text" : NULL; }
static int apply(int value, CallableInt callback) { return callback(value) + 10; }
static int bytes(const unsigned char *data, size_t length) {
    int sum = 0;
    for (size_t index = 0; index < length; index++) sum += data[index];
    return sum;
}
static int fixed(int mode, int value) { return mode * value; }
static int output(int value, int *out) { *out = value + 5; return 7; }
static int CALLABLE_ABI abi_value(int value) { return value + 17; }

CallableInt callable_choose(int mode) { return mode == 0 ? increment : mode == 1 ? negate : NULL; }
int (*callable_anon(int mode))(int) { return callable_choose(mode); }
CallableInt callable_from_point(CallablePoint point) { return callable_choose(point.x > 0 ? 0 : 1); }
CallableDouble callable_double(void) { return twice; }
CallablePoints callable_point(void) { return add; }
CallableText callable_text(void) { return text; }
CallableApply callable_apply(void) { return apply; }
CallableBytes callable_bytes(void) { return bytes; }
CallableFixed callable_fixed(void) { return fixed; }
CallableOut callable_out(void) { return output; }
CallableFactory callable_factory(void) { return callable_choose; }
CallableAbi callable_abi(void) { return abi_value; }
int (CALLABLE_ABI *callable_abi_anon(void))(int) { return abi_value; }
