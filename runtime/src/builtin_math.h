#pragma once

#include "./defaults.h"
#include "intrinsics.h"

/**
 * Create the Math namespace object and install its functions and constants.
 */
void mal_builtin_math_install(MalVm *vm);

typedef enum MalMathUnaryOp {
    MAL_MATH_UNARY_NONE,
    MAL_MATH_UNARY_ABS,
    MAL_MATH_UNARY_FLOOR,
    MAL_MATH_UNARY_CEIL,
    MAL_MATH_UNARY_TRUNC,
    MAL_MATH_UNARY_SQRT,
    MAL_MATH_UNARY_CBRT,
    MAL_MATH_UNARY_SIGN,
    MAL_MATH_UNARY_LOG,
    MAL_MATH_UNARY_LOG2,
    MAL_MATH_UNARY_LOG10,
    MAL_MATH_UNARY_EXP,
    MAL_MATH_UNARY_SIN,
    MAL_MATH_UNARY_COS,
    MAL_MATH_UNARY_TAN,
    MAL_MATH_UNARY_ASIN,
    MAL_MATH_UNARY_ACOS,
    MAL_MATH_UNARY_ATAN,
    MAL_MATH_UNARY_SINH,
    MAL_MATH_UNARY_COSH,
    MAL_MATH_UNARY_TANH,
    MAL_MATH_UNARY_ASINH,
    MAL_MATH_UNARY_ACOSH,
    MAL_MATH_UNARY_ATANH,
    MAL_MATH_UNARY_LOG1P,
    MAL_MATH_UNARY_EXPM1,
    MAL_MATH_UNARY_FROUND,
    MAL_MATH_UNARY_ROUND,
} MalMathUnaryOp;

/**
 * Fast path for a compiled direct Math method call with a numeric argument. The
 * exact native callback guard preserves monkey-patching semantics; the cached
 * operation avoids rediscovering the callback after the first hit.
 */
bool mal_builtin_math_unary_fast(
    MalValue callee, MalMathUnaryOp *cached_op, MalValue argument, MalValue *result
);

typedef enum MalMathBinaryOp {
    MAL_MATH_BINARY_NONE,
    MAL_MATH_BINARY_MIN,
    MAL_MATH_BINARY_MAX,
} MalMathBinaryOp;

/** Exact-callback fast path for two-number Math.min/Math.max calls. */
bool mal_builtin_math_binary_fast(
    MalValue callee, MalMathBinaryOp *cached_op, MalValue left, MalValue right, MalValue *result
);
