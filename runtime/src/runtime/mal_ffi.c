#include "../ffi/mal_ffi.h"

#include <limits.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <math.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_buffer_object.h"
#include "array_object.h"
#include "async_context.h"
#include "blocking_work.h"
#include "builtin_promise.h"
#include "host.h"
#include "web_host_timer.h"
#include "builtin_data_view.h"
#include "function_object.h"
#include "gc.h"
#include "heap_bigint.h"
#include "heap.h"
#include "intrinsics.h"
#include "object.h"
#include "object_ops.h"
#include "shape.h"
#include "typed_array_object.h"
#include "utf8.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

static_assert(sizeof(MalFfiRoots) == sizeof(MalRootSpan));
static_assert(offsetof(MalFfiRoots, slots) == offsetof(MalRootSpan, slots));
static_assert(offsetof(MalFfiRoots, count) == offsetof(MalRootSpan, count));
static_assert(MAL_FFI_VALUE_TAG_BASE == MAL_VALUE_TAG_BASE);
static_assert(MAL_FFI_VALUE_CLASS_MASK == MAL_VALUE_CLASS_MASK);
static_assert(MAL_FFI_VALUE_INT32 == MAL_VALUE_INT32);
static_assert(MAL_FFI_VALUE_NULL == MAL_VALUE_NULL);
static_assert(MAL_FFI_VALUE_UNDEFINED == MAL_VALUE_UNDEFINED);
static_assert(MAL_FFI_VALUE_TRUE == MAL_VALUE_TRUE);
static_assert(MAL_FFI_VALUE_FALSE == MAL_VALUE_FALSE);
static_assert(MAL_FFI_VALUE_NAN == MAL_VALUE_NAN);

/* Error formatting must not enlarge successful binding calls' stack frames. */
static __attribute__((noinline)) bool ffi_fail(
    MalVm *vm, MalIntrinsic prototype, const MalFfiSite *site, const char *expectation) {
    char message[512];
    if (site->field == nullptr) {
        snprintf(
            message, sizeof(message), "%s: %s expects %s", site->function, site->parameter,
            expectation);
    } else {
        snprintf(
            message, sizeof(message), "%s: %s.%s expects %s", site->function, site->parameter,
            site->field, expectation);
    }
    mal_vm_throw_error(vm, prototype, (const byte *) message);
    return false;
}

/**
 * `ffi_fail` with a formatted expectation. Kept out of line: its buffer would give
 * every conversion that can fail a large, canary-checked frame.
 */
static __attribute__((noinline, format(printf, 4, 5))) bool ffi_failf(
    MalVm *vm, MalIntrinsic prototype, const MalFfiSite *site, const char *format, ...) {
    char expectation[160];
    va_list arguments;
    va_start(arguments, format);
    vsnprintf(expectation, sizeof(expectation), format, arguments);
    va_end(arguments);
    return ffi_fail(vm, prototype, site, expectation);
}

bool mal_ffi_expected(MalVm *vm, const MalFfiSite *site, const char *expectation) {
    return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, expectation);
}

bool mal_ffi_number_to_integer(
    MalVm *vm, MalValue value, int32_t bits, bool is_signed, const MalFfiSite *site, int64_t *out) {
    if (!mal_ops_is_number(value)) return mal_ffi_expected(vm, site, "a number");
    i64 minimum = is_signed ? -(INT64_C(1) << (bits - 1)) : 0;
    i64 maximum = is_signed ? (INT64_C(1) << (bits - 1)) - 1 : (INT64_C(1) << bits) - 1;
    f64 number = mal_ops_number_as_f64(value);
    if (!isfinite(number) || trunc(number) != number || number < (f64) minimum
        || number > (f64) maximum) {
        return ffi_failf(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site, "an integer from %lld to %lld",
            (long long) minimum, (long long) maximum);
    }
    *out = (i64) number;
    return true;
}

static bool ffi_bigint(
    MalVm *vm, MalValue value, const MalFfiSite *site, i128 *out) {
    if (!mal_value_is_bigint(value)) {
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a bigint");
    }
    *out = mal_bigint_value(mal_value_to_bigint(value));
    return true;
}

bool mal_ffi_to_int64(
    MalVm *vm, MalValue value, int32_t bits, const MalFfiSite *site, int64_t *out) {
    i128 integer;
    if (!ffi_bigint(vm, value, site, &integer)) return false;
    i128 minimum = -((i128) 1 << (bits - 1));
    i128 maximum = ((i128) 1 << (bits - 1)) - 1;
    if (integer < minimum || integer > maximum) {
        return ffi_failf(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site,
            "a bigint in the signed %d-bit range", bits);
    }
    *out = (i64) integer;
    return true;
}

bool mal_ffi_to_uint64(
    MalVm *vm, MalValue value, int32_t bits, const MalFfiSite *site, uint64_t *out) {
    i128 integer;
    if (!ffi_bigint(vm, value, site, &integer)) return false;
    if (integer < 0 || integer >= ((i128) 1 << bits)) {
        return ffi_failf(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site,
            "a bigint in the unsigned %d-bit range", bits);
    }
    *out = (u64) integer;
    return true;
}

bool mal_ffi_to_string(
    MalVm *vm, MalValue value, bool nullable, uint32_t flags, const MalFfiSite *site, MalFfiString *out) {
    out->data = nullptr;
    out->length = 0;
    bool counted = (flags & MAL_FFI_STRING_COUNTED) != 0;
    if (nullable && mal_value_is_null(value)) return true;
    if (!mal_value_is_string(value)) {
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, nullable ? "a string or null" : "a string");
    }
    const MalString *string = mal_value_to_string(value);
    // A UTF-16 code unit encodes to at most three bytes; a pair's four cover two units.
    usize units = mal_string_length(string);
    char *data = out->inline_data;
    usize capacity = sizeof(out->inline_data);
    // ASCII can fit inline even when UTF-8's worst-case expansion would require a heap copy.
    if (units >= capacity) {
        if ((flags & MAL_FFI_STRING_BORROW) != 0
            && string->storage == MAL_STRING_STORAGE_PREPARED_UTF8) {
            if ((string->ffi_utf8_state & 1) == 0) {
                if (string->ffi_utf8_state == 0) {
                    out->data = (char *) string->latin1_units;
                    out->length = units;
                    out->borrowed = true;
                    return true;
                }
                const MalStringUtf8 *encoded = mal_string_ffi_utf8_cache(string);
                if (encoded->has_nul && !counted)
                    return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site,
                        "a string without NUL characters");
                out->data = (char *) encoded->data;
                out->length = encoded->length;
                out->borrowed = true;
                return true;
            }
        }
        data = units > (SIZE_MAX - 1) / 3 ? nullptr : malloc(units * 3 + 1);
        if (data == nullptr) return mal_ffi_out_of_memory(vm);
        out->borrowed = false;
        capacity = units * 3 + 1;
    }
    usize length = 0;
    bool encoded = false;
    bool nul = false;
    if (units != 0 && string->latin1 && string->storage < MAL_STRING_STORAGE_DEPENDENT) {
        // A flat ASCII string is its own UTF-8: one pass copies it and checks for high
        // bytes and NULs. Otherwise the general encoder overwrites the copy.
        const u8 *flat = string->storage == MAL_STRING_STORAGE_INLINE
            ? string->inline_latin1_units : string->latin1_units;
        u8 high = 0;
        u8 zero = 0;
        for (usize index = 0; index < units; index++) {
            u8 unit = flat[index];
            high |= unit;
            zero |= unit == 0;
            data[index] = (char) unit;
        }
        if (high < 0x80) {
            length = units;
            encoded = true;
            nul = zero != 0;
        }
    }
    if (!encoded) {
        if (units > (capacity - 1) / 3) {
            data = units > (SIZE_MAX - 1) / 3 ? nullptr : malloc(units * 3 + 1);
            if (data == nullptr) return mal_ffi_out_of_memory(vm);
            out->borrowed = false;
            capacity = units * 3 + 1;
        }
        mal_string_utf8_encode_into(string, (byte *) data, capacity, nullptr, &length);
        // NUL is the only code point whose UTF-8 encoding contains a zero byte.
        nul = memchr(data, 0, length) != nullptr;
    }
    data[length] = '\0';
    if (units >= sizeof(out->inline_data) && (flags & MAL_FFI_STRING_BORROW) != 0) {
        const u8 *prepared = nullptr;
        if (encoded && !nul) prepared = mal_string_prepare_ascii_cstr(&vm->heap, (MalString *) string);
        else if (!encoded && (!nul || counted)) {
            const MalStringUtf8 *cached = mal_string_prepare_ffi_utf8(
                &vm->heap, (MalString *) string, (const u8 *) data, length, nul);
            if (cached != nullptr) prepared = cached->data;
        }
        if (prepared != nullptr) {
            free(data);
            out->data = (char *) prepared;
            out->length = length;
            out->borrowed = true;
            return true;
        }
    }
    out->data = data;
    out->length = length;
    if (nul && !counted) {
        mal_ffi_string_release(out);
        return ffi_fail(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a string without NUL characters");
    }
    return true;
}

void mal_ffi_string_release(MalFfiString *string) {
    if (string->data != nullptr && string->data != string->inline_data && !string->borrowed) free(string->data);
    string->data = nullptr;
    string->length = 0;
}

bool mal_ffi_to_owned_string(MalVm *vm, MalValue value, const MalFfiSite *site, char **out) {
    *out = nullptr;
    MalFfiString string;
    if (!mal_ffi_to_string(vm, value, false, 0, site, &string)) return false;
    if (string.data != string.inline_data) {
        *out = string.data;
        return true;
    }
    char *copy = malloc(string.length + 1);
    if (copy == nullptr) return mal_ffi_out_of_memory(vm);
    memcpy(copy, string.data, string.length + 1);
    *out = copy;
    return true;
}

__attribute__((always_inline)) bool mal_ffi_to_bytes(
    MalVm *vm, MalValue value, bool nullable, bool writable, const MalFfiSite *site,
    void **data, size_t *length, void **pin) {
    if (pin != nullptr) *pin = nullptr;
    if (nullable && mal_value_is_null(value)) {
        *data = nullptr;
        *length = 0;
        return true;
    }
    MalBufferSourceSpan span;
    MalBufferSourceSpanStatus status = mal_buffer_source_span(value, &span);
    if (status == MAL_BUFFER_SOURCE_SPAN_OK && writable && span.buffer->immutable) {
        return ffi_fail(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a buffer that is not immutable");
    }
    if (status == MAL_BUFFER_SOURCE_SPAN_OK && !span.shared) {
        *data = span.data;
        *length = span.length;
        if (pin != nullptr) {
            span.buffer->pins++;
            *pin = span.buffer;
        }
        return true;
    }
    const char *expectation = status == MAL_BUFFER_SOURCE_SPAN_NOT_BUFFER_SOURCE
        ? (nullable ? "an ArrayBuffer, a view, or null" : "an ArrayBuffer or a view")
        : status == MAL_BUFFER_SOURCE_SPAN_OK ? "a buffer that is not shared"
                                              : "a buffer that is attached and in bounds";
    return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, expectation);
}

bool mal_ffi_is_typed_array(MalValue value) {
    return mal_value_is_typed_array_object(value);
}

bool mal_ffi_to_numeric_view(
    MalVm *vm, MalValue value, MalFfiNumericKind expected, size_t element_size, size_t alignment,
    const MalFfiSite *site, const void **data, int32_t *length, void **pin) {
    static const MalTypedArrayKind kinds[] = {
        MAL_TA_INT8, MAL_TA_UINT8, MAL_TA_INT16, MAL_TA_UINT16,
        MAL_TA_INT32, MAL_TA_UINT32, MAL_TA_BIGINT64, MAL_TA_BIGUINT64,
        MAL_TA_FLOAT32, MAL_TA_FLOAT64,
    };
    if (pin != nullptr) *pin = nullptr;
    if (!mal_value_is_typed_array_object(value) || (u32) expected >= sizeof(kinds) / sizeof(*kinds))
        return mal_ffi_expected(vm, site, "a matching numeric typed array");
    MalTypedArrayObject *array = mal_value_to_typed_array_object(value);
    MalTypedArraySpan span;
    if (!mal_typed_array_object_span(array, &span) || span.shared || span.kind != kinds[expected]
        || span.element_size != element_size || alignment == 0
        || (span.data != nullptr && (uintptr_t) span.data % alignment != 0))
        return mal_ffi_expected(vm, site, "matching, attached, unshared, in-bounds numeric storage");
    if (!mal_ffi_check_array_count(vm, span.length, INT32_MAX, site)) return false;
    *data = span.data;
    *length = (int32_t) span.length;
    if (pin != nullptr) {
        array->buffer->pins++;
        *pin = array->buffer;
    }
    return true;
}

bool mal_ffi_to_fixed_string(MalVm *vm, MalValue value, void *target, size_t capacity, const MalFfiSite *site) {
    MalFfiString text = {};
    if (!mal_ffi_to_string(vm, value, false, MAL_FFI_STRING_BORROW, site, &text)) return false;
    bool fits = text.length < capacity;
    if (fits) {
        memset(target, 0, capacity);
        memcpy(target, text.data, text.length);
    } else mal_ffi_expected(vm, site, "UTF-8 text shorter than the declared array capacity");
    mal_ffi_string_release(&text);
    return fits;
}

bool mal_ffi_to_fixed_bytes(MalVm *vm, MalValue value, void *target, size_t capacity, const MalFfiSite *site) {
    void *data;
    size_t length;
    if (!mal_ffi_to_bytes(vm, value, false, false, site, &data, &length, nullptr)) return false;
    if (length != capacity) {
        mal_ffi_expected(vm, site, "bytes matching the declared array capacity");
        return false;
    }
    memcpy(target, data, length);
    return true;
}

void mal_ffi_unpin(void *pin) {
    if (pin != nullptr) ((MalArrayBufferObject *) pin)->pins--;
}

bool mal_ffi_to_array_length(
    MalVm *vm, MalValue value, bool nullable, const MalFfiSite *site, int32_t *length) {
    if (nullable && mal_value_is_null(value)) {
        *length = 0;
        return true;
    }
    if (mal_value_is_array_object(value)
        && mal_array_object_length(mal_value_to_array_object(value)) <= (u32) INT32_MAX) {
        *length = (int32_t) mal_array_object_length(mal_value_to_array_object(value));
        return true;
    }
    bool is_array = false;
    if (mal_value_is_object(value) && !mal_vm_is_array(vm, value, &is_array)) return false;
    MalValue array_length = mal_value_new_undefined();
    if (is_array && !mal_vm_get_static(vm, value, (const byte *) "length", &array_length)) {
        return false;
    }
    if (!is_array || !mal_ops_is_number(array_length)) {
        return ffi_fail(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, nullable ? "an array or null" : "an array");
    }
    f64 count = mal_ops_number_as_f64(array_length);
    if (count > (f64) INT32_MAX) {
        return ffi_fail(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site, "an array of at most 2147483647 elements");
    }
    *length = (int32_t) count;
    return true;
}

bool mal_ffi_check_array_count(
    MalVm *vm, uint64_t count, uint64_t capacity, const MalFfiSite *site) {
    if (count > INT32_MAX || count > capacity)
        return ffi_fail(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site,
            "a non-negative array count within its allocated capacity");
    return true;
}

bool mal_ffi_check_count(
    MalVm *vm, size_t count, int32_t bits, bool is_signed, const MalFfiSite *site) {
    u64 maximum = bits >= 64 ? (is_signed ? (u64) INT64_MAX : UINT64_MAX)
                             : (is_signed ? (UINT64_C(1) << (bits - 1)) - 1 : (UINT64_C(1) << bits) - 1);
    if ((u64) count <= maximum) return true;
    return ffi_failf(
        vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site, "at most %llu elements",
        (unsigned long long) maximum);
}

/** An Array's elements when every one is an own data value, so reading them runs no JavaScript. */
static const MalValue *ffi_dense_elements(MalValue value, int32_t length) {
    if (!mal_value_is_array_object(value)) return nullptr;
    MalArrayObject *array = mal_value_to_array_object(value);
    if (length < 0 || array->length != (u32) length || array->elements == nullptr
        || array->dense_count < (u32) length || array->dense_maybe_holey) return nullptr;
    return array->elements;
}

// Typed views skip copying; keep the bulk work out of their shared bridge.
__attribute__((noinline)) bool mal_ffi_try_f64_elements(MalValue value, int32_t length, double *out) {
    const MalValue *elements = ffi_dense_elements(value, length);
    if (elements == nullptr) return false;
    // Raw doubles already have C's representation; tagged values need the decoding pass.
    if (length > 0 && elements[0] < MAL_VALUE_TAG_BASE) {
        static_assert((MAL_VALUE_TAG_BASE & UINT32_MAX) == 0);
        // An upper-word maximum lets SIMD validate the copy without narrowing lane comparisons.
        u32 maximum = 0;
        for (int32_t index = 0; index < length; index++) {
            MalValue element = elements[index];
            u32 high = (u32) (element >> 32);
            if (high > maximum) maximum = high;
            out[index] = mal_value_to_f64(element);
        }
        if (maximum < (u32) (MAL_VALUE_TAG_BASE >> 32)) return true;
    }
    bool valid = true;
    for (int32_t index = 0; index < length; index++) {
        MalValue element = elements[index];
        bool number = mal_ops_is_number(element);
        valid &= number;
        out[index] = number ? mal_ops_number_as_f64(element) : 0.0;
    }
    return valid;
}

// Unsigned stores keep each value's bits; C permits them to alias the signed element type.
static inline __attribute__((always_inline)) void ffi_store_integer(
    void *out, int32_t index, size_t width, i64 value) {
    switch (width) {
        case 1: ((u8 *) out)[index] = (u8) value; break;
        case 2: ((u16 *) out)[index] = (u16) value; break;
        default: ((u32 *) out)[index] = (u32) value; break;
    }
}

static inline __attribute__((always_inline)) bool ffi_integer_elements(
    const MalValue *elements, int32_t length, i64 minimum, i64 maximum, size_t width, void *out) {
    // Exact integers usually use the int32 class, which one branch-free pass validates.
    u32 classes = 0;
    i32 low = INT32_MAX;
    i32 high = INT32_MIN;
    for (int32_t index = 0; index < length; index++) {
        MalValue element = elements[index];
        classes |= (u32) (element >> 32) ^ (u32) (MAL_VALUE_INT32 >> 32);
        i32 integer = mal_value_to_i32(element);
        low = integer < low ? integer : low;
        high = integer > high ? integer : high;
        ffi_store_integer(out, index, width, integer);
    }
    if (classes == 0 && low >= minimum && high <= maximum) return true;
    for (int32_t index = 0; index < length; index++) {
        f64 number;
        if (!mal_ops_try_number_as_f64(elements[index], &number)
            || !(number >= (f64) minimum && number <= (f64) maximum) || trunc(number) != number)
            return false;
        ffi_store_integer(out, index, width, (i64) number);
    }
    return true;
}

__attribute__((noinline)) bool mal_ffi_try_integer_elements(
    MalValue value, int32_t length, int32_t bits, bool is_signed, void *out) {
    const MalValue *elements = ffi_dense_elements(value, length);
    if (elements == nullptr) return false;
    i64 minimum = is_signed ? -(INT64_C(1) << (bits - 1)) : 0;
    i64 maximum = is_signed ? (INT64_C(1) << (bits - 1)) - 1 : (INT64_C(1) << bits) - 1;
    switch (bits) {
        case 8: return ffi_integer_elements(elements, length, minimum, maximum, 1, out);
        case 16: return ffi_integer_elements(elements, length, minimum, maximum, 2, out);
        case 32: return ffi_integer_elements(elements, length, minimum, maximum, 4, out);
        default: return false;
    }
}

bool mal_ffi_element(
    MalVm *vm, MalValue array, int32_t index, int32_t length, const MalFfiSite *site, MalValue *out) {
    // An Array's dense elements are own data properties, so reading one runs no JavaScript.
    if (mal_value_is_array_object(array)) {
        MalArrayObject *object = mal_value_to_array_object(array);
        if (mal_array_object_length(object) == (u32) length
            && mal_array_object_dense_get(object, (u32) index, out)) {
            return true;
        }
    }
    bool is_array = false;
    if (mal_value_is_object(array) && !mal_vm_is_array(vm, array, &is_array)) return false;
    MalValue array_length = mal_value_new_undefined();
    if (is_array && !mal_vm_get_static(vm, array, (const byte *) "length", &array_length)) {
        return false;
    }
    if (!is_array || !mal_ops_is_number(array_length)
        || mal_ops_number_as_f64(array_length) != (f64) length) {
        return ffi_failf(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "an array of %d elements", (int) length);
    }
    return mal_vm_get_property(vm, array, mal_key_index((u32) index), out);
}

MalValue mal_ffi_from_int64(MalVm *vm, int64_t value) {
    return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) value));
}

MalValue mal_ffi_from_uint64(MalVm *vm, uint64_t value) {
    return mal_value_from_bigint(mal_bigint_new(&vm->heap, (i128) value));
}

MalValue mal_ffi_from_string(MalVm *vm, const char *value) {
    if (value == nullptr) return mal_value_new_null();
    MalString *string = mal_string_from_utf8(&vm->heap, (const byte *) value, strlen(value));
    if (string == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

MalValue mal_ffi_from_string_length(MalVm *vm, const char *value, size_t length) {
    if (value == nullptr) return mal_value_new_null();
    if ((u64) length > UINT64_C(3) * MAL_STRING_MAX_CODE_UNITS) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, (const byte *) "C string is too large");
        return mal_value_new_undefined();
    }
    MalUtf8DecodeStatus status;
    MalString *string = mal_string_from_utf8_report(
        &vm->heap, (const byte *) value, length, nullptr, &status);
    if (string == nullptr) {
        if (status == MAL_UTF8_DECODE_LENGTH_OVERFLOW)
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, (const byte *) "C string is too large");
        else mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    return mal_value_from_string(string);
}

MalValue mal_ffi_from_fixed_string(MalVm *vm, const void *value, size_t capacity) {
    const void *end = memchr(value, 0, capacity);
    if (end == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "C string has no terminator within its array bound");
        return mal_value_new_undefined();
    }
    return mal_ffi_from_string_length(vm, value, (const byte *) end - (const byte *) value);
}

MalFfiCopyStatus mal_ffi_copy_callback_bytes(
    const void *source, uint64_t length, bool text, void **out) {
    *out = nullptr;
    if (source == nullptr) return MAL_FFI_COPY_OK;
    uint64_t limit = text ? UINT64_C(3) * MAL_STRING_MAX_CODE_UNITS : INT32_MAX;
    if (length > limit || length > SIZE_MAX) return MAL_FFI_COPY_RANGE;
    void *copy = malloc(length == 0 ? 1 : (size_t) length);
    if (copy == nullptr) return MAL_FFI_COPY_MEMORY;
    memcpy(copy, source, (size_t) length);
    *out = copy;
    return MAL_FFI_COPY_OK;
}

MalFfiCopyStatus mal_ffi_copy_callback_array(
    const void *source, uint64_t length, size_t stride, size_t alignment, void **out) {
    *out = nullptr;
    if (source == nullptr) return MAL_FFI_COPY_OK;
    if (length > INT32_MAX || stride == 0 || length > SIZE_MAX / stride)
        return MAL_FFI_COPY_RANGE;
    void *copy = mal_ffi_allocate_storage(length == 0 ? 1 : (size_t) length, stride, alignment);
    if (copy == nullptr) return MAL_FFI_COPY_MEMORY;
    if (length > 0) memcpy(copy, source, (size_t) length * stride);
    *out = copy;
    return MAL_FFI_COPY_OK;
}

MalFfiCopyStatus mal_ffi_copy_callback_strings(
    const void *source, uint64_t length, size_t stride, size_t alignment, void **out) {
    *out = nullptr;
    if (source == nullptr) return MAL_FFI_COPY_OK;
    if (length > INT32_MAX || stride == 0 || stride % sizeof(const char *) != 0 || length > SIZE_MAX / stride)
        return MAL_FFI_COPY_RANGE;
    size_t table_size = (size_t) length * stride;
    size_t pointers = table_size / sizeof(const char *);
    size_t total = table_size;
    for (size_t i = 0; i < pointers; i++) {
        const char *text;
        memcpy(&text, (const byte *) source + i * sizeof(text), sizeof(text));
        if (text == nullptr) continue;
        size_t bytes = strlen(text);
        if ((u64) bytes > UINT64_C(3) * MAL_STRING_MAX_CODE_UNITS || bytes >= SIZE_MAX - total)
            return MAL_FFI_COPY_RANGE;
        total += bytes + 1;
    }
    byte *copy = mal_ffi_allocate_storage(1, total == 0 ? 1 : total, alignment);
    if (copy == nullptr) return MAL_FFI_COPY_MEMORY;
    byte *next = copy + table_size;
    // The C caller keeps the source stable until this callback returns, across both passes.
    for (size_t i = 0; i < pointers; i++) {
        const char *text;
        memcpy(&text, (const byte *) source + i * sizeof(text), sizeof(text));
        const char *stored = nullptr;
        if (text != nullptr) {
            size_t bytes = strlen(text) + 1;
            memcpy(next, text, bytes);
            stored = (const char *) next;
            next += bytes;
        }
        memcpy(copy + i * sizeof(stored), &stored, sizeof(stored));
    }
    *out = copy;
    return MAL_FFI_COPY_OK;
}

void mal_ffi_callback_copy_error(MalVm *vm, MalFfiCopyStatus status) {
    if (status == MAL_FFI_COPY_RANGE)
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "C callback count is out of range");
    else if (status == MAL_FFI_COPY_MEMORY) mal_vm_throw_allocation_error(vm);
}

MalValue mal_ffi_from_bytes(MalVm *vm, const void *data, size_t length) {
    if (length > UINT32_MAX) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, (const byte *) "C buffer is too large");
        return mal_value_new_undefined();
    }
    MalArrayBufferObject *buffer = mal_array_buffer_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        (u32) length, (u32) length, false, false);
    if (length > 0) memcpy(buffer->data, data, length);
    MalValue buffer_value = mal_value_from_array_buffer_object(buffer);
    MalRootSpan root;
    mal_gc_root(&root, &buffer_value, 1);
    MalTypedArrayObject *array = mal_typed_array_object_new(
        &vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]), buffer,
        MAL_TA_UINT8, 0, (u32) length, false);
    mal_gc_unroot(&root);
    return mal_value_from_typed_array_object(array);
}

typedef struct MalFfiGlobalStorage {
    const void *key;
    const void *count_key;
    void *data;
    size_t capacity;
    bool text;
    struct MalFfiGlobalStorage *next;
} MalFfiGlobalStorage;

/* C globals outlive individual isolates. This registry owns only malloc storage;
 * its lock serializes binding access, while C readers require library synchronization. */
static pthread_mutex_t ffi_global_lock = PTHREAD_MUTEX_INITIALIZER;
static MalFfiGlobalStorage *ffi_globals;

void mal_ffi_read_global_count(void (*read)(void *out), void *out) {
    pthread_mutex_lock(&ffi_global_lock);
    read(out);
    pthread_mutex_unlock(&ffi_global_lock);
}

MalValue mal_ffi_get_global_value(MalVm *vm, const MalFfiGlobal *global, const MalFfiSite *site) {
    void *data = nullptr;
    void *copy = nullptr;
    size_t length = 0;
    const char *error = nullptr;
    bool memory = false;
    pthread_mutex_lock(&ffi_global_lock);
    MalFfiGlobalStorage *stored = ffi_globals;
    while (stored != nullptr && stored->key != global->key) stored = stored->next;
    if (stored != nullptr && (stored->text != global->text || stored->count_key != global->count_key))
        error = "the retained global's original representation";
    else if (!global->read(&data, &length)) error = "a non-negative native byte count";
    else if (data == nullptr) {
        if (length != 0) error = "a null pointer with zero byte count";
    } else {
        size_t remaining = 0;
        if (stored != nullptr) {
            uintptr_t start = (uintptr_t) stored->data;
            uintptr_t pointer = (uintptr_t) data;
            if (pointer < start || pointer - start > stored->capacity)
                error = "a pointer within the retained allocation";
            else remaining = stored->capacity - (pointer - start);
        }
        if (error == nullptr && global->text) {
            if (stored == nullptr) length = strlen(data);
            else {
                const char *end = memchr(data, 0, remaining);
                if (end == nullptr) error = "NUL-terminated text within the retained allocation";
                else length = (size_t) (end - (const char *) data);
            }
        } else if (error == nullptr && stored != nullptr && length > remaining)
            error = "a byte count within the retained allocation";
        if (error == nullptr && length > (global->text ? UINT64_C(3) * MAL_STRING_MAX_CODE_UNITS : UINT32_MAX))
            error = "a byte count within JavaScript storage limits";
        if (error == nullptr) {
            copy = malloc(length == 0 ? 1 : length);
            if (copy == nullptr) memory = true;
            else if (length > 0) memcpy(copy, data, length);
        }
    }
    pthread_mutex_unlock(&ffi_global_lock);
    if (error != nullptr) {
        ffi_fail(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site, error);
        return mal_value_new_undefined();
    }
    if (memory) {
        mal_ffi_out_of_memory(vm);
        return mal_value_new_undefined();
    }
    if (data == nullptr) return mal_value_new_null();
    MalValue result = global->text ? mal_ffi_from_string_length(vm, copy, length)
                                   : mal_ffi_from_bytes(vm, copy, length);
    free(copy);
    return result;
}

bool mal_ffi_set_global_value(MalVm *vm, const MalFfiGlobal *global, MalValue value, const MalFfiSite *site) {
    void *copy = nullptr;
    size_t length = 0;
    if (!mal_value_is_null(value)) {
        if (global->text) {
            char *text;
            if (!mal_ffi_to_owned_string(vm, value, site, &text)) return false;
            copy = text;
            length = strlen(text);
        } else {
            void *data;
            if (!mal_ffi_to_bytes(vm, value, false, false, site, &data, &length, nullptr)) return false;
            if (!mal_ffi_check_count(vm, length, global->count_bits, global->count_signed, site)) return false;
            copy = malloc(length == 0 ? 1 : length);
            if (copy == nullptr) return mal_ffi_out_of_memory(vm);
            if (length > 0) memcpy(copy, data, length);
        }
    }
    MalFfiGlobalStorage *candidate = copy == nullptr ? nullptr : malloc(sizeof(*candidate));
    if (copy != nullptr && candidate == nullptr) {
        free(copy);
        return mal_ffi_out_of_memory(vm);
    }
    const char *error = nullptr;
    void *previous = nullptr;
    pthread_mutex_lock(&ffi_global_lock);
    MalFfiGlobalStorage **link = &ffi_globals;
    while (*link != nullptr && (*link)->key != global->key) link = &(*link)->next;
    MalFfiGlobalStorage *stored = *link;
    if (stored != nullptr && (stored->text != global->text || stored->count_key != global->count_key))
        error = "the retained global's original representation";
    for (MalFfiGlobalStorage *other = ffi_globals; error == nullptr && other != nullptr; other = other->next)
        if (global->count_key != nullptr && other->key != global->key && other->count_key == global->count_key)
            error = "a count belonging exclusively to one retained pointer";
    if (error == nullptr) {
        global->write(copy, length);
        if (stored != nullptr) previous = stored->data;
        if (copy == nullptr) {
            if (stored != nullptr) {
                *link = stored->next;
                free(stored);
            }
        } else {
            if (stored == nullptr) {
                stored = candidate;
                candidate = nullptr;
                stored->next = *link;
                *link = stored;
            }
            stored->key = global->key;
            stored->count_key = global->count_key;
            stored->data = copy;
            stored->capacity = length + (global->text ? 1 : 0);
            stored->text = global->text;
            copy = nullptr;
        }
    }
    pthread_mutex_unlock(&ffi_global_lock);
    free(previous);
    free(candidate);
    free(copy);
    return error == nullptr || mal_ffi_expected(vm, site, error);
}

typedef struct MalFfiState MalFfiState;

typedef struct MalFfiHandleView {
    const MalFfiHandleType *type;
    struct MalFfiHandleView *next;
} MalFfiHandleView;

typedef struct MalFfiRetainedField {
    MalValue buffer;
    MalArrayBufferPin *pin;
    void *data;
    usize length;
} MalFfiRetainedField;

typedef struct MalFfiNativeHandle {
    struct MalFfiNativeHandle *next;
    struct MalFfiNativeHandle *retired_next;
    MalFfiState *registry;
    MalValue wrapper;
    _Atomic u32 references;
    /** Input registrations protect lifetime while leaving callables usable. */
    _Atomic u32 results;
    /** These input leases are reachable through the destruction root, not global GC roots. */
    _Atomic u32 contained;
    /** Registrations never retain this native owner back through its reference count. */
    struct MalFfiKept *callbacks;
    void *value;
    const MalFfiHandleType *owner_type;
    MalArrayBufferStoreLease **stores;
    i32 store_count;
    bool owned;
    bool owns_storage;
    /** Failed delivery follows last lease release regardless of collection policy. */
    bool force_destroy;
    bool retired;
    bool destroying;
    bool superseded;
    bool registration_owner;
} MalFfiNativeHandle;

static void ffi_native_handle_drop(MalFfiNativeHandle *handle, bool result);
static void ffi_owner_finish(MalFfiNativeHandle *owner, bool released);

enum {
    MAL_FFI_HANDLE_BORROWED,
    MAL_FFI_HANDLE_OWNED,
    MAL_FFI_HANDLE_CHILD,
    MAL_FFI_HANDLE_LIBRARY,
};

typedef struct MalFfiHandleObject {
    MalObject object;
    MalObjectStorage object_storage;
    const MalFfiHandleType *type;
    /** Resource ownership and a borrowed owner are exclusive; views preserve an acquired destruction policy. */
    union {
        const MalFfiHandleType *owner_type;
        struct MalFfiHandleObject *owner;
    };
    MalFfiHandleView *views;
    MalFfiRetainedField *retained;
    MalFfiNativeHandle *native;
    const void *operation;
    /** Stable C storage, or the library's pointer; null once closed. */
    void *value;
    u8 ownership;
    /** Outer storage belongs to this wrapper, independently of C resource ownership. */
    bool owns_storage;
    /** Cleanup is in progress; callbacks cannot use or close this resource. */
    bool closing;
    bool worker_closing;
    /** A result conversion still owns this resource's undelivered lifetime. */
    bool provisional;
    /** The table that finds this open pointer handle by its pointer, or null. */
    MalFfiState *registry;
    struct MalFfiHandleObject *worker_close_next;
    /** C calls using the handle; it cannot close while any are. */
    u32 pins;
    /** Worker calls may mutate storage concurrently with JavaScript field reads. */
    u32 worker_pins;
    /**
     * The callback invocation this borrowed argument belongs to, or 0 for a handle
     * the program holds. Once that invocation returns the handle reads as closed:
     * the library only lent the resource for the callback.
     */
    u64 scope;
} MalFfiHandleObject;

typedef struct MalFfiClose {
    struct MalFfiClose *next;
    const void *site;
    MalFfiCallback *callback;
    void *key;
    MalValue handle;
    const void *operation;
    u64 scope;
    void *storage;
    MalArrayBufferStoreLease **stores;
    i32 store_count;
    u64 callback_identity;
    bool committed;
} MalFfiClose;

typedef struct MalFfiAsyncGroup {
    _Atomic u32 references;
    MalVm *vm;
    MalValue error;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
    bool failed;
    bool active;
} MalFfiAsyncGroup;

static MAL_ISOLATE_LOCAL MalFfiAsyncGroup *ffi_worker_group;

static void ffi_group_release(MalFfiAsyncGroup *group) {
    if (group != nullptr
        && atomic_fetch_sub_explicit(&group->references, 1, memory_order_acq_rel) == 1)
        free(group);
}

/** A kept callback; trampolines receive a pointer to `callback`, its first member. */
typedef struct MalFfiKept {
    MalFfiCallback callback;
    MalFfiNativeHandle *owner;
    struct MalFfiKept *owner_previous;
    struct MalFfiKept *owner_next;
    bool release_requested;
    /** The element of the VM's kept-function holder that roots `callback.function`. */
    u32 slot;
    pthread_t thread;
    struct MalFfiKept *previous;
    struct MalFfiKept *next;
    /** Link in the VM's queue of releases that arrived where the VM could not run them. */
    struct MalFfiKept *pending;
    /** The library may call from other threads; those calls queue for the VM thread. */
    bool queued;
    /** Released while calls still waited in the queue; the last of them completes it. */
    bool released;
    _Atomic u32 waiting;
    /** Queued messages can outlive both VM detach and C's final release. */
    _Atomic u32 references;
    MalFfiClose *close;
    /** Only its VM reads this association; worker posts carry a separate native reference. */
    MalFfiAsyncGroup *group;
} MalFfiKept;

static void ffi_close_free(MalFfiClose *close);
static void ffi_close_detach(MalFfiKept *kept);

static void ffi_kept_unref(MalFfiKept *kept) {
    if (atomic_fetch_sub_explicit(&kept->references, 1, memory_order_acq_rel) == 1) {
        mal_ffi_callback_results_free(&kept->callback);
        ffi_close_free(kept->close);
        free(kept);
    }
}

/**
 * Collected handles may release callbacks, whose VM roots can change only after
 * collection. A library callback cannot enter JavaScript while this is set.
 */
static _Thread_local bool ffi_finalizing;

typedef struct MalFfiHandleEntry {
    const MalFfiHandleType *type;
    void *pointer;
    /** Null for an empty slot. */
    union {
        MalFfiHandleObject *handle;
        u64 claim;
    };
} MalFfiHandleEntry;

struct MalFfiDiscardState {
    _Atomic u32 references;
    _Atomic bool frozen;
    MalFfiHandleEntry *claims;
    usize capacity;
};

enum {
    MAL_FFI_ASYNC_QUEUED,
    MAL_FFI_ASYNC_RUNNING,
    MAL_FFI_ASYNC_FINISHED,
    MAL_FFI_ASYNC_CANCELLED,
};

typedef struct MalFfiAsyncPayload {
    struct MalFfiAsyncPayload *next;
    _Atomic u32 references;
    _Atomic int phase;
    bool must_run;
    void *data;
    MalFfiAsyncRun run;
    MalFfiAsyncRelease release;
    MalFfiAsyncGroup *group;
    MalFfiCallback **callbacks;
    i32 callback_count;
} MalFfiAsyncPayload;
static void ffi_async_release(void *data);
static void ffi_async_cancel_queued(MalVm *vm);

/**
 * Per-VM binding state: the shape each record type's objects share, indexed by the
 * type's slot, and the open handle of each pointer, so a library returning a pointer
 * twice yields one handle. Handle entries are weak; a handle leaves the table when
 * it closes or is collected.
 */
struct MalFfiState {
    MalShape **shapes;
    usize shape_capacity;
    /** Open addressing with linear probing; capacity is zero or a power of two. */
    MalFfiHandleEntry *handles;
    usize handle_count;
    usize handle_capacity;
    /** Weak subset of registered handles whose worker close or initialization is unsettled. */
    MalFfiHandleObject *worker_closes;
    /** Callbacks libraries still hold, and the kept-function holder's reusable slots. */
    MalFfiKept *kept;
    /** Releases from a collection or another thread, run on the VM thread later. */
    _Atomic(MalFfiKept *) pending_releases;
    /** Callback invocations in progress, innermost last, numbered from 1. */
    u64 *invocations;
    usize invocation_depth;
    usize invocation_capacity;
    u64 last_invocation;
    /**
     * The host operation other threads post queued callback calls to, open while any
     * kept callback accepts them, so the event loop waits for their calls.
     */
    MalHostHandle inbox;
    u32 inbox_users;
    u32 kept_slots;
    u32 *free_slots;
    u32 free_count;
    u32 free_capacity;
    bool accepting_waits;
    /** Whether the runtime cleanup that drops pending async calls is registered. */
    bool async_cleanup;
    MalFfiAsyncPayload *retired_async;
    MalFfiNativeHandle *native_handles;
    MalFfiDiscardState *discards;
    MalFfiResults *results;
    /** An active call owns its numeric block independently of this idle slot. */
    void *scratch_data;
    size_t scratch_capacity;
};

static void ffi_discards_freeze(MalVm *vm, MalFfiState *state);

static void ffi_discards_drop(MalFfiDiscardState *state) {
    if (state != nullptr
        && atomic_fetch_sub_explicit(&state->references, 1, memory_order_acq_rel) == 1) {
        free(state->claims);
        free(state);
    }
}

/**
 * Orders other threads' posts to a VM's inbox against its teardown: they post under
 * the lock while the context still names its VM, and teardown detaches under it.
 */
static pthread_mutex_t ffi_queue_lock = PTHREAD_MUTEX_INITIALIZER;
static MalFfiClose *ffi_closes;

struct MalFfiWait {
    struct MalFfiWait *next;
    /** Comparison key only: the request may outlive both VM and callback context. */
    MalVm *vm;
    pthread_cond_t changed;
    u32 references;
    bool done;
    bool succeeded;
    void *message;
    MalFfiQueuedFree free;
};

static MalFfiWait *ffi_waiters;

static void ffi_wait_finish(MalFfiWait *wait, bool succeeded) {
    pthread_mutex_lock(&ffi_queue_lock);
    if (!wait->done) {
        wait->done = true;
        wait->succeeded = succeeded;
        pthread_cond_signal(&wait->changed);
    }
    pthread_mutex_unlock(&ffi_queue_lock);
}

void mal_ffi_callback_wait_release(MalFfiWait *wait) {
    if (wait == nullptr) return;
    pthread_mutex_lock(&ffi_queue_lock);
    bool last = --wait->references == 0;
    if (last) {
        MalFfiWait **link = &ffi_waiters;
        while (*link != wait) link = &(*link)->next;
        *link = wait->next;
    }
    pthread_mutex_unlock(&ffi_queue_lock);
    if (last) {
        pthread_cond_destroy(&wait->changed);
        wait->free(wait->message);
        free(wait);
    }
}

void mal_ffi_callbacks_shutdown(MalVm *vm) {
    // Unblocking producers must not let queued calls acquire new C-side ownership.
    ffi_async_cancel_queued(vm);
    pthread_mutex_lock(&ffi_queue_lock);
    if (vm->ffi != nullptr) vm->ffi->accepting_waits = false;
    for (MalFfiWait *wait = ffi_waiters; wait != nullptr; wait = wait->next) {
        if (wait->vm != vm || wait->done) continue;
        wait->done = true;
        pthread_cond_signal(&wait->changed);
    }
    pthread_mutex_unlock(&ffi_queue_lock);
}

static void ffi_state_free(MalVm *vm) {
    MalFfiState *state = vm->ffi;
    if (state == nullptr) return;
    mal_ffi_callbacks_shutdown(vm);
    // Teardown finalizers run after this, so the handles must forget the table first.
    for (usize index = 0; index < state->handle_capacity; index++) {
        if (state->handles[index].handle != nullptr) state->handles[index].handle->registry = nullptr;
    }
    for (MalFfiNativeHandle *native = state->native_handles; native != nullptr; native = native->next)
        native->registry = nullptr;
    // Libraries may still hold kept callbacks and release them later: detach instead
    // of freeing, so a late call finds no VM and a late release frees the context.
    pthread_mutex_lock(&ffi_queue_lock);
    MalFfiKept *retired = nullptr;
    for (MalFfiKept *kept = state->kept; kept != nullptr;) {
        MalFfiKept *next = kept->next;
        ffi_close_detach(kept);
        kept->callback.vm = nullptr;
        // A live VM kept this released context rooted until its queued calls retired.
        if (kept->released) {
            kept->next = retired;
            retired = kept;
        }
        kept = next;
    }
    pthread_mutex_unlock(&ffi_queue_lock);
    while (retired != nullptr) {
        MalFfiKept *next = retired->next;
        ffi_kept_unref(retired);
        retired = next;
    }
    // Contexts the library already released only wait for this VM; nothing holds them.
    MalFfiKept *pending = atomic_exchange(&state->pending_releases, nullptr);
    while (pending != nullptr) {
        MalFfiKept *next = pending->pending;
        ffi_kept_unref(pending);
        pending = next;
    }
    ffi_discards_freeze(vm, state);
    // Unobserved native results can call destructors; every callback must be detached first.
    while (state->retired_async != nullptr) {
        MalFfiAsyncPayload *payload = state->retired_async;
        state->retired_async = payload->next;
        ffi_async_release(payload);
    }
    free(state->free_slots);
    free(state->invocations);
    free(state->handles);
    ffi_discards_drop(state->discards);
    free(state->shapes);
    free(state->scratch_data);
    free(state);
    vm->ffi = nullptr;
}

static MalFfiState *ffi_state(MalVm *vm) {
    if (vm->ffi != nullptr) return vm->ffi;
    MalFfiState *state = calloc(1, sizeof(*state));
    if (state == nullptr || !mal_vm_register_runtime_cleanup(vm, ffi_state_free)) {
        free(state);
        return nullptr;
    }
    vm->ffi = state;
    state->accepting_waits = true;
    return state;
}

static const MalFfiHandleType *ffi_handle_family(const MalFfiHandleType *type) {
    return type->family == nullptr ? type : type->family;
}

static pthread_mutex_t ffi_retired_lock = PTHREAD_MUTEX_INITIALIZER;
static _Atomic(MalFfiNativeHandle *) ffi_retired_handles;

static bool ffi_retired_blocks(const MalFfiHandleType *type, const void *value, bool fresh) {
    if (value == nullptr || atomic_load_explicit(&ffi_retired_handles, memory_order_acquire) == nullptr)
        return false;
    const MalFfiHandleType *family = ffi_handle_family(type);
    bool found = false;
    pthread_mutex_lock(&ffi_retired_lock);
    for (MalFfiNativeHandle *native = atomic_load_explicit(&ffi_retired_handles, memory_order_relaxed);
         native != nullptr; native = native->retired_next) {
        if (!native->superseded && native->value == value
            && ffi_handle_family(native->owner_type) == family
            && (!fresh || !native->destroying)) {
            found = true;
            break;
        }
    }
    if (!found && fresh) {
        // C can return a new lifetime at this address before an older destructor returns.
        for (MalFfiNativeHandle *native = atomic_load_explicit(&ffi_retired_handles, memory_order_relaxed);
             native != nullptr; native = native->retired_next)
            if (native->value == value && ffi_handle_family(native->owner_type) == family)
                native->superseded = true;
    }
    pthread_mutex_unlock(&ffi_retired_lock);
    return found;
}

static bool ffi_retired_guard(MalVm *vm, const MalFfiHandleType *type, void *value, bool fresh) {
    if (!ffi_retired_blocks(type, value, fresh)) return true;
    if (!mal_ffi_threw(vm))
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "A C result resource is awaiting native lease cleanup");
    return false;
}

static void ffi_retired_register(MalFfiNativeHandle *native) {
    // The detached lease must remain discoverable after its VM and wrapper disappear.
    native->wrapper = mal_value_new_undefined();
    native->retired = true;
    pthread_mutex_lock(&ffi_retired_lock);
    native->retired_next = atomic_load_explicit(&ffi_retired_handles, memory_order_relaxed);
    atomic_store_explicit(&ffi_retired_handles, native, memory_order_release);
    pthread_mutex_unlock(&ffi_retired_lock);
}

static void ffi_retired_unregister(MalFfiNativeHandle *native) {
    pthread_mutex_lock(&ffi_retired_lock);
    MalFfiNativeHandle *previous = nullptr;
    MalFfiNativeHandle *entry = atomic_load_explicit(&ffi_retired_handles, memory_order_relaxed);
    while (entry != native) {
        previous = entry;
        entry = entry->retired_next;
    }
    if (previous == nullptr)
        atomic_store_explicit(&ffi_retired_handles, native->retired_next, memory_order_release);
    else previous->retired_next = native->retired_next;
    pthread_mutex_unlock(&ffi_retired_lock);
}

static usize ffi_handle_slot(const MalFfiHandleType *type, const void *pointer, usize capacity) {
    u64 key = (u64) (uptr) pointer ^ ((u64) (uptr) type * UINT64_C(0x9E3779B97F4A7C15));
    key ^= key >> 29;
    key *= UINT64_C(0xBF58476D1CE4E5B9);
    key ^= key >> 32;
    return (usize) key & (capacity - 1);
}

typedef struct MalFfiLibraryClaim {
    _Atomic(const MalFfiHandleType *) family;
    const void *value;
} MalFfiLibraryClaim;

typedef struct MalFfiLibraryClaims {
    struct MalFfiLibraryClaims *previous;
    usize capacity;
    usize count;
    MalFfiLibraryClaim entries[];
} MalFfiLibraryClaims;

static _Atomic(MalFfiLibraryClaims *) ffi_library_claims;
static pthread_mutex_t ffi_library_claim_lock = PTHREAD_MUTEX_INITIALIZER;

static bool ffi_library_claim_find(
    const MalFfiLibraryClaims *claims, const MalFfiHandleType *family, const void *value) {
    for (usize slot = ffi_handle_slot(family, value, claims->capacity);;
         slot = (slot + 1) & (claims->capacity - 1)) {
        const MalFfiLibraryClaim *entry = &claims->entries[slot];
        const MalFfiHandleType *found = atomic_load_explicit(&entry->family, memory_order_acquire);
        if (found == nullptr) return false;
        if (found == family && entry->value == value) return true;
    }
}

bool mal_ffi_is_library_resource(const MalFfiHandleType *type, const void *value) {
    if (!type->library_lifetime || value == nullptr) return false;
    MalFfiLibraryClaims *claims = atomic_load_explicit(&ffi_library_claims, memory_order_acquire);
    return claims != nullptr && ffi_library_claim_find(claims, ffi_handle_family(type), value);
}

static void ffi_library_claim_place(
    MalFfiLibraryClaims *claims, const MalFfiHandleType *family, const void *value) {
    usize slot = ffi_handle_slot(family, value, claims->capacity);
    while (atomic_load_explicit(&claims->entries[slot].family, memory_order_relaxed) != nullptr)
        slot = (slot + 1) & (claims->capacity - 1);
    claims->entries[slot].value = value;
    atomic_store_explicit(&claims->entries[slot].family, family, memory_order_release);
    claims->count++;
}

static bool ffi_library_claim_add(MalVm *vm, const MalFfiHandleType *type, const void *value) {
    const MalFfiHandleType *family = ffi_handle_family(type);
    pthread_mutex_lock(&ffi_library_claim_lock);
    MalFfiLibraryClaims *claims = atomic_load_explicit(&ffi_library_claims, memory_order_relaxed);
    if (claims != nullptr && ffi_library_claim_find(claims, family, value)) {
        pthread_mutex_unlock(&ffi_library_claim_lock);
        return true;
    }
    if (claims == nullptr || claims->count >= claims->capacity - claims->capacity / 4) {
        usize capacity = claims == nullptr ? 64 : claims->capacity;
        if (claims != nullptr) {
            if (capacity > SIZE_MAX / 2) goto mal_allocation_failed;
            capacity *= 2;
        }
        if (capacity > (SIZE_MAX - sizeof(MalFfiLibraryClaims)) / sizeof(MalFfiLibraryClaim))
            goto mal_allocation_failed;
        MalFfiLibraryClaims *grown = calloc(1, sizeof(*grown) + capacity * sizeof(MalFfiLibraryClaim));
        if (grown == nullptr) goto mal_allocation_failed;
        grown->capacity = capacity;
        for (usize index = 0; index < capacity; index++) atomic_init(&grown->entries[index].family, nullptr);
        if (claims != nullptr)
            for (usize index = 0; index < claims->capacity; index++) {
                const MalFfiLibraryClaim *entry = &claims->entries[index];
                const MalFfiHandleType *found = atomic_load_explicit(&entry->family, memory_order_relaxed);
                if (found != nullptr) ffi_library_claim_place(grown, found, entry->value);
            }
        // Claims last for the process. Keeping prior tables lets native cleanup read
        // them without a VM, a lock, or a reclamation race while another VM grows it.
        grown->previous = claims;
        atomic_store_explicit(&ffi_library_claims, grown, memory_order_release);
        claims = grown;
    }
    ffi_library_claim_place(claims, family, value);
    pthread_mutex_unlock(&ffi_library_claim_lock);
    return true;
mal_allocation_failed:
    pthread_mutex_unlock(&ffi_library_claim_lock);
    return mal_ffi_out_of_memory(vm);
}

static MalFfiHandleObject *ffi_handle_find(
    MalFfiState *state, const MalFfiHandleType *type, const void *pointer) {
    if (state->handle_capacity == 0) return nullptr;
    for (usize slot = ffi_handle_slot(type, pointer, state->handle_capacity);;
         slot = (slot + 1) & (state->handle_capacity - 1)) {
        MalFfiHandleEntry *entry = &state->handles[slot];
        if (entry->handle == nullptr) return nullptr;
        if (entry->type == type && entry->pointer == pointer) return entry->handle;
    }
}

static void ffi_handle_place(MalFfiState *state, MalFfiHandleEntry entry) {
    usize slot = ffi_handle_slot(entry.type, entry.pointer, state->handle_capacity);
    while (state->handles[slot].handle != nullptr) slot = (slot + 1) & (state->handle_capacity - 1);
    state->handles[slot] = entry;
}

/** An open pointer must be registered before C can hand out an alias to it. */
static bool ffi_handle_register(MalFfiState *state, MalFfiHandleObject *handle) {
    if ((state->handle_count + 1) * 2 > state->handle_capacity) {
        usize capacity = state->handle_capacity == 0 ? 16 : state->handle_capacity * 2;
        MalFfiHandleEntry *grown = calloc(capacity, sizeof(*grown));
        if (grown == nullptr) return false;
        MalFfiHandleEntry *previous = state->handles;
        usize previous_capacity = state->handle_capacity;
        state->handles = grown;
        state->handle_capacity = capacity;
        for (usize index = 0; index < previous_capacity; index++) {
            if (previous[index].handle != nullptr) ffi_handle_place(state, previous[index]);
        }
        free(previous);
    }
    ffi_handle_place(state, (MalFfiHandleEntry) {
        .type = ffi_handle_family(handle->type), .pointer = handle->value, .handle = handle});
    state->handle_count++;
    handle->registry = state;
    return true;
}

static void ffi_worker_close_unlink(MalFfiHandleObject *handle) {
    MalFfiHandleObject **link = &handle->registry->worker_closes;
    while (*link != handle) link = &(*link)->worker_close_next;
    *link = handle->worker_close_next;
    handle->worker_close_next = nullptr;
}

static void ffi_handle_worker_closing(MalFfiHandleObject *handle, bool worker) {
    if (handle->worker_closing == worker) return;
    if (handle->registry != nullptr) {
        if (worker) {
            handle->worker_close_next = handle->registry->worker_closes;
            handle->registry->worker_closes = handle;
        } else ffi_worker_close_unlink(handle);
    }
    handle->worker_closing = worker;
}

/** Remove a handle's entry, shifting later probes back so lookups stay correct. */
static void ffi_handle_unregister(MalFfiHandleObject *handle) {
    MalFfiState *state = handle->registry;
    if (state == nullptr) return;
    // Fresh address reuse retires the guard before the old worker completion unpins its handle.
    if (handle->worker_closing) ffi_worker_close_unlink(handle);
    handle->registry = nullptr;
    usize mask = state->handle_capacity - 1;
    usize slot = ffi_handle_slot(ffi_handle_family(handle->type), handle->value, state->handle_capacity);
    while (state->handles[slot].handle != handle) slot = (slot + 1) & mask;
    state->handles[slot] = (MalFfiHandleEntry) {0};
    state->handle_count--;
    for (usize next = (slot + 1) & mask; state->handles[next].handle != nullptr;
         next = (next + 1) & mask) {
        MalFfiHandleEntry entry = state->handles[next];
        state->handles[next] = (MalFfiHandleEntry) {0};
        ffi_handle_place(state, entry);
    }
}

static MalFfiHandleObject *ffi_handle(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_FFI_HANDLE_OBJECT)
        ? (MalFfiHandleObject *) mal_value_to_object(value)
        : nullptr;
}

static MalFfiHandleObject *ffi_handle_owner(MalFfiHandleObject *handle) {
    return handle->ownership == MAL_FFI_HANDLE_CHILD ? handle->owner : nullptr;
}

static const MalFfiHandleType *ffi_handle_policy(MalFfiHandleObject *handle) {
    return handle->ownership == MAL_FFI_HANDLE_CHILD ? handle->type : handle->owner_type;
}

static bool ffi_store(MalVm *vm, MalValue target, MalKey key, MalValue value) {
    if (!mal_object_set(mal_value_to_object(target), key, value)) {
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    return true;
}

static bool ffi_set_field(MalVm *vm, MalValue record, const char *name, MalValue value) {
    MalValue held[2] = {record, value};
    MalRootSpan root;
    mal_gc_root(&root, held, 2);
    MalKey key = mal_intrinsic_string_key(vm, (const byte *) name);
    bool stored = ffi_store(vm, held[0], key, held[1]);
    mal_gc_unroot(&root);
    return stored;
}

/** The last slot handed to a record type; slots are process-wide and never reused. */
static _Atomic i32 ffi_record_slots;

/** Slots are plain numbers that publish nothing else, so relaxed ordering suffices. */
static i32 ffi_record_slot(MalFfiRecordType *type) {
    i32 slot = atomic_load_explicit(&type->slot, memory_order_relaxed);
    if (slot != 0) return slot;
    i32 fresh = atomic_fetch_add_explicit(&ffi_record_slots, 1, memory_order_relaxed) + 1;
    // Another VM thread may number the type first; both then use its slot.
    if (atomic_compare_exchange_strong_explicit(
            &type->slot, &slot, fresh, memory_order_relaxed, memory_order_relaxed)) {
        return fresh;
    }
    return slot;
}

/**
 * Create the shape of `type`'s objects on a VM's first use. Kept out of line: its
 * key buffer would give every lookup a large, canary-checked frame.
 */
static __attribute__((noinline)) MalShape *ffi_record_shape_create(MalVm *vm, MalFfiRecordType *type, i32 slot) {
    MalFfiState *state = ffi_state(vm);
    if (state == nullptr) return nullptr;
    if ((usize) slot >= state->shape_capacity) {
        usize capacity = state->shape_capacity == 0 ? 16 : state->shape_capacity;
        while (capacity <= (usize) slot) capacity *= 2;
        MalShape **grown = realloc(state->shapes, capacity * sizeof(*grown));
        if (grown == nullptr) return nullptr;
        memset(grown + state->shape_capacity, 0, (capacity - state->shape_capacity) * sizeof(*grown));
        state->shapes = grown;
        state->shape_capacity = capacity;
    }
    // Wide structs get their keys from the heap, so the shape exists for any of them.
    MalString *inline_keys[64];
    MalString **keys = type->field_count <= (i32) countof(inline_keys)
        ? inline_keys
        : malloc(sizeof(*keys) * (usize) type->field_count);
    if (keys == nullptr) return nullptr;
    for (i32 index = 0; index < type->field_count; index++) {
        keys[index] = mal_intrinsic_ascii(vm, (const byte *) type->fields[index]);
    }
    MalShape *shape = mal_shape_from_string_keys(&vm->heap, keys, (u32) type->field_count);
    if (keys != inline_keys) free(keys);
    state->shapes[slot] = shape;
    return shape;
}

/** The shape of `type`'s objects; shapes live as long as the heap's transition tree. */
static inline MalShape *ffi_record_shape(MalVm *vm, MalFfiRecordType *type) {
    MalFfiState *state = vm->ffi;
    i32 slot = ffi_record_slot(type);
    if (state != nullptr && (usize) slot < state->shape_capacity && state->shapes[slot] != nullptr) {
        return state->shapes[slot];
    }
    return ffi_record_shape_create(vm, type, slot);
}

bool mal_ffi_record_fields(
    MalVm *vm, MalValue record, MalFfiRecordType *type, const MalFfiSite *site,
    MalValue *values) {
    if (mal_value_is_heap_type(record, MAL_HEAP_OBJECT)) {
        MalObject *object = mal_value_to_object(record);
        MalShape *shape = ffi_record_shape(vm, type);
        if (shape != nullptr && object->shape == shape) {
            const MalValue *fields = mal_object_fields_nonempty(object);
            for (i32 index = 0; index < type->field_count; index++) values[index] = fields[index];
            return true;
        }
    }
    if (!mal_value_is_object(record)) {
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "an object");
    }
    for (i32 index = 0; index < type->field_count; index++) {
        if (!mal_vm_get_static(vm, record, (const byte *) type->fields[index], &values[index])) {
            return false;
        }
    }
    return true;
}

/**
 * Read a record's immediate fields into `leaves`, depth first. Returns the position
 * after them, or null when some level lacks its record's shape.
 */
static MalValue *ffi_record_leaves(
    MalVm *vm, MalValue record, MalFfiRecordType *type, MalValue *leaves) {
    if (!mal_value_is_heap_type(record, MAL_HEAP_OBJECT)) return nullptr;
    MalObject *object = mal_value_to_object(record);
    MalShape *shape = ffi_record_shape(vm, type);
    if (shape == nullptr || object->shape != shape) return nullptr;
    // The shape proves every field is an own slot; a record has at least one.
    const MalValue *fields = mal_object_fields_nonempty(object);
    i32 count = type->field_count;
    MalFfiRecordType *const *nested = type->nested;
    for (i32 index = 0; index < count; index++) {
        MalFfiRecordType *inner = nested == nullptr ? nullptr : nested[index];
        if (inner == nullptr) *leaves++ = fields[index];
        else if ((leaves = ffi_record_leaves(vm, fields[index], inner, leaves)) == nullptr) {
            return nullptr;
        }
    }
    return leaves;
}

bool mal_ffi_record_leaves(MalVm *vm, MalValue record, MalFfiRecordType *type, MalValue *leaves) {
    return ffi_record_leaves(vm, record, type, leaves) != nullptr;
}

bool mal_ffi_try_record_elements(
    MalVm *vm, MalValue array, int32_t length, MalFfiRecordType *type,
    MalValue *values) {
    MalShape *shape = ffi_record_shape(vm, type);
    if (shape == nullptr || !mal_value_is_array_object(array)) return false;
    MalArrayObject *object = mal_value_to_array_object(array);
    if (mal_array_object_length(object) != (u32) length || object->elements == nullptr
        || object->dense_count < (u32) length) return false;
    const MalValue *dense = object->elements;
    i32 count = type->field_count;
    for (i32 index = 0; index < length; index++) {
        MalValue element = dense[index];
        if (mal_value_is_array_hole(element) || !mal_value_is_heap_type(element, MAL_HEAP_OBJECT)
            || mal_value_to_object(element)->shape != shape) return false;
        MalValue *fields = values + (usize) index * (usize) count;
        const MalValue *slots = mal_object_fields_nonempty(mal_value_to_object(element));
        for (i32 field = 0; field < count; field++) fields[field] = slots[field];
    }
    return true;
}

bool mal_ffi_stack_record(MalVm *vm, MalFfiRecordType *type, void *object, MalValue *slots) {
    MalShape *shape = ffi_record_shape(vm, type);
    if (shape == nullptr) return mal_ffi_out_of_memory(vm);
    mal_object_init_embedded_stack(
        &vm->heap, object, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]),
        shape, slots);
    return true;
}

MalValue mal_ffi_new_record(MalVm *vm, MalFfiRecordType *type, const MalValue *values) {
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]);
    MalShape *shape = ffi_record_shape(vm, type);
    if (shape != nullptr) {
        MalObject *object = mal_object_try_new_shaped(
            &vm->heap, prototype, shape, values, (u32) type->field_count);
        if (object == nullptr) {
            mal_vm_throw_allocation_error(vm);
            return mal_value_new_undefined();
        }
        return mal_value_from_object(object);
    }
    // A struct wider than the shape helper allows still gets an ordinary object.
    MalObject *object = mal_object_try_new(&vm->heap, prototype);
    if (object == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue record = mal_value_from_object(object);
    MalRootSpan root;
    mal_gc_root(&root, &record, 1);
    for (i32 index = 0; index < type->field_count && !mal_ffi_threw(vm); index++) {
        ffi_set_field(vm, record, type->fields[index], values[index]);
    }
    mal_gc_unroot(&root);
    return record;
}

MalValue mal_ffi_new_array(MalVm *vm, int32_t length) {
    return mal_value_from_array_object(mal_intrinsic_new_array(vm, (u32) length));
}

bool mal_ffi_set_element(MalVm *vm, MalValue array, int32_t index, MalValue value) {
    MalValue held[2] = {array, value};
    MalRootSpan root;
    mal_gc_root(&root, held, 2);
    bool stored = ffi_store(vm, held[0], mal_key_index((u32) index), held[1]);
    mal_gc_unroot(&root);
    return stored;
}

bool mal_ffi_threw(MalVm *vm) {
    return vm->completion.kind == MAL_COMPLETION_THROW;
}

bool mal_ffi_to_function(MalVm *vm, MalValue value, bool nullable, const MalFfiSite *site) {
    if ((nullable && mal_value_is_null(value)) || mal_value_is_callable(value)) return true;
    return ffi_fail(
        vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, nullable ? "a function or null" : "a function");
}

bool mal_ffi_call(
    MalVm *vm, MalValue function, const MalValue *args, int32_t count, MalValue *result) {
    MalCompletion completion =
        mal_vm_call_value(vm, function, mal_value_new_undefined(), args, count);
    if (completion.kind == MAL_COMPLETION_THROW) {
        vm->completion = completion;
        return false;
    }
    *result = completion.value;
    return true;
}

bool mal_ffi_out_of_memory(MalVm *vm) {
    mal_vm_throw_allocation_error(vm);
    return false;
}

MalValue mal_ffi_new_callable(
    MalVm *vm, const char *name, int32_t length, MalFfiFunction function,
    const void *target, size_t target_size, MalValue owner) {
    if (target_size > UINT32_MAX) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            (const byte *) "C function pointer representation is too large");
        return mal_value_new_undefined();
    }
    MalValue slots[2] = {mal_value_new_undefined(), owner};
    MalRootSpan root;
    mal_gc_root(&root, slots, 2);
    MalArrayBufferObject *buffer = mal_array_buffer_object_new_uninitialized(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
        (u32) target_size, (u32) target_size, false, false);
    memcpy(buffer->data, target, target_size);
    slots[0] = mal_value_from_array_buffer_object(buffer);
    MalNativeFunctionObject *callable = mal_native_function_object_new_with_slots_arity(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, (const byte *) name), length, function, slots, 2);
    mal_gc_unroot(&root);
    return mal_value_from_native_function_object(callable);
}

bool mal_ffi_callable_target(
    MalVm *vm, MalValue callee, MalFfiFunction function, void *target,
    size_t target_size, const MalFfiHandleType *owner_type, void **owner_pin, MalValue *owner_value,
    const MalFfiSite *site) {
    if (!mal_value_is_native_function_object(callee))
        return mal_ffi_expected(vm, site, "a native C function");
    MalNativeFunctionObject *callable = mal_value_to_native_function_object(callee);
    MalValue slot = mal_native_function_object_get_slot(callable, 0);
    if (callable->callback != function || !mal_value_is_array_buffer_object(slot))
        return mal_ffi_expected(vm, site, "a native C function");
    MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(slot);
    if (buffer->detached || buffer->shared || buffer->byte_length != target_size)
        return mal_ffi_expected(vm, site, "an intact C function pointer");
    memcpy(target, buffer->data, target_size);
    if (owner_type != nullptr) {
        MalValue owner = mal_native_function_object_get_slot(callable, 1);
        void *storage;
        if (!mal_ffi_to_handle(vm, owner, owner_type, false, site, &storage, nullptr)
            || !mal_ffi_handle_idle(vm, owner, site)) return false;
        if (!mal_ffi_to_handle(vm, owner, owner_type, false, site, &storage, owner_pin)) return false;
        *owner_value = owner;
        return true;
    }
    return true;
}

void mal_ffi_root(MalFfiRoots *roots, MalValue *slots, int32_t count) {
    mal_gc_root((MalRootSpan *) roots, slots, count);
}

void mal_ffi_unroot(MalFfiRoots *roots) {
    mal_gc_unroot((MalRootSpan *) roots);
}

/**
 * Values a VM materializes once per identity, so every image observes the same
 * function, constant, and handle prototype. Returns the cached value, or
 * undefined when `identity` has none yet.
 */
static bool ffi_prepared(MalVm *vm, const char *identity, MalValue *out) {
    for (MalPreparedValue *prepared = vm->prepared_values; prepared != nullptr;
         prepared = prepared->next) {
        if (strcmp(prepared->identity, identity) == 0) {
            *out = prepared->value;
            return true;
        }
    }
    return false;
}

/** Cache `value` under `identity`, taking ownership of the identity string. */
static bool ffi_prepare(MalVm *vm, char *identity, MalValue value) {
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    MalPreparedValue *prepared = calloc(1, sizeof(*prepared));
    char *data = strdup("");
    mal_gc_unroot(&root);
    if (prepared == nullptr || data == nullptr) {
        free(prepared);
        free(data);
        free(identity);
        mal_vm_throw_allocation_error(vm);
        return false;
    }
    prepared->identity = identity;
    prepared->data = data;
    prepared->value = value;
    prepared->next = vm->prepared_values;
    vm->prepared_values = prepared;
    return true;
}

/** The prepared value holding every kept callback's function, one per slot. */
static const char FFI_KEPT_IDENTITY[] = "maligator:ffi#kept";

void mal_ffi_callback_lost(void) {
    fputs(
        "maligator: a C library called a callback outside the call it was passed to, or from another thread\n",
        stderr);
    abort();
}

[[noreturn]] static void ffi_wrong_thread(void) {
    fputs("maligator: a C library called back into JavaScript from another thread\n", stderr);
    abort();
}

static void ffi_run_pending_releases(MalVm *vm);

static MAL_ISOLATE_LOCAL byte ffi_callback_thread;

void mal_ffi_callback_init(MalFfiCallback *callback, MalVm *vm, MalValue function) {
    callback->vm = vm;
    callback->function = function;
    callback->owner = mal_value_new_undefined();
    callback->thread_identity = &ffi_callback_thread;
    callback->results = nullptr;
    callback->inputs = nullptr;
    callback->results_accepting = true;
    callback->result_owner = nullptr;
}

typedef struct MalFfiResultCopy {
    struct MalFfiResultCopy *next;
    MalFfiNativeHandle *handle;
    bool contained;
    byte data[];
} MalFfiResultCopy;

void *mal_ffi_callback_result_copy(
    MalVm *vm, MalFfiCallback *callback, const void *source, size_t length, bool terminated,
    bool registration) {
    if (source == nullptr && length > 0) {
        mal_ffi_out_of_memory(vm);
        return nullptr;
    }
    usize capacity = length == 0 ? 1 : length;
    if (capacity > SIZE_MAX - sizeof(MalFfiResultCopy) - (terminated ? 1 : 0)) {
        mal_ffi_out_of_memory(vm);
        return nullptr;
    }
    MalFfiResultCopy *copy = malloc(sizeof(*copy) + capacity + (terminated ? 1 : 0));
    if (copy == nullptr) {
        mal_ffi_out_of_memory(vm);
        return nullptr;
    }
    if (length > 0) memcpy(copy->data, source, length);
    copy->handle = nullptr;
    if (terminated) copy->data[length] = 0;
    if (registration) pthread_mutex_lock(&ffi_queue_lock);
    if (registration && !callback->results_accepting) {
        pthread_mutex_unlock(&ffi_queue_lock);
        free(copy);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "A callback result cannot outlive its released registration");
        return nullptr;
    }
    copy->next = callback->results;
    callback->results = copy;
    if (registration) pthread_mutex_unlock(&ffi_queue_lock);
    return copy->data;
}

void mal_ffi_callback_results_free(MalFfiCallback *callback) {
    MalFfiResultCopy *lists[] = {callback->results, callback->inputs};
    callback->results = nullptr;
    callback->inputs = nullptr;
    for (usize index = 0; index < sizeof(lists) / sizeof(lists[0]); index++)
        for (MalFfiResultCopy *copy = lists[index]; copy != nullptr;) {
            MalFfiResultCopy *next = copy->next;
            if (copy->handle != nullptr) {
                if (copy->contained)
                    atomic_fetch_sub_explicit(&copy->handle->contained, 1, memory_order_acq_rel);
                ffi_native_handle_drop(copy->handle, index == 0);
            }
            free(copy);
            copy = next;
        }
}

MalFfiCallback *mal_ffi_keep(MalVm *vm, MalValue function) {
    MalValue held[2] = {function, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, held, 2);
    MalFfiState *state = ffi_state(vm);
    MalFfiKept *kept = calloc(1, sizeof(*kept));
    bool ready = state != nullptr && kept != nullptr;
    if (ready) ffi_run_pending_releases(vm);
    if (ready && !ffi_prepared(vm, FFI_KEPT_IDENTITY, &held[1])) {
        // A holder without a prototype, so no inherited setter can refuse a slot.
        held[1] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
        char *identity = strdup(FFI_KEPT_IDENTITY);
        ready = identity != nullptr && ffi_prepare(vm, identity, held[1]);
        if (identity == nullptr) mal_vm_throw_allocation_error(vm);
    }
    u32 slot = 0;
    if (ready) {
        bool reused = state->free_count > 0;
        slot = reused ? state->free_slots[--state->free_count] : state->kept_slots++;
        ready = mal_ffi_set_element(vm, held[1], (int32_t) slot, held[0]);
        if (!ready && reused) state->free_count++;
    }
    mal_gc_unroot(&root);
    if (!ready) {
        free(kept);
        if (!mal_ffi_threw(vm)) mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    mal_ffi_callback_init(&kept->callback, vm, held[0]);
    atomic_init(&kept->references, 1);
    kept->slot = slot;
    kept->thread = pthread_self();
    kept->next = state->kept;
    if (state->kept != nullptr) state->kept->previous = kept;
    state->kept = kept;
    return &kept->callback;
}

static void ffi_inbox_leave(MalVm *vm);

static void ffi_owner_unlink(MalFfiKept *kept) {
    MalFfiNativeHandle *owner = kept->owner;
    if (owner == nullptr) return;
    if (kept->owner_previous != nullptr) kept->owner_previous->owner_next = kept->owner_next;
    else owner->callbacks = kept->owner_next;
    if (kept->owner_next != nullptr) kept->owner_next->owner_previous = kept->owner_previous;
    kept->owner = nullptr;
    kept->callback.owner = mal_value_new_null();
    kept->owner_previous = nullptr;
    kept->owner_next = nullptr;
}

static void ffi_kept_slot_release(MalVm *vm, MalFfiKept *kept) {
    if (kept->slot == UINT32_MAX) return;
    MalFfiState *state = vm->ffi;
    MalValue array;
    if (ffi_prepared(vm, FFI_KEPT_IDENTITY, &array))
        (void) mal_object_set(mal_value_to_object(array), mal_key_index(kept->slot), mal_value_new_undefined());
    if (state->free_count == state->free_capacity) {
        u32 capacity = state->free_capacity == 0 ? 8 : state->free_capacity * 2;
        u32 *grown = realloc(state->free_slots, capacity * sizeof(*grown));
        if (grown != nullptr) {
            state->free_slots = grown;
            state->free_capacity = capacity;
        }
    }
    if (state->free_count < state->free_capacity) state->free_slots[state->free_count++] = kept->slot;
    kept->slot = UINT32_MAX;
}

/** Drop a released context's slot and free it; runs on the VM thread outside collection. */
static void ffi_release_now(MalFfiKept *kept) {
    MalVm *vm = kept->callback.vm;
    if (vm != nullptr && kept->queued) {
        // Queued calls still name this context; the last one to run completes the release.
        if (atomic_load(&kept->waiting) > 0) {
            kept->released = true;
            return;
        }
        ffi_inbox_leave(vm);
    }
    ffi_close_detach(kept);
    pthread_mutex_lock(&ffi_queue_lock);
    ffi_owner_unlink(kept);
    pthread_mutex_unlock(&ffi_queue_lock);
    if (vm != nullptr) {
        MalFfiState *state = vm->ffi;
        ffi_kept_slot_release(vm, kept);
        if (kept->previous != nullptr) kept->previous->next = kept->next;
        else state->kept = kept->next;
        if (kept->next != nullptr) kept->next->previous = kept->previous;
    }
    ffi_kept_unref(kept);
}

static void ffi_run_pending_releases(MalVm *vm) {
    MalFfiState *state = vm->ffi;
    if (state == nullptr || atomic_load_explicit(&state->pending_releases, memory_order_relaxed) == nullptr) {
        return;
    }
    MalFfiKept *pending = atomic_exchange(&state->pending_releases, nullptr);
    while (pending != nullptr) {
        MalFfiKept *next = pending->pending;
        ffi_release_now(pending);
        pending = next;
    }
}

static bool ffi_inbox_post_release(MalFfiKept *kept);

void mal_ffi_release(void *data) {
    if (data == nullptr) return;
    MalFfiKept *kept = data;
    pthread_mutex_lock(&ffi_queue_lock);
    kept->release_requested = true;
    kept->callback.results_accepting = false;
    MalVm *vm = kept->callback.vm;
    // A queued callback's release goes through its inbox, which wakes the event loop
    // that waits for it.
    if (vm != nullptr && kept->queued && (ffi_finalizing || !pthread_equal(kept->thread, pthread_self()))
        && ffi_inbox_post_release(kept)) {
        pthread_mutex_unlock(&ffi_queue_lock);
        return;
    }
    // Inside a collection or on another thread the VM cannot be touched; queue the
    // context for the VM thread, which runs the queue after its next C call.
    if (vm != nullptr && (ffi_finalizing || !pthread_equal(kept->thread, pthread_self()))) {
        MalFfiState *state = vm->ffi;
        MalFfiKept *head = atomic_load(&state->pending_releases);
        do {
            kept->pending = head;
        } while (!atomic_compare_exchange_weak(&state->pending_releases, &head, kept));
        pthread_mutex_unlock(&ffi_queue_lock);
        return;
    }
    pthread_mutex_unlock(&ffi_queue_lock);
    ffi_release_now(kept);
}

static void ffi_async_run(void *data) {
    MalFfiAsyncPayload *payload = data;
    int queued = MAL_FFI_ASYNC_QUEUED;
    if (!atomic_compare_exchange_strong_explicit(&payload->phase, &queued,
            MAL_FFI_ASYNC_RUNNING, memory_order_acq_rel, memory_order_acquire)) return;
    MalFfiAsyncGroup *previous = ffi_worker_group;
    ffi_worker_group = payload->group;
    payload->run(payload->data);
    ffi_worker_group = previous;
    atomic_store_explicit(&payload->phase, MAL_FFI_ASYNC_FINISHED, memory_order_release);
}

static void ffi_async_release(void *data) {
    MalFfiAsyncPayload *payload = data;
    if (atomic_fetch_sub_explicit(&payload->references, 1, memory_order_acq_rel) == 1) {
        payload->release(payload->data);
        for (i32 index = 0; index < payload->callback_count; index++)
            if (payload->callbacks[index] != nullptr) mal_ffi_callback_drop(payload->callbacks[index]);
        free(payload->callbacks);
        ffi_group_release(payload->group);
        free(payload);
    }
}

/** A C call running on a blocking worker, until its completion settles `promise`. */
typedef struct MalFfiAsync {
    struct MalFfiAsync *next;
    MalVm *vm;
    MalHostHandle operation;
    MalValue promise;
    /** Arguments the call uses in place, such as pinned buffers and handles. */
    MalValue *keep;
    i32 keep_count;
    MalFfiAsyncComplete complete;
    /** Host teardown can discard its result before VM cleanup retires argument pins. */
    MalFfiAsyncPayload *payload;
    MalAsyncContext *async_context;
#if MAL_REALMS
    MalRealm *realm;
#endif
} MalFfiAsync;

static MAL_ISOLATE_LOCAL MalFfiAsync *ffi_async_pending;
static MAL_ISOLATE_LOCAL bool ffi_async_installed;

static void ffi_async_cancel_queued(MalVm *vm) {
    for (MalFfiAsync *call = ffi_async_pending; call != nullptr; call = call->next) {
        if (call->vm != vm || call->payload->must_run) continue;
        int queued = MAL_FFI_ASYNC_QUEUED;
        (void) atomic_compare_exchange_strong_explicit(&call->payload->phase, &queued,
            MAL_FFI_ASYNC_CANCELLED, memory_order_acq_rel, memory_order_acquire);
    }
}

static void ffi_async_detach(MalFfiAsyncPayload *payload) {
    payload->group->active = false;
    for (i32 index = 0; index < payload->callback_count; index++) {
        MalFfiKept *kept = (MalFfiKept *) payload->callbacks[index];
        if (kept != nullptr && kept->group == payload->group) kept->group = nullptr;
    }
}

static void ffi_scan_roots(MalVm *vm, void *data) {
    (void) data;
    for (MalFfiAsync *call = ffi_async_pending; call != nullptr; call = call->next) {
        if (call->vm != vm) continue;
        mal_gc_mark_value(call->promise);
        mal_gc_mark_value(call->payload->group->error);
        for (i32 index = 0; index < call->keep_count; index++) mal_gc_mark_value(call->keep[index]);
        mal_gc_mark_value(mal_async_internal_value((MalHeapHeader *) call->async_context));
    }
    if (vm->ffi == nullptr) return;
    for (MalFfiNativeHandle *native = vm->ffi->native_handles; native != nullptr; native = native->next) {
        // Keeping the canonical wrapper prevents a later C alias from acquiring a second owner.
        if (atomic_load_explicit(&native->references, memory_order_acquire)
            > 1 + atomic_load_explicit(&native->contained, memory_order_acquire))
            mal_gc_mark_value(native->wrapper);
    }
}

static void ffi_async_free(MalVm *vm) {
    ffi_async_cancel_queued(vm);
    MalFfiAsync **link = &ffi_async_pending;
    while (*link != nullptr) {
        MalFfiAsync *call = *link;
        if (call->vm != vm) {
            link = &call->next;
            continue;
        }
        MalRootSpan kept;
        mal_gc_root(&kept, call->keep, call->keep_count);
        *link = call->next;
        ffi_async_detach(call->payload);
        (void) call->complete(vm, call->payload->data, false);
        if (vm->ffi != nullptr) {
            call->payload->next = vm->ffi->retired_async;
            vm->ffi->retired_async = call->payload;
        } else ffi_async_release(call->payload);
        mal_gc_unroot(&kept);
        free(call->keep);
        free(call);
    }
}

static bool ffi_async_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    MalHostTask task;
    if (host == nullptr || !mal_host_peek_task(&host->tasks, &task)) return false;
    MalFfiAsync **link = &ffi_async_pending;
    while (*link != nullptr && ((*link)->vm != vm || (*link)->operation != task.operation)) {
        link = &(*link)->next;
    }
    MalFfiAsync *call = *link;
    if (call == nullptr || !mal_host_next_task(&host->tasks, &task)) return false;
    MalRootSpan kept;
    mal_gc_root(&kept, call->keep, call->keep_count);
    *link = call->next;
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
    mal_realm_switch(vm, call->realm);
#endif
    MalValue roots[4] = {
        call->promise, mal_value_new_undefined(),
        mal_async_internal_value((MalHeapHeader *) call->async_context),
        call->payload->group->error};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalAsyncContextScope scope;
    mal_async_context_scope_enter(vm, &scope, call->async_context);
    void *data = mal_blocking_work_result_data(task.data);
    bool finished = atomic_load_explicit(&call->payload->phase, memory_order_acquire) == MAL_FFI_ASYNC_FINISHED;
    bool delivered = data != nullptr && task.result != MAL_HOST_TERMINAL_CANCELLED && finished;
    ffi_async_detach(call->payload);
    if (call->payload->group->failed)
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = roots[3]};
    if (!delivered && vm->completion.kind != MAL_COMPLETION_THROW)
        mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            (const byte *) (finished ? "A C library result could not be delivered" : "A C library call did not run"));
    // The completion releases what the call held, so it runs even when the work did not.
    roots[1] = call->complete(vm, call->payload->data, finished);
    if (call->payload->group->failed)
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_THROW, .value = roots[3]};
    bool rejected = vm->completion.kind == MAL_COMPLETION_THROW;
    if (rejected) {
        roots[1] = vm->completion.value;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    }
    mal_promise_settle_direct(
        vm, roots[0], vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], rejected, roots[1]);
    mal_async_context_scope_exit(vm, &scope);
    mal_gc_unroot(&root);
#if MAL_REALMS
    mal_realm_switch(vm, saved_realm);
#endif
    ffi_async_release(call->payload);
    mal_host_task_release(&host->tasks, &task);
    mal_gc_unroot(&kept);
    free(call->keep);
    free(call);
    return true;
}

bool mal_ffi_async(
    MalVm *vm, void *data, MalFfiAsyncRun run, MalFfiAsyncComplete complete,
    MalFfiAsyncRelease release, const MalValue *keep, int32_t keep_count,
    const MalFfiInputs *inputs, MalFfiCallback *const *callbacks, int32_t callback_count,
    MalValue *promise, bool must_run) {
    MalHost *host = mal_host(vm);
    if (host == nullptr) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            (const byte *) "Async C library calls need an event loop, such as the web platform surface");
        return false;
    }
    MalFfiState *state = ffi_state(vm);
    if (state == nullptr) return mal_ffi_out_of_memory(vm);
    if (!state->async_cleanup) {
        if (!mal_vm_register_runtime_cleanup(vm, ffi_async_free)) return mal_ffi_out_of_memory(vm);
        state->async_cleanup = true;
    }
    if (!ffi_async_installed) {
        mal_gc_register_root_source(ffi_scan_roots, nullptr);
        mal_host_register_macrotask_drain(ffi_async_drain, false);
        ffi_async_installed = true;
    }
    MalValue resolve;
    MalValue reject;
    mal_promise_new_direct_capability(vm, promise, &resolve, &reject);
    if (vm->completion.kind == MAL_COMPLETION_THROW) return false;
    i32 input_count = inputs == nullptr ? 0 : inputs->count;
    if (input_count > INT32_MAX - keep_count) return mal_ffi_out_of_memory(vm);
    i32 total = keep_count + input_count;
    MalFfiAsync *call = calloc(1, sizeof(*call));
    MalFfiAsyncPayload *payload = calloc(1, sizeof(*payload));
    MalFfiAsyncGroup *group = calloc(1, sizeof(*group));
    MalFfiCallback **held_callbacks = callback_count == 0 ? nullptr
        : malloc(sizeof(*held_callbacks) * (usize) callback_count);
    MalValue *kept = total == 0 ? nullptr : malloc(sizeof(*kept) * (usize) total);
    if (call == nullptr || payload == nullptr || group == nullptr
        || (callback_count > 0 && held_callbacks == nullptr) || (total > 0 && kept == nullptr)) {
        free(call);
        free(payload);
        free(kept);
        free(group);
        free(held_callbacks);
        return mal_ffi_out_of_memory(vm);
    }
    if (keep_count > 0) memcpy(kept, keep, sizeof(*kept) * (usize) keep_count);
    if (input_count > 0) memcpy(kept + keep_count, inputs->values, sizeof(*kept) * (usize) input_count);
    *call = (MalFfiAsync) {
        .vm = vm,
        .promise = *promise,
        .keep = kept,
        .keep_count = total,
        .complete = complete,
        .payload = payload,
        .async_context = mal_async_context_capture(vm),
#if MAL_REALMS
        .realm = vm->current_realm,
#endif
    };
    *group = (MalFfiAsyncGroup) {
        .references = 1, .vm = vm, .error = mal_value_new_undefined(), .active = true,
        .async_context = call->async_context,
#if MAL_REALMS
        .realm = call->realm,
#endif
    };
    for (i32 index = 0; index < callback_count; index++) {
        held_callbacks[index] = callbacks[index];
        if (callbacks[index] == nullptr) continue;
        mal_ffi_callback_hold(callbacks[index]);
        ((MalFfiKept *) callbacks[index])->group = group;
    }
    *payload = (MalFfiAsyncPayload) {
        .references = 2, .phase = MAL_FFI_ASYNC_QUEUED, .must_run = must_run, .data = data, .run = run, .release = release,
        .group = group, .callbacks = held_callbacks, .callback_count = callback_count};
    MalBlockingWorkReservation reservation = {0};
    if (!mal_blocking_work_reserve(host, sizeof(*call), &reservation)
        || !mal_blocking_work_start(host, ffi_async_run, payload, ffi_async_release, &reservation, &call->operation, must_run)) {
        mal_blocking_work_reservation_release(&reservation);
        free(kept);
        free(call);
        ffi_async_detach(payload);
        for (i32 index = 0; index < callback_count; index++)
            if (held_callbacks[index] != nullptr) mal_ffi_callback_drop(held_callbacks[index]);
        free(held_callbacks);
        ffi_group_release(group);
        free(payload);
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            (const byte *) "A C library call could not be scheduled");
        return false;
    }
    call->next = ffi_async_pending;
    ffi_async_pending = call;
    return true;
}

MalValue mal_ffi_rejected(MalVm *vm) {
    MalValue roots[2] = {vm->completion.value, mal_value_new_undefined()};
    vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalValue resolve;
    MalValue reject;
    mal_promise_new_direct_capability(vm, &roots[1], &resolve, &reject);
    if (vm->completion.kind != MAL_COMPLETION_THROW) {
        mal_promise_settle_direct(
            vm, roots[1], vm->intrinsics[MAL_INTRINSIC_PROMISE_CONSTRUCTOR], true, roots[0]);
    }
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined() : roots[1];
}

void mal_ffi_collectable_begin(MalVm *vm) {
    mal_gc_native_rooted_begin(vm);
}

void mal_ffi_collectable_end(MalVm *vm) {
    mal_gc_native_rooted_end(vm);
    ffi_run_pending_releases(vm);
}

MalVm *mal_ffi_callback_vm(MalFfiCallback *callback) {
    MalVm *vm = callback->vm;
    if (vm == nullptr || ffi_finalizing) return nullptr;
    if (callback->thread_identity != &ffi_callback_thread) ffi_wrong_thread();
    return vm;
}

MalVm *mal_ffi_callback_owner_vm(MalFfiCallback *callback) {
    MalVm *vm = mal_ffi_callback_vm(callback);
    if (vm == nullptr) return nullptr;
    MalFfiHandleObject *owner = ffi_handle(callback->owner);
    return owner == nullptr || owner->value == nullptr || owner->closing ? nullptr : vm;
}

void mal_ffi_callback_hold(MalFfiCallback *callback) {
    atomic_fetch_add_explicit(&((MalFfiKept *) callback)->references, 1, memory_order_relaxed);
}

void mal_ffi_callback_drop(MalFfiCallback *callback) {
    ffi_kept_unref((MalFfiKept *) callback);
}

typedef struct MalFfiReplacedEntry {
    void *key;
    MalFfiKept *kept[2];
    u64 identity[2];
    unsigned lane;
    MalFfiReplacement *pending;
    u64 pending_identity;
    bool retired;
} MalFfiReplacedEntry;

/**
 * Replaced callbacks are process-wide, as the libraries' own setter state is, so
 * worker VMs share them. Preparation reserves a key on the VM; workers publish it
 * immediately before C runs. Both trampoline generations remain routable until
 * the setter returns, since C can invoke either while replacing its registration.
 */
static pthread_mutex_t ffi_replaced_lock = PTHREAD_MUTEX_INITIALIZER;
/** Every site that ever held an entry, so destroying a handle finds its callbacks. */
static MalFfiReplaced *ffi_replaced_sites;
/** Entries keyed by a handle; destroying a handle skips the scan while there are none. */
static _Atomic usize ffi_replaced_keyed;
/** Registration order separates callbacks of resources that reuse an address. */
static u64 ffi_replaced_identity;

static MalFfiReplacedEntry *ffi_replaced_find(MalFfiReplaced *site, void *key) {
    MalFfiReplacedEntry *entries = site->entries;
    for (usize index = 0; index < site->count; index++) {
        if (entries[index].key == key && !entries[index].retired) return &entries[index];
    }
    return nullptr;
}

static MalFfiReplacedEntry *ffi_replacement_entry(MalFfiReplacement *replacement) {
    MalFfiReplaced *site = replacement->site;
    MalFfiReplacedEntry *entries = site->entries;
    for (usize index = 0; index < site->count; index++) {
        if (entries[index].pending == replacement) return &entries[index];
    }
    return nullptr;
}

static void ffi_replaced_remove(MalFfiReplaced *site, MalFfiReplacedEntry *entry) {
    MalFfiReplacedEntry *entries = site->entries;
    if (entry->key != nullptr) ffi_replaced_keyed--;
    *entry = entries[--site->count];
}

bool mal_ffi_replace_prepare(
    MalVm *vm, MalFfiReplaced *site, void *key, MalFfiCallback *callback,
    MalFfiReplacement *replacement) {
    pthread_mutex_lock(&ffi_replaced_lock);
    MalFfiReplacedEntry *entry = ffi_replaced_find(site, key);
    if (entry != nullptr && entry->pending != nullptr) {
        pthread_mutex_unlock(&ffi_replaced_lock);
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "A C callback replacement is already pending for this key");
        return false;
    }
    if (entry == nullptr) {
        if (site->count == site->capacity) {
            usize capacity = site->capacity == 0 ? 4 : site->capacity * 2;
            MalFfiReplacedEntry *grown = realloc(site->entries, capacity * sizeof(*grown));
            if (grown == nullptr) {
                pthread_mutex_unlock(&ffi_replaced_lock);
                return mal_ffi_out_of_memory(vm);
            }
            if (site->capacity == 0) {
                site->next = ffi_replaced_sites;
                ffi_replaced_sites = site;
            }
            site->entries = grown;
            site->capacity = capacity;
        }
        entry = &((MalFfiReplacedEntry *) site->entries)[site->count++];
        *entry = (MalFfiReplacedEntry) {.key = key, .lane = 1};
        if (key != nullptr) ffi_replaced_keyed++;
    }
    *replacement = (MalFfiReplacement) {
        .site = site, .key = key, .callback = callback, .lane = entry->lane ^ 1};
    entry->pending = replacement;
    entry->pending_identity = ++ffi_replaced_identity;
    if (callback != nullptr) {
        callback->result_owner = key;
        mal_ffi_callback_hold(callback);
    }
    pthread_mutex_unlock(&ffi_replaced_lock);
    return true;
}

void mal_ffi_replace_commit(MalFfiReplacement *replacement) {
    pthread_mutex_lock(&ffi_replaced_lock);
    MalFfiReplacedEntry *entry = ffi_replacement_entry(replacement);
    if (entry == nullptr || entry->retired || replacement->committed
        || entry->kept[replacement->lane] != nullptr) abort();
    entry->kept[replacement->lane] = (MalFfiKept *) replacement->callback;
    entry->identity[replacement->lane] = ++ffi_replaced_identity;
    entry->lane = replacement->lane;
    replacement->committed = true;
    pthread_mutex_unlock(&ffi_replaced_lock);
}

void mal_ffi_replace_return(MalFfiReplacement *replacement) {
    pthread_mutex_lock(&ffi_replaced_lock);
    MalFfiReplacedEntry *entry = ffi_replacement_entry(replacement);
    if (entry == nullptr || !replacement->committed) abort();
    MalFfiKept *previous = entry->kept[replacement->lane ^ 1];
    if (previous != nullptr) {
        pthread_mutex_lock(&ffi_queue_lock);
        previous->callback.results_accepting = false;
        pthread_mutex_unlock(&ffi_queue_lock);
    }
    pthread_mutex_unlock(&ffi_replaced_lock);
}

void mal_ffi_replace_finish(MalFfiReplacement *replacement) {
    if (replacement->site == nullptr) return;
    pthread_mutex_lock(&ffi_replaced_lock);
    MalFfiReplacedEntry *entry = ffi_replacement_entry(replacement);
    if (entry == nullptr || entry->pending != replacement) abort();
    MalFfiCallback *retired;
    if (replacement->committed) {
        unsigned previous = replacement->lane ^ 1;
        MalFfiKept *kept = entry->kept[previous];
        retired = kept == nullptr ? nullptr : &kept->callback;
        entry->kept[previous] = nullptr;
        entry->identity[previous] = 0;
    } else retired = replacement->callback;
    entry->pending = nullptr;
    entry->pending_identity = 0;
    if (entry->kept[0] == nullptr && entry->kept[1] == nullptr)
        ffi_replaced_remove(replacement->site, entry);
    pthread_mutex_unlock(&ffi_replaced_lock);
    // Releasing can queue VM work or detach a closing handle; never hold the registry lock.
    mal_ffi_release(retired);
    if (replacement->callback != nullptr) mal_ffi_callback_drop(replacement->callback);
    replacement->site = nullptr;
}

MalFfiCallback *mal_ffi_replaced(MalFfiReplaced *site, void *key, unsigned lane) {
    if (lane > 1) abort();
    pthread_mutex_lock(&ffi_replaced_lock);
    MalFfiReplacedEntry *entry = ffi_replaced_find(site, key);
    MalFfiKept *kept = entry == nullptr ? nullptr : entry->kept[lane];
    if (kept != nullptr)
        atomic_fetch_add_explicit(&kept->references, 1, memory_order_relaxed);
    // Checked under the lock: the owning thread may release the context right after.
    bool foreign = kept != nullptr && !pthread_equal(kept->thread, pthread_self());
    bool live = foreign && !kept->queued && kept->callback.vm != nullptr;
    // A queued callback's call from another thread reserves its place in the queue
    // here, before the lock lets the VM thread replace and release the context.
    if (foreign && kept->queued) {
        atomic_fetch_add_explicit(&kept->references, 1, memory_order_relaxed);
        atomic_fetch_add(&kept->waiting, 1);
        foreign = false;
    }
    pthread_mutex_unlock(&ffi_replaced_lock);
    if (foreign && live) ffi_wrong_thread();
    return kept == nullptr ? nullptr : &kept->callback;
}

/** Release the callbacks kept for a handle whose resource was just destroyed. */
static void ffi_replaced_drop_before(void *key, u64 identity) {
    if (key == nullptr || atomic_load_explicit(&ffi_replaced_keyed, memory_order_relaxed) == 0) {
        return;
    }
    for (;;) {
        MalFfiKept *kept = nullptr;
        pthread_mutex_lock(&ffi_replaced_lock);
        for (MalFfiReplaced *site = ffi_replaced_sites; site != nullptr && kept == nullptr;
             site = site->next) {
            MalFfiReplacedEntry *entries = site->entries;
            for (usize index = 0; index < site->count && kept == nullptr;) {
                MalFfiReplacedEntry *entry = &entries[index];
                if (entry->key != key) { index++; continue; }
                for (unsigned lane = 0; lane < 2; lane++) {
                    if (entry->kept[lane] == nullptr || entry->identity[lane] > identity) continue;
                    kept = entry->kept[lane];
                    entry->kept[lane] = nullptr;
                    entry->identity[lane] = 0;
                    break;
                }
                if (entry->kept[0] == nullptr && entry->kept[1] == nullptr) {
                    if (entry->pending == nullptr) {
                        ffi_replaced_remove(site, entry);
                        continue;
                    }
                    // A close may create a new resource at this address before its setter returns.
                    if (entry->pending_identity <= identity) entry->retired = true;
                }
                index++;
            }
        }
        pthread_mutex_unlock(&ffi_replaced_lock);
        // Released outside the lock: a release runs on the VM thread or queues for it.
        if (kept == nullptr) return;
        mal_ffi_release(kept);
    }
}

static void ffi_replaced_drop(void *key) {
    ffi_replaced_drop_before(key, UINT64_MAX);
}

static void ffi_replaced_drop_owner(MalFfiNativeHandle *owner) {
    for (;;) {
        MalFfiKept *kept = nullptr;
        pthread_mutex_lock(&ffi_replaced_lock);
        pthread_mutex_lock(&ffi_queue_lock);
        for (MalFfiReplaced *site = ffi_replaced_sites; site != nullptr && kept == nullptr; site = site->next) {
            MalFfiReplacedEntry *entries = site->entries;
            for (usize index = 0; index < site->count && kept == nullptr; index++) {
                MalFfiReplacedEntry *entry = &entries[index];
                for (unsigned lane = 0; lane < 2; lane++) {
                    if (entry->kept[lane] == nullptr || entry->kept[lane]->owner != owner) continue;
                    kept = entry->kept[lane];
                    entry->kept[lane] = nullptr;
                    entry->identity[lane] = 0;
                    if (entry->kept[0] == nullptr && entry->kept[1] == nullptr) {
                        if (entry->pending == nullptr) ffi_replaced_remove(site, entry);
                        else entry->retired = true;
                    }
                    break;
                }
            }
        }
        pthread_mutex_unlock(&ffi_queue_lock);
        pthread_mutex_unlock(&ffi_replaced_lock);
        if (kept == nullptr) return;
        mal_ffi_release(kept);
    }
}

static void ffi_owner_finish(MalFfiNativeHandle *owner, bool released) {
    if (!owner->registration_owner) return;
    if (released) ffi_replaced_drop_owner(owner);
    for (;;) {
        pthread_mutex_lock(&ffi_queue_lock);
        MalFfiKept *kept = owner->callbacks;
        if (kept == nullptr) { pthread_mutex_unlock(&ffi_queue_lock); return; }
        atomic_fetch_add_explicit(&kept->references, 1, memory_order_relaxed);
        ffi_owner_unlink(kept);
        bool requested = kept->release_requested;
        MalVm *vm = kept->callback.vm;
        if (!released && vm != nullptr) {
            // Collection can leave a collect:false or failed-destruction resource
            // alive in C. Its callbacks retain native copies, never dead VM values.
            MalFfiState *state = vm->ffi;
            if (kept->previous != nullptr) kept->previous->next = kept->next;
            else state->kept = kept->next;
            if (kept->next != nullptr) kept->next->previous = kept->previous;
            kept->previous = nullptr;
            kept->next = nullptr;
            kept->callback.vm = nullptr;
            kept->callback.function = mal_value_new_undefined();
        }
        pthread_mutex_unlock(&ffi_queue_lock);
        if (!released && vm != nullptr && kept->queued) ffi_inbox_leave(vm);
        if (released && !requested) mal_ffi_release(kept);
        ffi_kept_unref(kept);
    }
}

/** A queued call of a kept callback from another thread, or with no `run`, its release. */
typedef struct MalFfiQueuedCall {
    MalFfiKept *kept;
    MalFfiQueuedRun run;
    MalFfiQueuedFree free;
    void *message;
    bool ran;
    MalFfiWait *wait;
    MalFfiAsyncGroup *group;
} MalFfiQueuedCall;

static MAL_ISOLATE_LOCAL bool ffi_inbox_installed;

static void ffi_queued_destroy(void *data) {
    MalFfiQueuedCall *call = data;
    // A call the host drops without running gives back its place in the queue.
    if (call->run != nullptr) {
        if (!call->ran) atomic_fetch_sub(&call->kept->waiting, 1);
        ffi_kept_unref(call->kept);
    } else if (!call->ran) {
        ffi_kept_unref(call->kept);
    }
    if (call->wait != nullptr) {
        ffi_wait_finish(call->wait, false);
        mal_ffi_callback_wait_release(call->wait);
    } else if (call->message != nullptr) call->free(call->message);
    ffi_group_release(call->group);
    free(call);
}

/** Caller holds the queue lock so VM detach cannot retire the inbox during posting. */
static bool ffi_inbox_post_release(MalFfiKept *kept) {
    MalFfiQueuedCall *call = malloc(sizeof(*call));
    if (call == nullptr) return false;
    *call = (MalFfiQueuedCall) {.kept = kept};
    MalVm *vm = kept->callback.vm;
    bool posted = vm != nullptr
        && mal_host_post_progress(mal_host(vm), vm->ffi->inbox, call, ffi_queued_destroy);
    if (!posted) free(call);
    return posted;
}

static void ffi_inbox_leave(MalVm *vm) {
    MalFfiState *state = vm->ffi;
    MalHost *host = mal_host(vm);
    if (--state->inbox_users > 0 || host == nullptr) return;
    // The terminal task retires the inbox once the drain consumes it, and the loop
    // stops waiting for calls from other threads.
    (void) mal_host_operation_complete(&host->tasks, state->inbox, MAL_HOST_TERMINAL_OK, nullptr, nullptr);
    mal_reactor_release_work(&host->reactor);
}

static bool ffi_inbox_drain(MalVm *vm) {
    MalHost *host = mal_host(vm);
    MalHostTask task;
    if (host == nullptr || vm->ffi == nullptr || !mal_host_peek_task(&host->tasks, &task)) {
        return false;
    }
    if (mal_host_operation_owner(&host->tasks, task.operation) != vm->ffi) return false;
    if (!mal_host_next_task(&host->tasks, &task)) return false;
    if (task.kind == MAL_HOST_TASK_TERMINAL) {
        mal_host_operation_unbind(&host->tasks, task.operation, vm->ffi);
        mal_host_task_release(&host->tasks, &task);
        return true;
    }
    MalFfiQueuedCall *call = task.data;
    MalFfiKept *kept = call->kept;
    if (call->run == nullptr) {
        call->ran = true;
        mal_host_task_release(&host->tasks, &task);
        ffi_release_now(kept);
        return true;
    }
    bool pending = true;
    if (call->wait != nullptr) {
        pthread_mutex_lock(&ffi_queue_lock);
        pending = !call->wait->done;
        pthread_mutex_unlock(&ffi_queue_lock);
    }
    MalFfiAsyncGroup *group = call->group != nullptr ? call->group : kept->group;
    bool grouped = group != nullptr && group->active && group->vm == vm;
    bool ran = pending && kept->callback.vm == vm && !(grouped && group->failed);
    MalAsyncContextScope scope;
#if MAL_REALMS
    MalRealm *saved_realm = vm->current_realm;
#endif
    if (grouped) {
#if MAL_REALMS
        mal_realm_switch(vm, group->realm);
#endif
        mal_async_context_scope_enter(vm, &scope, group->async_context);
    }
    if (ran) call->run(vm, &kept->callback, call->message);
    call->ran = true;
    bool succeeded = ran && vm->completion.kind != MAL_COMPLETION_THROW;
    if (grouped && vm->completion.kind == MAL_COMPLETION_THROW) {
        if (!group->failed) group->error = vm->completion.value;
        group->failed = true;
        vm->completion = (MalCompletion) {.kind = MAL_COMPLETION_NORMAL, .value = mal_value_new_undefined()};
    }
    if (grouped) {
        mal_async_context_scope_exit(vm, &scope);
#if MAL_REALMS
        mal_realm_switch(vm, saved_realm);
#endif
    }
    if (call->wait != nullptr)
        ffi_wait_finish(call->wait, succeeded);
    u32 left = atomic_fetch_sub(&kept->waiting, 1) - 1;
    mal_host_task_release(&host->tasks, &task);
    if (left == 0 && kept->released) ffi_release_now(kept);
    return true;
}

MalFfiCallback *mal_ffi_keep_queued(MalVm *vm, MalValue function) {
    MalHost *host = mal_host(vm);
    if (host == nullptr) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_ERROR_PROTOTYPE,
            (const byte *) "Callbacks a C library calls from other threads need an event loop, such as the web platform surface");
        return nullptr;
    }
    MalFfiCallback *callback = mal_ffi_keep(vm, function);
    if (callback == nullptr) return nullptr;
    MalFfiState *state = vm->ffi;
    if (state->inbox_users == 0) {
        // The inbox keeps the event loop waiting while the library may still call.
        bool started = mal_host_operation_start(&host->tasks, &state->inbox);
        bool bound = started && mal_host_operation_bind(&host->tasks, state->inbox, state);
        bool retained = bound && mal_reactor_retain_work(&host->reactor);
        if (!retained || !mal_host_operation_activate(&host->tasks, state->inbox)) {
            if (retained) mal_reactor_release_work(&host->reactor);
            if (bound) mal_host_operation_unbind(&host->tasks, state->inbox, state);
            if (started) (void) mal_host_operation_abort_start(&host->tasks, state->inbox);
            mal_ffi_release(callback);
            mal_vm_throw_allocation_error(vm);
            return nullptr;
        }
        if (!ffi_inbox_installed) {
            mal_host_register_macrotask_drain(ffi_inbox_drain, false);
            ffi_inbox_installed = true;
        }
    }
    state->inbox_users++;
    ((MalFfiKept *) callback)->queued = true;
    return callback;
}

bool mal_ffi_callback_here(MalFfiCallback *callback) {
    MalFfiKept *kept = (MalFfiKept *) callback;
    return pthread_equal(kept->thread, pthread_self())
        || (!kept->queued && kept->callback.vm == nullptr);
}

void mal_ffi_callback_reserve(MalFfiCallback *callback) {
    MalFfiKept *kept = (MalFfiKept *) callback;
    if (!kept->queued) ffi_wrong_thread();
    atomic_fetch_add_explicit(&kept->references, 1, memory_order_relaxed);
    atomic_fetch_add(&kept->waiting, 1);
}

static bool ffi_callback_post_locked(
    MalFfiKept *kept, MalFfiQueuedRun run, void *message, MalFfiQueuedFree release,
    MalFfiWait *wait) {
    MalFfiQueuedCall *call = message == nullptr ? nullptr : malloc(sizeof(*call));
    if (call != nullptr) {
        *call = (MalFfiQueuedCall) {
            .kept = kept, .run = run, .free = release, .message = message, .wait = wait};
        MalVm *vm = kept->callback.vm;
        MalFfiAsyncGroup *group = ffi_worker_group;
        if (group != nullptr && group->vm == vm) {
            atomic_fetch_add_explicit(&group->references, 1, memory_order_relaxed);
            call->group = group;
        }
        bool posted = vm != nullptr
            && (wait == nullptr || vm->ffi->accepting_waits)
            && mal_host_post_progress(mal_host(vm), vm->ffi->inbox, call, ffi_queued_destroy);
        if (posted) return true;
        ffi_group_release(call->group);
        free(call);
    }
    return false;
}

bool mal_ffi_callback_queue(
    MalFfiCallback *callback, MalFfiQueuedRun run, void *message, MalFfiQueuedFree release) {
    MalFfiKept *kept = (MalFfiKept *) callback;
    pthread_mutex_lock(&ffi_queue_lock);
    bool posted = ffi_callback_post_locked(kept, run, message, release, nullptr);
    pthread_mutex_unlock(&ffi_queue_lock);
    if (posted) return true;
    if (message != nullptr) release(message);
    // A release that waited for this call stays pending: only the VM thread may free it.
    atomic_fetch_sub(&kept->waiting, 1);
    ffi_kept_unref(kept);
    return false;
}

int mal_ffi_callback_wait_enter(void) {
    // A canceled condition wait reacquires the queue lock. Defer cancellation until
    // the generated frame has released the request and its keyed or close references.
    int previous;
    if (pthread_setcancelstate(PTHREAD_CANCEL_DISABLE, &previous) != 0) abort();
    return previous;
}

void mal_ffi_callback_wait_leave(int cancellation_state) {
    if (pthread_setcancelstate(cancellation_state, nullptr) != 0) abort();
    if (cancellation_state == PTHREAD_CANCEL_ENABLE) pthread_testcancel();
}

bool mal_ffi_callback_wait(
    MalFfiCallback *callback, MalFfiQueuedRun run, void *message, MalFfiQueuedFree release,
    MalFfiWait **request) {
    *request = nullptr;
    MalFfiKept *kept = (MalFfiKept *) callback;
    MalFfiWait *wait = message == nullptr ? nullptr : calloc(1, sizeof(*wait));
    if (wait == nullptr || pthread_cond_init(&wait->changed, nullptr) != 0) {
        free(wait);
        if (message != nullptr) release(message);
        atomic_fetch_sub(&kept->waiting, 1);
        ffi_kept_unref(kept);
        return false;
    }
    wait->references = 1;
    wait->message = message;
    wait->free = release;
    pthread_mutex_lock(&ffi_queue_lock);
    wait->vm = kept->callback.vm;
    wait->next = ffi_waiters;
    ffi_waiters = wait;
    bool posted = ffi_callback_post_locked(kept, run, message, release, wait);
    if (posted) wait->references++;
    while (posted && !wait->done) pthread_cond_wait(&wait->changed, &ffi_queue_lock);
    bool succeeded = posted && wait->succeeded;
    *request = wait;
    pthread_mutex_unlock(&ffi_queue_lock);
    if (!posted) {
        atomic_fetch_sub(&kept->waiting, 1);
        ffi_kept_unref(kept);
    }
    return succeeded;
}

/** A malloc'd `<specifier>#<name>` identity, or null after an allocation throw. */
static char *ffi_identity(MalVm *vm, const MalFfiLibrary *library, const char *name) {
    usize length = strlen(library->specifier) + 1 + strlen(name) + 1;
    char *identity = malloc(length);
    if (identity == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return nullptr;
    }
    snprintf(identity, length, "%s#%s", library->specifier, name);
    return identity;
}

static void ffi_native_handle_stores_clear(MalFfiNativeHandle *handle) {
    for (i32 index = 0; index < handle->store_count; index++)
        mal_array_buffer_store_release(handle->stores[index]);
    free(handle->stores);
    handle->stores = nullptr;
    handle->store_count = 0;
}

static void ffi_native_handle_drop(MalFfiNativeHandle *handle, bool result) {
    if (result) atomic_fetch_sub_explicit(&handle->results, 1, memory_order_acq_rel);
    if (atomic_fetch_sub_explicit(&handle->references, 1, memory_order_acq_rel) != 1) return;
    bool previous = ffi_finalizing;
    ffi_finalizing = true;
    bool released = false;
    bool destroys = handle->value != nullptr && handle->owned
        && (handle->force_destroy || handle->owner_type->collect) && handle->owner_type->destroy != nullptr;
    u64 callback_identity = 0;
    if ((destroys || handle->owns_storage)
        && atomic_load_explicit(&ffi_replaced_keyed, memory_order_relaxed) != 0) {
        pthread_mutex_lock(&ffi_replaced_lock);
        callback_identity = ffi_replaced_identity;
        pthread_mutex_unlock(&ffi_replaced_lock);
    }
    if (handle->retired) {
        pthread_mutex_lock(&ffi_retired_lock);
        handle->destroying = true;
        pthread_mutex_unlock(&ffi_retired_lock);
    }
    if (destroys) {
        if (handle->owner_type->destroy(handle->value)) {
            released = true;
            ffi_replaced_drop_before(handle->value, callback_identity);
        }
    }
    if (handle->owns_storage) {
        ffi_replaced_drop_before(handle->value, callback_identity);
        free(handle->value);
        released = true;
    }
    ffi_owner_finish(handle, released);
    ffi_native_handle_stores_clear(handle);
    if (handle->retired) ffi_retired_unregister(handle);
    free(handle);
    ffi_finalizing = previous;
}

static bool ffi_handle_borrowed(MalFfiHandleObject *handle) {
    return handle->native != nullptr
        && atomic_load_explicit(&handle->native->references, memory_order_acquire) > 1;
}

static bool ffi_handle_result_borrowed(MalFfiHandleObject *handle) {
    return handle->native != nullptr
        && atomic_load_explicit(&handle->native->results, memory_order_acquire) != 0;
}

static void ffi_native_handle_unregister(MalFfiNativeHandle *native) {
    if (native->registry == nullptr) return;
    MalFfiNativeHandle **link = &native->registry->native_handles;
    while (*link != native) link = &(*link)->next;
    *link = native->next;
    native->registry = nullptr;
}

/** Forget the resource; freeing caller-owned storage also releases its keyed callbacks. */
static void ffi_handle_forget(MalFfiHandleObject *handle) {
    if (handle->registry != nullptr) ffi_handle_unregister(handle);
    // Retiring a closing address may expose a fresh resource during its C destructor.
    // The old wrapper still traces its registrations until that destructor returns.
    if (handle->closing && handle->native != nullptr && handle->native->callbacks != nullptr) {
        handle->value = nullptr;
        handle->provisional = false;
        return;
    }
    if (handle->retained != nullptr) {
        for (i32 index = 0; index < handle->type->managed_field_count; index++) {
            MalFfiRetainedField *field = &handle->retained[index];
            if (!ffi_finalizing) mal_gc_write_barrier(field->buffer);
            mal_array_buffer_object_release_pin(field->pin);
        }
        free(handle->retained);
        handle->retained = nullptr;
    }
    if (handle->owns_storage) {
        ffi_replaced_drop(handle->value);
        free(handle->value);
    }
    if (handle->native != nullptr) {
        ffi_native_handle_unregister(handle->native);
        ffi_native_handle_drop(handle->native, false);
        handle->native = nullptr;
    }
    handle->value = nullptr;
    handle->provisional = false;
    if (handle->ownership == MAL_FFI_HANDLE_CHILD) {
        if (!ffi_finalizing) mal_gc_write_barrier(mal_value_from_heap((MalHeapHeader *) handle->owner));
        handle->ownership = MAL_FFI_HANDLE_BORROWED;
    }
    handle->owner_type = handle->type;
}

static void ffi_close_free(MalFfiClose *close) {
    if (close == nullptr) return;
    free(close->storage);
    for (i32 index = 0; index < close->store_count; index++)
        mal_array_buffer_store_release(close->stores[index]);
    free(close->stores);
    free(close);
}

/** Retire VM ownership before publishing detachment; native ownership remains. */
static void ffi_close_detach(MalFfiKept *kept) {
    MalFfiClose *close = kept->close;
    if (close == nullptr || !close->committed || mal_value_is_undefined(close->handle)) return;
    MalFfiHandleObject *handle = ffi_handle(close->handle);
    if (handle->value == close->key) ffi_handle_forget(handle);
    else close->key = nullptr;
    if (handle->worker_closing) mal_ffi_unpin_worker_handle(handle);
    else mal_ffi_unpin_handle(handle);
    handle->closing = false;
    ffi_handle_worker_closing(handle, false);
    handle->operation = nullptr;
    close->handle = mal_value_new_undefined();
}

bool mal_ffi_close_prepare(
    MalVm *vm, MalFfiCallback *callback, MalValue value, const void *site,
    const MalFfiSite *error) {
    MalFfiHandleObject *handle = ffi_handle(value);
    if (handle == nullptr || handle->value == nullptr || handle->pins != 1 || handle->closing || handle->provisional
        || ffi_handle_borrowed(handle) || ffi_handle_owner(handle) != nullptr
        || mal_ffi_is_library_resource(handle->type, handle->value))
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, error,
            "a handle no other C call is using");
    if (handle->owns_storage && handle->type->size == 0 && ffi_handle_policy(handle)->destroy != nullptr)
        return mal_ffi_expected(vm, error, "a destructor binding for managed caller-storage cleanup");
    MalFfiClose *close = calloc(1, sizeof(*close));
    if (close == nullptr) return mal_ffi_out_of_memory(vm);
    close->site = site;
    close->callback = callback;
    close->key = handle->value;
    close->handle = value;
    if (handle->retained != nullptr) {
        close->stores = calloc((usize) handle->type->managed_field_count, sizeof(*close->stores));
        if (close->stores == nullptr) {
            ffi_close_free(close);
            return mal_ffi_out_of_memory(vm);
        }
        for (i32 index = 0; index < handle->type->managed_field_count; index++) {
            MalFfiRetainedField *field = &handle->retained[index];
            if (field->pin == nullptr) continue;
            MalArrayBufferStoreLease *lease = mal_array_buffer_object_retain_store(
                mal_value_to_array_buffer_object(field->buffer));
            if (lease == nullptr) {
                ffi_close_free(close);
                return mal_ffi_out_of_memory(vm);
            }
            close->stores[close->store_count++] = lease;
        }
    }
    MalValue roots[3] = {value, callback->function, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    roots[2] = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
    bool ok = !mal_ffi_threw(vm)
        && mal_ffi_set_element(vm, roots[2], 0, roots[0])
        && mal_ffi_set_element(vm, roots[2], 1, roots[1]);
    MalValue holder;
    if (ok) ok = ffi_prepared(vm, FFI_KEPT_IDENTITY, &holder)
        && mal_object_set(mal_value_to_object(holder), mal_key_index(((MalFfiKept *) callback)->slot), roots[2]);
    mal_gc_unroot(&root);
    if (!ok) {
        ffi_close_free(close);
        return false;
    }
    ((MalFfiKept *) callback)->close = close;
    return true;
}

void mal_ffi_close_commit(MalFfiCallback *callback, void **pin, bool worker) {
    MalFfiClose *close = ((MalFfiKept *) callback)->close;
    MalFfiHandleObject *handle = *pin;
    close->scope = handle->scope;
    close->operation = handle->operation;
    handle->closing = true;
    ffi_handle_worker_closing(handle, worker);
    handle->scope = 0;
    handle->operation = nullptr;
    if (handle->owns_storage) {
        close->storage = handle->value;
        handle->owns_storage = false;
    }
    *pin = nullptr;
    close->committed = true;
    pthread_mutex_lock(&ffi_queue_lock);
    close->next = ffi_closes;
    ffi_closes = close;
    pthread_mutex_unlock(&ffi_queue_lock);
}

void mal_ffi_close_start(MalFfiCallback *callback) {
    MalFfiClose *close = ((MalFfiKept *) callback)->close;
    pthread_mutex_lock(&ffi_replaced_lock);
    u64 identity = ffi_replaced_identity;
    pthread_mutex_unlock(&ffi_replaced_lock);
    pthread_mutex_lock(&ffi_queue_lock);
    close->callback_identity = identity;
    pthread_mutex_unlock(&ffi_queue_lock);
}

void mal_ffi_close_cancel(MalFfiCallback *callback, void **pin) {
    if (callback == nullptr) return;
    MalFfiKept *kept = (MalFfiKept *) callback;
    MalFfiClose *close = kept->close;
    if (close == nullptr || !close->committed) return;
    pthread_mutex_lock(&ffi_queue_lock);
    MalFfiClose **entry = &ffi_closes;
    while (*entry != nullptr && *entry != close) entry = &(*entry)->next;
    if (*entry != close) abort();
    *entry = close->next;
    pthread_mutex_unlock(&ffi_queue_lock);
    MalFfiHandleObject *handle = ffi_handle(close->handle);
    if (*pin != nullptr || handle == nullptr || handle->value != close->key) abort();
    *pin = handle;
    handle->closing = false;
    ffi_handle_worker_closing(handle, false);
    handle->scope = close->scope;
    handle->operation = close->operation;
    if (close->storage != nullptr) {
        handle->owns_storage = true;
        close->storage = nullptr;
    }
    kept->close = nullptr;
    ffi_close_free(close);
}

MalFfiCallback *mal_ffi_close_take(const void *site, void *key, MalFfiCallback *data) {
    pthread_mutex_lock(&ffi_queue_lock);
    MalFfiClose **entry = &ffi_closes;
    while (*entry != nullptr && !((*entry)->site == site
        && (data != nullptr ? (*entry)->callback == data : (*entry)->key == key)))
        entry = &(*entry)->next;
    MalFfiClose *close = *entry;
    MalFfiCallback *callback = nullptr;
    if (close != nullptr) {
        *entry = close->next;
        key = close->key;
        callback = close->callback;
        atomic_fetch_add_explicit(&((MalFfiKept *) callback)->references, 1, memory_order_relaxed);
    }
    pthread_mutex_unlock(&ffi_queue_lock);
    if (close != nullptr) ffi_replaced_drop_before(key, close->callback_identity);
    return callback;
}

MalValue mal_ffi_close_value(MalFfiCallback *callback) {
    return ((MalFfiKept *) callback)->close->handle;
}

void mal_ffi_close_finish(MalFfiCallback *callback) {
    ffi_close_detach((MalFfiKept *) callback);
}

void mal_ffi_close_return(MalFfiCallback *callback) {
    if (callback == nullptr) return;
    mal_ffi_release(callback);
    ffi_kept_unref((MalFfiKept *) callback);
}

static void ffi_handle_trace(MalHeapHeader *cell) {
    MalFfiHandleObject *handle = (MalFfiHandleObject *) cell;
    if (handle->ownership == MAL_FFI_HANDLE_CHILD)
        mal_gc_mark_value(mal_value_from_heap((MalHeapHeader *) handle->owner));
    if (handle->native != nullptr)
        for (MalFfiKept *kept = handle->native->callbacks; kept != nullptr; kept = kept->owner_next) {
            mal_gc_mark_value(kept->callback.function);
            for (MalFfiResultCopy *input = kept->callback.inputs; input != nullptr; input = input->next)
                if (input->contained) mal_gc_mark_value(input->handle->wrapper);
        }
    if (handle->retained == nullptr) return;
    for (i32 index = 0; index < handle->type->managed_field_count; index++)
        mal_gc_mark_value(handle->retained[index].buffer);
}

static void ffi_handle_finalize(MalHeapHeader *cell) {
    MalFfiHandleObject *handle = (MalFfiHandleObject *) cell;
    bool previous = ffi_finalizing;
    ffi_finalizing = true;
    MalFfiNativeHandle *native = handle->native;
    if (native != nullptr) {
        ffi_native_handle_unregister(native);
        native->wrapper = mal_value_new_undefined();
        native->value = handle->value;
        native->owner_type = ffi_handle_policy(handle);
        native->owned = handle->ownership == MAL_FFI_HANDLE_OWNED;
        native->owns_storage = handle->owns_storage;
        handle->native = nullptr;
        handle->owns_storage = false;
    } else if (handle->value != nullptr && handle->ownership == MAL_FFI_HANDLE_OWNED && ffi_handle_policy(handle)->collect
        && ffi_handle_policy(handle)->destroy != nullptr) {
        if (ffi_handle_policy(handle)->destroy(handle->value)) ffi_replaced_drop(handle->value);
    }
    ffi_handle_forget(handle);
    if (native != nullptr) ffi_native_handle_drop(native, false);
    while (handle->views != nullptr) {
        MalFfiHandleView *view = handle->views;
        handle->views = view->next;
        free(view);
    }
    ffi_finalizing = previous;
}

static MalValue ffi_handle_dispose(
    MalVm *vm, MalValue this_value, const MalValue *args, i32 argc, MalValue new_target,
    MalValue callee) {
    (void) args;
    (void) argc;
    (void) new_target;
    (void) callee;
    MalFfiHandleObject *handle = ffi_handle(this_value);
    if (handle == nullptr) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "[Symbol.dispose] requires a C library handle");
        return mal_value_new_undefined();
    }
    if (handle->pins > 0 || handle->closing || handle->provisional || ffi_handle_borrowed(handle)) {
        mal_vm_throw_error(
            vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Cannot close a C library handle while a C call uses it");
        return mal_value_new_undefined();
    }
    if (handle->value != nullptr) {
        void *value = handle->value;
        const MalFfiHandleType *owner = ffi_handle_policy(handle);
        bool release = handle->ownership == MAL_FFI_HANDLE_OWNED && owner->destroy != nullptr;
        handle->closing = true;
        // Unconditional release can hand out the same pointer again. A conditional
        // release keeps its identity until C confirms it stopped owning the resource.
        if (!handle->owns_storage && handle->type->size == 0 && (!release || !owner->destroy_can_fail))
            ffi_handle_forget(handle);
        if (release) {
            if (!owner->destroy(value)) {
                handle->closing = false;
                if (vm->completion.kind != MAL_COMPLETION_THROW) {
                    char message[512];
                    snprintf(message, sizeof(message), "%s did not release the %s handle",
                        owner->destroy_name, owner->name);
                    mal_vm_throw_error(vm, MAL_INTRINSIC_ERROR_PROTOTYPE, (const byte *) message);
                }
                return mal_value_new_undefined();
            }
            ffi_replaced_drop(value);
            if (handle->native != nullptr) ffi_owner_finish(handle->native, true);
        }
        ffi_handle_forget(handle);
        handle->closing = false;
    }
    return mal_value_new_undefined();
}

static MalValue ffi_handle_prototype(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type) {
    usize name_length = strlen("type:") + strlen(type->name) + 1;
    char *name = malloc(name_length);
    if (name == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    snprintf(name, name_length, "type:%s", type->name);
    char *identity = ffi_identity(vm, library, name);
    free(name);
    if (identity == nullptr) return mal_value_new_undefined();
    MalValue cached;
    if (ffi_prepared(vm, identity, &cached)) {
        free(identity);
        return cached;
    }
    MalValue held[2] = {
        mal_value_from_object(mal_object_new(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]))),
        mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, held, 2);
    MalObject *prototype = mal_value_to_object(held[0]);
    mal_intrinsic_define_symbol_method(
        vm, prototype, MAL_INTRINSIC_SYMBOL_DISPOSE, (const byte *) "[Symbol.dispose]",
        ffi_handle_dispose);
    held[1] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) type->name));
    MalValue tag = vm->intrinsics[MAL_INTRINSIC_SYMBOL_TO_STRING_TAG];
    if (mal_value_is_symbol(tag)) {
        MalPropertyDesc description = {.value = held[1], .flags = MAL_PROPERTY_CONFIGURABLE};
        mal_object_define_own(prototype, mal_key_from_value(tag), &description);
    }
    for (i32 index = 0; index < type->field_count + type->view_field_count; index++) {
        // Install guarded view names up front: C may refine a frozen canonical wrapper.
        const MalFfiField *field = index < type->field_count
            ? &type->fields[index] : &type->view_fields[index - type->field_count];
        char getter_name[128];
        char setter_name[128];
        snprintf(getter_name, sizeof(getter_name), "get %s", field->name);
        snprintf(setter_name, sizeof(setter_name), "set %s", field->name);
        mal_intrinsic_define_accessor_n(
            vm, prototype, mal_intrinsic_string_key(vm, (const byte *) field->name),
            (const byte *) getter_name, 0, field->get, (const byte *) setter_name, 1, field->set,
            MAL_PROPERTY_CONFIGURABLE);
    }
    MalValue result = held[0];
    mal_gc_unroot(&root);
    if (!ffi_prepare(vm, identity, result)) return mal_value_new_undefined();
    return result;
}

static bool ffi_scope_active(MalVm *vm, u64 scope) {
    if (scope == 0) return true;
    MalFfiState *state = vm->ffi;
    if (state == nullptr) return false;
    for (usize index = state->invocation_depth; index > 0; index--) {
        if (state->invocations[index - 1] == scope) return true;
    }
    return false;
}

static bool ffi_handle_owners_open(MalVm *vm, MalFfiHandleObject *handle) {
    for (MalFfiHandleObject *owner = ffi_handle_owner(handle); owner != nullptr; owner = ffi_handle_owner(owner))
        if (owner->value == nullptr || owner->closing || !ffi_scope_active(vm, owner->scope)) return false;
    return true;
}

static bool ffi_handle_owner_expired(MalVm *vm, MalFfiHandleObject *handle) {
    for (MalFfiHandleObject *owner = ffi_handle_owner(handle); owner != nullptr; owner = ffi_handle_owner(owner))
        if (owner->value == nullptr || !ffi_scope_active(vm, owner->scope)) return true;
    return false;
}

enum {
    MAL_FFI_DISCARD_PRESENT = 1,
    MAL_FFI_DISCARD_VALID = 2,
    MAL_FFI_DISCARD_REPLACEABLE = 4,
};

static u32 ffi_discard_flags(MalVm *vm, MalFfiHandleObject *handle) {
    u32 flags = MAL_FFI_DISCARD_PRESENT;
    if (handle->value != nullptr && ffi_scope_active(vm, handle->scope)
        && !ffi_handle_owner_expired(vm, handle)) flags |= MAL_FFI_DISCARD_VALID;
    if (handle->closing || !ffi_handle_owners_open(vm, handle)) flags |= MAL_FFI_DISCARD_REPLACEABLE;
    return flags;
}

static void ffi_discards_freeze(MalVm *vm, MalFfiState *state) {
    MalFfiDiscardState *discards = state->discards;
    if (discards == nullptr) return;
    // The host joins blocking work before heap finalization. Reuse the weak table
    // without allocating at teardown, and leave native readers no VM pointers.
    for (usize index = 0; index < state->handle_capacity; index++) {
        MalFfiHandleEntry *entry = &state->handles[index];
        entry->claim = entry->handle == nullptr ? 0 : ffi_discard_flags(vm, entry->handle);
    }
    discards->claims = state->handles;
    discards->capacity = state->handle_capacity;
    state->handles = nullptr;
    atomic_store_explicit(&discards->frozen, true, memory_order_release);
}

bool mal_ffi_discards_init(MalVm *vm, MalFfiDiscards *discards,
    MalFfiDiscardedHandle *items, int32_t capacity) {
    MalFfiState *state = ffi_state(vm);
    if (state == nullptr) return mal_ffi_out_of_memory(vm);
    if (state->discards == nullptr) {
        MalFfiDiscardState *shared = calloc(1, sizeof(*shared));
        if (shared == nullptr) return mal_ffi_out_of_memory(vm);
        atomic_init(&shared->references, 1);
        atomic_init(&shared->frozen, false);
        state->discards = shared;
    }
    atomic_fetch_add_explicit(&state->discards->references, 1, memory_order_relaxed);
    *discards = (MalFfiDiscards) {.state = state->discards, .items = items, .capacity = capacity};
    return true;
}

void mal_ffi_discards_finish(MalFfiDiscards *discards) {
    ffi_discards_drop(discards->state);
    discards->state = nullptr;
}

static MalFfiResultClaim *ffi_result_pending(MalVm *vm, const MalFfiHandleType *type,
    void *value, MalFfiResults *exclude);

bool mal_ffi_same_resource(const MalFfiHandleType *left_type, const void *left,
    const MalFfiHandleType *right_type, const void *right) {
    return left == right && ffi_handle_family(left_type) == ffi_handle_family(right_type);
}

bool mal_ffi_discard_needed(MalVm *vm, const MalFfiDiscards *discards,
    const MalFfiHandleType *type, const void *value, bool fresh) {
    if (value == nullptr) return false;
    if (vm != nullptr && ffi_result_pending(vm, type, (void *) value, nullptr) != nullptr) return false;
    const MalFfiHandleType *family = ffi_handle_family(type);
    if (ffi_retired_blocks(type, value, fresh)) return false;
    if (mal_ffi_is_library_resource(type, value)) return false;
    u32 flags = 0;
    if (vm != nullptr) {
        MalFfiHandleObject *known = vm->ffi == nullptr ? nullptr : ffi_handle_find(vm->ffi, family, value);
        if (known != nullptr) flags = ffi_discard_flags(vm, known);
    } else {
        MalFfiDiscardState *state = discards->state;
        if (state == nullptr || !atomic_load_explicit(&state->frozen, memory_order_acquire)) abort();
        if (state->capacity != 0)
            for (usize slot = ffi_handle_slot(family, value, state->capacity);;
                 slot = (slot + 1) & (state->capacity - 1)) {
                const MalFfiHandleEntry *entry = &state->claims[slot];
                if (entry->claim == 0) break;
                if (entry->type == family && entry->pointer == value) { flags = (u32) entry->claim; break; }
            }
    }
    return !(flags & MAL_FFI_DISCARD_VALID) || (fresh && (flags & MAL_FFI_DISCARD_REPLACEABLE));
}

void mal_ffi_discard_resource(MalVm *vm, const MalFfiDiscards *discards,
    const MalFfiHandleType *type, void *value, bool fresh) {
    if (!mal_ffi_discard_needed(vm, discards, type, value, fresh)) return;
    MalCompletion completion = vm == nullptr ? (MalCompletion) {0} : vm->completion;
    MalRootSpan root;
    if (vm != nullptr) mal_gc_root(&root, &completion.value, 1);
    bool previous = ffi_finalizing;
    ffi_finalizing = true;
    if (type->destroy(value)) ffi_replaced_drop(value);
    ffi_finalizing = previous;
    if (vm != nullptr) {
        vm->completion = completion;
        mal_gc_unroot(&root);
    }
}

bool mal_ffi_discard_claim(MalVm *vm, MalFfiDiscards *discards,
    const MalFfiHandleType *type, const void *value, bool fresh) {
    if (value == nullptr) return false;
    const MalFfiHandleType *family = ffi_handle_family(type);
    MalFfiDiscardedHandle *item = nullptr;
    for (i32 index = 0; index < discards->count; index++) {
        if (discards->items[index].family != family || discards->items[index].value != value) continue;
        item = &discards->items[index];
        if (item->claimed) return false;
        break;
    }
    if (item == nullptr) {
        if (discards->count == discards->capacity) abort();
        item = &discards->items[discards->count++];
        *item = (MalFfiDiscardedHandle) {.family = family, .value = value};
    }
    item->claimed = mal_ffi_discard_needed(vm, discards, type, value, fresh);
    return item->claimed;
}

bool mal_ffi_callback_enter(MalVm *vm) {
    MalFfiState *state = ffi_state(vm);
    if (state != nullptr && state->invocation_depth == state->invocation_capacity) {
        usize capacity = state->invocation_capacity == 0 ? 8 : state->invocation_capacity * 2;
        u64 *grown = realloc(state->invocations, capacity * sizeof(*grown));
        if (grown == nullptr) {
            state = nullptr;
        } else {
            state->invocations = grown;
            state->invocation_capacity = capacity;
        }
    }
    if (state == nullptr) return mal_ffi_out_of_memory(vm);
    state->invocations[state->invocation_depth++] = ++state->last_invocation;
    return true;
}

void mal_ffi_callback_leave(MalVm *vm) {
    vm->ffi->invocation_depth--;
}

void *mal_ffi_allocate_storage(size_t count, size_t size, size_t alignment) {
    if (size != 0 && count > SIZE_MAX / size) return nullptr;
    size *= count;
    if (alignment <= _Alignof(max_align_t)) return malloc(size);
    size_t remainder = size % alignment;
    if (remainder != 0) {
        size_t padding = alignment - remainder;
        if (size > SIZE_MAX - padding) return nullptr;
        size += padding;
    }
    return aligned_alloc(alignment, size);
}

void *mal_ffi_calloc_storage(size_t count, size_t size, size_t alignment) {
    void *storage = mal_ffi_allocate_storage(count, size, alignment);
    if (storage != nullptr) memset(storage, 0, count * size);
    return storage;
}

void *mal_ffi_scratch_allocate(MalVm *vm, MalFfiScratch *scratch, size_t count,
    size_t size, size_t alignment, size_t reserve) {
    if (size != 0 && count > SIZE_MAX / size) return nullptr;
    size_t bytes = count * size;
    enum { minimum = 4096, maximum = 64 * 1024 };
    if (bytes == 0 || bytes > maximum || alignment > _Alignof(max_align_t))
        return mal_ffi_allocate_storage(count, size, alignment);
    if (scratch->data == nullptr) {
        MalFfiState *state = ffi_state(vm);
        if (state == nullptr) return mal_ffi_allocate_storage(count, size, alignment);
        size_t wanted = reserve > maximum / bytes ? maximum : bytes * reserve;
        size_t capacity = minimum;
        while (capacity < wanted) capacity *= 2;
        if (state->scratch_data != nullptr && state->scratch_capacity >= capacity) {
            scratch->data = state->scratch_data;
            scratch->capacity = state->scratch_capacity;
            state->scratch_data = nullptr;
            state->scratch_capacity = 0;
        } else {
            scratch->data = malloc(capacity);
            if (scratch->data == nullptr)
                return mal_ffi_allocate_storage(count, size, alignment);
            scratch->capacity = capacity;
        }
    }
    size_t offset = (scratch->used + alignment - 1) & ~(alignment - 1);
    if (bytes > scratch->capacity - offset)
        return mal_ffi_allocate_storage(count, size, alignment);
    scratch->used = offset + bytes;
    return (byte *) scratch->data + offset;
}

void mal_ffi_scratch_free(MalFfiScratch *scratch, void *data) {
    uintptr_t start = (uintptr_t) scratch->data;
    if (scratch->data != nullptr && (uintptr_t) data >= start
        && (uintptr_t) data - start < scratch->capacity) return;
    free(data);
}

void mal_ffi_scratch_release(MalVm *vm, MalFfiScratch *scratch) {
    if (scratch->data == nullptr) return;
    MalFfiState *state = vm->ffi;
    if (state != nullptr && state->scratch_capacity < scratch->capacity) {
        free(state->scratch_data);
        state->scratch_data = scratch->data;
        state->scratch_capacity = scratch->capacity;
    } else free(scratch->data);
    *scratch = (MalFfiScratch) {0};
}

static bool ffi_type_supports(const MalFfiHandleType *actual, const MalFfiHandleType *expected) {
    if (actual == expected) return true;
    for (i32 index = 0; index < actual->view_count; index++) {
        if (actual->views[index] == expected) return true;
    }
    return false;
}

static MalFfiResultClaim *ffi_result_find(MalFfiResults *results,
    const MalFfiHandleType *type, void *value) {
    if (results->lookup != nullptr) {
        const MalFfiHandleType *family = ffi_handle_family(type);
        for (usize slot = ffi_handle_slot(family, value, results->lookup_capacity);;
             slot = (slot + 1) & (results->lookup_capacity - 1)) {
            i32 found = results->lookup[slot];
            if (found == 0) return nullptr;
            MalFfiResultClaim *claim = &results->claims[found - 1];
            if (claim->value == value && ffi_handle_family(claim->type) == family) return claim;
        }
    }
    for (i32 index = 0; index < results->count; index++) {
        MalFfiResultClaim *claim = &results->claims[index];
        if (claim->value == value && ffi_handle_family(claim->type) == ffi_handle_family(type)) return claim;
    }
    return nullptr;
}


static MalFfiResultClaim *ffi_result_pending(MalVm *vm, const MalFfiHandleType *type,
    void *value, MalFfiResults *exclude) {
    MalFfiState *state = vm->ffi;
    for (MalFfiResults *results = state == nullptr ? nullptr : state->results;
         results != nullptr; results = results->previous) {
        if (results == exclude) continue;
        MalFfiResultClaim *claim = ffi_result_find(results, type, value);
        if (claim != nullptr && claim->cleanup && !claim->handed_off) return claim;
    }
    return nullptr;
}

static void ffi_result_track(MalVm *vm, const MalFfiHandleType *type, void *value, MalValue wrapper) {
    MalFfiState *state = vm->ffi;
    for (MalFfiResults *results = state == nullptr ? nullptr : state->results;
         results != nullptr; results = results->previous) {
        MalFfiResultClaim *claim = ffi_result_find(results, type, value);
        if (claim == nullptr) continue;
        if (mal_value_is_undefined(claim->handles[1])) claim->handles[1] = wrapper;
        if (claim->cleanup && claim->handles[1] == wrapper) ffi_handle(wrapper)->provisional = true;
    }
}

static void ffi_result_delivered(MalVm *vm, MalFfiHandleObject *handle) {
    if (handle == nullptr || handle->value == nullptr || handle->closing || handle->scope != 0) return;
    for (MalFfiResults *results = vm->ffi == nullptr ? nullptr : vm->ffi->results;
         results != nullptr; results = results->previous) {
        MalFfiResultClaim *claim = ffi_result_find(results, handle->type, handle->value);
        if (claim == nullptr || claim->owner_type != nullptr) continue;
        if (mal_value_is_undefined(claim->handles[1]))
            claim->handles[1] = mal_value_from_heap((MalHeapHeader *) handle);
        if (ffi_handle(claim->handles[1]) == handle) claim->handed_off = true;
    }
}

static bool ffi_handle_published_supports(MalFfiHandleObject *handle, const MalFfiHandleType *type) {
    if (ffi_type_supports(handle->type, type)) return true;
    for (MalFfiHandleView *view = handle->views; view != nullptr; view = view->next) {
        if (ffi_type_supports(view->type, type)) return true;
    }
    return false;
}

static __attribute__((noinline)) bool ffi_handle_supports(MalFfiHandleObject *handle, const MalFfiHandleType *type) {
    if (ffi_handle_published_supports(handle, type)) return true;
    if (handle->provisional && handle->registry != nullptr)
        for (MalFfiResults *results = handle->registry->results; results != nullptr; results = results->previous) {
            MalFfiResultClaim *claim = ffi_result_find(results, handle->type, handle->value);
            if (claim == nullptr || ffi_handle(claim->handles[1]) != handle) continue;
            for (MalFfiHandleView *view = claim->views; view != nullptr; view = view->next)
                if (ffi_type_supports(view->type, type)) return true;
        }
    return false;
}

/** `scope` 0 makes a handle the program holds; otherwise it lives as long as that invocation. */
static MalValue ffi_new_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value,
    bool owned, u64 scope, bool owns_storage, bool fresh, MalFfiResultClaim *claim) {
    if (claim == nullptr && type->size == 0) {
        MalFfiResultClaim *pending = ffi_result_pending(vm, type, value, nullptr);
        if (pending != nullptr) {
            if (owned && type->destroy != nullptr) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    (const byte *) "A pending C resource requires a complete result ownership transaction");
                return mal_value_new_undefined();
            }
            claim = pending;
            scope = 0;
            fresh = pending->fresh;
        }
    }
    if (owned && mal_ffi_is_library_resource(type, value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "Cannot take ownership of a library-lifetime C resource");
        return mal_value_new_undefined();
    }
    MalFfiState *state = type->size == 0 ? ffi_state(vm) : nullptr;
    MalFfiHandleObject *open = state == nullptr ? nullptr : ffi_handle_find(state, ffi_handle_family(type), value);
    if (fresh && open != nullptr && (open->closing || !ffi_handle_owners_open(vm, open))) {
        ffi_replaced_drop(open->value);
        ffi_handle_forget(open);
        open = nullptr;
    }
    if (open != nullptr && (!ffi_scope_active(vm, open->scope) || ffi_handle_owner_expired(vm, open))) {
        // C may reuse a callback's stack address for a different resource or type.
        ffi_handle_forget(open);
        open = nullptr;
    }
    if (type->size == 0 && open == nullptr && !ffi_retired_guard(vm, type, value, fresh))
        return mal_value_new_undefined();
    if (open != nullptr) {
        if (owned && ffi_handle_owner(open) != nullptr) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                (const byte *) "Cannot take ownership of an owner-bound C resource");
            return mal_value_new_undefined();
        }
        if (open->type != type && !ffi_handle_published_supports(open, type)) {
            bool staged = false;
            for (MalFfiHandleView *pending = claim == nullptr ? nullptr : claim->views;
                 pending != nullptr; pending = pending->next)
                if (ffi_type_supports(pending->type, type)) { staged = true; break; }
            if (!staged) {
                MalFfiHandleView *view = malloc(sizeof(*view));
                if (view == nullptr) {
                    mal_vm_throw_allocation_error(vm);
                    return mal_value_new_undefined();
                }
                if (claim != nullptr) {
                    *view = (MalFfiHandleView) {type, claim->views};
                    claim->views = view;
                } else {
                    *view = (MalFfiHandleView) {type, open->views};
                    open->views = view;
                }
            }
        }
        if (claim == nullptr && owned && !open->owns_storage
            && (open->ownership != MAL_FFI_HANDLE_OWNED || ffi_handle_policy(open)->destroy == nullptr)) {
            open->ownership = MAL_FFI_HANDLE_OWNED;
            open->owner_type = type;
        }
        // A nested loan must not shorten an outer invocation's still-active loan.
        if (claim == nullptr && (scope == 0 || !ffi_scope_active(vm, open->scope))) open->scope = scope;
        MalValue result = mal_value_from_heap((MalHeapHeader *) open);
        if (claim != nullptr) ffi_result_track(vm, type, value, result);
        return result;
    }
    void *stored = value;
    if (type->size > 0) {
        stored = mal_ffi_allocate_storage(1, type->size, type->alignment);
        if (stored != nullptr) memcpy(stored, value, type->size);
        owns_storage = true;
    }
    MalFfiResultClaim *responsible = type->size == 0 ? ffi_result_pending(vm, type, value, nullptr) : nullptr;
    // The originating claim owns the initial type; nested refinements publish at commit.
    const MalFfiHandleType *canonical = responsible == nullptr ? type : responsible->type;
    MalValue prototype =
        stored == nullptr ? mal_value_new_undefined() : ffi_handle_prototype(vm, library, canonical);
    if (stored == nullptr || vm->completion.kind == MAL_COMPLETION_THROW) {
        // A staged result leaves cleanup to its enclosing conversion transaction.
        if (claim == nullptr && owned && type->destroy != nullptr) type->destroy(value);
        if (owns_storage) free(stored);
        if (vm->completion.kind != MAL_COMPLETION_THROW) mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    MalValue rooted[2] = {prototype, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, rooted, 2);
    MalFfiHandleObject *handle =
        mal_heap_try_alloc(&vm->heap, sizeof(MalFfiHandleObject), MAL_HEAP_FFI_HANDLE_OBJECT);
    if (handle == nullptr) {
        if (claim == nullptr && owned && type->destroy != nullptr) type->destroy(stored);
        if (owns_storage) free(stored);
        mal_gc_unroot(&root);
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    handle->ownership = MAL_FFI_HANDLE_BORROWED;
    mal_object_init(
        &vm->heap, &handle->object, MAL_HEAP_FFI_HANDLE_OBJECT, mal_value_to_object(prototype));
    rooted[1] = mal_value_from_heap((MalHeapHeader *) handle);
    handle->type = canonical;
    handle->owner_type = canonical;
    handle->views = nullptr;
    handle->retained = nullptr;
    handle->native = nullptr;
    handle->operation = nullptr;
    handle->value = stored;
    handle->ownership = claim == nullptr && owned ? MAL_FFI_HANDLE_OWNED : MAL_FFI_HANDLE_BORROWED;
    handle->owns_storage = owns_storage;
    handle->closing = false;
    handle->worker_closing = false;
    handle->worker_close_next = nullptr;
    handle->provisional = false;
    handle->registry = nullptr;
    handle->pins = 0;
    handle->worker_pins = 0;
    handle->scope = scope;
    if (vm->completion.kind != MAL_COMPLETION_THROW && owns_storage && type->managed_field_count > 0) {
        handle->retained = calloc((usize) type->managed_field_count, sizeof(*handle->retained));
        if (handle->retained != nullptr) {
            for (i32 index = 0; index < type->managed_field_count; index++)
                handle->retained[index].buffer = mal_value_new_undefined();
        } else {
            mal_vm_throw_allocation_error(vm);
        }
    }
    if (vm->completion.kind != MAL_COMPLETION_THROW && type->size == 0
        && (state == nullptr || !ffi_handle_register(state, handle))) {
        mal_vm_throw_allocation_error(vm);
    }
    if (vm->completion.kind == MAL_COMPLETION_THROW) {
        if (claim == nullptr && owned && type->destroy != nullptr) type->destroy(stored);
        ffi_handle_forget(handle);
    }
    if (claim != nullptr && !mal_ffi_threw(vm)) ffi_result_track(vm, type, value, rooted[1]);
    if (canonical != type && !mal_ffi_threw(vm))
        rooted[1] = ffi_new_handle(vm, library, type, value, owned, scope, false, fresh, claim);
    mal_gc_unroot(&root);
    return vm->completion.kind == MAL_COMPLETION_THROW ? mal_value_new_undefined()
        : rooted[1];
}

void mal_ffi_results_init(MalFfiResults *results, MalFfiResultClaim *claims,
    MalValue *handles, int32_t capacity) {
    *results = (MalFfiResults) {.claims = claims, .capacity = capacity};
    for (i32 index = 0; index < 2 * capacity; index++) handles[index] = mal_value_new_undefined();
    mal_ffi_root(&results->roots, handles, 2 * capacity);
}

bool mal_ffi_results_reserve(MalVm *vm, MalFfiResults *results, uint64_t capacity) {
    if (capacity <= (u64) results->capacity) return true;
    if (results->count != 0) abort();
    if (capacity > INT32_MAX / 2) goto mal_failed;
    usize count = (usize) capacity;
    usize lookup_capacity = 1;
    while (lookup_capacity < count * 2) lookup_capacity *= 2;
    if (lookup_capacity > SIZE_MAX / sizeof(i32)) goto mal_failed;
    usize lookup_bytes = lookup_capacity * sizeof(i32);
    usize padding = _Alignof(MalValue) - 1;
    usize stride = sizeof(MalFfiResultClaim) + 2 * sizeof(MalValue);
    if (lookup_bytes > SIZE_MAX - padding || count > (SIZE_MAX - lookup_bytes - padding) / stride) goto mal_failed;
    void *allocation = calloc(1, count * stride + lookup_bytes + padding);
    if (allocation == nullptr) goto mal_failed;
    void *previous = results->allocation;
    results->allocation = allocation;
    results->claims = allocation;
    results->capacity = (i32) count;
    usize roots_offset = (count * sizeof(MalFfiResultClaim) + padding) & ~padding;
    results->roots.slots = (MalValue *) ((byte *) allocation + roots_offset);
    results->roots.count = (i32) count * 2;
    results->lookup = (i32 *) (results->roots.slots + count * 2);
    results->lookup_capacity = lookup_capacity;
    for (i32 index = 0; index < results->roots.count; index++)
        results->roots.slots[index] = mal_value_new_undefined();
    free(previous);
    return true;
mal_failed:
    return mal_ffi_threw(vm) ? false : mal_ffi_out_of_memory(vm);
}

static MalFfiResultClaim *ffi_result_insert(MalFfiResults *results,
    const MalFfiHandleType *type, void *value) {
    if (results->count == results->capacity) abort();
    i32 index = results->count++;
    MalFfiResultClaim *claim = &results->claims[index];
    *claim = (MalFfiResultClaim) {.type = type, .value = value,
        .handles = &results->roots.slots[2 * index]};
    if (results->lookup != nullptr) {
        usize slot = ffi_handle_slot(ffi_handle_family(type), value, results->lookup_capacity);
        while (results->lookup[slot] != 0) slot = (slot + 1) & (results->lookup_capacity - 1);
        results->lookup[slot] = index + 1;
    }
    return claim;
}

void mal_ffi_result_hint(MalFfiResults *results, const MalFfiHandleType *type, void *value) {
    if (value == nullptr) return;
    MalFfiResultClaim *claim = ffi_result_find(results, type, value);
    if (claim == nullptr) claim = ffi_result_insert(results, type, value);
    claim->fresh = true;
}

void mal_ffi_result_claim(MalVm *vm, MalFfiResults *results,
    const MalFfiHandleType *type, void *value, bool owned, bool fresh) {
    if (value == nullptr) return;
    MalFfiResultClaim *claim = ffi_result_find(results, type, value);
    fresh |= claim != nullptr && claim->fresh;
    if (!ffi_retired_guard(vm, type, value, fresh)) return;
    if (results->state == nullptr) {
        MalFfiState *state = ffi_state(vm);
        if (state == nullptr) { if (!mal_ffi_threw(vm)) mal_ffi_out_of_memory(vm); }
        else {
            results->state = state;
            results->previous = state->results;
            state->results = results;
        }
    }
    if (claim == nullptr) claim = ffi_result_insert(results, type, value);
    if (!claim->inventoried) {
        // Fresh hints share identity; the first actual claim chooses canonical metadata.
        claim->type = type;
        claim->inventoried = true;
        MalFfiHandleObject *open = vm->ffi == nullptr ? nullptr
            : ffi_handle_find(vm->ffi, ffi_handle_family(type), value);
        if (open != nullptr) {
            claim->handles[0] = mal_value_from_heap((MalHeapHeader *) open);
            claim->flags = ffi_discard_flags(vm, open);
        }
    }
    if (owned && type->destroy != nullptr && claim->owner_type == nullptr) claim->owner_type = type;
    claim->fresh |= fresh;
    bool replaces = claim->fresh && (claim->flags & MAL_FFI_DISCARD_REPLACEABLE);
    claim->cleanup = claim->owner_type != nullptr && !mal_ffi_is_library_resource(type, value)
        && ffi_result_pending(vm, type, value, results) == nullptr
        && (!(claim->flags & MAL_FFI_DISCARD_VALID) || replaces);
    if (replaces && claim->handles[1] == claim->handles[0])
        claim->handles[1] = mal_value_new_undefined();
    else if (!replaces && (claim->flags & MAL_FFI_DISCARD_VALID)
        && mal_value_is_undefined(claim->handles[1])) claim->handles[1] = claim->handles[0];
}

MalValue mal_ffi_result_handle(MalVm *vm, MalFfiResults *results,
    const MalFfiLibrary *library, const MalFfiHandleType *type, void *value,
    bool owned, bool fresh) {
    if (value == nullptr) return mal_value_new_null();
    MalFfiResultClaim *claim = ffi_result_find(results, type, value);
    MalFfiHandleObject *prior = claim == nullptr ? nullptr : ffi_handle(claim->handles[1]);
    if (claim != nullptr && ((prior != nullptr && (prior->value != value || prior->closing))
        || (claim->handed_off && prior == nullptr))) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
            (const byte *) "A C result resource was released during conversion");
        return mal_value_new_undefined();
    }
    MalValue result = ffi_new_handle(vm, library, type, value, owned, 0, false,
        claim == nullptr ? fresh : claim->fresh, claim);
    if (claim != nullptr && !mal_ffi_threw(vm)) claim->handles[1] = result;
    return result;
}

static void ffi_result_retire(MalFfiHandleObject *handle, const MalFfiHandleType *type) {
    MalFfiNativeHandle *native = handle->native;
    if (native != nullptr) {
        ffi_native_handle_unregister(native);
        native->value = handle->value;
        native->owner_type = type;
        native->owned = true;
        native->owns_storage = handle->owns_storage;
        native->force_destroy = true;
        ffi_retired_register(native);
        handle->native = nullptr;
        handle->owns_storage = false;
    }
    ffi_handle_forget(handle);
    if (native != nullptr) ffi_native_handle_drop(native, false);
}

void mal_ffi_results_finish(MalVm *vm, MalFfiResults *results) {
    if (!mal_ffi_threw(vm))
        for (i32 index = 0; index < results->count; index++) {
            MalFfiResultClaim *claim = &results->claims[index];
            MalFfiHandleObject *handle = ffi_handle(claim->handles[1]);
            if ((handle != nullptr && (handle->value != claim->value || handle->closing))
                || (claim->handed_off && handle == nullptr)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE,
                    (const byte *) "A C result resource was released during conversion");
                break;
            }
        }
    MalCompletion completion = vm->completion;
    MalRootSpan root;
    mal_gc_root(&root, &completion.value, 1);
    bool failed = completion.kind == MAL_COMPLETION_THROW;
    for (i32 index = 0; index < results->count; index++) {
        MalFfiResultClaim *claim = &results->claims[index];
        MalFfiHandleObject *handle = ffi_handle(claim->handles[1]);
        bool retired = false;
        if (!failed && handle != nullptr) {
            if (claim->owner_type != nullptr && !handle->owns_storage
                && (handle->ownership != MAL_FFI_HANDLE_OWNED || ffi_handle_policy(handle)->destroy == nullptr)) {
                handle->ownership = MAL_FFI_HANDLE_OWNED;
                handle->owner_type = claim->owner_type;
            }
            if (claim->owner_type != nullptr) {
                handle->scope = 0;
                handle->provisional = false;
            } else ffi_result_delivered(vm, handle);
            for (MalFfiResults *ancestor = results->previous; ancestor != nullptr; ancestor = ancestor->previous) {
                MalFfiResultClaim *parent = ffi_result_find(ancestor, claim->type, claim->value);
                if (parent == nullptr || parent->handles[1] != claim->handles[1]) continue;
                if (claim->owner_type != nullptr) parent->cleanup = false;
                if (claim->owner_type != nullptr || parent->owner_type == nullptr)
                    parent->handed_off = true;
            }
        } else if (!claim->handed_off && handle != nullptr && claim->handles[1] != claim->handles[0]
            && ffi_result_pending(vm, claim->type, claim->value, results) == nullptr) {
            if (claim->cleanup && handle->native != nullptr) {
                ffi_result_retire(handle, claim->owner_type);
                retired = true;
            } else if (!ffi_handle_borrowed(handle)) ffi_handle_forget(handle);
        }
        while (claim->views != nullptr) {
            MalFfiHandleView *view = claim->views;
            claim->views = view->next;
            if (!failed && handle != nullptr && !ffi_handle_published_supports(handle, view->type)) {
                view->next = handle->views;
                handle->views = view;
            } else free(view);
        }
        if (failed && claim->cleanup && !retired && claim->owner_type->destroy(claim->value))
            ffi_replaced_drop(claim->value);
        vm->completion = completion;
    }
    if (results->state != nullptr) {
        MalFfiState *state = results->state;
        if (state->results != results) abort();
        state->results = results->previous;
    }
    mal_gc_unroot(&root);
    mal_ffi_unroot(&results->roots);
    free(results->allocation);
}

MalValue mal_ffi_new_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value,
    bool owned, bool fresh) {
    MalValue result = ffi_new_handle(vm, library, type, value, owned, 0, false, fresh, nullptr);
    if (vm->ffi != nullptr && vm->ffi->results != nullptr && !mal_ffi_threw(vm))
        ffi_result_delivered(vm, ffi_handle(result));
    return result;
}

static bool ffi_handle_can_adopt(
    MalVm *vm, MalFfiHandleObject *child, MalFfiHandleObject *owner, const MalFfiSite *site) {
    if (child == owner) return true;
    MalFfiHandleObject *prior = ffi_handle_owner(child);
    if (child->ownership == MAL_FFI_HANDLE_OWNED || child->ownership == MAL_FFI_HANDLE_LIBRARY
        || child->owns_storage || (prior != nullptr && prior != owner))
        return mal_ffi_expected(vm, site, "one distinct owning resource for a borrowed pointer");
    if (prior == nullptr && (child->pins > 0 || child->closing || child->provisional || ffi_handle_borrowed(child)))
        return mal_ffi_expected(vm, site, "a resource no C operation is using before assigning its owner");
    return true;
}

static MalFfiHandleObject *ffi_owner_root(
    MalVm *vm, MalValue owner_value, const MalFfiSite *site) {
    MalFfiHandleObject *owner = ffi_handle(owner_value);
    if (owner == nullptr || owner->value == nullptr || owner->closing
        || !ffi_scope_active(vm, owner->scope) || !ffi_handle_owners_open(vm, owner)) {
        mal_ffi_expected(vm, site, "an open owning resource");
        return nullptr;
    }
    // Borrowed descendants share the same native destruction boundary. Keeping the
    // owning root avoids retaining an entire sibling traversal through view objects.
    while (ffi_handle_owner(owner) != nullptr) {
        owner = ffi_handle_owner(owner);
    }
    if (owner->scope == 0 && ffi_handle_policy(owner)->destroy == nullptr) {
        mal_ffi_expected(vm, site, "a destructor-backed owning root for a borrowed resource");
        return nullptr;
    }
    return owner;
}

bool mal_ffi_owner_ready(MalVm *vm, MalValue value, const MalFfiSite *site) {
    return ffi_owner_root(vm, value, site) != nullptr;
}

MalValue mal_ffi_new_owner_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type,
    void *value, MalValue owner_value) {
    MalFfiSite site = {type->name, "owner", nullptr};
    if (!type->borrows_owner) {
        mal_ffi_expected(vm, &site, "a handle family that supports owner-bound resource fields");
        return mal_value_new_undefined();
    }
    MalFfiHandleObject *owner = ffi_owner_root(vm, owner_value, &site);
    if (owner == nullptr) return mal_value_new_undefined();
    owner_value = mal_value_from_heap((MalHeapHeader *) owner);
    MalValue roots[] = {owner_value, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 2);
    MalFfiState *state = ffi_state(vm);
    MalFfiHandleObject *candidate = state == nullptr ? nullptr
        : ffi_handle_find(state, ffi_handle_family(type), value);
    if (candidate != owner && ffi_result_pending(vm, type, value, nullptr) != nullptr) {
        mal_ffi_expected(vm, &site, "a delivered resource before assigning an owner");
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (candidate != owner && mal_ffi_is_library_resource(type, value)) {
        mal_ffi_expected(vm, &site, "a resource whose lifetime belongs to its owning handle");
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    if (candidate != nullptr && ffi_scope_active(vm, candidate->scope)
        && !ffi_handle_owner_expired(vm, candidate)
        && !ffi_handle_can_adopt(vm, candidate, owner, &site)) {
        mal_gc_unroot(&root);
        return mal_value_new_undefined();
    }
    roots[1] = ffi_new_handle(vm, library, type, value, false, owner->scope, false, false, nullptr);
    MalFfiHandleObject *child = mal_ffi_threw(vm) ? nullptr : ffi_handle(roots[1]);
    if (child != nullptr && child != owner && ffi_handle_owner(child) == nullptr) {
        child->owner = owner;
        child->ownership = MAL_FFI_HANDLE_CHILD;
        mal_gc_card(&child->object.header, roots[0]);
    }
    if (child != nullptr) ffi_result_delivered(vm, child);
    mal_gc_unroot(&root);
    return mal_ffi_threw(vm) ? mal_value_new_undefined() : roots[1];
}

MalValue mal_ffi_new_library_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value) {
    MalFfiSite site = {type->name, "library lifetime", nullptr};
    if (!type->library_lifetime || type->size != 0) {
        mal_ffi_expected(vm, &site, "a pointer family that supports library-lifetime resource fields");
        return mal_value_new_undefined();
    }
    MalFfiState *state = ffi_state(vm);
    if (state == nullptr) { mal_ffi_out_of_memory(vm); return mal_value_new_undefined(); }
    if (ffi_result_pending(vm, type, value, nullptr) != nullptr) {
        mal_ffi_expected(vm, &site, "a delivered resource for library lifetime");
        return mal_value_new_undefined();
    }
    MalFfiHandleObject *candidate = ffi_handle_find(state, ffi_handle_family(type), value);
    if (candidate != nullptr && ffi_scope_active(vm, candidate->scope)
        && !ffi_handle_owner_expired(vm, candidate)) {
        if (candidate->ownership == MAL_FFI_HANDLE_OWNED || candidate->ownership == MAL_FFI_HANDLE_CHILD
            || (candidate->ownership != MAL_FFI_HANDLE_LIBRARY
                && (candidate->pins != 0 || candidate->closing || ffi_handle_borrowed(candidate)))) {
            mal_ffi_expected(vm, &site, "an independent borrowed resource for library lifetime");
            return mal_value_new_undefined();
        }
    }
    if (!ffi_library_claim_add(vm, type, value)) return mal_value_new_undefined();
    MalValue result = ffi_new_handle(vm, library, type, value, false, 0, false, false, nullptr);
    if (!mal_ffi_threw(vm)) {
        ffi_handle(result)->ownership = MAL_FFI_HANDLE_LIBRARY;
        ffi_result_delivered(vm, ffi_handle(result));
    }
    return result;
}

MalValue mal_ffi_allocate_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type,
    size_t size, size_t alignment) {
    void *storage = mal_ffi_allocate_storage(1, size, alignment);
    if (storage == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    memset(storage, 0, size);
    return ffi_new_handle(vm, library, type, storage, false, 0, true, false, nullptr);
}

MalValue mal_ffi_allocate_opaque_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type,
    uint64_t size, uint64_t alignment, const MalFfiSite *site) {
    if (size == 0 || size > SIZE_MAX || alignment == 0 || alignment > SIZE_MAX
        || (alignment & (alignment - 1)) != 0 || size > SIZE_MAX - (alignment - 1)) {
        ffi_fail(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site,
            "a positive size and power-of-two alignment that fit caller storage");
        return mal_value_new_undefined();
    }
    return mal_ffi_allocate_handle(vm, library, type, (size_t)size, (size_t)alignment);
}

MalValue mal_ffi_allocate_trailing_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type,
    uint64_t count, size_t offset, size_t stride, size_t minimum, size_t alignment,
    const MalFfiSite *site) {
    size_t limit = SIZE_MAX - SIZE_MAX % alignment;
    if (offset > limit || count > (limit - offset) / stride) {
        ffi_fail(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site,
            "a trailing element count that fits caller storage");
        return mal_value_new_undefined();
    }
    size_t size = offset + (size_t) count * stride;
    // Tail padding can make sizeof(T) larger than offsetof(T, array).
    if (size < minimum) size = minimum;
    return mal_ffi_allocate_handle(vm, library, type, size, alignment);
}

MalValue mal_ffi_new_callback_handle(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiHandleType *type, void *value) {
    MalFfiState *state = vm->ffi;
    u64 scope = state == nullptr || state->invocation_depth == 0
        ? 0
        : state->invocations[state->invocation_depth - 1];
    return ffi_new_handle(vm, library, type, value, false, scope, false, false, nullptr);
}

// ThinLTO must specialize the descriptor and optional pin at each binding site.
__attribute__((always_inline)) bool mal_ffi_to_handle(
    MalVm *vm, MalValue value, const MalFfiHandleType *type, bool nullable,
    const MalFfiSite *site, void **out, void **pin) {
    if (pin != nullptr) *pin = nullptr;
    if (nullable && mal_value_is_null(value)) {
        *out = nullptr;
        return true;
    }
    MalFfiHandleObject *handle = ffi_handle(value);
    bool typed = handle != nullptr && (handle->type == type
        || (type->family != nullptr && ffi_handle_supports(handle, type)));
    if (typed && handle->value != nullptr && !handle->closing && ffi_scope_active(vm, handle->scope)
        && (!type->borrows_owner || ffi_handle_owners_open(vm, handle))) {
        *out = handle->value;
        if (pin != nullptr) {
            for (MalFfiHandleObject *held = handle; held != nullptr; held = ffi_handle_owner(held)) held->pins++;
            *pin = handle;
        }
        return true;
    }
    return typed ? ffi_failf(
                       vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "an open %s handle", type->name)
                 : ffi_failf(
                       vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "a %s handle%s", type->name,
                       nullable ? " or null" : "");
}

static bool ffi_handle_held(MalVm *vm, MalFfiHandleObject *handle, const MalFfiSite *site) {
    for (MalFfiHandleObject *held = handle; held != nullptr; held = ffi_handle_owner(held))
        if (held->scope != 0)
            return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site,
                "a handle and owner the program holds, not ones a callback lends");
    return true;
}

bool mal_ffi_to_worker_handle(
    MalVm *vm, MalValue value, const MalFfiHandleType *type, bool nullable,
    const MalFfiSite *site, void **out, void **pin) {
    *pin = nullptr;
    void *held;
    if (!mal_ffi_to_handle(vm, value, type, nullable, site, out, &held)) return false;
    MalFfiHandleObject *handle = held;
    if (handle == nullptr) return true;
    if (!ffi_handle_held(vm, handle, site)) {
        mal_ffi_unpin_handle(handle);
        return false;
    }
    for (MalFfiHandleObject *owner = handle; owner != nullptr; owner = ffi_handle_owner(owner))
        if (owner->provisional) {
            mal_ffi_unpin_handle(handle);
            return mal_ffi_expected(vm, site, "a delivered resource before worker admission");
        }
    for (MalFfiHandleObject *held_owner = handle; held_owner != nullptr; held_owner = ffi_handle_owner(held_owner)) held_owner->worker_pins++;
    *pin = handle;
    return true;
}

void mal_ffi_unpin_worker_handle(void *pin) {
    MalFfiHandleObject *handle = pin;
    if (handle == nullptr) return;
    for (MalFfiHandleObject *held = handle; held != nullptr; held = ffi_handle_owner(held)) held->worker_pins--;
    mal_ffi_unpin_handle(handle);
}

bool mal_ffi_handle_idle(MalVm *vm, MalValue value, const MalFfiSite *site) {
    MalFfiHandleObject *handle = ffi_handle(value);
    if (handle != nullptr) {
        for (MalFfiHandleObject *held = handle; held != nullptr; held = ffi_handle_owner(held))
            if (held->worker_pins != 0 || held->operation != nullptr || ffi_handle_result_borrowed(held))
                return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "state no C operation is using");
        return true;
    }
    return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "state no C operation is using");
}

static bool ffi_state_range(MalFfiHandleObject *handle, i32 index, void **data, usize *length) {
    const MalFfiManagedField *field = &handle->type->managed_fields[index];
    MalFfiRetainedField *range = &handle->retained[index];
    if (!field->read(handle->value, data, length)) return false;
    if (*data == nullptr) return *length == 0;
    if (range->pin == nullptr) return false;
    uptr start = (uptr) range->data;
    uptr pointer = (uptr) *data;
    return pointer >= start && pointer - start <= range->length
        && *length <= range->length - (pointer - start);
}

static bool ffi_state_check(MalVm *vm, MalFfiHandleObject *handle, const MalFfiSite *site) {
    for (i32 index = 0; index < handle->type->managed_field_count; index++) {
        void *data;
        usize length;
        if (!ffi_state_range(handle, index, &data, &length))
            return ffi_failf(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site,
                "%s within its retained byte range", handle->type->managed_fields[index].name);
    }
    return true;
}

static bool ffi_prepare_handle(
    MalVm *vm, MalFfiHandleObject *handle, const MalFfiSite *site,
    MalFfiNativeHandle **prepared, const void *operation) {
    bool borrowed = ffi_handle_borrowed(handle);
    if (handle->retained != nullptr
        && ((handle->operation != nullptr && handle->operation != operation)
            || (!borrowed && !ffi_state_check(vm, handle, site)))) {
        if (!mal_ffi_threw(vm)) mal_ffi_expected(vm, site, "state no C operation is using");
        return false;
    }
    MalFfiState *state = ffi_state(vm);
    if (state == nullptr) return mal_ffi_out_of_memory(vm);
    if (handle->native == nullptr) {
        MalFfiNativeHandle *native = calloc(1, sizeof(*native));
        if (native == nullptr) return mal_ffi_out_of_memory(vm);
        atomic_init(&native->references, 1);
        atomic_init(&native->results, 0);
        atomic_init(&native->contained, 0);
        native->wrapper = mal_value_from_heap((MalHeapHeader *) handle);
        native->registry = state;
        native->next = state->native_handles;
        state->native_handles = native;
        handle->native = native;
    }
    MalFfiNativeHandle *native = handle->native;
    if (handle->retained != nullptr && !borrowed) {
        i32 capacity = handle->type->managed_field_count;
        MalArrayBufferStoreLease **stores = calloc((usize) capacity, sizeof(*stores));
        if (stores == nullptr) return mal_ffi_out_of_memory(vm);
        i32 count = 0;
        for (i32 index = 0; index < capacity; index++) {
            MalFfiRetainedField *field = &handle->retained[index];
            if (field->pin == nullptr) continue;
            MalArrayBufferStoreLease *lease = mal_array_buffer_object_retain_store(
                mal_value_to_array_buffer_object(field->buffer));
            if (lease == nullptr) {
                for (i32 previous = 0; previous < count; previous++)
                    mal_array_buffer_store_release(stores[previous]);
                free(stores);
                return mal_ffi_out_of_memory(vm);
            }
            stores[count++] = lease;
        }
        ffi_native_handle_stores_clear(native);
        native->stores = stores;
        native->store_count = count;
    }
    *prepared = native;
    return true;
}

static bool ffi_callback_input_contains(MalFfiCallback *callback, MalFfiHandleObject *handle) {
    for (MalFfiResultCopy *copy = callback->inputs; copy != nullptr; copy = copy->next)
        if (copy->handle == handle->native) return true;
    return false;
}

bool mal_ffi_callback_own(MalVm *vm, MalFfiCallback *callback, MalValue value,
    const void *operation, const MalFfiSite *site) {
    if (callback == nullptr) return true;
    MalFfiHandleObject *handle = ffi_handle(value);
    if (handle == nullptr) return mal_ffi_expected(vm, site, "a non-null registration owner");
    if (!ffi_handle_held(vm, handle, site)) return false;
    for (;;) {
        if (handle->provisional || handle->scope != 0)
            return mal_ffi_expected(vm, site, "a delivered registration owner held by the program");
        MalFfiHandleObject *parent = ffi_handle_owner(handle);
        if (parent == nullptr) break;
        handle = parent;
    }
    const MalFfiHandleType *policy = ffi_handle_policy(handle);
    if (handle->ownership != MAL_FFI_HANDLE_OWNED || policy->destroy == nullptr)
        return mal_ffi_expected(vm, site, "an independently owned library resource with a destructor");
    // Final native release must stop C consumers before freeing owned storage.
    if (handle->owns_storage && (!policy->collect || policy->destroy_can_fail))
        return mal_ffi_expected(vm, site, "owner storage with an unconditional collecting destructor");
    MalFfiNativeHandle *native;
    if (!ffi_prepare_handle(vm, handle, site, &native, operation)) return false;
    MalFfiKept *kept = (MalFfiKept *) callback;
    if (kept->owner != nullptr) abort();
    kept->owner = native;
    native->registration_owner = true;
    kept->callback.owner = mal_value_from_heap((MalHeapHeader *) handle);
    kept->owner_next = native->callbacks;
    if (native->callbacks != nullptr) native->callbacks->owner_previous = kept;
    native->callbacks = kept;
    mal_gc_card(&handle->object.header, callback->function);
    ffi_kept_slot_release(vm, kept);
    return true;
}

bool mal_ffi_callback_pin_owner(MalVm *vm, MalFfiCallback *callback, MalValue *value, void **pin,
    const MalFfiSite *site) {
    MalFfiHandleObject *handle = ffi_handle(callback->owner);
    if (handle == nullptr) return mal_ffi_expected(vm, site, "a live registration owner");
    if (!ffi_handle_held(vm, handle, site)) return false;
    handle->pins++;
    *value = callback->owner;
    *pin = handle;
    return true;
}

static bool ffi_callback_retain_handle(
    MalVm *vm, MalFfiCallback *callback, MalValue value, bool registration,
    bool input, const MalFfiSite *site) {
    MalFfiHandleObject *handle = ffi_handle(value);
    if (!ffi_handle_held(vm, handle, site)) return false;
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    MalFfiResultCopy *prepared = nullptr;
    MalFfiResultCopy *tail = nullptr;
    MalFfiKept *kept = input || registration ? (MalFfiKept *) callback : nullptr;
    MalFfiHandleObject *root_owner = kept == nullptr || kept->owner == nullptr
        ? nullptr : ffi_handle(kept->owner->wrapper);
    for (MalFfiHandleObject *held = handle; held != nullptr; held = ffi_handle_owner(held)) {
        if (held == root_owner) {
            if (input) break;
            mal_ffi_expected(vm, site, "a result resource independent of its registration owner");
            goto mal_failed;
        }
        if (!input && registration && (held->value == callback->result_owner
                || ffi_callback_input_contains(callback, held))) {
            mal_ffi_expected(vm, site, "a result resource independent of its registration owner");
            goto mal_failed;
        }
        if (input && ffi_callback_input_contains(callback, held)) continue;
        MalFfiNativeHandle *native;
        if (!ffi_prepare_handle(vm, held, site, &native, nullptr)) goto mal_failed;
        MalFfiResultCopy *result = malloc(sizeof(*result));
        if (result == nullptr) {
            mal_ffi_out_of_memory(vm);
            goto mal_failed;
        }
        *result = (MalFfiResultCopy) {.next = prepared, .handle = native,
            .contained = input && root_owner != nullptr};
        prepared = result;
        if (tail == nullptr) tail = result;
    }
    if (prepared == nullptr) { mal_gc_unroot(&root); return true; }
    if (registration) pthread_mutex_lock(&ffi_queue_lock);
    if (registration && !callback->results_accepting) {
        pthread_mutex_unlock(&ffi_queue_lock);
        mal_ffi_expected(vm, site, "a live registration for this callback result");
        goto mal_failed;
    }
    // Publish the entire owner chain together: C must never receive a child lease
    // whose owning resource could already be released.
    for (MalFfiResultCopy *result = prepared; result != nullptr; result = result->next) {
        atomic_fetch_add_explicit(&result->handle->references, 1, memory_order_relaxed);
        if (result->contained) {
            atomic_fetch_add_explicit(&result->handle->contained, 1, memory_order_relaxed);
            mal_gc_card(&root_owner->object.header, result->handle->wrapper);
        }
        if (!input) atomic_fetch_add_explicit(&result->handle->results, 1, memory_order_release);
        ffi_result_delivered(vm, ffi_handle(result->handle->wrapper));
    }
    tail->next = input ? callback->inputs : callback->results;
    if (input) callback->inputs = prepared;
    else callback->results = prepared;
    if (registration) pthread_mutex_unlock(&ffi_queue_lock);
    mal_gc_unroot(&root);
    return true;
mal_failed:
    while (prepared != nullptr) {
        MalFfiResultCopy *next = prepared->next;
        free(prepared);
        prepared = next;
    }
    mal_gc_unroot(&root);
    return false;
}

bool mal_ffi_callback_result_handle(
    MalVm *vm, MalFfiCallback *callback, MalValue value, const MalFfiHandleType *type,
    bool nullable, bool registration, const MalFfiSite *site, void **out) {
    if (!mal_ffi_to_handle(vm, value, type, nullable, site, out, nullptr)) return false;
    return *out == nullptr || ffi_callback_retain_handle(vm, callback, value, registration, false, site);
}

bool mal_ffi_callback_retain_owners(
    MalVm *vm, MalFfiCallback *callback, MalValue value, const MalFfiInputs *inputs,
    const MalFfiSite *site) {
    if (callback == nullptr) return true;
    MalFfiHandleObject *handle = ffi_handle(value);
    for (MalFfiHandleObject *owner = handle; owner != nullptr; owner = ffi_handle_owner(owner))
        if (owner->provisional)
            return mal_ffi_expected(vm, site, "a delivered resource before retaining an input");
    MalFfiKept *kept = (MalFfiKept *) callback;
    if (handle != nullptr && kept->owner != nullptr && ffi_handle_owner(handle) != nullptr) {
        MalFfiHandleObject *root_owner = handle;
        while (ffi_handle_owner(root_owner) != nullptr) root_owner = ffi_handle_owner(root_owner);
        if (mal_value_from_heap((MalHeapHeader *) root_owner) != kept->owner->wrapper)
            return mal_ffi_expected(vm, site, "borrowed inputs contained by the registration's destruction owner");
    }
    if (handle != nullptr && ffi_handle_owner(handle) != nullptr
        && !ffi_callback_retain_handle(vm, callback, value, true, true, site)) return false;
    if (inputs != nullptr)
        for (i32 index = 0; index < inputs->count; index++)
            if (!mal_ffi_callback_retain_owners(vm, callback, inputs->values[index], nullptr, site)) return false;
    return true;
}

bool mal_ffi_begin_handle_use(MalVm *vm, void *pin, const void *operation, const MalFfiSite *site) {
    MalFfiHandleObject *handle = pin;
    if (handle == nullptr || handle->retained == nullptr) return true;
    if (ffi_handle_borrowed(handle))
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site,
            "state no callback result is lending to C");
    if (handle->operation == operation) return true;
    if (handle->operation != nullptr)
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site, "state no other C operation is using");
    if (!ffi_state_check(vm, handle, site)) return false;
    handle->operation = operation;
    return true;
}

void mal_ffi_end_handle_use(
    MalVm *vm, void *pin, const void *operation, const MalFfiSite *site, bool check) {
    MalFfiHandleObject *handle = pin;
    // All arguments for this operation have finished C; independent callback pins may remain.
    if (handle == nullptr || handle->operation != operation) return;
    if (check && handle->value != nullptr && vm->completion.kind != MAL_COMPLETION_THROW)
        (void) ffi_state_check(vm, handle, site);
    handle->operation = nullptr;
}

MalValue mal_ffi_state_value(
    MalVm *vm, MalValue value, const MalFfiHandleType *type, int32_t index, const MalFfiSite *site) {
    void *storage;
    if (!mal_ffi_to_handle(vm, value, type, false, site, &storage, nullptr)
        || !mal_ffi_handle_idle(vm, value, site)) return mal_value_new_undefined();
    MalFfiHandleObject *handle = ffi_handle(value);
    // Accessors belong to the caller allocation's descriptor, even through a view.
    if (handle->type != type || handle->retained == nullptr
        || index < 0 || index >= type->managed_field_count) {
        mal_ffi_expected(vm, site, "the state field's allocating handle");
        return mal_value_new_undefined();
    }
    void *data;
    usize length;
    if (!ffi_state_range(handle, index, &data, &length)) {
        ffi_fail(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, site, "a pointer and count within the retained byte range");
        return mal_value_new_undefined();
    }
    MalFfiRetainedField *range = &handle->retained[index];
    if (range->pin == nullptr || (data == nullptr && range->data != nullptr)) return mal_value_new_null();
    if (type->managed_fields[index].text) {
        MalRootSpan root;
        mal_gc_root(&root, &value, 1);
        MalValue result = mal_ffi_from_string_length(vm, data, length);
        mal_gc_unroot(&root);
        return result;
    }
    MalArrayBufferObject *buffer = mal_value_to_array_buffer_object(range->buffer);
    u32 offset = data == nullptr ? 0 : (u32) ((uptr) data - (uptr) buffer->data);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    MalTypedArrayObject *array = mal_typed_array_object_new(&vm->heap,
        mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_TYPED_ARRAY_UINT8_PROTOTYPE]),
        buffer, MAL_TA_UINT8, offset, (u32) length, false);
    mal_gc_unroot(&root);
    return mal_value_from_typed_array_object(array);
}

bool mal_ffi_set_state_value(
    MalVm *vm, MalValue value, const MalFfiHandleType *type, int32_t index, MalValue input,
    const MalFfiSite *site) {
    void *storage;
    if (!mal_ffi_to_handle(vm, value, type, false, site, &storage, nullptr)
        || !mal_ffi_handle_idle(vm, value, site)) return false;
    MalFfiHandleObject *handle = ffi_handle(value);
    if (handle->type != type || handle->retained == nullptr
        || index < 0 || index >= type->managed_field_count)
        return mal_ffi_expected(vm, site, "the state field's allocating handle");
    const MalFfiManagedField *field = &type->managed_fields[index];
    MalFfiRetainedField next = {.buffer = mal_value_new_undefined()};
    MalValue roots[] = {value, input, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, 3);
    MalFfiString text = {.data = nullptr};
    bool ok = false;
    if (field->text && !mal_value_is_null(input)) {
        if (!mal_ffi_to_string(vm, input, false, MAL_FFI_STRING_COUNTED, site, &text)
            || !mal_ffi_check_count(vm, text.length, field->count_bits, field->count_signed, site)) goto mal_done;
        u32 capacity = text.length == 0 ? 1 : (u32) text.length;
        MalArrayBufferObject *buffer = mal_array_buffer_object_new(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ARRAY_BUFFER_PROTOTYPE]),
            capacity, capacity, false, false);
        roots[2] = mal_value_from_array_buffer_object(buffer);
        if (buffer->data == nullptr) {
            mal_ffi_out_of_memory(vm);
            goto mal_done;
        }
        memcpy(buffer->data, text.data, text.length);
        next.data = buffer->data;
        next.length = text.length;
        next.buffer = roots[2];
        next.pin = mal_array_buffer_object_retain_pin(buffer);
        if (next.pin == nullptr) {
            mal_ffi_out_of_memory(vm);
            goto mal_done;
        }
    } else if (!mal_value_is_null(input)) {
        MalBufferSourceSpan span;
        if (!mal_ffi_to_bytes(vm, input, false, field->writable, site, &next.data, &next.length, nullptr)
            || !mal_ffi_check_count(vm, next.length, field->count_bits, field->count_signed, site)) goto mal_done;
        if (mal_buffer_source_span(input, &span) != MAL_BUFFER_SOURCE_SPAN_OK) goto mal_done;
        next.pin = mal_array_buffer_object_retain_pin(span.buffer);
        if (next.pin == nullptr) {
            mal_ffi_out_of_memory(vm);
            goto mal_done;
        }
        next.buffer = mal_value_from_array_buffer_object(span.buffer);
    }
    MalFfiRetainedField *range = &handle->retained[index];
    field->write(storage, next.data, next.length);
    mal_gc_write_barrier(range->buffer);
    MalArrayBufferPin *previous = range->pin;
    *range = next;
    mal_gc_card(&handle->object.header, next.buffer);
    mal_array_buffer_object_release_pin(previous);
    if (handle->native != nullptr) ffi_native_handle_stores_clear(handle->native);
    ok = true;
mal_done:
    mal_ffi_string_release(&text);
    mal_gc_unroot(&root);
    return ok;
}

void mal_ffi_unpin_handle(void *pin) {
    for (MalFfiHandleObject *held = pin; held != nullptr; held = ffi_handle_owner(held)) held->pins--;
}

void mal_ffi_inputs_init(MalFfiInputs *inputs, const void *operation, bool worker) {
    *inputs = (MalFfiInputs) {.operation = operation, .worker = worker, .rooted = true};
    mal_ffi_root(&inputs->roots, nullptr, 0);
}

void mal_ffi_inputs_unroot(MalFfiInputs *inputs) {
    if (inputs->rooted) {
        mal_ffi_unroot(&inputs->roots);
        inputs->rooted = false;
    }
}

bool mal_ffi_input_handle(
    MalVm *vm, MalFfiInputs *inputs, MalValue value, const MalFfiHandleType *type,
    bool nullable, const MalFfiSite *site, void **out) {
    if (inputs == nullptr) return mal_ffi_to_handle(vm, value, type, nullable, site, out, nullptr);
    MalRootSpan root;
    mal_gc_root(&root, &value, 1);
    bool ok = true;
    if (inputs->count == inputs->capacity) {
        usize capacity = inputs->capacity == 0 ? 8 : (usize) inputs->capacity * 2;
        if (capacity > INT32_MAX) capacity = INT32_MAX;
        MalValue *grown = inputs->count == INT32_MAX ? nullptr : realloc(inputs->values, capacity * sizeof(*grown));
        if (grown == nullptr) ok = mal_ffi_out_of_memory(vm);
        else {
            inputs->values = grown;
            inputs->capacity = (i32) capacity;
            inputs->roots.slots = grown;
        }
    }
    void *pin = nullptr;
    if (ok) ok = inputs->worker
        ? mal_ffi_to_worker_handle(vm, value, type, nullable, site, out, &pin)
        : mal_ffi_to_handle(vm, value, type, nullable, site, out, &pin);
    if (ok && pin != nullptr) {
        inputs->values[inputs->count++] = value;
        inputs->roots.count = inputs->count;
        ok = mal_ffi_begin_handle_use(vm, pin, inputs->operation, site);
    }
    mal_gc_unroot(&root);
    return ok;
}

void mal_ffi_inputs_release(MalVm *vm, MalFfiInputs *inputs, const MalFfiSite *site, bool check) {
    for (i32 index = 0; index < inputs->count; index++) {
        MalFfiHandleObject *handle = ffi_handle(inputs->values[index]);
        mal_ffi_end_handle_use(vm, handle, inputs->operation, site, check);
        if (inputs->worker) mal_ffi_unpin_worker_handle(handle);
        else mal_ffi_unpin_handle(handle);
    }
    mal_ffi_inputs_unroot(inputs);
    free(inputs->values);
    inputs->values = nullptr;
    inputs->count = 0;
    inputs->capacity = 0;
}

bool mal_ffi_handle_results_ready(MalVm *vm, const MalFfiHandleType *type, const MalFfiSite *site) {
    MalFfiState *state = vm->ffi;
    if (state == nullptr) return true;
    for (MalFfiHandleObject *handle = state->worker_closes; handle != nullptr;
         handle = handle->worker_close_next) {
        if (ffi_handle_family(handle->type) == ffi_handle_family(type))
            return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site,
                "a settled worker close before returning this handle type, or a fresh result fact");
    }
    return true;
}

bool mal_ffi_begin_handle_initialization(MalVm *vm, void *pin, const MalFfiHandleType *type,
    bool worker, const MalFfiSite *site) {
    MalFfiHandleObject *handle = pin;
    if (handle == nullptr || handle->type != type || type->size != 0 || !handle->owns_storage
        || handle->ownership != MAL_FFI_HANDLE_BORROWED || handle->scope != 0
        || type->destroy == nullptr || !type->collect || type->destroy_can_fail
        || handle->pins != 1 || handle->closing || handle->provisional || ffi_handle_borrowed(handle))
        return mal_ffi_expected(vm, site, "uninitialized caller storage no other C call is using");
    handle->closing = true;
    ffi_handle_worker_closing(handle, worker);
    return true;
}

void mal_ffi_finish_handle_initialization(MalValue value, bool initialized) {
    MalFfiHandleObject *handle = ffi_handle(value);
    if (handle == nullptr) return;
    if (initialized) handle->ownership = MAL_FFI_HANDLE_OWNED;
    handle->closing = false;
    ffi_handle_worker_closing(handle, false);
}

bool mal_ffi_begin_handle_close(MalVm *vm, void *pin, bool worker, const MalFfiSite *site) {
    if (pin == nullptr) return true;
    MalFfiHandleObject *handle = pin;
    if (mal_ffi_is_library_resource(handle->type, handle->value))
        return mal_ffi_expected(vm, site, "a resource the program owns for a destroy binding");
    if (ffi_handle_owner(handle) != nullptr)
        return mal_ffi_expected(vm, site, "an independently owned resource for a destroy binding");
    if (handle->owns_storage && handle->type->size == 0 && handle->ownership != MAL_FFI_HANDLE_OWNED)
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site,
            "library-owned storage for a destroy binding; caller storage needs explicit C cleanup");
    if (handle->pins != 1 || handle->closing || handle->provisional || ffi_handle_borrowed(handle))
        return ffi_fail(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, site,
            "a handle no other C call is using");
    handle->closing = true;
    ffi_handle_worker_closing(handle, worker);
    return true;
}

void mal_ffi_finish_handle_close(MalValue value, bool released) {
    MalFfiHandleObject *handle = ffi_handle(value);
    if (handle == nullptr) return;
    handle->closing = false;
    ffi_handle_worker_closing(handle, false);
    if (released) {
        ffi_replaced_drop(handle->value);
        if (handle->native != nullptr) ffi_owner_finish(handle->native, true);
        ffi_handle_forget(handle);
    }
}

static const MalFfiExport *ffi_find_export(const MalFfiLibrary *library, const char *name) {
    i32 low = 0;
    i32 high = library->export_count - 1;
    while (low <= high) {
        i32 middle = low + (high - low) / 2;
        int order = strcmp(library->exports[middle].name, name);
        if (order == 0) return &library->exports[middle];
        if (order < 0) low = middle + 1;
        else high = middle - 1;
    }
    return nullptr;
}

static MalValue ffi_export_value(
    MalVm *vm, const MalFfiLibrary *library, const MalFfiExport *entry) {
    char *identity = ffi_identity(vm, library, entry->name);
    if (identity == nullptr) return mal_value_new_undefined();
    MalValue value;
    if (ffi_prepared(vm, identity, &value)) {
        free(identity);
        return value;
    }
    if (entry->function != nullptr) {
        MalObject *prototype =
            mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
        value = mal_value_from_native_function_object(mal_native_function_object_new_arity(
            &vm->heap, prototype, mal_intrinsic_ascii(vm, (const byte *) entry->name),
            entry->length, entry->function));
    } else {
        value = entry->constant(vm);
        if (vm->completion.kind == MAL_COMPLETION_THROW) {
            free(identity);
            return mal_value_new_undefined();
        }
    }
    if (!ffi_prepare(vm, identity, value)) return mal_value_new_undefined();
    return value;
}

void mal_ffi_install(
    MalVm *vm, const MalFfiLibrary *library, const MalHostInstallSlot *slots, int32_t count) {
    mal_gc_register_finalizer(MAL_HEAP_FFI_HANDLE_OBJECT, ffi_handle_finalize);
    mal_gc_register_tracer(MAL_HEAP_FFI_HANDLE_OBJECT, ffi_handle_trace);
    mal_gc_register_root_source(ffi_scan_roots, nullptr);
    for (i32 index = 0; index < count; index++) {
        const MalFfiExport *entry = ffi_find_export(library, slots[index].name);
        if (entry == nullptr) {
            char message[512];
            snprintf(
                message, sizeof(message), "%s has no export '%s'", library->specifier,
                slots[index].name);
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, (const byte *) message);
            return;
        }
        MalValue value = ffi_export_value(vm, library, entry);
        if (vm->completion.kind == MAL_COMPLETION_THROW) return;
        vm->globals[slots[index].slot] = value;
    }
}
