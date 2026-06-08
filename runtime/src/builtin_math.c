#include "builtin_math.h"

#include <math.h>
#include <time.h>

#include "value_ops.h"
#include "vm.h"

static f64 mal_builtin_math_arg(const MalValue *args, i32 arg_count, i32 index) {
    return index < arg_count ? mal_ops_to_number(args[index]) : NAN;
}

#define MAL_BUILTIN_MATH_UNARY(name, expression) \
    static MalValue mal_builtin_math_##name(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) { \
        (void) vm; \
        (void) this_value; \
        f64 x = mal_builtin_math_arg(args, arg_count, 0); \
        return mal_ops_number_value(expression); \
    }

MAL_BUILTIN_MATH_UNARY(abs, fabs(x))
MAL_BUILTIN_MATH_UNARY(floor, floor(x))
MAL_BUILTIN_MATH_UNARY(ceil, ceil(x))
// JS rounds halves toward positive infinity.
MAL_BUILTIN_MATH_UNARY(round, floor(x + 0.5))
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

static MalValue mal_builtin_math_clz32(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    f64 x = mal_builtin_math_arg(args, arg_count, 0);
    u32 value = isfinite(x) ? (u32) (i64) x : 0;

    return mal_value_from_i32(value == 0 ? 32 : __builtin_clz(value));
}

static MalValue mal_builtin_math_imul(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    f64 left = mal_builtin_math_arg(args, arg_count, 0);
    f64 right = mal_builtin_math_arg(args, arg_count, 1);
    u32 a = isfinite(left) ? (u32) (i64) left : 0;
    u32 b = isfinite(right) ? (u32) (i64) right : 0;

    return mal_value_from_i32((i32) (a * b));
}

static MalValue mal_builtin_math_pow(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    return mal_ops_number_value(pow(mal_builtin_math_arg(args, arg_count, 0), mal_builtin_math_arg(args, arg_count, 1)));
}

static MalValue mal_builtin_math_atan2(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    return mal_ops_number_value(atan2(mal_builtin_math_arg(args, arg_count, 0), mal_builtin_math_arg(args, arg_count, 1)));
}

static MalValue mal_builtin_math_hypot(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    f64 sum = 0;
    for (i32 i = 0; i < arg_count; i++) {
        f64 value = mal_ops_to_number(args[i]);
        sum += value * value;
    }

    return mal_ops_number_value(sqrt(sum));
}

static MalValue mal_builtin_math_min(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    f64 result = INFINITY;
    for (i32 i = 0; i < arg_count; i++) {
        f64 value = mal_ops_to_number(args[i]);
        if (isnan(value)) {
            return mal_value_new_nan();
        }
        if (value < result) {
            result = value;
        }
    }

    return mal_ops_number_value(result);
}

static MalValue mal_builtin_math_max(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    f64 result = -INFINITY;
    for (i32 i = 0; i < arg_count; i++) {
        f64 value = mal_ops_to_number(args[i]);
        if (isnan(value)) {
            return mal_value_new_nan();
        }
        if (value > result) {
            result = value;
        }
    }

    return mal_ops_number_value(result);
}

static u64 mal_builtin_math_random_state;

static MalValue mal_builtin_math_random(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target) {
    (void) vm;
    (void) this_value;
    (void) args;
    (void) arg_count;

    // xorshift64*: fast and plenty for a non-cryptographic Math.random.
    u64 x = mal_builtin_math_random_state;
    x ^= x >> 12;
    x ^= x << 25;
    x ^= x >> 27;
    mal_builtin_math_random_state = x;

    return mal_value_from_f64((f64) ((x * 0x2545F4914F6CDD1DULL) >> 11) / (f64) (1ULL << 53));
}

void mal_builtin_math_install(MalVm *vm) {
    if (mal_builtin_math_random_state == 0) {
        mal_builtin_math_random_state = (u64) time(nullptr) | 1;
    }

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

    mal_intrinsic_define_method(vm, math, "abs", mal_builtin_math_abs);
    mal_intrinsic_define_method(vm, math, "floor", mal_builtin_math_floor);
    mal_intrinsic_define_method(vm, math, "ceil", mal_builtin_math_ceil);
    mal_intrinsic_define_method(vm, math, "round", mal_builtin_math_round);
    mal_intrinsic_define_method(vm, math, "trunc", mal_builtin_math_trunc);
    mal_intrinsic_define_method(vm, math, "sqrt", mal_builtin_math_sqrt);
    mal_intrinsic_define_method(vm, math, "cbrt", mal_builtin_math_cbrt);
    mal_intrinsic_define_method(vm, math, "sign", mal_builtin_math_sign);
    mal_intrinsic_define_method(vm, math, "log", mal_builtin_math_log);
    mal_intrinsic_define_method(vm, math, "log2", mal_builtin_math_log2);
    mal_intrinsic_define_method(vm, math, "log10", mal_builtin_math_log10);
    mal_intrinsic_define_method(vm, math, "exp", mal_builtin_math_exp);
    mal_intrinsic_define_method(vm, math, "sin", mal_builtin_math_sin);
    mal_intrinsic_define_method(vm, math, "cos", mal_builtin_math_cos);
    mal_intrinsic_define_method(vm, math, "tan", mal_builtin_math_tan);
    mal_intrinsic_define_method(vm, math, "asin", mal_builtin_math_asin);
    mal_intrinsic_define_method(vm, math, "acos", mal_builtin_math_acos);
    mal_intrinsic_define_method(vm, math, "atan", mal_builtin_math_atan);
    mal_intrinsic_define_method(vm, math, "sinh", mal_builtin_math_sinh);
    mal_intrinsic_define_method(vm, math, "cosh", mal_builtin_math_cosh);
    mal_intrinsic_define_method(vm, math, "tanh", mal_builtin_math_tanh);
    mal_intrinsic_define_method(vm, math, "asinh", mal_builtin_math_asinh);
    mal_intrinsic_define_method(vm, math, "acosh", mal_builtin_math_acosh);
    mal_intrinsic_define_method(vm, math, "atanh", mal_builtin_math_atanh);
    mal_intrinsic_define_method(vm, math, "log1p", mal_builtin_math_log1p);
    mal_intrinsic_define_method(vm, math, "expm1", mal_builtin_math_expm1);
    mal_intrinsic_define_method(vm, math, "fround", mal_builtin_math_fround);
    mal_intrinsic_define_method(vm, math, "clz32", mal_builtin_math_clz32);
    mal_intrinsic_define_method(vm, math, "imul", mal_builtin_math_imul);
    mal_intrinsic_define_method(vm, math, "atan2", mal_builtin_math_atan2);
    mal_intrinsic_define_method(vm, math, "pow", mal_builtin_math_pow);
    mal_intrinsic_define_method(vm, math, "hypot", mal_builtin_math_hypot);
    mal_intrinsic_define_method(vm, math, "min", mal_builtin_math_min);
    mal_intrinsic_define_method(vm, math, "max", mal_builtin_math_max);
    mal_intrinsic_define_method(vm, math, "random", mal_builtin_math_random);
}
