#include "builtin_math.h"

#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#include "builtin_iterator.h"
#include "checked_size.h"
#include "float16.h"
#include "object_ops.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

/**
 * Spec ToNumber on a Math argument. Returns false with a pending throw
 * completion on the vm (Symbol/BigInt/abrupt @@toPrimitive); callers bail by
 * returning any placeholder value, the dispatcher reads vm->completion.
 * Missing arguments coerce to NaN (ToNumber(undefined)).
 */
static inline bool mal_builtin_math_value_to_number(MalVm *vm, MalValue value, f64 *out) {
    if (mal_ops_is_number(value)) {
        *out = mal_ops_number_as_f64(value);
        return true;
    }
    return mal_vm_to_number(vm, value, out);
}

static bool mal_builtin_math_to_number(MalVm *vm, const MalValue *args, i32 arg_count, i32 index, f64 *out) {
    if (index >= arg_count) {
        *out = NAN;
        return true;
    }
    return mal_builtin_math_value_to_number(vm, args[index], out);
}

#define MAL_BUILTIN_MATH_UNARY(name, expression) \
    static MalValue mal_builtin_math_##name(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) { \
        (void) this_value; \
        (void) new_target; \
        (void) callee; \
        f64 x; \
        if (!mal_builtin_math_to_number(vm, args, arg_count, 0, &x)) { \
            return mal_value_new_nan(); \
        } \
        return mal_ops_number_value(expression); \
    }

MAL_BUILTIN_MATH_UNARY(abs, fabs(x))
MAL_BUILTIN_MATH_UNARY(floor, floor(x))
MAL_BUILTIN_MATH_UNARY(ceil, ceil(x))
MAL_BUILTIN_MATH_UNARY(trunc, trunc(x))
MAL_BUILTIN_MATH_UNARY(sqrt, sqrt(x))
MAL_BUILTIN_MATH_UNARY(cbrt, cbrt(x))
MAL_BUILTIN_MATH_UNARY(sign, isnan(x) ? NAN : (x > 0 ? 1 : (x < 0 ? -1 : x)))
MAL_BUILTIN_MATH_UNARY(log, log(x))
MAL_BUILTIN_MATH_UNARY(log2, log2(x))
MAL_BUILTIN_MATH_UNARY(log10, log10(x))
MAL_BUILTIN_MATH_UNARY(exp, exp(x))
MAL_BUILTIN_MATH_UNARY(sin, sin(x))
MAL_BUILTIN_MATH_UNARY(cos, cos(x))
MAL_BUILTIN_MATH_UNARY(tan, tan(x))
MAL_BUILTIN_MATH_UNARY(asin, asin(x))
MAL_BUILTIN_MATH_UNARY(acos, acos(x))
MAL_BUILTIN_MATH_UNARY(atan, atan(x))
MAL_BUILTIN_MATH_UNARY(sinh, sinh(x))
MAL_BUILTIN_MATH_UNARY(cosh, cosh(x))
MAL_BUILTIN_MATH_UNARY(tanh, tanh(x))
MAL_BUILTIN_MATH_UNARY(asinh, asinh(x))
MAL_BUILTIN_MATH_UNARY(acosh, acosh(x))
MAL_BUILTIN_MATH_UNARY(atanh, atanh(x))
MAL_BUILTIN_MATH_UNARY(log1p, log1p(x))
MAL_BUILTIN_MATH_UNARY(expm1, expm1(x))
MAL_BUILTIN_MATH_UNARY(fround, (f64) (float) x)

#undef MAL_BUILTIN_MATH_UNARY

static MalValue mal_builtin_math_round(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target,
    MalValue callee
);

static MalValue mal_builtin_math_round_number(f64 x) {
    if (!isfinite(x) || x == 0.0 || fabs(x) >= 4503599627370496.0 /* 2^52 */) {
        return mal_ops_number_value(x);
    }
    if (x < 0.0 && x >= -0.5) {
        return mal_value_from_f64(-0.0);
    }
    f64 lower = floor(x);
    return mal_ops_number_value(x - lower < 0.5 ? lower : lower + 1.0);
}

f64 mal_builtin_math_unary_number_known(MalMathUnaryOp operation, f64 x) {
    switch (operation) {
        case MAL_MATH_UNARY_ABS: return fabs(x);
        case MAL_MATH_UNARY_FLOOR: return floor(x);
        case MAL_MATH_UNARY_CEIL: return ceil(x);
        case MAL_MATH_UNARY_TRUNC: return trunc(x);
        case MAL_MATH_UNARY_SQRT: return sqrt(x);
        case MAL_MATH_UNARY_CBRT: return cbrt(x);
        case MAL_MATH_UNARY_SIGN: return isnan(x) ? NAN : (x > 0 ? 1 : (x < 0 ? -1 : x));
        case MAL_MATH_UNARY_LOG: return log(x);
        case MAL_MATH_UNARY_LOG2: return log2(x);
        case MAL_MATH_UNARY_LOG10: return log10(x);
        case MAL_MATH_UNARY_EXP: return exp(x);
        case MAL_MATH_UNARY_SIN: return sin(x);
        case MAL_MATH_UNARY_COS: return cos(x);
        case MAL_MATH_UNARY_TAN: return tan(x);
        case MAL_MATH_UNARY_ASIN: return asin(x);
        case MAL_MATH_UNARY_ACOS: return acos(x);
        case MAL_MATH_UNARY_ATAN: return atan(x);
        case MAL_MATH_UNARY_SINH: return sinh(x);
        case MAL_MATH_UNARY_COSH: return cosh(x);
        case MAL_MATH_UNARY_TANH: return tanh(x);
        case MAL_MATH_UNARY_ASINH: return asinh(x);
        case MAL_MATH_UNARY_ACOSH: return acosh(x);
        case MAL_MATH_UNARY_ATANH: return atanh(x);
        case MAL_MATH_UNARY_LOG1P: return log1p(x);
        case MAL_MATH_UNARY_EXPM1: return expm1(x);
        case MAL_MATH_UNARY_FROUND: return (f64) (float) x;
        case MAL_MATH_UNARY_ROUND:
            return mal_ops_number_as_f64(mal_builtin_math_round_number(x));
        case MAL_MATH_UNARY_NONE: return NAN;
    }
    return NAN;
}

bool mal_builtin_math_unary_fast(
    MalValue callee, MalMathUnaryOp *cached_op, MalValue argument, MalValue *result
) {
    if (!mal_value_is_native_function_object(callee) || !mal_ops_is_number(argument)) {
        return false;
    }
    MalNativeFunctionCallback callback = mal_native_function_object_callback(
        mal_value_to_native_function_object(callee));
    f64 x = mal_ops_number_as_f64(argument);

#define MAL_MATH_UNARY_CASE(op, name, expression) \
    case MAL_MATH_UNARY_##op: \
        if (callback == mal_builtin_math_##name) { \
            *result = mal_ops_number_value(expression); \
            return true; \
        } \
        break;
    switch (*cached_op) {
        MAL_MATH_UNARY_CASE(ABS, abs, fabs(x))
        MAL_MATH_UNARY_CASE(FLOOR, floor, floor(x))
        MAL_MATH_UNARY_CASE(CEIL, ceil, ceil(x))
        MAL_MATH_UNARY_CASE(TRUNC, trunc, trunc(x))
        MAL_MATH_UNARY_CASE(SQRT, sqrt, sqrt(x))
        MAL_MATH_UNARY_CASE(CBRT, cbrt, cbrt(x))
        MAL_MATH_UNARY_CASE(SIGN, sign, isnan(x) ? NAN : (x > 0 ? 1 : (x < 0 ? -1 : x)))
        MAL_MATH_UNARY_CASE(LOG, log, log(x))
        MAL_MATH_UNARY_CASE(LOG2, log2, log2(x))
        MAL_MATH_UNARY_CASE(LOG10, log10, log10(x))
        MAL_MATH_UNARY_CASE(EXP, exp, exp(x))
        MAL_MATH_UNARY_CASE(SIN, sin, sin(x))
        MAL_MATH_UNARY_CASE(COS, cos, cos(x))
        MAL_MATH_UNARY_CASE(TAN, tan, tan(x))
        MAL_MATH_UNARY_CASE(ASIN, asin, asin(x))
        MAL_MATH_UNARY_CASE(ACOS, acos, acos(x))
        MAL_MATH_UNARY_CASE(ATAN, atan, atan(x))
        MAL_MATH_UNARY_CASE(SINH, sinh, sinh(x))
        MAL_MATH_UNARY_CASE(COSH, cosh, cosh(x))
        MAL_MATH_UNARY_CASE(TANH, tanh, tanh(x))
        MAL_MATH_UNARY_CASE(ASINH, asinh, asinh(x))
        MAL_MATH_UNARY_CASE(ACOSH, acosh, acosh(x))
        MAL_MATH_UNARY_CASE(ATANH, atanh, atanh(x))
        MAL_MATH_UNARY_CASE(LOG1P, log1p, log1p(x))
        MAL_MATH_UNARY_CASE(EXPM1, expm1, expm1(x))
        MAL_MATH_UNARY_CASE(FROUND, fround, (f64) (float) x)
        case MAL_MATH_UNARY_ROUND:
            if (callback == mal_builtin_math_round) {
                *result = mal_builtin_math_round_number(x);
                return true;
            }
            break;
        default: break;
    }
#undef MAL_MATH_UNARY_CASE

#define MAL_MATH_UNARY_RESOLVE(op, name, expression) \
    if (callback == mal_builtin_math_##name) { \
        *cached_op = MAL_MATH_UNARY_##op; \
        *result = mal_ops_number_value(expression); \
        return true; \
    }
    MAL_MATH_UNARY_RESOLVE(ABS, abs, fabs(x))
    MAL_MATH_UNARY_RESOLVE(FLOOR, floor, floor(x))
    MAL_MATH_UNARY_RESOLVE(CEIL, ceil, ceil(x))
    MAL_MATH_UNARY_RESOLVE(TRUNC, trunc, trunc(x))
    MAL_MATH_UNARY_RESOLVE(SQRT, sqrt, sqrt(x))
    MAL_MATH_UNARY_RESOLVE(CBRT, cbrt, cbrt(x))
    MAL_MATH_UNARY_RESOLVE(SIGN, sign, isnan(x) ? NAN : (x > 0 ? 1 : (x < 0 ? -1 : x)))
    MAL_MATH_UNARY_RESOLVE(LOG, log, log(x))
    MAL_MATH_UNARY_RESOLVE(LOG2, log2, log2(x))
    MAL_MATH_UNARY_RESOLVE(LOG10, log10, log10(x))
    MAL_MATH_UNARY_RESOLVE(EXP, exp, exp(x))
    MAL_MATH_UNARY_RESOLVE(SIN, sin, sin(x))
    MAL_MATH_UNARY_RESOLVE(COS, cos, cos(x))
    MAL_MATH_UNARY_RESOLVE(TAN, tan, tan(x))
    MAL_MATH_UNARY_RESOLVE(ASIN, asin, asin(x))
    MAL_MATH_UNARY_RESOLVE(ACOS, acos, acos(x))
    MAL_MATH_UNARY_RESOLVE(ATAN, atan, atan(x))
    MAL_MATH_UNARY_RESOLVE(SINH, sinh, sinh(x))
    MAL_MATH_UNARY_RESOLVE(COSH, cosh, cosh(x))
    MAL_MATH_UNARY_RESOLVE(TANH, tanh, tanh(x))
    MAL_MATH_UNARY_RESOLVE(ASINH, asinh, asinh(x))
    MAL_MATH_UNARY_RESOLVE(ACOSH, acosh, acosh(x))
    MAL_MATH_UNARY_RESOLVE(ATANH, atanh, atanh(x))
    MAL_MATH_UNARY_RESOLVE(LOG1P, log1p, log1p(x))
    MAL_MATH_UNARY_RESOLVE(EXPM1, expm1, expm1(x))
    MAL_MATH_UNARY_RESOLVE(FROUND, fround, (f64) (float) x)
#undef MAL_MATH_UNARY_RESOLVE
    if (callback == mal_builtin_math_round) {
        *cached_op = MAL_MATH_UNARY_ROUND;
        *result = mal_builtin_math_round_number(x);
        return true;
    }
    *cached_op = MAL_MATH_UNARY_NONE;
    return false;
}

// Math.round: spec rounds halves toward +Infinity, but preserves -0 for
// arguments in (-0.5, -0] and returns the argument unchanged for NaN, the
// infinities, integers, and magnitudes so large that x + 0.5 would lose
// precision (>= 2^52). floor(x + 0.5) is correct only for the remaining range.
static MalValue mal_builtin_math_round(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    f64 x;
    if (!mal_builtin_math_to_number(vm, args, arg_count, 0, &x)) {
        return mal_value_new_nan();
    }

    return mal_builtin_math_round_number(x);
}

f64 mal_builtin_math_clz32_number(f64 x) {
    u32 value = mal_ops_number_to_uint32(x);
    return value == 0 ? 32 : __builtin_clz(value);
}

static MalValue mal_builtin_math_clz32(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    f64 x;
    if (!mal_builtin_math_to_number(vm, args, arg_count, 0, &x)) {
        return mal_value_new_nan();
    }
    return mal_ops_number_value(mal_builtin_math_clz32_number(x));
}

f64 mal_builtin_math_imul_number(f64 left, f64 right) {
    u32 a = mal_ops_number_to_uint32(left);
    u32 b = mal_ops_number_to_uint32(right);
    return (i32) (a * b);
}

static MalValue mal_builtin_math_imul(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    f64 left;
    if (!mal_builtin_math_to_number(vm, args, arg_count, 0, &left)) {
        return mal_value_new_nan();
    }
    f64 right;
    if (!mal_builtin_math_to_number(vm, args, arg_count, 1, &right)) {
        return mal_value_new_nan();
    }
    return mal_ops_number_value(mal_builtin_math_imul_number(left, right));
}

// Spec "applying the ** operator": C pow disagrees with the spec on NaN
// exponents and on |base| == 1 with an infinite exponent, so handle those
// special cases by hand before delegating to libm.
f64 mal_builtin_math_pow_number(f64 base, f64 exponent) {
    if (isnan(exponent)) {
        return NAN;
    }
    if (exponent == 0.0) {
        return 1.0;
    }
    if (isnan(base)) {
        return NAN;
    }
    if (isinf(exponent)) {
        f64 abs_base = fabs(base);
        if (abs_base == 1.0) {
            return NAN;
        }
        if (abs_base > 1.0) {
            return exponent > 0.0 ? INFINITY : 0.0;
        }
        return exponent > 0.0 ? 0.0 : INFINITY;
    }
    return pow(base, exponent);
}

static MalValue mal_builtin_math_pow(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    f64 base;
    if (!mal_builtin_math_to_number(vm, args, arg_count, 0, &base)) {
        return mal_value_new_nan();
    }
    f64 exponent;
    if (!mal_builtin_math_to_number(vm, args, arg_count, 1, &exponent)) {
        return mal_value_new_nan();
    }
    return mal_ops_number_value(mal_builtin_math_pow_number(base, exponent));
}

static MalValue mal_builtin_math_atan2(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    f64 y;
    if (!mal_builtin_math_to_number(vm, args, arg_count, 0, &y)) {
        return mal_value_new_nan();
    }
    f64 x;
    if (!mal_builtin_math_to_number(vm, args, arg_count, 1, &x)) {
        return mal_value_new_nan();
    }
    return mal_ops_number_value(atan2(y, x));
}

typedef struct {
    bool any_infinity;
    bool any_nan;
    f64 scale;
    f64 scaled_sum;
} MalHypotState;

static void mal_builtin_math_hypot_add(MalHypotState *state, f64 value) {
    if (isinf(value)) {
        state->any_infinity = true;
    } else if (isnan(value)) {
        state->any_nan = true;
    } else {
        // Rescaling keeps finite squares representable without changing coercion order.
        f64 magnitude = fabs(value);
        if (magnitude > state->scale) {
            f64 ratio = state->scale / magnitude;
            state->scaled_sum = state->scaled_sum * ratio * ratio + 1.0;
            state->scale = magnitude;
        } else if (magnitude != 0.0) {
            f64 ratio = magnitude / state->scale;
            state->scaled_sum += ratio * ratio;
        }
    }
}

static f64 mal_builtin_math_hypot_finish(const MalHypotState *state) {
    if (state->any_infinity) return INFINITY;
    if (state->any_nan) return NAN;
    return state->scale == 0.0 ? 0.0 : state->scale * sqrt(state->scaled_sum);
}

f64 mal_builtin_math_hypot_numbers(const f64 *args, i32 arg_count) {
    if (arg_count == 1) return fabs(args[0]);
    if (arg_count == 2) {
        if (isinf(args[0]) || isinf(args[1])) return INFINITY;
        if (isnan(args[0]) || isnan(args[1])) return NAN;
        return hypot(args[0], args[1]);
    }
    MalHypotState state = {0};
    for (i32 i = 0; i < arg_count; i++) mal_builtin_math_hypot_add(&state, args[i]);
    return mal_builtin_math_hypot_finish(&state);
}

static MalValue mal_builtin_math_hypot(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    if (arg_count <= 2) {
        f64 numbers[2];
        for (i32 i = 0; i < arg_count; i++) {
            if (!mal_builtin_math_value_to_number(vm, args[i], &numbers[i])) return mal_value_new_nan();
        }
        return mal_ops_number_value(mal_builtin_math_hypot_numbers(numbers, arg_count));
    }
    MalHypotState state = {0};
    for (i32 i = 0; i < arg_count; i++) {
        f64 value;
        if (!mal_builtin_math_value_to_number(vm, args[i], &value)) return mal_value_new_nan();
        mal_builtin_math_hypot_add(&state, value);
    }
    return mal_ops_number_value(mal_builtin_math_hypot_finish(&state));
}

static f64 mal_builtin_math_min_max_add(f64 result, f64 value, bool is_max) {
    if (isnan(result) || isnan(value)) return NAN;
    if (result == 0.0 && value == 0.0) {
        bool negative = is_max ? signbit(result) && signbit(value) : signbit(result) || signbit(value);
        return negative ? -0.0 : 0.0;
    }
    return is_max ? (value > result ? value : result) : (value < result ? value : result);
}

f64 mal_builtin_math_min_max_numbers(const f64 *args, i32 arg_count, bool is_max) {
    f64 result = is_max ? -INFINITY : INFINITY;
    for (i32 i = 0; i < arg_count; i++) result = mal_builtin_math_min_max_add(result, args[i], is_max);
    return result;
}

static MalValue mal_builtin_math_min_max(MalVm *vm, const MalValue *args, i32 arg_count, bool is_max) {
    f64 result = is_max ? -INFINITY : INFINITY;
    // A NaN result cannot short-circuit the remaining observable conversions.
    for (i32 i = 0; i < arg_count; i++) {
        f64 value;
        if (!mal_builtin_math_value_to_number(vm, args[i], &value)) return mal_value_new_nan();
        result = mal_builtin_math_min_max_add(result, value, is_max);
    }
    return mal_ops_number_value(result);
}

static MalValue mal_builtin_math_min(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_builtin_math_min_max(vm, args, arg_count, false);
}

static MalValue mal_builtin_math_max(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_builtin_math_min_max(vm, args, arg_count, true);
}

static MalValue mal_builtin_math_min_max_two(f64 left, f64 right, bool is_max) {
    return mal_ops_number_value(mal_builtin_math_min_max_add(left, right, is_max));
}

f64 mal_builtin_math_binary_number_known(MalMathBinaryOp operation, f64 left, f64 right) {
    MalValue result;
    switch (operation) {
        case MAL_MATH_BINARY_MIN:
            result = mal_builtin_math_min_max_two(left, right, false);
            break;
        case MAL_MATH_BINARY_MAX:
            result = mal_builtin_math_min_max_two(left, right, true);
            break;
        case MAL_MATH_BINARY_NONE:
            return NAN;
    }
    return mal_ops_number_as_f64(result);
}

bool mal_builtin_math_binary_fast(
    MalValue callee, MalMathBinaryOp *cached_op, MalValue left, MalValue right, MalValue *result
) {
    if (!mal_value_is_native_function_object(callee) || !mal_ops_is_number(left) ||
        !mal_ops_is_number(right)) {
        return false;
    }
    MalNativeFunctionCallback callback = mal_native_function_object_callback(
        mal_value_to_native_function_object(callee));
    f64 x = mal_ops_number_as_f64(left);
    f64 y = mal_ops_number_as_f64(right);
    if (*cached_op == MAL_MATH_BINARY_MIN && callback == mal_builtin_math_min) {
        *result = mal_builtin_math_min_max_two(x, y, false);
        return true;
    }
    if (*cached_op == MAL_MATH_BINARY_MAX && callback == mal_builtin_math_max) {
        *result = mal_builtin_math_min_max_two(x, y, true);
        return true;
    }
    if (callback == mal_builtin_math_min) {
        *cached_op = MAL_MATH_BINARY_MIN;
        *result = mal_builtin_math_min_max_two(x, y, false);
        return true;
    }
    if (callback == mal_builtin_math_max) {
        *cached_op = MAL_MATH_BINARY_MAX;
        *result = mal_builtin_math_min_max_two(x, y, true);
        return true;
    }
    *cached_op = MAL_MATH_BINARY_NONE;
    return false;
}

f64 mal_builtin_math_f16round_number(f64 x) {
    return mal_float16_bits_to_f64(mal_float16_f64_to_bits(x));
}

static MalValue mal_builtin_math_f16round(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    f64 x;
    if (!mal_builtin_math_to_number(vm, args, arg_count, 0, &x)) {
        return mal_value_new_nan();
    }
    return mal_ops_number_value(mal_builtin_math_f16round_number(x));
}

// Math.sumPrecise: exact (infinitely precise then single-rounded) summation of
// a list of Numbers, per the Neumaier/Shewchuk-style exact accumulation used by
// the proposal's reference. Elements must already be Numbers (no coercion);
// non-Numbers throw TypeError and close the iterator.
//
// We accumulate an exact running sum as a list of non-overlapping partial sums
// (Shewchuk's algorithm) and round once at the end.
// A same-sign addition of two finite doubles overflows by at most one 2^1024
// unit, so we carry the overflow as an integer count of 2^1024 units and keep
// the running partials reduced into the representable range. 2^1024 itself is
// not representable, so we always work in halves of 2^1023 (ldexp(1, 1023),
// which is finite and equals Number.MAX_VALUE's leading power of two).

typedef struct {
    f64 *partials;
    usize count;
    usize capacity;
    f64 overflow; // accumulated multiples of 2^1024 (carries beyond MAX_VALUE)
    f64 inline_partials[16];
} MalSumPartials;

static bool mal_sum_partials_push(MalVm *vm, MalSumPartials *p, f64 value) {
    if (p->count == p->capacity) {
        usize required;
        usize new_capacity;
        usize bytes;
        if (!mal_checked_size_add(p->count, 1, SIZE_MAX, &required) ||
            !mal_checked_size_growth(
                p->capacity, required, countof(p->inline_partials),
                SIZE_MAX / sizeof(f64), &new_capacity) ||
            !mal_checked_size_multiply(sizeof(f64), new_capacity, SIZE_MAX, &bytes)) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        f64 *grown;
        if (p->partials == p->inline_partials) {
            grown = malloc(bytes);
            if (grown != nullptr) {
                memcpy(grown, p->inline_partials, sizeof(f64) * p->count);
            }
        } else {
            grown = realloc(p->partials, bytes);
        }
        if (grown == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return false;
        }
        p->partials = grown;
        p->capacity = new_capacity;
    }
    p->partials[p->count++] = value;
    return true;
}

static bool mal_sum_partials_add(MalVm *vm, MalSumPartials *p, f64 x) {
    usize i = 0;
    for (usize j = 0; j < p->count; j++) {
        f64 y = p->partials[j];
        if (fabs(x) < fabs(y)) {
            f64 t = x;
            x = y;
            y = t;
        }
        f64 hi = x + y;
        f64 lo;
        if (isinf(hi)) {
            // Same-sign overflow: carry one 2^1024 unit and reduce the running
            // value by 2^1024 (two 2^1023 chunks) so partials stay finite. Each
            // subtraction can round when the operand carries bits below the
            // 2^1023 ULP (2^971), so we capture those residuals via Knuth 2Sum
            // and keep them as the low partial — the reduced sum must stay
            // exact or the final boundary rounding is wrong.
            f64 sign = hi > 0.0 ? 1.0 : -1.0;
            p->overflow += sign;
            f64 neg_half = -sign * ldexp(1.0, 1023); // -2^1023

            // xr = x - 2^1023 (exact part + residual rx)
            f64 xr = x + neg_half;
            f64 bv = xr - x;
            f64 rx = (x - (xr - bv)) + (neg_half - bv);
            // yr = y - 2^1023 (exact part + residual ry)
            f64 yr = y + neg_half;
            f64 bv2 = yr - y;
            f64 ry = (y - (yr - bv2)) + (neg_half - bv2);

            hi = xr + yr;
            f64 b3 = hi - xr;
            f64 hr = (xr - (hi - b3)) + (yr - b3); // residual of xr + yr (Knuth 2Sum)
            lo = rx + ry + hr;
        } else {
            lo = y - (hi - x);
        }
        if (lo != 0.0) {
            p->partials[i++] = lo;
        }
        x = hi;
    }
    p->count = i;
    return mal_sum_partials_push(vm, p, x);
}

static f64 mal_sum_partials_total(MalVm *vm, MalSumPartials *p) {
    // Reconcile carried 2^1024 overflow units. true_sum = (partials) +
    // overflow*2^1024. Two regimes:
    //  - In range: the partials carry a large opposite-signed value that pulls
    //    the magnitude back below 2^1024. Feeding the overflow back in as two
    //    2^1023 chunks through the exact accumulator settles to no overflow, and
    //    the folded result is correct (single rounding).
    //  - At/above the boundary: feeding the chunks re-triggers overflow because
    //    the magnitude truly sits near 2^1024. We then decide MAX_VALUE vs
    //    Infinity from the signed deviation of the partials from 2^1024.
    if (p->overflow != 0.0) {
        if (fabs(p->overflow) >= 2.0) {
            return p->overflow > 0.0 ? INFINITY : -INFINITY;
        }
        f64 sign = p->overflow > 0.0 ? 1.0 : -1.0;

        // Signed deviation of the current partials from 0 as an exact (hi, lo)
        // pair (their true sum is small relative to 2^1024). Fold the
        // non-overlapping partials top-down: dev_hi is the rounded sum, dev_lo
        // the residual that breaks an exact boundary tie. Computed before
        // feeding so the boundary test below sees the true offset.
        f64 dev_hi = 0.0;
        f64 dev_lo = 0.0;
        for (usize k = p->count; k-- > 0;) {
            f64 y = p->partials[k];
            f64 s = dev_hi + y;
            // |dev_hi| >= |y| (partials decrease), so Fast2Sum applies.
            dev_lo += (dev_hi - s) + y;
            dev_hi = s;
        }
        dev_hi *= sign; // align with the overflow direction
        dev_lo *= sign;

        f64 half = sign * ldexp(1.0, 1023); // 2^1023
        p->overflow = 0.0;
        if (!mal_sum_partials_add(vm, p, half) ||
            !mal_sum_partials_add(vm, p, half)) {
            return NAN;
        }

        if (p->overflow != 0.0) {
            // Boundary regime: |true| is within an ulp of 2^1024. The true
            // magnitude is 2^1024 + dev (dev = dev_hi + dev_lo, negative).
            // IEEE rounds |value| >= 2^1024 - 2^970 (the overflow midpoint, ties
            // to the infinite "even" candidate) to Infinity, else to MAX_VALUE.
            f64 max_value = ldexp(1.0, 1023) + (ldexp(1.0, 1023) - ldexp(1.0, 971)); // 2^1024 - 2^971
            f64 neg_threshold = -ldexp(1.0, 970);
            bool overflows;
            if (dev_hi > neg_threshold) {
                overflows = true;
            } else if (dev_hi < neg_threshold) {
                overflows = false;
            } else {
                // Exactly at the midpoint to sub-ulp precision: the residual
                // decides; a non-negative residual reaches/exceeds the
                // threshold (ties to Infinity), a negative one stays at MAX.
                overflows = dev_lo >= 0.0;
            }
            if (overflows) {
                return sign > 0.0 ? INFINITY : -INFINITY;
            }
            return sign * max_value;
        }
        // Settled in range: fall through to the standard fold over the partials.
    }

    // Correctly-rounded total of the non-overlapping partials, following
    // CPython's math.fsum tail. Partials are in increasing magnitude, so the
    // most-significant terms dominate and the round-half-to-even tie-break can
    // need a second pass over the smaller terms.
    usize n = p->count;
    if (n == 0) {
        return 0.0;
    }
    const f64 *partials = p->partials;

    f64 hi = partials[--n];
    f64 lo = 0.0;
    // sum_exact: fold partials down from the top until a nonzero residual.
    while (n > 0) {
        f64 x = hi;
        f64 y = partials[--n];
        hi = x + y;
        f64 yr = hi - x;
        lo = y - yr;
        if (lo != 0.0) {
            break;
        }
    }
    // Half-even rounding across multiple partials needs a second pass when the
    // residual and the next partial share a sign.
    if (n > 0 && ((lo < 0.0 && partials[n - 1] < 0.0) ||
                  (lo > 0.0 && partials[n - 1] > 0.0))) {
        f64 y = lo * 2.0;
        f64 x = hi + y;
        f64 yr = x - hi;
        if (y == yr) {
            hi = x;
        }
    }
    return hi;
}

typedef struct {
    MalSumPartials partials;
    bool positive_infinity;
    bool negative_infinity;
    bool nan;
    bool all_negative_zero;
} MalNumberSum;

static void mal_number_sum_init(MalNumberSum *sum) {
    *sum = (MalNumberSum) {0};
    sum->partials.partials = sum->partials.inline_partials;
    sum->partials.capacity = countof(sum->partials.inline_partials);
    sum->all_negative_zero = true;
}

static bool mal_number_sum_add(MalVm *vm, MalNumberSum *sum, f64 value) {
    if (isnan(value)) {
        sum->nan = true;
        return true;
    }
    if (isinf(value)) {
        if (value > 0.0) sum->positive_infinity = true;
        else sum->negative_infinity = true;
        return true;
    }
    if (value != 0.0 || !signbit(value)) sum->all_negative_zero = false;
    return value == 0.0 || mal_sum_partials_add(vm, &sum->partials, value);
}

static f64 mal_number_sum_finish(MalVm *vm, MalNumberSum *sum, bool error) {
    f64 result = NAN;
    if (!error && !sum->nan && !(sum->positive_infinity && sum->negative_infinity)) {
        if (sum->positive_infinity) result = INFINITY;
        else if (sum->negative_infinity) result = -INFINITY;
        else if (sum->all_negative_zero) result = -0.0;
        else {
            result = mal_sum_partials_total(vm, &sum->partials);
            if (result == 0.0) result = 0.0;
        }
    }
    if (sum->partials.partials != sum->partials.inline_partials) free(sum->partials.partials);
    return result;
}

f64 mal_builtin_math_sum_precise_numbers(MalVm *vm, const f64 *values, usize count) {
    MalNumberSum sum;
    mal_number_sum_init(&sum);
    for (usize index = 0; index < count; index++)
        if (!mal_number_sum_add(vm, &sum, values[index])) return mal_number_sum_finish(vm, &sum, true);
    return mal_number_sum_finish(vm, &sum, false);
}

static MalValue mal_builtin_math_sum_precise(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return mal_builtin_math_sum_precise_known(vm, arg_count > 0 ? args[0] : mal_value_new_undefined());
}

MalValue mal_builtin_math_sum_precise_known(MalVm *vm, MalValue items) {
    MalIteratorRecord record;
    if (!mal_vm_get_iterator(vm, items, &record)) {
        return mal_value_new_nan();
    }

    MalNumberSum sum;
    mal_number_sum_init(&sum);
    bool error = false;
    while (true) {
        MalValue value;
        bool done = false;
        if (!mal_vm_iterator_step_fast(vm, &record, &value, &done)) {
            error = true;
            break;
        }
        if (done) {
            break;
        }

        if (!mal_ops_is_number(value)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Math.sumPrecise expects only Number values");
            mal_vm_iterator_close(vm, &record);
            error = true;
            break;
        }

        if (!mal_number_sum_add(vm, &sum, mal_ops_to_number(value))) {
            error = true;
            break;
        }
    }
    return mal_ops_number_value(mal_number_sum_finish(vm, &sum, error));
}

/*
 * Math.random's generator. Non-cryptographic by specification and by choice —
 * xorshift64* leaks its whole state through two consecutive outputs, so nothing
 * that needs unpredictability may read from here. It is the *seed* that matters:
 * a clock-only seed made the stream guessable without observing any output at
 * all, which turns every application-level misuse of Math.random into a remote
 * prediction. The seed below is therefore drawn from the host CSPRNG whenever a
 * program links one, and from process/context divergence otherwise.
 */
static _Atomic(u64) mal_builtin_math_random_state;

/*
 * Seeding happens at installation and again whenever a host registers a source,
 * both of which precede any user code — so the draw itself is left exactly as it
 * was, with no per-call check on a hot path.
 *
 * The flag is atomic and the seeding is under a mutex because an embedder may
 * stand up isolates on several threads: two of them installing at once would
 * otherwise race on the state. Seeding is idempotent in effect but not free of
 * ordering, and a torn 64-bit state is worth ruling out.
 */
static atomic_bool mal_builtin_math_seeded;
#if !defined(__wasi__) || defined(__wasm_atomics__)
static pthread_mutex_t mal_builtin_math_seed_mutex = PTHREAD_MUTEX_INITIALIZER;
#endif
static MalMathSeedSource mal_builtin_math_seed_source;

/* SplitMix64's finalizer: diffuses the low-entropy fallback inputs so that
 * correlated values (two timestamps a microsecond apart) do not produce
 * correlated seeds. */
static u64 mal_builtin_math_mix(u64 value) {
    value += 0x9e3779b97f4a7c15ULL;
    value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9ULL;
    value = (value ^ (value >> 27)) * 0x94d049bb133111ebULL;
    return value ^ (value >> 31);
}

/*
 * The no-host-CSPRNG fallback. None of these are secrets, but together they
 * cost an attacker the nanosecond of process start *and* the PIE/stack ASLR
 * slides, rather than the one-second guess a bare time() seed cost. A program
 * that links either crypto surface never reaches this path.
 */
static u64 mal_builtin_math_fallback_seed(void) {
    u64 seed = 0;
    struct timespec now;
    if (clock_gettime(CLOCK_REALTIME, &now) == 0) {
        seed ^= mal_builtin_math_mix((u64) now.tv_sec * 1000000000ULL + (u64) now.tv_nsec);
    }
    if (clock_gettime(CLOCK_MONOTONIC, &now) == 0) {
        seed ^= mal_builtin_math_mix((u64) now.tv_sec * 1000000000ULL + (u64) now.tv_nsec);
    }
    seed ^= mal_builtin_math_mix((u64) getpid());
    // Three independent ASLR slides: the stack, the data segment, and the text
    // segment under PIE.
    u64 stack_slot = 0;
    seed ^= mal_builtin_math_mix((u64) (uintptr_t) &stack_slot);
    seed ^= mal_builtin_math_mix((u64) (uintptr_t) &mal_builtin_math_random_state);
    seed ^= mal_builtin_math_mix((u64) (uintptr_t) (void *) &mal_builtin_math_install);
    return seed;
}

/* `force` re-seeds an already-seeded generator, which is what registering a
 * source does: the CSPRNG must win over the fallback drawn at installation,
 * whichever order the two happened in. */
static void mal_builtin_math_seed(bool force) {
#if !defined(__wasi__) || defined(__wasm_atomics__)
    pthread_mutex_lock(&mal_builtin_math_seed_mutex);
#endif
    if (force || !atomic_load_explicit(&mal_builtin_math_seeded, memory_order_relaxed)) {
        u64 seed = 0;
        if (mal_builtin_math_seed_source == nullptr
            || mal_builtin_math_seed_source(&seed, sizeof(seed)) != 0) {
            seed = mal_builtin_math_fallback_seed();
        }
        // xorshift64* degenerates to a fixed point at zero, which the seed
        // sources can legitimately produce.
        atomic_store_explicit(
            &mal_builtin_math_random_state,
            seed == 0 ? 0x9e3779b97f4a7c15ULL : seed,
            memory_order_release);
        atomic_store_explicit(&mal_builtin_math_seeded, true, memory_order_release);
    }
#if !defined(__wasi__) || defined(__wasm_atomics__)
    pthread_mutex_unlock(&mal_builtin_math_seed_mutex);
#endif
}

void mal_builtin_math_set_seed_source(MalMathSeedSource source) {
#if !defined(__wasi__) || defined(__wasm_atomics__)
    pthread_mutex_lock(&mal_builtin_math_seed_mutex);
#endif
    mal_builtin_math_seed_source = source;
#if !defined(__wasi__) || defined(__wasm_atomics__)
    pthread_mutex_unlock(&mal_builtin_math_seed_mutex);
#endif
    mal_builtin_math_seed(true);
}

static MalValue mal_builtin_math_random(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;

    return mal_ops_number_value(mal_builtin_math_random_number());
}

f64 mal_builtin_math_random_number(void) {
    // xorshift64*: fast and plenty for a non-cryptographic Math.random.
    // Several isolates may execute on different host threads. Advance the shared
    // process generator with a CAS so concurrent draws cannot race, repeat a state,
    // or invoke undefined behavior through an unsynchronized C data race.
    u64 previous = atomic_load_explicit(
        &mal_builtin_math_random_state, memory_order_relaxed);
    u64 x;
    do {
        x = previous;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
    } while (!atomic_compare_exchange_weak_explicit(
        &mal_builtin_math_random_state, &previous, x,
        memory_order_relaxed, memory_order_relaxed));

    return (f64) ((x * 0x2545F4914F6CDD1DULL) >> 11) / (f64) (1ULL << 53);
}

void mal_builtin_math_install(MalVm *vm) {
    // Seeded here so the generator is never usable in an unseeded state. A host
    // that later registers a CSPRNG re-seeds over this; a program that links
    // none keeps it.
    mal_builtin_math_seed(false);

    MalObject *math = mal_intrinsic_new_object(vm);
    vm->intrinsics[MAL_INTRINSIC_MATH] = mal_value_from_object(math);

    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "Math")),
        MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(math, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    mal_intrinsic_define_data(vm, math, "PI", mal_value_from_f64(M_PI), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, math, "E", mal_value_from_f64(M_E), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, math, "LN2", mal_value_from_f64(M_LN2), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, math, "LN10", mal_value_from_f64(M_LN10), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, math, "LOG2E", mal_value_from_f64(M_LOG2E), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, math, "LOG10E", mal_value_from_f64(M_LOG10E), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, math, "SQRT2", mal_value_from_f64(M_SQRT2), MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, math, "SQRT1_2", mal_value_from_f64(M_SQRT1_2), MAL_PROPERTY_NONE);

    mal_intrinsic_define_method_n(vm, math, "abs", 1, mal_builtin_math_abs);
    mal_intrinsic_define_method_n(vm, math, "floor", 1, mal_builtin_math_floor);
    mal_intrinsic_define_method_n(vm, math, "ceil", 1, mal_builtin_math_ceil);
    mal_intrinsic_define_method_n(vm, math, "round", 1, mal_builtin_math_round);
    mal_intrinsic_define_method_n(vm, math, "trunc", 1, mal_builtin_math_trunc);
    mal_intrinsic_define_method_n(vm, math, "sqrt", 1, mal_builtin_math_sqrt);
    mal_intrinsic_define_method_n(vm, math, "cbrt", 1, mal_builtin_math_cbrt);
    mal_intrinsic_define_method_n(vm, math, "sign", 1, mal_builtin_math_sign);
    mal_intrinsic_define_method_n(vm, math, "log", 1, mal_builtin_math_log);
    mal_intrinsic_define_method_n(vm, math, "log2", 1, mal_builtin_math_log2);
    mal_intrinsic_define_method_n(vm, math, "log10", 1, mal_builtin_math_log10);
    mal_intrinsic_define_method_n(vm, math, "exp", 1, mal_builtin_math_exp);
    mal_intrinsic_define_method_n(vm, math, "sin", 1, mal_builtin_math_sin);
    mal_intrinsic_define_method_n(vm, math, "cos", 1, mal_builtin_math_cos);
    mal_intrinsic_define_method_n(vm, math, "tan", 1, mal_builtin_math_tan);
    mal_intrinsic_define_method_n(vm, math, "asin", 1, mal_builtin_math_asin);
    mal_intrinsic_define_method_n(vm, math, "acos", 1, mal_builtin_math_acos);
    mal_intrinsic_define_method_n(vm, math, "atan", 1, mal_builtin_math_atan);
    mal_intrinsic_define_method_n(vm, math, "sinh", 1, mal_builtin_math_sinh);
    mal_intrinsic_define_method_n(vm, math, "cosh", 1, mal_builtin_math_cosh);
    mal_intrinsic_define_method_n(vm, math, "tanh", 1, mal_builtin_math_tanh);
    mal_intrinsic_define_method_n(vm, math, "asinh", 1, mal_builtin_math_asinh);
    mal_intrinsic_define_method_n(vm, math, "acosh", 1, mal_builtin_math_acosh);
    mal_intrinsic_define_method_n(vm, math, "atanh", 1, mal_builtin_math_atanh);
    mal_intrinsic_define_method_n(vm, math, "log1p", 1, mal_builtin_math_log1p);
    mal_intrinsic_define_method_n(vm, math, "expm1", 1, mal_builtin_math_expm1);
    mal_intrinsic_define_method_n(vm, math, "fround", 1, mal_builtin_math_fround);
    mal_intrinsic_define_method_n(vm, math, "f16round", 1, mal_builtin_math_f16round);
    mal_intrinsic_define_method_n(vm, math, "clz32", 1, mal_builtin_math_clz32);
    mal_intrinsic_define_method_n(vm, math, "imul", 2, mal_builtin_math_imul);
    mal_intrinsic_define_method_n(vm, math, "atan2", 2, mal_builtin_math_atan2);
    mal_intrinsic_define_method_n(vm, math, "pow", 2, mal_builtin_math_pow);
    mal_intrinsic_define_method_n(vm, math, "hypot", 2, mal_builtin_math_hypot);
    mal_intrinsic_define_method_n(vm, math, "min", 2, mal_builtin_math_min);
    mal_intrinsic_define_method_n(vm, math, "max", 2, mal_builtin_math_max);
    mal_intrinsic_define_method_n(vm, math, "sumPrecise", 1, mal_builtin_math_sum_precise);
    mal_intrinsic_define_method_n(vm, math, "random", 0, mal_builtin_math_random);
}

#include "generated/known_native_builtin_math_c.inc"
