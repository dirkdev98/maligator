#include "builtin_atomics.h"

#include <math.h>

#include "array_buffer_object.h"
#include "bigint128.h"
#include "builtin_bigint.h"
#include "builtin_promise.h"
#include "heap_bigint.h"
#include "intrinsics.h"
#include "object.h"
#include "scalar_bits.h"
#include "typed_array_object.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// The Atomics methods all operate on an integer TypedArray. Because the engine
// is single-threaded, an "atomic" read-modify-write is just an ordinary
// read-then-write; the value coercions and validation ordering still follow the
// spec so the observable behavior (return values, error types/order) matches.

// ValidateIntegerTypedArray: a (non-out-of-bounds) TypedArray whose element type
// is one of the integer kinds (Float/Uint8Clamped are rejected with a TypeError).
static MalTypedArrayObject *atomics_validate(MalVm *vm, MalValue value, bool writable) {
    if (!mal_value_is_typed_array_object(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Atomics: argument is not a TypedArray");
        return nullptr;
    }
    MalTypedArrayObject *array = mal_value_to_typed_array_object(value);
    if (writable && array->buffer->immutable) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Atomics: cannot write to an immutable buffer");
        return nullptr;
    }
    if (mal_typed_array_object_is_out_of_bounds(array)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Atomics: TypedArray is out of bounds");
        return nullptr;
    }
    switch (array->kind) {
    case MAL_TA_INT8:
    case MAL_TA_UINT8:
    case MAL_TA_INT16:
    case MAL_TA_UINT16:
    case MAL_TA_INT32:
    case MAL_TA_UINT32:
    case MAL_TA_BIGINT64:
    case MAL_TA_BIGUINT64:
        return array;
    default: // Uint8Clamped, Float32, Float64
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Atomics: TypedArray is not an integer type");
        return nullptr;
    }
}

// ValidateAtomicAccess: ToIndex(requestIndex), then require it within [0, length).
// Runs user coercion (may throw); on a bad index throws RangeError.
static bool atomics_to_index(MalVm *vm, MalValue value, u32 length, u32 *out) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) {
        return false;
    }
    number = mal_ops_number_to_integer_or_infinity(number);
    if (number < 0 || number > MAL_NUMBER_MAX_SAFE_INTEGER) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Atomics: invalid index");
        return false;
    }
    if (number >= (f64) length) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Atomics: index out of range");
        return false;
    }
    *out = (u32) number;
    return true;
}

// ToIntegerOrInfinity for a numeric Atomics value (NaN -> 0, ±Infinity kept).
static bool atomics_to_integer(MalVm *vm, MalValue value, f64 *out) {
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) {
        return false;
    }
    *out = mal_ops_number_to_integer_or_infinity(number);
    return true;
}

// Reduce a finite Number to the low `bytes*8` bits (the element-width modular
// representation), matching the TypedArray store conversion.
// RevalidateAtomicAccess after a user coercion may have detached/shrunk the
// buffer: an out-of-bounds view is a TypeError, a now-too-small index a RangeError.
static bool atomics_revalidate(MalVm *vm, MalTypedArrayObject *array, u32 index) {
    if (mal_typed_array_object_is_out_of_bounds(array)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Atomics: TypedArray is out of bounds");
        return false;
    }
    if (index >= mal_typed_array_object_length(array)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Atomics: index out of range");
        return false;
    }
    return true;
}

typedef enum {
    ATOMICS_ADD,
    ATOMICS_SUB,
    ATOMICS_AND,
    ATOMICS_OR,
    ATOMICS_XOR,
    ATOMICS_EXCHANGE,
} AtomicsOp;

static i64 atomics_apply_i64(AtomicsOp op, i64 old, i64 operand) {
    switch (op) {
    case ATOMICS_ADD:
        return old + operand;
    case ATOMICS_SUB:
        return old - operand;
    case ATOMICS_AND:
        return old & operand;
    case ATOMICS_OR:
        return old | operand;
    case ATOMICS_XOR:
        return old ^ operand;
    case ATOMICS_EXCHANGE:
        return operand;
    }
    return operand;
}

static i128 atomics_apply_i128(AtomicsOp op, i128 old, i128 operand) {
    switch (op) {
    case ATOMICS_ADD:
        return mal_bigint128_add(old, operand);
    case ATOMICS_SUB:
        return mal_bigint128_subtract(old, operand);
    case ATOMICS_AND:
        return mal_bigint128_bit_and(old, operand);
    case ATOMICS_OR:
        return mal_bigint128_bit_or(old, operand);
    case ATOMICS_XOR:
        return mal_bigint128_bit_xor(old, operand);
    case ATOMICS_EXCHANGE:
        return operand;
    }
    return operand;
}

static MalValue atomics_numeric_value_from_bits(
    MalTypedArrayKind kind,
    u64 bits
) {
    switch (kind) {
        case MAL_TA_INT8:
            return mal_value_from_i32(mal_scalar_i8_from_bits((u8) bits));
        case MAL_TA_UINT8:
            return mal_value_from_i32((u8) bits);
        case MAL_TA_INT16:
            return mal_value_from_i32(mal_scalar_i16_from_bits((u16) bits));
        case MAL_TA_UINT16:
            return mal_value_from_i32((u16) bits);
        case MAL_TA_INT32:
            return mal_value_from_i32(mal_scalar_i32_from_bits((u32) bits));
        case MAL_TA_UINT32: {
            u32 value = (u32) bits;
            return mal_value_from_u32(value);
        }
        default:
            return mal_value_new_undefined();
    }
}

// Shared read-modify-write: AtomicReadModifyWrite(typedArray, index, value, op).
// Reads the old element (the return value), computes the new value, stores it
// (the store re-truncates to the element width), and returns the old value.
static MalValue atomics_rmw(MalVm *vm, const MalValue *args, i32 arg_count, AtomicsOp op) {
    MalTypedArrayObject *array = atomics_validate(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), true);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    u32 index;
    if (!atomics_to_index(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), length, &index)) {
        return mal_value_new_undefined();
    }
    MalValue value = arg_count >= 3 ? args[2] : mal_value_new_undefined();

    if (mal_typed_array_is_bigint(array->kind)) {
        i128 operand;
        if (!mal_bigint_to_bigint(vm, value, &operand)) {
            return mal_value_new_undefined();
        }
        if (!atomics_revalidate(vm, array, index)) {
            return mal_value_new_undefined();
        }
        MalTypedArraySpan span;
        if (!mal_typed_array_object_span(array, &span)) {
            return mal_value_new_undefined();
        }
        u64 old_bits = mal_typed_array_span_load_bits(&span, index);
        i128 old = array->kind == MAL_TA_BIGINT64
            ? (i128) mal_scalar_i64_from_bits(old_bits)
            : (i128) (u128) old_bits;
        i128 result = atomics_apply_i128(op, old, operand);
        mal_typed_array_span_store_bits(&span, index, (u64) (u128) result);
        return mal_value_from_bigint(mal_bigint_new(&vm->heap, old));
    }

    f64 number;
    if (!atomics_to_integer(vm, value, &number)) {
        return mal_value_new_undefined();
    }
    if (!atomics_revalidate(vm, array, index)) {
        return mal_value_new_undefined();
    }
    u32 element_size = mal_typed_array_element_size(array->kind);
    i64 operand = (i64) mal_ops_number_to_uint_width(number, element_size * 8);
    MalTypedArraySpan span;
    if (!mal_typed_array_object_span(array, &span)) {
        return mal_value_new_undefined();
    }
    u64 old_bits = mal_typed_array_span_load_bits(&span, index);
    i64 result = atomics_apply_i64(op, (i64) old_bits, operand);
    mal_typed_array_span_store_bits(&span, index, (u64) result);
    return atomics_numeric_value_from_bits(array->kind, old_bits);
}

static MalValue mal_atomics_add(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return atomics_rmw(vm, args, arg_count, ATOMICS_ADD);
}

static MalValue mal_atomics_sub(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return atomics_rmw(vm, args, arg_count, ATOMICS_SUB);
}

static MalValue mal_atomics_and(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return atomics_rmw(vm, args, arg_count, ATOMICS_AND);
}

static MalValue mal_atomics_or(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return atomics_rmw(vm, args, arg_count, ATOMICS_OR);
}

static MalValue mal_atomics_xor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return atomics_rmw(vm, args, arg_count, ATOMICS_XOR);
}

static MalValue mal_atomics_exchange(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return atomics_rmw(vm, args, arg_count, ATOMICS_EXCHANGE);
}

static MalValue mal_atomics_load(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalTypedArrayObject *array = atomics_validate(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), false);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 index;
    if (!atomics_to_index(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(),
                          mal_typed_array_object_length(array), &index)) {
        return mal_value_new_undefined();
    }
    return mal_typed_array_object_get(vm, array, index);
}

static MalValue mal_atomics_store(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalTypedArrayObject *array = atomics_validate(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), true);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 index;
    if (!atomics_to_index(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(),
                          mal_typed_array_object_length(array), &index)) {
        return mal_value_new_undefined();
    }
    MalValue value = arg_count >= 3 ? args[2] : mal_value_new_undefined();

    // Atomics.store returns the coerced value (NOT the truncated stored bits).
    if (mal_typed_array_is_bigint(array->kind)) {
        i128 big;
        if (!mal_bigint_to_bigint(vm, value, &big)) {
            return mal_value_new_undefined();
        }
        MalValue coerced = mal_value_is_bigint(value)
            ? value
            : mal_value_from_bigint(mal_bigint_new(&vm->heap, big));
        if (!atomics_revalidate(vm, array, index)) {
            return mal_value_new_undefined();
        }
        MalTypedArraySpan span;
        if (!mal_typed_array_object_span(array, &span)) {
            return mal_value_new_undefined();
        }
        mal_typed_array_span_store_bits(&span, index, (u64) (u128) big);
        return coerced;
    }

    f64 number;
    if (!atomics_to_integer(vm, value, &number)) {
        return mal_value_new_undefined();
    }
    if (!atomics_revalidate(vm, array, index)) {
        return mal_value_new_undefined();
    }
    mal_typed_array_object_set(vm, array, index, mal_ops_number_value(number));
    return mal_ops_number_value(number);
}

static MalValue mal_atomics_compare_exchange(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalTypedArrayObject *array = atomics_validate(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), true);
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 length = mal_typed_array_object_length(array);
    u32 index;
    if (!atomics_to_index(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), length, &index)) {
        return mal_value_new_undefined();
    }
    MalValue expected = arg_count >= 3 ? args[2] : mal_value_new_undefined();
    MalValue replacement = arg_count >= 4 ? args[3] : mal_value_new_undefined();

    if (mal_typed_array_is_bigint(array->kind)) {
        i128 expected_big;
        if (!mal_bigint_to_bigint(vm, expected, &expected_big)) {
            return mal_value_new_undefined();
        }
        i128 replacement_big;
        if (!mal_bigint_to_bigint(vm, replacement, &replacement_big)) {
            return mal_value_new_undefined();
        }
        if (!atomics_revalidate(vm, array, index)) {
            return mal_value_new_undefined();
        }
        MalValue old_value = mal_typed_array_object_get(vm, array, index);
        i128 old = mal_bigint_value(mal_value_to_bigint(old_value));
        if ((u64) (u128) old == (u64) (u128) expected_big) {
            mal_typed_array_object_set(vm, array, index,
                                       mal_value_from_bigint(mal_bigint_new(&vm->heap, replacement_big)));
        }
        return old_value;
    }

    f64 expected_num;
    if (!atomics_to_integer(vm, expected, &expected_num)) {
        return mal_value_new_undefined();
    }
    f64 replacement_num;
    if (!atomics_to_integer(vm, replacement, &replacement_num)) {
        return mal_value_new_undefined();
    }
    if (!atomics_revalidate(vm, array, index)) {
        return mal_value_new_undefined();
    }
    u32 element_size = mal_typed_array_element_size(array->kind);
    MalTypedArraySpan span;
    if (!mal_typed_array_object_span(array, &span)) {
        return mal_value_new_undefined();
    }
    u64 old_bits = mal_typed_array_span_load_bits(&span, index);
    u64 expected_bits = mal_ops_number_to_uint_width(expected_num, element_size * 8);
    if (old_bits == expected_bits) {
        u64 replacement_bits = mal_ops_number_to_uint_width(
            replacement_num, element_size * 8);
        mal_typed_array_span_store_bits(&span, index, replacement_bits);
    }
    return atomics_numeric_value_from_bits(array->kind, old_bits);
}

static MalValue mal_atomics_is_lock_free(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    f64 size;
    if (!atomics_to_integer(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &size)) {
        return mal_value_new_undefined();
    }
    bool lock_free = size == 1 || size == 2 || size == 4 || size == 8;
    return mal_value_new_boolean(lock_free);
}

// ValidateIntegerTypedArray(typedArray, /*waitable*/ true): wait/notify accept
// only Int32Array and BigInt64Array.
static MalTypedArrayObject *atomics_validate_waitable(MalVm *vm, MalValue value) {
    if (!mal_value_is_typed_array_object(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Atomics: argument is not a TypedArray");
        return nullptr;
    }
    MalTypedArrayObject *array = mal_value_to_typed_array_object(value);
    if (mal_typed_array_object_is_out_of_bounds(array)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Atomics: TypedArray is out of bounds");
        return nullptr;
    }
    if (array->kind != MAL_TA_INT32 && array->kind != MAL_TA_BIGINT64) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Atomics: TypedArray is not an Int32Array or BigInt64Array");
        return nullptr;
    }
    return array;
}

// {async: <bool>, value: <value>} — the WaitAsync result record.
static MalValue atomics_wait_result(MalVm *vm, bool async, MalValue value) {
    MalObject *result = mal_intrinsic_new_object(vm);
    mal_intrinsic_define_data(vm, result, "async", mal_value_new_boolean(async),
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    mal_intrinsic_define_data(vm, result, "value", value,
                              MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
    return mal_value_from_object(result);
}

// Atomics.notify(typedArray, index, count): single-threaded, no agent is ever
// waiting, so this validates + coerces (for the observable ordering/throws) and
// returns +0.
static MalValue mal_atomics_notify(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalTypedArrayObject *array = atomics_validate_waitable(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    u32 index;
    if (!atomics_to_index(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(),
                          mal_typed_array_object_length(array), &index)) {
        return mal_value_new_undefined();
    }
    // count: undefined -> +Infinity; else max(ToIntegerOrInfinity, 0). Coerced for
    // its observable side effects even though the woken count is always 0 here.
    if (arg_count >= 3 && !mal_value_is_undefined(args[2])) {
        f64 count;
        if (!atomics_to_integer(vm, args[2], &count)) {
            return mal_value_new_undefined();
        }
    }
    return mal_value_from_i32(0);
}

// Atomics.wait(typedArray, index, value, timeout): requires a SharedArrayBuffer
// and a blockable agent. This engine is single-threaded (the agent can never
// suspend), so after validation + coercion it throws TypeError — matching a
// host whose [[CanBlock]] is false.
static MalValue mal_atomics_wait(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalTypedArrayObject *array = atomics_validate_waitable(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    if (!array->buffer->shared) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Atomics.wait: buffer is not a SharedArrayBuffer");
        return mal_value_new_undefined();
    }
    u32 index;
    if (!atomics_to_index(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(),
                          mal_typed_array_object_length(array), &index)) {
        return mal_value_new_undefined();
    }
    // Coerce value (ToBigInt / ToNumber) then timeout (ToNumber) for their side
    // effects and possible throws, in spec order.
    MalValue value = arg_count >= 3 ? args[2] : mal_value_new_undefined();
    if (mal_typed_array_is_bigint(array->kind)) {
        i128 big;
        if (!mal_bigint_to_bigint(vm, value, &big)) {
            return mal_value_new_undefined();
        }
    } else {
        f64 number;
        if (!mal_vm_to_number(vm, value, &number)) {
            return mal_value_new_undefined();
        }
    }
    f64 timeout;
    if (!mal_vm_to_number(vm, arg_count >= 4 ? args[3] : mal_value_new_undefined(), &timeout)) {
        return mal_value_new_undefined();
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                       "Atomics.wait: agent cannot be suspended");
    return mal_value_new_undefined();
}

// Atomics.waitAsync(typedArray, index, value, timeout): does not require a
// blockable agent. The synchronous outcomes — value mismatch ("not-equal") and
// a zero timeout ("timed-out") — are returned directly; otherwise a pending
// promise is returned that, single-threaded, never settles (no other agent can
// notify it).
static MalValue mal_atomics_wait_async(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    MalTypedArrayObject *array = atomics_validate_waitable(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (array == nullptr) {
        return mal_value_new_undefined();
    }
    if (!array->buffer->shared) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Atomics.waitAsync: buffer is not a SharedArrayBuffer");
        return mal_value_new_undefined();
    }
    u32 index;
    if (!atomics_to_index(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(),
                          mal_typed_array_object_length(array), &index)) {
        return mal_value_new_undefined();
    }
    MalValue value = arg_count >= 3 ? args[2] : mal_value_new_undefined();
    bool matches;
    if (mal_typed_array_is_bigint(array->kind)) {
        i128 big;
        if (!mal_bigint_to_bigint(vm, value, &big)) {
            return mal_value_new_undefined();
        }
        i128 current = mal_bigint_value(mal_value_to_bigint(mal_typed_array_object_get(vm, array, index)));
        matches = current == big;
    } else {
        f64 number;
        if (!mal_vm_to_number(vm, value, &number)) {
            return mal_value_new_undefined();
        }
        u32 element_size = mal_typed_array_element_size(array->kind);
        u64 want = mal_ops_number_to_uint_width(number, element_size * 8);
        u64 current = mal_ops_number_to_uint_width(
            mal_ops_to_number(mal_typed_array_object_get(vm, array, index)), element_size * 8);
        matches = current == want;
    }
    f64 timeout;
    if (!mal_vm_to_number(vm, arg_count >= 4 ? args[3] : mal_value_new_undefined(), &timeout)) {
        return mal_value_new_undefined();
    }
    if (isnan(timeout) || timeout < 0) {
        timeout = isnan(timeout) ? (f64) INFINITY : 0;
    }

    if (!matches) {
        return atomics_wait_result(vm, false, mal_value_from_string(mal_intrinsic_ascii(vm, "not-equal")));
    }
    if (timeout == 0) {
        return atomics_wait_result(vm, false, mal_value_from_string(mal_intrinsic_ascii(vm, "timed-out")));
    }
    // Would block: hand back a pending promise. With no other agent it never
    // settles, which is the correct shape for the result record.
    MalValue promise, resolve, reject;
    if (!mal_promise_new_capability(vm, vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], &promise, &resolve,
                                    &reject)) {
        return mal_value_new_undefined();
    }
    return atomics_wait_result(vm, true, promise);
}

// Atomics.pause(iterationNumber): a micro-pause hint. iterationNumber, if given,
// must be an integral Number; returns undefined.
static MalValue mal_atomics_pause(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    if (arg_count >= 1 && !mal_value_is_undefined(args[0])) {
        bool is_number = mal_value_is_int32(args[0]) || mal_value_is_f64_or_nan(args[0]);
        f64 n = is_number ? mal_ops_to_number(args[0]) : 0;
        if (!is_number || !isfinite(n) || trunc(n) != n) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Atomics.pause: iterationNumber must be an integer");
            return mal_value_new_undefined();
        }
    }
    return mal_value_new_undefined();
}

void mal_builtin_atomics_install(MalVm *vm) {
    MalObject *atomics = mal_intrinsic_new_object(vm);
    vm->intrinsics[MAL_INTRINSIC_ATOMICS] = mal_value_from_object(atomics);

    MalPropertyDesc tag_desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, "Atomics")), MAL_PROPERTY_CONFIGURABLE);
    mal_object_define_own(atomics, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &tag_desc);

    mal_intrinsic_define_method_n(vm, atomics, "add", 3, mal_atomics_add);
    mal_intrinsic_define_method_n(vm, atomics, "sub", 3, mal_atomics_sub);
    mal_intrinsic_define_method_n(vm, atomics, "and", 3, mal_atomics_and);
    mal_intrinsic_define_method_n(vm, atomics, "or", 3, mal_atomics_or);
    mal_intrinsic_define_method_n(vm, atomics, "xor", 3, mal_atomics_xor);
    mal_intrinsic_define_method_n(vm, atomics, "exchange", 3, mal_atomics_exchange);
    mal_intrinsic_define_method_n(vm, atomics, "compareExchange", 4, mal_atomics_compare_exchange);
    mal_intrinsic_define_method_n(vm, atomics, "load", 2, mal_atomics_load);
    mal_intrinsic_define_method_n(vm, atomics, "store", 3, mal_atomics_store);
    mal_intrinsic_define_method_n(vm, atomics, "isLockFree", 1, mal_atomics_is_lock_free);
    mal_intrinsic_define_method_n(vm, atomics, "notify", 3, mal_atomics_notify);
    mal_intrinsic_define_method_n(vm, atomics, "wait", 4, mal_atomics_wait);
    mal_intrinsic_define_method_n(vm, atomics, "waitAsync", 4, mal_atomics_wait_async);
    mal_intrinsic_define_method_n(vm, atomics, "pause", 0, mal_atomics_pause);
}

#include "generated/known_native_builtin_atomics_c.inc"
