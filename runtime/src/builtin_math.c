#include "builtin_math.h"

#include <math.h>
#include <stdint.h>
#include <stdlib.h>
#include <time.h>

#include "builtin_iterator.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

#ifndef M_E
#define M_E 2.71828182845904523536
#endif
#ifndef M_LN2
#define M_LN2 0.69314718055994530942
#endif
#ifndef M_LN10
#define M_LN10 2.30258509299404568402
#endif
#ifndef M_LOG2E
#define M_LOG2E 1.44269504088896340736
#endif
#ifndef M_LOG10E
#define M_LOG10E 0.43429448190325182765
#endif
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#ifndef M_SQRT1_2
#define M_SQRT1_2 0.70710678118654752440
#endif
#ifndef M_SQRT2
#define M_SQRT2 1.41421356237309504880
#endif

/**
 * Spec ToNumber on a Math argument. Returns false with a pending throw
 * completion on the vm (Symbol/BigInt/abrupt @@toPrimitive); callers bail by
 * returning any placeholder value, the dispatcher reads vm->completion.
 * Missing arguments coerce to NaN (ToNumber(undefined)).
 */
static bool mal_builtin_math_to_number(MalVm *vm, const MalValue *args, i32 arg_count, i32 index, f64 *out) {
    if (index >= arg_count) {
        *out = NAN;
        return true;
    }
    return mal_vm_to_number(vm, args[index], out);
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

    if (!isfinite(x) || x == 0.0) {
        return mal_ops_number_value(x);
    }
    // Already integral, or so large that adding 0.5 changes nothing.
    if (fabs(x) >= 4503599627370496.0 /* 2^52 */) {
        return mal_ops_number_value(x);
    }
    // x in (-0.5, -0] and (0, 0.5) round to -0 / +0 respectively; the negative
    // half-open range must yield -0.
    if (x < 0.0 && x >= -0.5) {
        return mal_value_from_f64(-0.0);
    }
    // Round half toward +Infinity. Computing floor(x) and the fractional part
    // separately avoids the precision loss of floor(x + 0.5) (which can round
    // a value just under 0.5 up to a full integer).
    f64 lower = floor(x);
    f64 frac = x - lower;
    f64 result = frac < 0.5 ? lower : lower + 1.0;
    return mal_ops_number_value(result);
}

// ToUint32 per spec (ToNumber already applied): truncate toward zero, reduce
// modulo 2^32 into [0, 2^32).
static u32 mal_builtin_math_to_uint32(f64 x) {
    if (!isfinite(x) || x == 0.0) {
        return 0;
    }
    f64 truncated = trunc(x);
    f64 modulo = fmod(truncated, 4294967296.0);
    if (modulo < 0.0) {
        modulo += 4294967296.0;
    }
    return (u32) modulo;
}

static MalValue mal_builtin_math_clz32(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    f64 x;
    if (!mal_builtin_math_to_number(vm, args, arg_count, 0, &x)) {
        return mal_value_new_nan();
    }
    u32 value = mal_builtin_math_to_uint32(x);
    return mal_value_from_i32(value == 0 ? 32 : __builtin_clz(value));
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
    u32 a = mal_builtin_math_to_uint32(left);
    u32 b = mal_builtin_math_to_uint32(right);
    return mal_value_from_i32((i32) (a * b));
}

// Spec "applying the ** operator": C pow disagrees with the spec on NaN
// exponents and on |base| == 1 with an infinite exponent, so handle those
// special cases by hand before delegating to libm.
static f64 mal_builtin_math_pow_op(f64 base, f64 exponent) {
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
        // abs_base < 1.0
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
    return mal_ops_number_value(mal_builtin_math_pow_op(base, exponent));
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

// Math.hypot: coerce every argument first (ToNumber order, abrupt completions
// propagate), then if any coerced value is an infinity the result is +Infinity
// even when another is NaN; otherwise NaN if any is NaN.
static MalValue mal_builtin_math_hypot(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    f64 *coerced = nullptr;
    if (arg_count > 0) {
        coerced = malloc(sizeof(f64) * (usize) arg_count);
    }
    for (i32 i = 0; i < arg_count; i++) {
        if (!mal_vm_to_number(vm, args[i], &coerced[i])) {
            free(coerced);
            return mal_value_new_nan();
        }
    }

    bool any_infinity = false;
    bool any_nan = false;
    for (i32 i = 0; i < arg_count; i++) {
        if (isinf(coerced[i])) {
            any_infinity = true;
        } else if (isnan(coerced[i])) {
            any_nan = true;
        }
    }

    if (any_infinity) {
        free(coerced);
        return mal_ops_number_value(INFINITY);
    }
    if (any_nan) {
        free(coerced);
        return mal_value_new_nan();
    }

    // Sum of squares with scaling to avoid spurious overflow/underflow.
    f64 max_abs = 0.0;
    for (i32 i = 0; i < arg_count; i++) {
        f64 a = fabs(coerced[i]);
        if (a > max_abs) {
            max_abs = a;
        }
    }
    if (max_abs == 0.0) {
        free(coerced);
        return mal_ops_number_value(0.0);
    }
    f64 sum = 0.0;
    for (i32 i = 0; i < arg_count; i++) {
        f64 scaled = coerced[i] / max_abs;
        sum += scaled * scaled;
    }
    free(coerced);
    return mal_ops_number_value(max_abs * sqrt(sum));
}

// Math.min / Math.max coerce *all* arguments first (ToNumber side effects must
// all run), then compare. NaN poisons the result; +0 is treated as greater
// than -0 so min/max pick the spec-correct signed zero.
static MalValue mal_builtin_math_min_max(MalVm *vm, const MalValue *args, i32 arg_count, bool is_max) {
    f64 *coerced = nullptr;
    if (arg_count > 0) {
        coerced = malloc(sizeof(f64) * (usize) arg_count);
    }
    for (i32 i = 0; i < arg_count; i++) {
        if (!mal_vm_to_number(vm, args[i], &coerced[i])) {
            free(coerced);
            return mal_value_new_nan();
        }
    }

    f64 result = is_max ? -INFINITY : INFINITY;
    bool result_is_neg_zero = false;
    bool saw_nan = false;
    for (i32 i = 0; i < arg_count; i++) {
        f64 value = coerced[i];
        if (isnan(value)) {
            saw_nan = true;
            continue;
        }
        bool value_is_neg_zero = (value == 0.0 && signbit(value));
        if (is_max) {
            if (value > result) {
                result = value;
                result_is_neg_zero = value_is_neg_zero;
            } else if (value == 0.0 && result == 0.0 && result_is_neg_zero && !value_is_neg_zero) {
                // +0 beats -0 for max.
                result = value;
                result_is_neg_zero = false;
            }
        } else {
            if (value < result) {
                result = value;
                result_is_neg_zero = value_is_neg_zero;
            } else if (value == 0.0 && result == 0.0 && !result_is_neg_zero && value_is_neg_zero) {
                // -0 beats +0 for min.
                result = value;
                result_is_neg_zero = true;
            }
        }
    }
    free(coerced);

    if (saw_nan) {
        return mal_value_new_nan();
    }
    if (result == 0.0 && result_is_neg_zero) {
        return mal_value_from_f64(-0.0);
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

// Round a binary64 to the nearest binary16 (round-to-nearest, ties to even)
// and widen back to binary64, matching Math.f16round.
static f64 mal_builtin_math_round_f16(f64 x) {
    if (isnan(x)) {
        return NAN;
    }
    if (isinf(x)) {
        return x;
    }
    if (x == 0.0) {
        return x; // preserves the sign of zero
    }

    int sign = signbit(x) ? 1 : 0;
    f64 ax = fabs(x);

    // binary16: 1 sign, 5 exponent (bias 15), 10 mantissa.
    // Largest finite half is 65504; midpoint to infinity is 65520.
    if (ax >= 65520.0) {
        return sign ? -INFINITY : INFINITY;
    }
    // Smallest positive subnormal half is 2^-24; below half of it rounds to 0.
    if (ax < ldexp(1.0, -25)) {
        return sign ? -0.0 : 0.0;
    }

    int exponent;
    f64 mantissa = frexp(ax, &exponent); // ax = mantissa * 2^exponent, mantissa in [0.5, 1)
    // Number of mantissa bits available at this magnitude.
    f64 rounded;
    if (exponent - 1 >= -14) {
        // Normal half: 11 significant bits (implicit + 10).
        f64 scale = ldexp(1.0, 11);
        f64 scaled = mantissa * scale; // in [scale/2, scale)
        f64 r = nearbyint(scaled);     // ties to even under default rounding mode
        rounded = ldexp(r, exponent - 11);
    } else {
        // Subnormal half: round to a multiple of 2^-24.
        f64 unit = ldexp(1.0, -24);
        f64 r = nearbyint(ax / unit);
        rounded = r * unit;
    }
    return sign ? -rounded : rounded;
}

static MalValue mal_builtin_math_f16round(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    f64 x;
    if (!mal_builtin_math_to_number(vm, args, arg_count, 0, &x)) {
        return mal_value_new_nan();
    }
    return mal_ops_number_value(mal_builtin_math_round_f16(x));
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
} MalSumPartials;

static bool mal_sum_partials_push(MalSumPartials *p, f64 value) {
    if (p->count == p->capacity) {
        usize new_capacity = p->capacity == 0 ? 16 : p->capacity * 2;
        f64 *grown = realloc(p->partials, sizeof(f64) * new_capacity);
        if (grown == nullptr) {
            return false;
        }
        p->partials = grown;
        p->capacity = new_capacity;
    }
    p->partials[p->count++] = value;
    return true;
}

static bool mal_sum_partials_add(MalSumPartials *p, f64 x) {
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
    return mal_sum_partials_push(p, x);
}

static f64 mal_sum_partials_total(MalSumPartials *p) {
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
        mal_sum_partials_add(p, half);
        mal_sum_partials_add(p, half);

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

static MalValue mal_builtin_math_sum_precise(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;

    MalValue items = arg_count > 0 ? args[0] : mal_value_new_undefined();

    MalIteratorRecord record;
    if (!mal_vm_get_iterator(vm, items, &record)) {
        return mal_value_new_nan();
    }

    // State: track non-finite contributions; finite values feed the exact
    // accumulator. -0 only matters when the entire (non-empty) sum is zero.
    MalSumPartials partials = {0};
    bool seen_pos_inf = false;
    bool seen_neg_inf = false;
    bool seen_nan = false;
    bool any_value = false;
    bool any_nonneg_zero = false; // saw a +0 or a nonzero, forcing +0 over -0

    bool error = false;
    while (true) {
        MalValue value;
        bool done = false;
        if (!mal_vm_iterator_step(vm, &record, &value, &done)) {
            error = true;
            break;
        }
        if (done) {
            break;
        }

        any_value = true;

        // The element must already be a Number; otherwise TypeError and the
        // iterator is closed (no coercion is performed).
        if (!mal_ops_is_number(value)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Math.sumPrecise expects only Number values");
            mal_vm_iterator_close(vm, &record);
            error = true;
            break;
        }

        f64 n = mal_ops_to_number(value);

        if (isnan(n)) {
            seen_nan = true;
            continue;
        }
        if (isinf(n)) {
            if (n > 0.0) {
                seen_pos_inf = true;
            } else {
                seen_neg_inf = true;
            }
            continue;
        }
        if (n != 0.0 || !signbit(n)) {
            any_nonneg_zero = true; // a nonzero, or a +0
        }
        if (n != 0.0) {
            if (!mal_sum_partials_add(&partials, n)) {
                error = true;
                break;
            }
        }
    }

    MalValue result;
    if (error) {
        result = mal_value_new_nan();
    } else if (seen_nan || (seen_pos_inf && seen_neg_inf)) {
        // NaN if any NaN OR both infinities present.
        result = mal_value_new_nan();
    } else if (seen_pos_inf) {
        result = mal_ops_number_value(INFINITY);
    } else if (seen_neg_inf) {
        result = mal_ops_number_value(-INFINITY);
    } else if (!any_value) {
        result = mal_value_from_f64(-0.0); // empty list
    } else {
        f64 total = mal_sum_partials_total(&partials);
        if (total == 0.0) {
            // All contributions were zero: -0 unless a +0 (or recovered
            // nonzero) appeared.
            result = any_nonneg_zero ? mal_ops_number_value(0.0) : mal_value_from_f64(-0.0);
        } else {
            result = mal_ops_number_value(total);
        }
    }

    free(partials.partials);
    return result;
}

static u64 mal_builtin_math_random_state;

static MalValue mal_builtin_math_random(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) vm;
    (void) this_value;
    (void) args;
    (void) arg_count;
    (void) new_target;
    (void) callee;

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
