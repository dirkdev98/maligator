#pragma once

#include "./defaults.h"
#include "intrinsics.h"
#include "value_ops.h"

/**
 * Create the Math namespace object and install its functions and constants.
 */
void mal_builtin_math_install(MalVm *vm);

/**
 * Fill `buffer[0..length)` with unpredictable bytes. Returns 0 on success or a
 * positive errno — the signature of `mal_host_entropy`, so a host registers its
 * CSPRNG directly with no adapter.
 */
typedef int (*MalMathSeedSource)(void *buffer, usize length);

/**
 * Supply the seed source for `Math.random`'s generator.
 *
 * `Math.random` stays non-cryptographic whatever is registered here: the
 * generator is xorshift64*, whose state two consecutive outputs reveal. What a
 * source buys is that the stream cannot be predicted *without* observing it,
 * which a clock-derived seed could not promise.
 *
 * This indirection exists for layering, not taste. The engine may not name the
 * host entropy boundary: a direct call would pull entropy.o into the static
 * link of every program that touches Math, including those that install no
 * crypto surface at all. Instead the two translation units that already depend
 * on that boundary (node:crypto and the web crypto global) register it, so the
 * dependency stays exactly as wide as the program's own use of it.
 *
 * Safe to call from any thread, and order-independent with respect to
 * installation: registering re-seeds, so the CSPRNG wins over the process
 * divergence used at install time either way. Passing `nullptr` re-seeds from
 * the fallback.
 */
void mal_builtin_math_set_seed_source(MalMathSeedSource source);

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

/** Locked-world numeric lowering after canonical identity and number proofs. */
f64 mal_builtin_math_unary_number_known(MalMathUnaryOp operation, f64 argument);

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

/** Locked-world two-number Math.min/Math.max lowering. */
f64 mal_builtin_math_binary_number_known(
    MalMathBinaryOp operation, f64 left, f64 right
);

/** Each Math builtin's native callback, indexed by its operation; NONE has none. */
extern const MalNativeFunctionCallback mal_builtin_math_unary_callbacks[MAL_MATH_UNARY_ROUND + 1];
extern const MalNativeFunctionCallback mal_builtin_math_binary_callbacks[MAL_MATH_BINARY_MAX + 1];

// A matching callee runs its kernel on Number arguments without coercion or allocation.
static inline bool mal_builtin_math_unary_callee_matches(MalMathUnaryOp operation, MalValue callee) {
    return mal_value_is_native_function_object(callee) &&
        mal_value_to_native_function_object(callee)->callback ==
            mal_builtin_math_unary_callbacks[operation];
}

static inline bool mal_builtin_math_binary_callee_matches(MalMathBinaryOp operation, MalValue callee) {
    return mal_value_is_native_function_object(callee) &&
        mal_value_to_native_function_object(callee)->callback ==
            mal_builtin_math_binary_callbacks[operation];
}

/** Exact-callback fast path for two-number Math.min/Math.max calls. */
bool mal_builtin_math_binary_fast(
    MalValue callee, MalMathBinaryOp *cached_op, MalValue left, MalValue right, MalValue *result
);

// Callers prove canonical identity and numeric inputs; these kernels never coerce.
f64 mal_builtin_math_clz32_number(f64 argument);
f64 mal_builtin_math_imul_number(f64 left, f64 right);
f64 mal_builtin_math_pow_number(f64 base, f64 exponent);
f64 mal_builtin_math_f16round_number(f64 argument);
f64 mal_builtin_math_hypot_numbers(const f64 *arguments, i32 argument_count);
f64 mal_builtin_math_min_max_numbers(const f64 *arguments, i32 argument_count, bool is_max);
f64 mal_builtin_math_random_number(void);
MalValue mal_builtin_math_sum_precise_known(MalVm *vm, MalValue items);
f64 mal_builtin_math_sum_precise_numbers(MalVm *vm, const f64 *values, usize count);
