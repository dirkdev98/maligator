#include "heap_bigint.h"

#include <assert.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "ecma_whitespace.h"
#include "gc.h"
#include "heap_string.h"
#include "value.h"
#include "vm.h"
#include "vm_ops.h"

static void bigint_oom(MalHeap *heap) {
    mal_vm_throw_allocation_error(mal_vm_from_heap(heap));
}

static void bigint_size_error(MalHeap *heap) {
    mal_vm_throw_error(mal_vm_from_heap(heap), MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
        "Maximum BigInt size exceeded");
}

static u32 normalized_count(const u32 *digits, u32 count) {
    while (count != 0 && digits[count - 1] == 0) count--;
    return count;
}

static i128 signed_bits(u128 bits) {
    i128 result;
    memcpy(&result, &bits, sizeof result);
    return result;
}

// Inline magnitudes keep a constant allocation size, including values above
// signed i128, so publication avoids the wide allocator and a temporary limb copy.
static inline __attribute__((always_inline)) MalBigInt *bigint_from_inline(
    MalHeap *heap, i32 sign, u128 magnitude
) {
    MalVm *owner = nullptr;
    usize cache_index = 0;
    u32 limit = sign < 0 ? (u32) -MAL_SMALL_BIGINT_CACHE_MIN
        : MAL_SMALL_BIGINT_CACHE_MIN + MAL_SMALL_BIGINT_CACHE_CAPACITY - 1;
    if (magnitude <= limit) {
        owner = mal_vm_from_heap(heap);
        if (owner->small_bigint_cache == nullptr) {
            owner->small_bigint_cache = calloc(MAL_SMALL_BIGINT_CACHE_CAPACITY,
                sizeof(*owner->small_bigint_cache));
            if (owner->small_bigint_cache == nullptr) {
                bigint_oom(heap);
                return nullptr;
            }
        }
        cache_index = sign < 0 ? (usize) -MAL_SMALL_BIGINT_CACHE_MIN - (usize) magnitude
            : (usize) -MAL_SMALL_BIGINT_CACHE_MIN + (usize) magnitude;
        MalBigInt *cached = owner->small_bigint_cache[cache_index];
        if (cached != nullptr) return cached;
    }
    MalBigInt *result = mal_heap_try_alloc(heap, sizeof(*result), MAL_HEAP_BIGINT);
    if (result == nullptr) {
        bigint_oom(heap);
        return nullptr;
    }
    u64 low = (u64) magnitude, high = (u64) (magnitude >> 64);
    result->sign = magnitude == 0 ? 0 : sign;
    result->digit_count = high != 0 ? (high >> 32 != 0 ? 4 : 3)
        : low != 0 ? (low >> 32 != 0 ? 2 : 1) : 0;
    memcpy(result->data.inline_digits, &magnitude, sizeof magnitude);
    if (owner != nullptr) owner->small_bigint_cache[cache_index] = result;
    return result;
}

MalBigInt *mal_bigint_new(MalHeap *heap, i128 value) {
    return bigint_from_inline(heap, value < 0 ? -1 : 1,
        value < 0 ? (u128) 0 - (u128) value : (u128) value);
}

bool mal_bigint_try_i128(const MalBigInt *value, i128 *out) {
    if (value->digit_count > 4) return false;
    u128 magnitude;
    memcpy(&magnitude, value->data.inline_digits, sizeof magnitude);
    u128 maximum = ((u128) 1 << 127) - (value->sign < 0 ? 0 : 1);
    if (magnitude > maximum) return false;
    *out = signed_bits(value->sign < 0 ? (u128) 0 - magnitude : magnitude);
    return true;
}

MalBigInt *mal_bigint_from_digits(MalHeap *heap, i32 sign, const u32 *digits, u32 count) {
    count = normalized_count(digits, count);
    if (count <= 4) {
        u128 magnitude = 0;
        if (count != 0) memcpy(&magnitude, digits, count * sizeof(u32));
        return bigint_from_inline(heap, sign, magnitude);
    }
    if (count > MAL_BIGINT_MAX_DIGITS) {
        bigint_size_error(heap);
        return nullptr;
    }
    usize trailing = (usize) count * sizeof(u32);
    MalBigInt *result = mal_heap_try_alloc(heap, sizeof(*result) + trailing, MAL_HEAP_BIGINT);
    if (result == nullptr) {
        bigint_oom(heap);
        return nullptr;
    }
    result->sign = sign;
    result->digit_count = count;
    u32 *owned = (u32 *) (result + 1);
    memcpy(owned, digits, trailing);
    result->data.digits = owned;
    return result;
}

u32 mal_bigint_bit_length(const MalBigInt *value) {
    if (value->digit_count == 0) return 0;
    return (value->digit_count - 1) * 32 + 32
        - (u32) __builtin_clz(mal_bigint_digits(value)[value->digit_count - 1]);
}

u64 mal_bigint_low_u64(const MalBigInt *value) {
    u64 bits;
    memcpy(&bits, mal_bigint_digits(value), sizeof bits);
    return value->sign < 0 ? (u64) 0 - bits : bits;
}

static i32 compare_magnitude(const MalBigInt *left, const MalBigInt *right) {
    if (left->digit_count != right->digit_count)
        return left->digit_count < right->digit_count ? -1 : 1;
    const u32 *a = mal_bigint_digits(left), *b = mal_bigint_digits(right);
    for (u32 i = left->digit_count; i != 0; i--) {
        if (a[i - 1] != b[i - 1]) return a[i - 1] < b[i - 1] ? -1 : 1;
    }
    return 0;
}

i32 mal_bigint_compare(const MalBigInt *left, const MalBigInt *right) {
    if (left->sign != right->sign) return left->sign < right->sign ? -1 : 1;
    return left->sign * compare_magnitude(left, right);
}

static u32 number_magnitude(f64 number, u32 digits[34]) {
    memset(digits, 0, 34 * sizeof(u32));
    u64 bits;
    memcpy(&bits, &number, sizeof bits);
    u32 exponent = (u32) ((bits >> 52) & 0x7ff);
    u64 mantissa = bits & ((UINT64_C(1) << 52) - 1);
    if (exponent != 0) mantissa |= UINT64_C(1) << 52;
    i32 shift = exponent == 0 ? -1074 : (i32) exponent - 1023 - 52;
    u32 count = 0;
    if (shift < 0) {
        u64 integer = shift <= -64 ? 0 : mantissa >> (u32) -shift;
        digits[0] = (u32) integer;
        digits[1] = (u32) (integer >> 32);
        count = 2;
    } else {
        u128 shifted = (u128) mantissa << ((u32) shift % 32);
        count = (u32) shift / 32;
        while (shifted != 0) {
            digits[count++] = (u32) shifted;
            shifted >>= 32;
        }
    }
    return normalized_count(digits, count);
}

MalBigInt *mal_bigint_from_number(MalHeap *heap, f64 number) {
    if (!isfinite(number) || trunc(number) != number) {
        mal_vm_throw_error(mal_vm_from_heap(heap), MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "The number is not an integer");
        return nullptr;
    }
    if (number >= -0x1p63 && number < 0x1p63) return mal_bigint_new(heap, (i64) number);
    u32 digits[34];
    u32 count = number_magnitude(number, digits);
    return mal_bigint_from_digits(heap, number < 0 ? -1 : 1, digits, count);
}

i32 mal_bigint_compare_number(const MalBigInt *left, f64 right) {
    if (isnan(right)) return 2;
    if (isinf(right)) return right > 0 ? -1 : 1;
    u32 digits[34];
    u32 count = number_magnitude(right, digits);
    MalBigInt integer = {.sign = count == 0 ? 0 : right < 0 ? -1 : 1, .digit_count = count};
    if (count <= 4) memcpy(integer.data.inline_digits, digits, sizeof integer.data.inline_digits);
    else integer.data.digits = digits;
    i32 comparison = mal_bigint_compare(left, &integer);
    if (comparison == 0 && trunc(right) != right) return right > 0 ? -1 : 1;
    return comparison;
}

static bool magnitude_bit(const MalBigInt *value, u32 bit) {
    u32 word = bit / 32;
    return word < value->digit_count && ((mal_bigint_digits(value)[word] >> (bit % 32)) & 1) != 0;
}

static bool magnitude_low_bits(const MalBigInt *value, u32 count) {
    const u32 *digits = mal_bigint_digits(value);
    u32 words = count / 32;
    for (u32 i = 0; i < words && i < value->digit_count; i++) if (digits[i] != 0) return true;
    return count % 32 != 0 && words < value->digit_count
        && (digits[words] & (((u32) 1 << (count % 32)) - 1)) != 0;
}

f64 mal_bigint_to_number(const MalBigInt *value) {
    if (value->digit_count <= 4) {
        u128 magnitude;
        memcpy(&magnitude, value->data.inline_digits, sizeof magnitude);
        f64 result = value->digit_count <= 2 ? (f64) (u64) magnitude : (f64) magnitude;
        return value->sign < 0 ? -result : result;
    }
    u32 bits = mal_bigint_bit_length(value);
    if (bits > 1024) return value->sign < 0 ? -INFINITY : INFINITY;
    u32 shift = bits > 53 ? bits - 53 : 0;
    u64 top = 0;
    for (u32 bit = bits; bit > shift; bit--) top = (top << 1) | magnitude_bit(value, bit - 1);
    if (shift != 0 && magnitude_bit(value, shift - 1)
        && ((top & 1) != 0 || magnitude_low_bits(value, shift - 1))) top++;
    f64 result = ldexp((f64) top, (i32) shift);
    return value->sign < 0 ? -result : result;
}

u64 mal_bigint_hash(const MalBigInt *value) {
    u64 hash = UINT64_C(0x9e3779b97f4a7c15) ^ (u64) value->sign;
    const u32 *digits = mal_bigint_digits(value);
    for (u32 i = 0; i < value->digit_count; i++) {
        hash ^= digits[i];
        hash *= UINT64_C(0x100000001b3);
        hash ^= hash >> 32;
    }
    return hash;
}

typedef struct BigBuffer {
    u32 *digits;
    u32 count;
    u32 capacity;
    u32 small[8];
} BigBuffer;

static void buffer_init(BigBuffer *buffer) {
    buffer->digits = buffer->small;
    buffer->count = 0;
    buffer->capacity = countof(buffer->small);
}

static void buffer_dispose(BigBuffer *buffer) {
    if (buffer->digits != buffer->small) free(buffer->digits);
}

static bool buffer_reserve(MalHeap *heap, BigBuffer *buffer, u32 count) {
    if (count <= buffer->capacity) return true;
    if (count > MAL_BIGINT_MAX_DIGITS + 1) {
        bigint_size_error(heap);
        return false;
    }
    u32 capacity = buffer->capacity <= (MAL_BIGINT_MAX_DIGITS + 1) / 2
        ? buffer->capacity * 2 : MAL_BIGINT_MAX_DIGITS + 1;
    if (capacity < count) capacity = count;
    u32 *digits = malloc((usize) capacity * sizeof(u32));
    if (digits == nullptr) {
        bigint_oom(heap);
        return false;
    }
    if (buffer->count != 0) memcpy(digits, buffer->digits, buffer->count * sizeof(u32));
    buffer_dispose(buffer);
    buffer->digits = digits;
    buffer->capacity = capacity;
    return true;
}

static MalBigInt *buffer_publish(MalHeap *heap, BigBuffer *buffer, i32 sign) {
    MalBigInt *result = mal_bigint_from_digits(heap, sign, buffer->digits, buffer->count);
    buffer_dispose(buffer);
    return result;
}

static bool buffer_copy(MalHeap *heap, BigBuffer *buffer, const MalBigInt *value) {
    if (!buffer_reserve(heap, buffer, value->digit_count)) return false;
    buffer->count = value->digit_count;
    if (buffer->count != 0) memcpy(buffer->digits, mal_bigint_digits(value), buffer->count * sizeof(u32));
    return true;
}

static bool buffer_multiply_add(MalHeap *heap, BigBuffer *buffer, u32 factor, u32 addend) {
    if (!buffer_reserve(heap, buffer, buffer->count + 1)) return false;
    u64 carry = addend;
    for (u32 i = 0; i < buffer->count; i++) {
        carry += (u64) buffer->digits[i] * factor;
        buffer->digits[i] = (u32) carry;
        carry >>= 32;
    }
    if (carry != 0) buffer->digits[buffer->count++] = (u32) carry;
    return true;
}

static i32 digit_value(c16 unit) {
    if (unit >= '0' && unit <= '9') return unit - '0';
    if (unit >= 'a' && unit <= 'z') return unit - 'a' + 10;
    if (unit >= 'A' && unit <= 'Z') return unit - 'A' + 10;
    return -1;
}

MalBigInt *mal_bigint_parse(MalHeap *heap, const c16 *units, usize length, bool *valid) {
    *valid = true;
    usize start = 0, end = length;
    while (start < end && mal_ecma_is_string_whitespace(units[start])) start++;
    while (end > start && mal_ecma_is_string_whitespace(units[end - 1])) end--;
    if (start == end) return mal_bigint_new(heap, 0);
    bool signed_input = units[start] == '+' || units[start] == '-';
    i32 sign = units[start] == '-' ? -1 : 1;
    if (signed_input) start++;
    u32 radix = 10;
    if (!signed_input && end - start >= 2 && units[start] == '0') {
        c16 prefix = units[start + 1];
        if (prefix == 'x' || prefix == 'X') radix = 16;
        else if (prefix == 'o' || prefix == 'O') radix = 8;
        else if (prefix == 'b' || prefix == 'B') radix = 2;
        if (radix != 10) start += 2;
    }
    if (start == end) { *valid = false; return nullptr; }
    usize small_limit = radix == 10 ? 19 : radix == 16 ? 16 : radix == 8 ? 21 : 64;
    if (end - start <= small_limit) {
        u64 magnitude = 0;
        for (usize i = start; i < end; i++) {
            i32 digit = digit_value(units[i]);
            if (digit < 0 || (u32) digit >= radix) { *valid = false; return nullptr; }
            magnitude = magnitude * radix + (u32) digit;
        }
        return bigint_from_inline(heap, sign, magnitude);
    }
    usize inline_limit = radix == 10 ? 38 : radix == 16 ? 32 : radix == 8 ? 42 : 128;
    if (end - start <= inline_limit) {
        u128 magnitude = 0;
        for (usize i = start; i < end; i++) {
            i32 digit = digit_value(units[i]);
            if (digit < 0 || (u32) digit >= radix) { *valid = false; return nullptr; }
            magnitude = magnitude * radix + (u32) digit;
        }
        return bigint_from_inline(heap, sign, magnitude);
    }
    for (usize i = start; i < end; i++) {
        i32 digit = digit_value(units[i]);
        if (digit < 0 || (u32) digit >= radix) { *valid = false; return nullptr; }
    }
    while (start < end && units[start] == '0') start++;
    if (start == end) return mal_bigint_new(heap, 0);
    BigBuffer buffer;
    buffer_init(&buffer);
    if (radix != 10) {
        u32 shift = radix == 16 ? 4 : radix == 8 ? 3 : 1;
        usize leading_bits = 32 - (u32) __builtin_clz((u32) digit_value(units[start]));
        if (end - start - 1 > (MAL_BIGINT_MAX_BITS - leading_bits) / shift) {
            bigint_size_error(heap);
            return nullptr;
        }
        u32 bits = (u32) ((end - start - 1) * shift + leading_bits);
        u32 count = (bits + 31) / 32;
        if (!buffer_reserve(heap, &buffer, count)) return nullptr;
        u64 packed = 0;
        u32 packed_bits = 0;
        for (usize i = end; i > start; i--) {
            packed |= (u64) digit_value(units[i - 1]) << packed_bits;
            packed_bits += shift;
            if (packed_bits >= 32) {
                buffer.digits[buffer.count++] = (u32) packed;
                packed >>= 32;
                packed_bits -= 32;
            }
        }
        if (packed != 0) buffer.digits[buffer.count++] = (u32) packed;
    } else {
        for (usize i = start; i < end;) {
            u32 chunk = 0, factor = 1;
            usize stop = i + 9 < end ? i + 9 : end;
            for (; i < stop; i++) { chunk = chunk * 10 + units[i] - '0'; factor *= 10; }
            if (!buffer_multiply_add(heap, &buffer, factor, chunk)) {
                buffer_dispose(&buffer);
                return nullptr;
            }
        }
    }
    return buffer_publish(heap, &buffer, sign);
}

static MalBigInt *copy_signed(MalHeap *heap, const MalBigInt *value, i32 sign) {
    BigBuffer buffer;
    buffer_init(&buffer);
    if (!buffer_copy(heap, &buffer, value)) return nullptr;
    return buffer_publish(heap, &buffer, sign);
}

static MalBigInt *add_signed(MalHeap *heap, const MalBigInt *left, const MalBigInt *right, bool subtract) {
    i32 right_sign = subtract ? -right->sign : right->sign;
    if (left->digit_count <= 4 && right->digit_count <= 4) {
        u128 a, b, result;
        memcpy(&a, left->data.inline_digits, sizeof a);
        memcpy(&b, right->data.inline_digits, sizeof b);
        if (left->sign == right_sign) {
            if (!__builtin_add_overflow(a, b, &result)) return bigint_from_inline(heap, left->sign, result);
        } else {
            return a >= b ? bigint_from_inline(heap, left->sign, a - b)
                : bigint_from_inline(heap, right_sign, b - a);
        }
    }
    if (right_sign == 0) return (MalBigInt *) left;
    if (left->sign == 0)
        return right_sign == right->sign ? (MalBigInt *) right : copy_signed(heap, right, right_sign);
    BigBuffer buffer;
    buffer_init(&buffer);
    const u32 *x = mal_bigint_digits(left), *y = mal_bigint_digits(right);
    i32 sign = left->sign;
    if (left->sign == right_sign) {
        u32 count = left->digit_count > right->digit_count ? left->digit_count : right->digit_count;
        if (!buffer_reserve(heap, &buffer, count + 1)) return nullptr;
        u64 carry = 0;
        for (u32 i = 0; i < count; i++) {
            carry += (i < left->digit_count ? (u64) x[i] : 0)
                + (i < right->digit_count ? (u64) y[i] : 0);
            buffer.digits[i] = (u32) carry;
            carry >>= 32;
        }
        buffer.count = count;
        if (carry != 0) buffer.digits[buffer.count++] = (u32) carry;
    } else {
        i32 order = compare_magnitude(left, right);
        if (order == 0) return mal_bigint_new(heap, 0);
        const MalBigInt *larger = order > 0 ? left : right;
        const MalBigInt *smaller = order > 0 ? right : left;
        sign = order > 0 ? left->sign : right_sign;
        x = mal_bigint_digits(larger);
        y = mal_bigint_digits(smaller);
        if (!buffer_reserve(heap, &buffer, larger->digit_count)) return nullptr;
        u64 borrow = 0;
        for (u32 i = 0; i < larger->digit_count; i++) {
            u64 subtrahend = (i < smaller->digit_count ? (u64) y[i] : 0) + borrow;
            buffer.digits[i] = (u32) ((u64) x[i] - subtrahend);
            borrow = (u64) x[i] < subtrahend;
        }
        assert(borrow == 0);
        buffer.count = larger->digit_count;
    }
    return buffer_publish(heap, &buffer, sign);
}

MalBigInt *mal_bigint_add(MalHeap *heap, const MalBigInt *left, const MalBigInt *right) {
    return add_signed(heap, left, right, false);
}

MalBigInt *mal_bigint_subtract(MalHeap *heap, const MalBigInt *left, const MalBigInt *right) {
    return add_signed(heap, left, right, true);
}

MalBigInt *mal_bigint_negate(MalHeap *heap, const MalBigInt *value) {
    i128 small;
    if (mal_bigint_try_i128(value, &small) && (u128) small != ((u128) 1 << 127))
        return mal_bigint_new(heap, -small);
    return copy_signed(heap, value, -value->sign);
}

MalBigInt *mal_bigint_multiply(MalHeap *heap, const MalBigInt *left, const MalBigInt *right) {
    if (left->digit_count <= 2 && right->digit_count <= 2) {
        u64 a, b;
        memcpy(&a, left->data.inline_digits, sizeof a);
        memcpy(&b, right->data.inline_digits, sizeof b);
        return bigint_from_inline(heap, left->sign * right->sign, (u128) a * b);
    }
    if (left->digit_count <= 4 && right->digit_count <= 4 &&
        mal_bigint_bit_length(left) + mal_bigint_bit_length(right) <= 128) {
        u128 a, b;
        memcpy(&a, left->data.inline_digits, sizeof a);
        memcpy(&b, right->data.inline_digits, sizeof b);
        return bigint_from_inline(heap, left->sign * right->sign, a * b);
    }
    if (left->sign == 0 || right->sign == 0) return mal_bigint_new(heap, 0);
    if ((u64) mal_bigint_bit_length(left) + mal_bigint_bit_length(right) - 1 > MAL_BIGINT_MAX_BITS) {
        bigint_size_error(heap);
        return nullptr;
    }
    BigBuffer buffer;
    buffer_init(&buffer);
    u32 count = left->digit_count + right->digit_count;
    if (!buffer_reserve(heap, &buffer, count)) return nullptr;
    memset(buffer.digits, 0, (usize) count * sizeof(u32));
    const u32 *x = mal_bigint_digits(left), *y = mal_bigint_digits(right);
    for (u32 i = 0; i < left->digit_count; i++) {
        u64 carry = 0;
        for (u32 j = 0; j < right->digit_count; j++) {
            carry += (u64) x[i] * y[j] + buffer.digits[i + j];
            buffer.digits[i + j] = (u32) carry;
            carry >>= 32;
        }
        buffer.digits[i + right->digit_count] = (u32) carry;
    }
    buffer.count = count;
    return buffer_publish(heap, &buffer, left->sign * right->sign);
}

static u32 divide_word(u32 *digits, u32 count, u32 divisor) {
    u64 remainder = 0;
    for (u32 i = count; i != 0; i--) {
        u64 numerator = (remainder << 32) | digits[i - 1];
        digits[i - 1] = (u32) (numerator / divisor);
        remainder = numerator % divisor;
    }
    return (u32) remainder;
}

MalBigInt *mal_bigint_divide(MalHeap *heap, const MalBigInt *left, const MalBigInt *right, bool remainder) {
    if (right->sign == 0) {
        mal_vm_throw_error(mal_vm_from_heap(heap), MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Division by zero");
        return nullptr;
    }
    if (left->digit_count <= 4 && right->digit_count <= 4) {
        u128 a, b;
        memcpy(&a, left->data.inline_digits, sizeof a);
        memcpy(&b, right->data.inline_digits, sizeof b);
        u128 result;
        if (left->digit_count <= 2 && right->digit_count <= 2) {
            result = remainder ? (u64) a % (u64) b : (u64) a / (u64) b;
        } else {
            result = remainder ? a % b : a / b;
        }
        return bigint_from_inline(heap, remainder ? left->sign : left->sign * right->sign, result);
    }
    i32 order = compare_magnitude(left, right);
    if (order < 0) return remainder ? (MalBigInt *) left : mal_bigint_new(heap, 0);
    if (order == 0) return mal_bigint_new(heap, remainder ? 0 : left->sign * right->sign);
    BigBuffer dividend, divisor, quotient;
    buffer_init(&dividend);
    buffer_init(&divisor);
    buffer_init(&quotient);
    u32 n = right->digit_count, m = left->digit_count - n;
    if (!buffer_copy(heap, &dividend, left)) goto failure;
    if (n == 1) {
        u32 tail = divide_word(dividend.digits, dividend.count, mal_bigint_digits(right)[0]);
        if (!remainder) return buffer_publish(heap, &dividend, left->sign * right->sign);
        buffer_dispose(&dividend);
        return mal_bigint_new(heap, left->sign < 0 ? -(i128) tail : (i128) tail);
    }
    if (!buffer_reserve(heap, &dividend, left->digit_count + 1)
        || !buffer_reserve(heap, &divisor, n)
        || !buffer_reserve(heap, &quotient, m + 1)) goto failure;
    u32 shift = (u32) __builtin_clz(mal_bigint_digits(right)[n - 1]);
    u64 carry = 0;
    for (u32 i = 0; i < left->digit_count; i++) {
        u64 part = ((u64) dividend.digits[i] << shift) | carry;
        dividend.digits[i] = (u32) part;
        carry = part >> 32;
    }
    dividend.digits[left->digit_count] = (u32) carry;
    carry = 0;
    for (u32 i = 0; i < n; i++) {
        u64 part = ((u64) mal_bigint_digits(right)[i] << shift) | carry;
        divisor.digits[i] = (u32) part;
        carry = part >> 32;
    }
    assert(carry == 0);
    // Normalization makes the quotient estimate at most two too large; the
    // second-highest limb corrects it before the full multiply/subtract.
    for (u32 step = m + 1; step != 0; step--) {
        u32 j = step - 1;
        u32 high = divisor.digits[n - 1];
        u64 top = ((u64) dividend.digits[j + n] << 32) | dividend.digits[j + n - 1];
        u64 estimate, tail;
        if (dividend.digits[j + n] == high) {
            estimate = UINT32_MAX;
            tail = (u64) dividend.digits[j + n - 1] + high;
        } else {
            estimate = top / high;
            tail = top % high;
        }
        while (tail <= UINT32_MAX
            && estimate * divisor.digits[n - 2] > (tail << 32) + dividend.digits[j + n - 2]) {
            estimate--;
            tail += high;
        }
        u64 borrow = 0;
        for (u32 i = 0; i < n; i++) {
            u64 product = estimate * divisor.digits[i] + borrow;
            u32 before = dividend.digits[j + i];
            dividend.digits[j + i] = before - (u32) product;
            borrow = (product >> 32) + (before < (u32) product);
        }
        bool negative = dividend.digits[j + n] < borrow;
        dividend.digits[j + n] -= (u32) borrow;
        if (negative) {
            estimate--;
            carry = 0;
            for (u32 i = 0; i < n; i++) {
                carry += (u64) dividend.digits[j + i] + divisor.digits[i];
                dividend.digits[j + i] = (u32) carry;
                carry >>= 32;
            }
            dividend.digits[j + n] += (u32) carry;
        }
        quotient.digits[j] = (u32) estimate;
    }
    buffer_dispose(&divisor);
    if (remainder) {
        buffer_dispose(&quotient);
        for (u32 i = 0; i < n; i++) {
            u64 part = dividend.digits[i];
            if (shift != 0) part |= (u64) dividend.digits[i + 1] << 32;
            dividend.digits[i] = (u32) (part >> shift);
        }
        dividend.count = n;
        return buffer_publish(heap, &dividend, left->sign);
    }
    buffer_dispose(&dividend);
    quotient.count = m + 1;
    return buffer_publish(heap, &quotient, left->sign * right->sign);

failure:
    buffer_dispose(&dividend);
    buffer_dispose(&divisor);
    buffer_dispose(&quotient);
    return nullptr;
}

static u32 twos_word(const MalBigInt *value, u32 index, u64 *carry) {
    u32 word = index < value->digit_count ? mal_bigint_digits(value)[index] : 0;
    if (value->sign >= 0) return word;
    u64 bits = (u64) ~word + *carry;
    *carry = bits >> 32;
    return (u32) bits;
}

static void twos_to_magnitude(BigBuffer *buffer, u32 top_mask) {
    u64 carry = 1;
    for (u32 i = 0; i < buffer->count; i++) {
        carry += (u32) ~buffer->digits[i];
        buffer->digits[i] = (u32) carry;
        carry >>= 32;
    }
    if (buffer->count != 0) buffer->digits[buffer->count - 1] &= top_mask;
}

MalBigInt *mal_bigint_bitwise(MalHeap *heap, const MalBigInt *left, const MalBigInt *right, char operation) {
    u32 count = (left->digit_count > right->digit_count ? left->digit_count : right->digit_count) + 1;
    if (operation == '&' && (left->sign >= 0 || right->sign >= 0)) {
        if (left->sign >= 0) count = left->digit_count;
        if (right->sign >= 0 && right->digit_count < count) count = right->digit_count;
        if (count == 0) return mal_bigint_new(heap, 0);
        if (count == 1) {
            u32 a = mal_bigint_digits(left)[0], b = mal_bigint_digits(right)[0];
            if (left->sign < 0) a = 0u - a;
            if (right->sign < 0) b = 0u - b;
            return bigint_from_inline(heap, 1, a & b);
        }
        if (count == 2) return bigint_from_inline(heap, 1, mal_bigint_low_u64(left) & mal_bigint_low_u64(right));
    }
    if (left->sign >= 0 && right->sign >= 0 && left->digit_count <= 4 && right->digit_count <= 4) {
        u128 a, b;
        memcpy(&a, left->data.inline_digits, sizeof a);
        memcpy(&b, right->data.inline_digits, sizeof b);
        return bigint_from_inline(heap, 1, operation == '&' ? a & b : operation == '|' ? a | b : a ^ b);
    }
    i128 a, b;
    if (mal_bigint_try_i128(left, &a) && mal_bigint_try_i128(right, &b)) {
        u128 bits = operation == '&' ? (u128) a & (u128) b
            : operation == '|' ? (u128) a | (u128) b : (u128) a ^ (u128) b;
        return mal_bigint_new(heap, signed_bits(bits));
    }
    BigBuffer buffer;
    buffer_init(&buffer);
    if (!buffer_reserve(heap, &buffer, count)) return nullptr;
    u64 a_carry = 1, b_carry = 1;
    for (u32 i = 0; i < count; i++) {
        u32 x = twos_word(left, i, &a_carry), y = twos_word(right, i, &b_carry);
        buffer.digits[i] = operation == '&' ? x & y : operation == '|' ? x | y : x ^ y;
    }
    bool negative = operation == '&' ? left->sign < 0 && right->sign < 0
        : operation == '|' ? left->sign < 0 || right->sign < 0 : (left->sign < 0) != (right->sign < 0);
    buffer.count = count;
    if (negative) twos_to_magnitude(&buffer, UINT32_MAX);
    return buffer_publish(heap, &buffer, negative ? -1 : 1);
}

MalBigInt *mal_bigint_not(MalHeap *heap, const MalBigInt *value) {
    MalBigInt minus_one = {.sign = -1, .digit_count = 1, .data.inline_digits = {1}};
    return mal_bigint_bitwise(heap, value, &minus_one, '^');
}

MalBigInt *mal_bigint_shift(MalHeap *heap, const MalBigInt *value, const MalBigInt *count, bool right) {
    if (count->sign == 0 || value->sign == 0) return (MalBigInt *) value;
    if (count->sign < 0) right = !right;
    u64 amount = mal_bigint_low_u64(count);
    if (count->sign < 0) amount = (u64) 0 - amount;
    if (mal_bigint_bit_length(count) > 64) amount = UINT64_MAX;
    u32 length = mal_bigint_bit_length(value);
    if (right && amount >= length) return mal_bigint_new(heap, value->sign < 0 ? -1 : 0);
    if (!right && amount > MAL_BIGINT_MAX_BITS - length) {
        bigint_size_error(heap);
        return nullptr;
    }
    u32 words = (u32) (amount / 32), bits = (u32) (amount % 32);
    BigBuffer buffer;
    buffer_init(&buffer);
    const u32 *digits = mal_bigint_digits(value);
    if (!right) {
        u32 count_out = (length + (u32) amount + 31) / 32;
        if (!buffer_reserve(heap, &buffer, count_out)) return nullptr;
        buffer.count = count_out;
        memset(buffer.digits, 0, buffer.count * sizeof(u32));
        u64 carry = 0;
        for (u32 i = 0; i < value->digit_count; i++) {
            u64 part = ((u64) digits[i] << bits) | carry;
            buffer.digits[words + i] = (u32) part;
            carry = part >> 32;
        }
        if (carry != 0) buffer.digits[words + value->digit_count] = (u32) carry;
    } else {
        u32 count_out = value->digit_count - words;
        if (!buffer_reserve(heap, &buffer, count_out + 1)) return nullptr;
        for (u32 i = 0; i < count_out; i++) {
            u64 part = digits[i + words];
            if (bits != 0 && i + words + 1 < value->digit_count) part |= (u64) digits[i + words + 1] << 32;
            buffer.digits[i] = (u32) (part >> bits);
        }
        buffer.count = normalized_count(buffer.digits, count_out);
        if (value->sign < 0 && magnitude_low_bits(value, (u32) amount)) {
            u64 carry = 1;
            for (u32 i = 0; i < buffer.count && carry != 0; i++) {
                carry += buffer.digits[i];
                buffer.digits[i] = (u32) carry;
                carry >>= 32;
            }
            if (carry != 0) buffer.digits[buffer.count++] = (u32) carry;
        }
    }
    return buffer_publish(heap, &buffer, value->sign);
}

MalBigInt *mal_bigint_width(MalHeap *heap, const MalBigInt *value, u64 bits, bool is_signed) {
    if (bits == 0 || value->sign == 0) return mal_bigint_new(heap, 0);
    u32 length = mal_bigint_bit_length(value);
    if (is_signed) {
        if (bits > length || (value->sign < 0 && bits == length
                && !magnitude_low_bits(value, length - 1))) return (MalBigInt *) value;
    } else if (value->sign > 0 && bits >= length) return (MalBigInt *) value;
    if (bits <= 64) {
        u64 mask = bits == 64 ? UINT64_MAX : (UINT64_C(1) << bits) - 1;
        u64 twos = mal_bigint_low_u64(value) & mask;
        bool negative = is_signed && (twos & (UINT64_C(1) << (bits - 1))) != 0;
        return bigint_from_inline(heap, negative ? -1 : 1,
            negative ? ((u64) 0 - twos) & mask : twos);
    }
    if (bits <= 128) {
        u128 magnitude = 0;
        u32 count = value->digit_count < 4 ? value->digit_count : 4;
        memcpy(&magnitude, mal_bigint_digits(value), count * sizeof(u32));
        u128 mask = bits == 128 ? ~(u128) 0 : ((u128) 1 << bits) - 1;
        u128 twos = (value->sign < 0 ? (u128) 0 - magnitude : magnitude) & mask;
        bool negative = is_signed && (twos & ((u128) 1 << (bits - 1))) != 0;
        return bigint_from_inline(heap, negative ? -1 : 1,
            negative ? ((u128) 0 - twos) & mask : twos);
    }
    if (bits > MAL_BIGINT_MAX_BITS) {
        bigint_size_error(heap);
        return nullptr;
    }
    u32 count = ((u32) bits + 31) / 32;
    BigBuffer buffer;
    buffer_init(&buffer);
    if (!buffer_reserve(heap, &buffer, count)) return nullptr;
    u64 carry = 1;
    for (u32 i = 0; i < count; i++) buffer.digits[i] = twos_word(value, i, &carry);
    u32 mask = bits % 32 != 0 ? ((u32) 1 << (bits % 32)) - 1 : UINT32_MAX;
    buffer.digits[count - 1] &= mask;
    bool negative = is_signed && (buffer.digits[count - 1] & ((u32) 1 << ((bits - 1) % 32))) != 0;
    buffer.count = count;
    if (negative) twos_to_magnitude(&buffer, mask);
    return buffer_publish(heap, &buffer, negative ? -1 : 1);
}

MalBigInt *mal_bigint_power(MalHeap *heap, const MalBigInt *base, const MalBigInt *exponent) {
    if (exponent->sign < 0) {
        mal_vm_throw_error(mal_vm_from_heap(heap), MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
            "Exponent must be non-negative");
        return nullptr;
    }
    if (exponent->sign == 0) return mal_bigint_new(heap, 1);
    if (base->sign == 0) return mal_bigint_new(heap, 0);
    u32 length = mal_bigint_bit_length(base);
    if (length == 1) return mal_bigint_new(heap,
        base->sign < 0 && (mal_bigint_digits(exponent)[0] & 1) != 0 ? -1 : 1);
    u64 power = mal_bigint_low_u64(exponent);
    if (mal_bigint_bit_length(exponent) > 64 || power > (MAL_BIGINT_MAX_BITS - 1) / (length - 1)) {
        bigint_size_error(heap);
        return nullptr;
    }
    MalBigInt *one = mal_bigint_new(heap, 1);
    if (one == nullptr) return nullptr;
    MalValue roots[] = {mal_value_from_bigint((MalBigInt *) base), mal_value_from_bigint(one)};
    MalRootSpan span;
    mal_gc_root(&span, roots, countof(roots));
    MalBigInt *result = nullptr;
    while (power != 0) {
        if ((power & 1) != 0) {
            result = mal_bigint_multiply(heap, mal_value_to_bigint(roots[1]), mal_value_to_bigint(roots[0]));
            if (result == nullptr) goto done;
            roots[1] = mal_value_from_bigint(result);
        }
        power >>= 1;
        if (power != 0) {
            result = mal_bigint_multiply(heap, mal_value_to_bigint(roots[0]), mal_value_to_bigint(roots[0]));
            if (result == nullptr) goto done;
            roots[0] = mal_value_from_bigint(result);
        }
    }
    result = mal_value_to_bigint(roots[1]);
done:
    mal_gc_unroot(&span);
    return result;
}

static MalString *bigint_ascii(MalHeap *heap, const byte *text, usize length) {
    MalString *result = mal_string_try_new_ascii(heap, text, length);
    if (result == nullptr) bigint_oom(heap);
    return result;
}

static byte *write_decimal_word(byte *out, u64 value, u32 minimum) {
    byte reverse[20];
    u32 count = 0;
    do { reverse[count++] = (byte) ('0' + value % 10); value /= 10; } while (value != 0);
    while (count < minimum) reverse[count++] = '0';
    while (count != 0) *out++ = reverse[--count];
    return out;
}

MalString *mal_bigint_to_string(MalHeap *heap, const MalBigInt *value, i32 radix) {
    assert(radix >= 2 && radix <= 36);
    if (value->sign == 0) return bigint_ascii(heap, "0", 1);
    static const byte alphabet[] = "0123456789abcdefghijklmnopqrstuvwxyz";
    byte small[140];
    u32 shift = radix == 2 ? 1 : radix == 4 ? 2 : radix == 8 ? 3
        : radix == 16 ? 4 : radix == 32 ? 5 : 0;
    if (value->digit_count <= 4) {
        u128 magnitude;
        memcpy(&magnitude, value->data.inline_digits, sizeof magnitude);
        if (radix == 10) {
            if (value->digit_count <= 2) {
                byte *cursor = small;
                if (value->sign < 0) *cursor++ = '-';
                cursor = write_decimal_word(cursor, (u64) magnitude, 0);
                return bigint_ascii(heap, small, (usize) (cursor - small));
            }
            u64 chunks[3];
            u32 count = 0;
            const u128 base = (u128) UINT64_C(10000000000000000000);
            do { chunks[count++] = (u64) (magnitude % base); magnitude /= base; } while (magnitude != 0);
            byte *cursor = small;
            if (value->sign < 0) *cursor++ = '-';
            cursor = write_decimal_word(cursor, chunks[--count], 1);
            while (count != 0) cursor = write_decimal_word(cursor, chunks[--count], 19);
            return bigint_ascii(heap, small, (usize) (cursor - small));
        }
        byte *end = small + sizeof small, *cursor = end;
        if (shift != 0) {
            if (value->digit_count <= 2) {
                u64 word = (u64) magnitude;
                do { *--cursor = alphabet[(u32) word & ((1u << shift) - 1)]; word >>= shift; } while (word != 0);
            } else {
                do { *--cursor = alphabet[(u32) magnitude & ((1u << shift) - 1)]; magnitude >>= shift; } while (magnitude != 0);
            }
        } else {
            do { *--cursor = alphabet[magnitude % (u32) radix]; magnitude /= (u32) radix; } while (magnitude != 0);
        }
        if (value->sign < 0) *--cursor = '-';
        return bigint_ascii(heap, cursor, (usize) (end - cursor));
    }
    u32 bits = mal_bigint_bit_length(value);
    if (shift != 0) {
        usize digits_out = (bits + shift - 1) / shift;
        usize length = digits_out + (value->sign < 0 ? 1 : 0);
        byte *text = malloc(length);
        if (text == nullptr) { bigint_oom(heap); return nullptr; }
        byte *cursor = text;
        if (value->sign < 0) *cursor++ = '-';
        const u32 *digits = mal_bigint_digits(value);
        for (usize i = digits_out; i != 0; i--) {
            u32 bit = (u32) ((i - 1) * shift), word = bit / 32, offset = bit % 32;
            u64 part = digits[word];
            if (offset != 0 && word + 1 < value->digit_count) part |= (u64) digits[word + 1] << 32;
            *cursor++ = alphabet[(part >> offset) & ((1u << shift) - 1)];
        }
        MalString *result = bigint_ascii(heap, text, length);
        free(text);
        return result;
    }
    u32 chunk_base = (u32) radix, chunk_digits = 1;
    while (chunk_base <= UINT32_MAX / (u32) radix) { chunk_base *= (u32) radix; chunk_digits++; }
    u32 chunk_bits = 31 - (u32) __builtin_clz(chunk_base);
    usize capacity = ((usize) bits + chunk_bits - 1) / chunk_bits * chunk_digits + 1;
    if (capacity > MAL_STRING_MAX_CODE_UNITS) {
        mal_vm_throw_error(mal_vm_from_heap(heap), MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Invalid string length");
        return nullptr;
    }
    byte *text = malloc(capacity);
    if (text == nullptr) { bigint_oom(heap); return nullptr; }
    BigBuffer buffer;
    buffer_init(&buffer);
    if (!buffer_copy(heap, &buffer, value)) { free(text); return nullptr; }
    byte *end = text + capacity, *cursor = end;
    do {
        u32 chunk = divide_word(buffer.digits, buffer.count, chunk_base);
        buffer.count = normalized_count(buffer.digits, buffer.count);
        u32 width = buffer.count == 0 ? 0 : chunk_digits, written = 0;
        do { *--cursor = alphabet[chunk % (u32) radix]; chunk /= (u32) radix; written++; }
        while (chunk != 0 || written < width);
    } while (buffer.count != 0);
    if (value->sign < 0) *--cursor = '-';
    buffer_dispose(&buffer);
    MalString *result = bigint_ascii(heap, cursor, (usize) (end - cursor));
    free(text);
    return result;
}
