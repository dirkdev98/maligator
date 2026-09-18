#pragma once

#include <math.h>
#include "./defaults.h"
#include "heap.h"
#include "heap_bigint.h"
#include "heap_string.h"
#include "value.h"

MalString *mal_ops_to_string(MalHeap *heap, MalValue value);

f64 mal_ops_to_number(MalValue value);

/** StringToNumber over an already selected UTF-16 span. */
MalValue mal_ops_string_units_to_number(const c16 *code_units, usize length);

#define MAL_NUMBER_MAX_SAFE_INTEGER 9007199254740991.0
#define MAL_NUMBER_MIN_SAFE_INTEGER (-MAL_NUMBER_MAX_SAFE_INTEGER)

/** Pure-number tails; callers perform observable ToNumber coercion separately. */
f64 mal_ops_number_to_integer_or_infinity(f64 number);
f64 mal_ops_number_to_length(f64 number);
/** ToIntegerOrInfinity followed by relative indexing and a [0, length] clamp. */
f64 mal_ops_number_clamp_relative(f64 number, f64 length);
/** Unsigned modulo 2^width conversion; width must be in [1, 32]. */
u64 mal_ops_number_to_uint_width(f64 number, u32 width);
u32 mal_ops_number_to_uint32(f64 number);

/**
 * Number::remainder (JS `%`). Semantically `fmod`, but libm `fmod` dominates any
 * modulo-heavy loop. A finite dividend smaller in magnitude than the divisor is
 * already the exact remainder; otherwise, real code overwhelmingly uses integer
 * operands (indices, hashes, ring buffers), which can take a native integer `%`.
 * Guarded to |operand| <= 2^53 so the double→int64 cast is exact and can't
 * overflow (which rules out the INT64_MIN % -1 UB), and a zero dividend returns
 * the input to preserve -0 (sign of the dividend). Kept `static inline`
 * (value_ops.h reaches both the runtime and the emitted C) so the native `%` path
 * inlines in hot loops. Everything else defers to fmod.
 */
static inline f64 mal_number_remainder(f64 a, f64 b) {
    if (fabs(a) < fabs(b)) {
        return a;
    }
    if (b != 0.0 && a >= -9007199254740992.0 && a <= 9007199254740992.0 && b >= -9007199254740992.0 &&
        b <= 9007199254740992.0) {
        i64 ia = (i64) a;
        i64 ib = (i64) b;
        if ((f64) ia == a && (f64) ib == b) {
            if (ia == 0) {
                return a; // ±0 dividend: the result is the dividend, keeping its sign
            }
            i64 r = ia % ib;
            // A zero remainder takes the sign of the dividend (ECMAScript
            // Number::remainder / IEEE 754); the integer 0 would otherwise be +0.
            return r == 0 ? (ia < 0 ? -0.0 : 0.0) : (f64) r;
        }
    }
    return fmod(a, b);
}

/** Number::exponentiate for operands that have already passed ToNumeric. */
static inline f64 mal_number_exponentiate(f64 base, f64 exponent) {
    // Number::exponentiate differs from C pow for these two cases.
    if (isnan(exponent) || (isinf(exponent) && (base == 1.0 || base == -1.0))) {
        return NAN;
    }
    return pow(base, exponent);
}

/**
 * Whether the value is a JS Number (any of: int32, f64, NaN, -0, ±Infinity),
 * and the f64 recovery of a value already known to be one (precondition:
 * mal_ops_is_number). Both are written directly over the NaN-boxing layout
 * (see value.h) and kept `static inline` so the native-C backend's speculative
 * numeric guard lowers to a few bit tests in the hot loop instead of two
 * cross-TU calls. mal_ops_number_as_f64 matches mal_ops_to_number on Numbers.
 */
static inline bool mal_ops_is_number(MalValue value) {
    return ((value & MASK_EXPONENT_BITS) != MASK_EXPONENT_BITS) || // genuine f64 (incl ±0.0)
        ((value & MAL_VALUE_CLASS_MASK) == MAL_VALUE_INT32) ||          // tagged int32
        value == MAL_VALUE_NAN ||
        value == MAL_VALUE_NEGATIVE_ZERO ||
        value == MAL_VALUE_POSITIVE_INFINITY ||
        value == MAL_VALUE_NEGATIVE_INFINITY;
}

static inline f64 mal_ops_number_as_f64(MalValue value) {
    if ((value & MASK_EXPONENT_BITS) != MASK_EXPONENT_BITS) {
        return *(f64 *) &value; // genuine double, incl ±0.0
    }
    if ((value & MAL_VALUE_CLASS_MASK) == MAL_VALUE_INT32) {
        return (f64) (i32) (u32) (value & MASK_INT32); // tagged int32
    }
    if (value == MAL_VALUE_POSITIVE_INFINITY) {
        return INFINITY;
    }
    if (value == MAL_VALUE_NEGATIVE_INFINITY) {
        return -INFINITY;
    }
    if (value == MAL_VALUE_NEGATIVE_ZERO) {
        return -0.0;
    }
    return NAN; // MAL_VALUE_NAN
}

/** Reinterpret a uint32 result as the corresponding signed two's-complement value. */
static inline i32 mal_ops_u32_to_i32(u32 value) {
    return value <= 2147483647u ? (i32) value : (i32) ((i64) value - 4294967296ll);
}

/** ToInt32 for a value already known to be a JS Number. */
static inline i32 mal_ops_number_to_i32(f64 number) {
    // In-range finite values need only C's truncating conversion. This is the
    // overwhelmingly common case for native bitwise code (indices, counters,
    // flags), and avoids the general ToUint32 fmod/ldexp path. Comparisons also
    // reject NaN and infinities; keep the bounds conservative so the cast is
    // always defined by C.
    if (number >= -2147483648.0 && number <= 2147483647.0) {
        return (i32) number;
    }
    return mal_ops_u32_to_i32(mal_ops_number_to_uint32(number));
}

/**
 * The result of a function body for the native backend's RETURN: for a
 * [[Construct]] call a non-object completion becomes `this`
 * (OrdinaryCallEvaluateBody), mirroring the interpreter's frame->is_construct
 * handling. `new_target` is the constructor object for a construct and undefined
 * for a plain call, so a plain call always passes its value through unchanged.
 */
static inline MalValue mal_ops_construct_result(MalValue value, MalValue this_value, MalValue new_target) {
    return (mal_value_is_object(new_target) && !mal_value_is_object(value)) ? this_value : value;
}

/**
 * Box a f64 as an int32 when integral and in range, else as f64/NaN. Kept
 * `static inline` (value_ops.h reaches both the runtime and the emitted C) so the
 * native-C backend's boundary boxing inlines in the hot loop instead of a cross-TU
 * call per boxed arithmetic result — and so `mal_ops_number_as_f64` composed with
 * it (a chained guarded-numeric op re-boxing then re-unboxing) can fold to identity.
 */
static inline MalValue mal_ops_number_value(f64 value) {
    if (isnan(value)) {
        return mal_value_new_nan();
    }

    // Negative zero is a distinct Number (Object.is, 1/x, sameValue) and must
    // not be canonicalized to the int32 +0 the next branch would produce. Keep
    // it as a raw f64 — the same encoding the interpreter stores for a `-0`
    // literal — so arithmetic that yields -0 (e.g. -1 * 0) and the compiled
    // backend's boundary boxing both preserve it.
    if (value == 0.0 && signbit(value)) {
        return mal_value_from_f64(value);
    }

    if (value >= INT32_MIN && value <= INT32_MAX && trunc(value) == value) {
        return mal_value_from_i32((i32) value);
    }

    // Also maps infinities to their static encodings.
    return mal_value_from_f64_convert_nan(value);
}

/** Add two values already proven to be JS Numbers without coercion. */
static inline MalValue mal_ops_add_numbers(MalValue left, MalValue right) {
    if (mal_value_is_int32(left) && mal_value_is_int32(right)) {
        i64 result = (i64) mal_value_to_i32(left) + (i64) mal_value_to_i32(right);
        return result >= INT32_MIN && result <= INT32_MAX
            ? mal_value_from_i32((i32) result)
            : mal_ops_number_value((f64) result);
    }

    return mal_ops_number_value(
        mal_ops_number_as_f64(left) + mal_ops_number_as_f64(right));
}

/** Canonical Strict Equality Comparison (7.2.15). String comparison may flatten. */
static inline bool mal_ops_strict_equal_bool(MalValue left, MalValue right) {
    // NaN must precede bit identity because every NaN has one canonical encoding.
    if (mal_value_is_nan(left) || mal_value_is_nan(right)) {
        return false;
    }

    if (left == right) {
        return true;
    }

    if (mal_value_is_string(left) && mal_value_is_string(right)) {
        return mal_string_equals(mal_value_to_string(left), mal_value_to_string(right));
    }

    if (mal_value_is_bigint(left) || mal_value_is_bigint(right)) {
        return mal_value_is_bigint(left) && mal_value_is_bigint(right) &&
            mal_bigint_value(mal_value_to_bigint(left)) == mal_bigint_value(mal_value_to_bigint(right));
    }

    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        return mal_ops_number_as_f64(left) == mal_ops_number_as_f64(right);
    }

    return false;
}

/** Returns false without allocating when string concatenation exceeds the engine limit. */
bool mal_ops_add_checked(MalHeap *heap, MalValue left, MalValue right, MalValue *out);

MalValue mal_ops_subtract(MalValue left, MalValue right);

MalValue mal_ops_multiply(MalValue left, MalValue right);

MalValue mal_ops_divide(MalValue left, MalValue right);

MalValue mal_ops_remainder(MalValue left, MalValue right);

MalValue mal_ops_exponentiate(MalValue left, MalValue right);

MalValue mal_ops_bit_and(MalValue left, MalValue right);

MalValue mal_ops_bit_or(MalValue left, MalValue right);

MalValue mal_ops_bit_xor(MalValue left, MalValue right);

MalValue mal_ops_shift_left(MalValue left, MalValue right);

MalValue mal_ops_shift_right(MalValue left, MalValue right);

MalValue mal_ops_shift_right_unsigned(MalValue left, MalValue right);

MalValue mal_ops_less_than(MalValue left, MalValue right);

MalValue mal_ops_less_equal(MalValue left, MalValue right);

MalValue mal_ops_greater_than(MalValue left, MalValue right);

MalValue mal_ops_greater_equal(MalValue left, MalValue right);

MalValue mal_ops_equal(MalValue left, MalValue right);

MalValue mal_ops_not_equal(MalValue left, MalValue right);

MalValue mal_ops_strict_equal(MalValue left, MalValue right);

/** Spec SameValue (7.2.10): like ===, but NaN equals NaN and +0 differs from -0. */
bool mal_ops_same_value(MalValue left, MalValue right);

MalValue mal_ops_strict_not_equal(MalValue left, MalValue right);
