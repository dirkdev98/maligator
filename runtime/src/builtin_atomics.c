#include "builtin_atomics.h"

#include <math.h>

#include "array_buffer_object.h"
#include "bigint128.h"
#include "shared_memory.h"
#include "builtin_bigint.h"
#include "heap_bigint.h"
#include "gc.h"
#include "intrinsics.h"
#include "object.h"
#include "scalar_bits.h"
#include "typed_array_object.h"
#include "value.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// Every element access below is a sequentially consistent native atomic on the
// element's address (shared_memory.h), for ordinary buffers too: one code path,
// and an aligned atomic on unshared memory costs no more than a plain access.
// Typed-array byte offsets are element-aligned, so every address is aligned.

static byte *atomics_element_address(const MalTypedArraySpan *span, u32 index) {
    return span->data + (size_t) index * span->element_size;
}

// ValidateIntegerTypedArray: a (non-out-of-bounds) TypedArray whose element type
// is one of the integer kinds (Float/Uint8Clamped are rejected with a TypeError).
static MalTypedArrayObject *atomics_validate(MalVm *vm, MalValue value, bool writable) {
    if (!mal_value_is_typed_array_object(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Atomics: argument is not a TypedArray");
        return nullptr;
    }
    MalTypedArrayObject *array = mal_value_to_typed_array_object(value);
    // A length-tracking view must see growth published by another agent.
    mal_array_buffer_object_refresh_shared_length(array->buffer);
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
static MalValue atomics_rmw(MalVm *vm, const MalValue *args, i32 arg_count, MalSharedRmw op) {
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
        // Modular 64-bit arithmetic on raw bits equals the BigInt op truncated
        // to the element width, so the native RMW is exact.
        u64 old_bits = mal_shared_atomic_rmw(
            atomics_element_address(&span, index), 8, op, (u64) (u128) operand);
        i128 old = array->kind == MAL_TA_BIGINT64
            ? (i128) mal_scalar_i64_from_bits(old_bits)
            : (i128) (u128) old_bits;
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
    u64 old_bits = mal_shared_atomic_rmw(
        atomics_element_address(&span, index), element_size, op, (u64) operand);
    return atomics_numeric_value_from_bits(array->kind, old_bits);
}

static MalValue mal_atomics_add(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return atomics_rmw(vm, args, arg_count, MAL_SHARED_RMW_ADD);
}

static MalValue mal_atomics_sub(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return atomics_rmw(vm, args, arg_count, MAL_SHARED_RMW_SUB);
}

static MalValue mal_atomics_and(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return atomics_rmw(vm, args, arg_count, MAL_SHARED_RMW_AND);
}

static MalValue mal_atomics_or(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return atomics_rmw(vm, args, arg_count, MAL_SHARED_RMW_OR);
}

static MalValue mal_atomics_xor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return atomics_rmw(vm, args, arg_count, MAL_SHARED_RMW_XOR);
}

static MalValue mal_atomics_exchange(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) new_target;
    (void) callee;
    return atomics_rmw(vm, args, arg_count, MAL_SHARED_RMW_EXCHANGE);
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
    if (!atomics_revalidate(vm, array, index)) {
        return mal_value_new_undefined();
    }
    MalTypedArraySpan span;
    if (!mal_typed_array_object_span(array, &span)) {
        return mal_value_new_undefined();
    }
    u64 bits = mal_shared_atomic_load(atomics_element_address(&span, index), span.element_size);
    if (array->kind == MAL_TA_BIGINT64) {
        return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) mal_scalar_i64_from_bits(bits)));
    }
    if (array->kind == MAL_TA_BIGUINT64) {
        return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) (u128) bits));
    }
    return atomics_numeric_value_from_bits(array->kind, bits);
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
        mal_shared_atomic_store(atomics_element_address(&span, index), 8, (u64) (u128) big);
        return coerced;
    }

    f64 number;
    if (!atomics_to_integer(vm, value, &number)) {
        return mal_value_new_undefined();
    }
    if (!atomics_revalidate(vm, array, index)) {
        return mal_value_new_undefined();
    }
    MalTypedArraySpan span;
    if (!mal_typed_array_object_span(array, &span)) {
        return mal_value_new_undefined();
    }
    mal_shared_atomic_store(atomics_element_address(&span, index), span.element_size,
                            mal_ops_number_to_uint_width(number, span.element_size * 8));
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
        MalTypedArraySpan span;
        if (!mal_typed_array_object_span(array, &span)) {
            return mal_value_new_undefined();
        }
        u64 old_bits = mal_shared_atomic_compare_exchange(
            atomics_element_address(&span, index), 8,
            (u64) (u128) expected_big, (u64) (u128) replacement_big);
        i128 old = array->kind == MAL_TA_BIGINT64
            ? (i128) mal_scalar_i64_from_bits(old_bits)
            : (i128) (u128) old_bits;
        return mal_value_from_bigint(mal_bigint_new(&vm->heap, old));
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
    u64 expected_bits = mal_ops_number_to_uint_width(expected_num, element_size * 8);
    u64 replacement_bits = mal_ops_number_to_uint_width(replacement_num, element_size * 8);
    u64 old_bits = mal_shared_atomic_compare_exchange(
        atomics_element_address(&span, index), element_size, expected_bits, replacement_bits);
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
    mal_array_buffer_object_refresh_shared_length(array->buffer);
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

// Per-isolate agent record. Each isolate runs on one mutator thread, so
// isolate-local storage is the agent's [[CanBlock]] and termination point.
// Threadless WASI has no other agent that could ever notify, so it cannot block.
#if defined(__wasi__)
static MAL_ISOLATE_LOCAL bool g_atomics_can_block = false;
#else
static MAL_ISOLATE_LOCAL bool g_atomics_can_block = true;
#endif
static MAL_ISOLATE_LOCAL MalSharedWaitInterrupt *g_atomics_interrupt;
// Per isolate: only an isolate whose event loop installed the hook can settle
// its own waitAsync promises, and teardown clears it before the loop is freed.
static MAL_ISOLATE_LOCAL MalAtomicsWaitAsyncHook g_atomics_wait_async_hook;

void mal_atomics_set_agent(bool can_block, MalSharedWaitInterrupt *interrupt) {
#if defined(__wasi__)
    (void) can_block;
#else
    g_atomics_can_block = can_block;
#endif
    g_atomics_interrupt = interrupt;
}

void mal_atomics_set_wait_async_hook(MalAtomicsWaitAsyncHook hook) {
    g_atomics_wait_async_hook = hook;
}

// Byte offset of element `index` inside the shared backing (not the view).
static u32 atomics_backing_offset(const MalTypedArrayObject *array, u32 index) {
    return array->byte_offset + index * mal_typed_array_element_size(array->kind);
}

// Atomics.notify(typedArray, index, count): wakes up to `count` waiters on the
// shared backing at this element, FIFO. An unshared buffer has no waiters.
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
    // count: undefined -> +Infinity; else max(ToIntegerOrInfinity, 0).
    u32 count = UINT32_MAX;
    if (arg_count >= 3 && !mal_value_is_undefined(args[2])) {
        f64 number;
        if (!atomics_to_integer(vm, args[2], &number)) {
            return mal_value_new_undefined();
        }
        count = number <= 0 ? 0 : number >= (f64) UINT32_MAX ? UINT32_MAX : (u32) number;
    }
    MalArrayBufferObject *buffer = array->buffer;
    if (!buffer->shared || buffer->shared_memory == nullptr) {
        return mal_value_from_i32(0);
    }
    u32 woken = mal_shared_memory_notify(buffer->shared_memory, atomics_backing_offset(array, index), count);
    return mal_value_from_u32(woken);
}

// DoWait step: coerce `value` (ToInt32 / ToBigInt64) to the raw element bits
// compared inside the waiter-list critical section.
static bool atomics_wait_operands(
    MalVm *vm, MalTypedArrayObject *array, const MalValue *args, i32 arg_count, u64 *out_expected) {
    MalValue value = arg_count >= 3 ? args[2] : mal_value_new_undefined();
    if (mal_typed_array_is_bigint(array->kind)) {
        i128 big;
        if (!mal_bigint_to_bigint(vm, value, &big)) {
            return false;
        }
        *out_expected = (u64) (u128) big;
        return true;
    }
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) {
        return false;
    }
    *out_expected = mal_ops_number_to_uint_width(number, 32);
    return true;
}

// timeout: NaN -> +Infinity, otherwise max(ToNumber(timeout), 0) milliseconds.
static bool atomics_wait_timeout(MalVm *vm, const MalValue *args, i32 arg_count, f64 *out_timeout) {
    f64 timeout;
    if (!mal_vm_to_number(vm, arg_count >= 4 ? args[3] : mal_value_new_undefined(), &timeout)) {
        return false;
    }
    *out_timeout = isnan(timeout) ? (f64) INFINITY : timeout < 0 ? 0 : timeout;
    return true;
}

// Atomics.wait(typedArray, index, value, timeout): DoWait(sync). Blocks the
// mutator thread on the shared waiter list; a host whose [[CanBlock]] is false
// (threadless WASI, or an agent root marks non-blocking) throws TypeError.
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
    u64 expected;
    if (!atomics_wait_operands(vm, array, args, arg_count, &expected)) {
        return mal_value_new_undefined();
    }
    f64 timeout;
    if (!atomics_wait_timeout(vm, args, arg_count, &timeout)) {
        return mal_value_new_undefined();
    }
    if (!g_atomics_can_block) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                           "Atomics.wait: agent cannot be suspended");
        return mal_value_new_undefined();
    }
    // A SharedArrayBuffer never detaches or shrinks, so the index validated
    // before coercion still addresses the same element.
    mal_gc_set_mutator_busy(vm, false);
    MalSharedWaitResult result = mal_shared_memory_wait_sync(
        array->buffer->shared_memory, atomics_backing_offset(array, index),
        mal_typed_array_element_size(array->kind), expected, timeout, g_atomics_interrupt);
    mal_gc_set_mutator_busy(vm, true);
    switch (result) {
    case MAL_SHARED_WAIT_OK:
        return mal_value_from_string(mal_intrinsic_ascii(vm, "ok"));
    case MAL_SHARED_WAIT_NOT_EQUAL:
        return mal_value_from_string(mal_intrinsic_ascii(vm, "not-equal"));
    case MAL_SHARED_WAIT_TIMED_OUT:
        return mal_value_from_string(mal_intrinsic_ascii(vm, "timed-out"));
    case MAL_SHARED_WAIT_INTERRUPTED:
        break;
    }
    // Root's termination path must observe the still-signaled interrupt and
    // unwind this exception without running user catch handlers.
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Atomics.wait: agent terminated");
    return mal_value_new_undefined();
}

// Atomics.waitAsync(typedArray, index, value, timeout): DoWait(async). Needs no
// blockable agent and holds no thread: the waiter is a list entry whose notify
// or timeout settles the promise on this isolate's event loop.
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
    u64 expected;
    if (!atomics_wait_operands(vm, array, args, arg_count, &expected)) {
        return mal_value_new_undefined();
    }
    f64 timeout;
    if (!atomics_wait_timeout(vm, args, arg_count, &timeout)) {
        return mal_value_new_undefined();
    }
    MalSharedMemory *memory = array->buffer->shared_memory;
    u32 offset = atomics_backing_offset(array, index);
    u32 width = mal_typed_array_element_size(array->kind);
    MalSharedWaitResult result;
    MalValue promise = mal_value_new_undefined();
    if (timeout == 0) {
        u64 mask = width == 8 ? ~0ull : 0xFFFFFFFFull;
        u64 current = mal_shared_atomic_load(mal_shared_memory_data(memory) + offset, width);
        result = (current & mask) == (expected & mask) ? MAL_SHARED_WAIT_TIMED_OUT : MAL_SHARED_WAIT_NOT_EQUAL;
    } else if (g_atomics_wait_async_hook != nullptr) {
        // The hook compares and enqueues inside one critical section and owns
        // the promise's settlement on this isolate's event loop.
        if (!g_atomics_wait_async_hook(vm, memory, offset, width, expected, timeout, &result, &promise)) {
            return mal_value_new_undefined();
        }
    } else {
        // Without an event loop (threadless WASI, a bare embedder) neither a
        // notify nor a timer can settle a pending promise, so refuse to create one.
        u64 mask = width == 8 ? ~0ull : 0xFFFFFFFFull;
        u64 current = mal_shared_atomic_load(mal_shared_memory_data(memory) + offset, width);
        if ((current & mask) == (expected & mask)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                               "Atomics.waitAsync: no event loop can settle the wait");
            return mal_value_new_undefined();
        }
        result = MAL_SHARED_WAIT_NOT_EQUAL;
    }
    switch (result) {
    case MAL_SHARED_WAIT_NOT_EQUAL:
        return atomics_wait_result(vm, false, mal_value_from_string(mal_intrinsic_ascii(vm, "not-equal")));
    case MAL_SHARED_WAIT_TIMED_OUT:
        return atomics_wait_result(vm, false, mal_value_from_string(mal_intrinsic_ascii(vm, "timed-out")));
    default:
        return atomics_wait_result(vm, true, promise);
    }
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
