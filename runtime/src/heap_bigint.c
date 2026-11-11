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

// Below this many limbs schoolbook multiplication beats Karatsuba's extra additions.
#define KARATSUBA_LIMBS 32u

static void bigint_oom(MalHeap *heap) {
    mal_vm_throw_allocation_error(mal_vm_from_heap(heap));
}

static void bigint_size_error(MalHeap *heap) {
    mal_vm_throw_error(mal_vm_from_heap(heap), MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE,
        "Maximum BigInt size exceeded");
}

static u32 normalized_count(const u64 *digits, u32 count) {
    while (count != 0 && digits[count - 1] == 0) count--;
    return count;
}

static i128 signed_bits(u128 bits) {
    i128 result;
    memcpy(&result, &bits, sizeof result);
    return result;
}

// Valid for at most two limbs; inline limbs beyond the count are zero.
static inline u128 inline_magnitude(const MalBigInt *value) {
    return (u128) value->data.inline_digits[1] << 64 | value->data.inline_digits[0];
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
    result->digit_count = high != 0 ? 2 : low != 0 ? 1 : 0;
    result->data.inline_digits[0] = low;
    result->data.inline_digits[1] = high;
    if (owner != nullptr) owner->small_bigint_cache[cache_index] = result;
    return result;
}

MalBigInt *mal_bigint_new(MalHeap *heap, i128 value) {
    return bigint_from_inline(heap, value < 0 ? -1 : 1,
        value < 0 ? (u128) 0 - (u128) value : (u128) value);
}

bool mal_bigint_try_i128(const MalBigInt *value, i128 *out) {
    if (value->digit_count > 2) return false;
    u128 magnitude = inline_magnitude(value);
    u128 maximum = ((u128) 1 << 127) - (value->sign < 0 ? 0 : 1);
    if (magnitude > maximum) return false;
    *out = signed_bits(value->sign < 0 ? (u128) 0 - magnitude : magnitude);
    return true;
}

MalBigInt *mal_bigint_from_digits(MalHeap *heap, i32 sign, const u64 *digits, u32 count) {
    count = normalized_count(digits, count);
    if (count <= 2) {
        u128 magnitude = count == 0 ? 0 : digits[0];
        if (count == 2) magnitude |= (u128) digits[1] << 64;
        return bigint_from_inline(heap, sign, magnitude);
    }
    if (count > MAL_BIGINT_MAX_DIGITS) {
        bigint_size_error(heap);
        return nullptr;
    }
    usize trailing = (usize) count * sizeof(u64);
    MalBigInt *result = mal_heap_try_alloc(heap, sizeof(*result) + trailing, MAL_HEAP_BIGINT);
    if (result == nullptr) {
        bigint_oom(heap);
        return nullptr;
    }
    result->sign = sign;
    result->digit_count = count;
    u64 *owned = (u64 *) (result + 1);
    memcpy(owned, digits, trailing);
    result->data.digits = owned;
    return result;
}

u32 mal_bigint_bit_length(const MalBigInt *value) {
    if (value->digit_count == 0) return 0;
    return value->digit_count * 64
        - (u32) __builtin_clzll(mal_bigint_digits(value)[value->digit_count - 1]);
}

u64 mal_bigint_low_u64(const MalBigInt *value) {
    u64 bits = mal_bigint_digits(value)[0];
    return value->sign < 0 ? (u64) 0 - bits : bits;
}

static i32 compare_magnitude(const MalBigInt *left, const MalBigInt *right) {
    if (left->digit_count != right->digit_count)
        return left->digit_count < right->digit_count ? -1 : 1;
    const u64 *a = mal_bigint_digits(left), *b = mal_bigint_digits(right);
    for (u32 i = left->digit_count; i != 0; i--) {
        if (a[i - 1] != b[i - 1]) return a[i - 1] < b[i - 1] ? -1 : 1;
    }
    return 0;
}

i32 mal_bigint_compare(const MalBigInt *left, const MalBigInt *right) {
    if (left->sign != right->sign) return left->sign < right->sign ? -1 : 1;
    return left->sign * compare_magnitude(left, right);
}

// A finite double's integer magnitude spans at most 1024 bits.
#define NUMBER_LIMBS 17u

static u32 number_magnitude(f64 number, u64 digits[NUMBER_LIMBS]) {
    memset(digits, 0, NUMBER_LIMBS * sizeof(u64));
    u64 bits;
    memcpy(&bits, &number, sizeof bits);
    u32 exponent = (u32) ((bits >> 52) & 0x7ff);
    u64 mantissa = bits & ((UINT64_C(1) << 52) - 1);
    if (exponent != 0) mantissa |= UINT64_C(1) << 52;
    i32 shift = exponent == 0 ? -1074 : (i32) exponent - 1023 - 52;
    u32 count = 0;
    if (shift < 0) {
        digits[0] = shift <= -64 ? 0 : mantissa >> (u32) -shift;
        count = 1;
    } else {
        u128 shifted = (u128) mantissa << ((u32) shift % 64);
        count = (u32) shift / 64;
        while (shifted != 0) {
            digits[count++] = (u64) shifted;
            shifted >>= 64;
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
    u64 digits[NUMBER_LIMBS];
    u32 count = number_magnitude(number, digits);
    return mal_bigint_from_digits(heap, number < 0 ? -1 : 1, digits, count);
}

i32 mal_bigint_compare_number(const MalBigInt *left, f64 right) {
    if (isnan(right)) return 2;
    if (isinf(right)) return right > 0 ? -1 : 1;
    u64 digits[NUMBER_LIMBS];
    u32 count = number_magnitude(right, digits);
    MalBigInt integer = {.sign = count == 0 ? 0 : right < 0 ? -1 : 1, .digit_count = count};
    if (count <= 2) memcpy(integer.data.inline_digits, digits, sizeof integer.data.inline_digits);
    else integer.data.digits = digits;
    i32 comparison = mal_bigint_compare(left, &integer);
    if (comparison == 0 && trunc(right) != right) return right > 0 ? -1 : 1;
    return comparison;
}

static bool magnitude_low_bits(const MalBigInt *value, u32 count) {
    const u64 *digits = mal_bigint_digits(value);
    u32 words = count / 64;
    for (u32 i = 0; i < words && i < value->digit_count; i++) if (digits[i] != 0) return true;
    return count % 64 != 0 && words < value->digit_count
        && (digits[words] & ((UINT64_C(1) << (count % 64)) - 1)) != 0;
}

f64 mal_bigint_to_number(const MalBigInt *value) {
    if (value->digit_count <= 2) {
        u128 magnitude = inline_magnitude(value);
        f64 result = value->digit_count <= 1 ? (f64) (u64) magnitude : (f64) magnitude;
        return value->sign < 0 ? -result : result;
    }
    u32 bits = mal_bigint_bit_length(value);
    if (bits > 1024) return value->sign < 0 ? -INFINITY : INFINITY;
    // The top 64 bits plus a sticky bit for any lower one round once to binary64,
    // with the same ties-to-even result as rounding the complete magnitude.
    u32 shift = bits - 64, word = shift / 64, offset = shift % 64;
    const u64 *digits = mal_bigint_digits(value);
    u64 top = digits[word] >> offset;
    if (offset != 0) top |= digits[word + 1] << (64 - offset);
    if (magnitude_low_bits(value, shift)) top |= 1;
    f64 result = ldexp((f64) top, (i32) shift);
    return value->sign < 0 ? -result : result;
}

u64 mal_bigint_hash(const MalBigInt *value) {
    u64 hash = UINT64_C(0x9e3779b97f4a7c15) ^ (u64) value->sign;
    const u64 *digits = mal_bigint_digits(value);
    for (u32 i = 0; i < value->digit_count; i++) {
        hash ^= digits[i];
        hash *= UINT64_C(0x100000001b3);
        hash ^= hash >> 32;
    }
    return hash;
}

typedef struct BigBuffer {
    u64 *digits;
    u32 count;
    u32 capacity;
    u64 small[4];
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
    if (count > MAL_BIGINT_MAX_DIGITS + 2) {
        bigint_size_error(heap);
        return false;
    }
    u32 capacity = buffer->capacity <= (MAL_BIGINT_MAX_DIGITS + 2) / 2
        ? buffer->capacity * 2 : MAL_BIGINT_MAX_DIGITS + 2;
    if (capacity < count) capacity = count;
    u64 *digits = malloc((usize) capacity * sizeof(u64));
    if (digits == nullptr) {
        bigint_oom(heap);
        return false;
    }
    if (buffer->count != 0) memcpy(digits, buffer->digits, buffer->count * sizeof(u64));
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
    if (buffer->count != 0) memcpy(buffer->digits, mal_bigint_digits(value), buffer->count * sizeof(u64));
    return true;
}

static bool buffer_multiply_add(MalHeap *heap, BigBuffer *buffer, u64 factor, u64 addend) {
    if (!buffer_reserve(heap, buffer, buffer->count + 1)) return false;
    u128 carry = addend;
    for (u32 i = 0; i < buffer->count; i++) {
        carry += (u128) buffer->digits[i] * factor;
        buffer->digits[i] = (u64) carry;
        carry >>= 64;
    }
    if (carry != 0) buffer->digits[buffer->count++] = (u64) carry;
    return true;
}

/* Möller–Granlund division by an invariant normalized word: the reciprocal
 * floor((2^128 - 1) / d) - 2^64 turns each 2-by-1 step into two multiplications,
 * since 64-bit targets such as arm64 lack a 128-by-64-bit divide. */
static u64 reciprocal_word(u64 divisor) {
    return (u64) ((((u128) ~divisor) << 64 | UINT64_MAX) / divisor);
}

// (high:low) / divisor for a normalized divisor and high < divisor.
static inline u64 divide_2by1(u64 high, u64 low, u64 divisor, u64 reciprocal, u64 *remainder) {
    u128 estimate = (u128) reciprocal * high + ((u128) high << 64 | low);
    u64 quotient = (u64) (estimate >> 64) + 1, fraction = (u64) estimate;
    u64 rest = low - quotient * divisor;
    if (rest > fraction) {
        quotient--;
        rest += divisor;
    }
    if (__builtin_expect(rest >= divisor, 0)) {
        quotient++;
        rest -= divisor;
    }
    *remainder = rest;
    return quotient;
}

// Divides the magnitude in place and returns the remainder.
static u64 divide_word(u64 *digits, u32 count, u64 divisor) {
    u32 shift = (u32) __builtin_clzll(divisor);
    u64 normalized = divisor << shift, reciprocal = reciprocal_word(normalized), rest = 0;
    if (shift == 0) {
        for (u32 i = count; i != 0; i--)
            digits[i - 1] = divide_2by1(rest, digits[i - 1], normalized, reciprocal, &rest);
        return rest;
    }
    // Shifting the dividend with the divisor leaves the quotient unchanged.
    rest = digits[count - 1] >> (64 - shift);
    for (u32 i = count; i != 0; i--) {
        u64 low = digits[i - 1] << shift;
        if (i > 1) low |= digits[i - 2] >> (64 - shift);
        digits[i - 1] = divide_2by1(rest, low, normalized, reciprocal, &rest);
    }
    return rest >> shift;
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
        u32 count = (bits + 63) / 64;
        if (!buffer_reserve(heap, &buffer, count)) return nullptr;
        u128 packed = 0;
        u32 packed_bits = 0;
        for (usize i = end; i > start; i--) {
            packed |= (u128) (u32) digit_value(units[i - 1]) << packed_bits;
            packed_bits += shift;
            if (packed_bits >= 64) {
                buffer.digits[buffer.count++] = (u64) packed;
                packed >>= 64;
                packed_bits -= 64;
            }
        }
        if (packed != 0) buffer.digits[buffer.count++] = (u64) packed;
    } else {
        for (usize i = start; i < end;) {
            u64 chunk = 0, factor = 1;
            usize stop = i + 19 < end ? i + 19 : end;
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
    if (left->digit_count <= 2 && right->digit_count <= 2) {
        u128 a = inline_magnitude(left), b = inline_magnitude(right), result;
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
    const u64 *x = mal_bigint_digits(left), *y = mal_bigint_digits(right);
    i32 sign = left->sign;
    if (left->sign == right_sign) {
        u32 count = left->digit_count > right->digit_count ? left->digit_count : right->digit_count;
        if (!buffer_reserve(heap, &buffer, count + 1)) return nullptr;
        u128 carry = 0;
        for (u32 i = 0; i < count; i++) {
            carry += (u128) (i < left->digit_count ? x[i] : 0)
                + (i < right->digit_count ? y[i] : 0);
            buffer.digits[i] = (u64) carry;
            carry >>= 64;
        }
        buffer.count = count;
        if (carry != 0) buffer.digits[buffer.count++] = (u64) carry;
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
            u128 difference = (u128) x[i] - (i < smaller->digit_count ? y[i] : 0) - borrow;
            buffer.digits[i] = (u64) difference;
            borrow = (u64) (difference >> 127);
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

// a[0, count) += b[0, count) + carry; returns the outgoing carry.
static u64 add_limbs(u64 *a, const u64 *b, u32 count, u64 carry) {
    for (u32 i = 0; i < count; i++) {
        u128 sum = (u128) a[i] + b[i] + carry;
        a[i] = (u64) sum;
        carry = (u64) (sum >> 64);
    }
    return carry;
}

// a[0, count) -= b[0, count) + borrow; returns the outgoing borrow.
static u64 subtract_limbs(u64 *a, const u64 *b, u32 count, u64 borrow) {
    for (u32 i = 0; i < count; i++) {
        u128 difference = (u128) a[i] - b[i] - borrow;
        a[i] = (u64) difference;
        borrow = (u64) (difference >> 127);
    }
    return borrow;
}

// Propagates a carry from a[0] through a[0, count); returns the outgoing carry.
static u64 increment_limbs(u64 *a, u32 count, u64 carry) {
    for (u32 i = 0; i < count && carry != 0; i++) {
        a[i] += carry;
        carry = a[i] < carry;
    }
    return carry;
}

static u64 decrement_limbs(u64 *a, u32 count, u64 borrow) {
    for (u32 i = 0; i < count && borrow != 0; i++) {
        u64 before = a[i];
        a[i] = before - borrow;
        borrow = before < borrow;
    }
    return borrow;
}

// out[0, nx + ny) = x * y.
static void multiply_basecase(u64 *out, const u64 *x, u32 nx, const u64 *y, u32 ny) {
    memset(out, 0, (usize) (nx + ny) * sizeof(u64));
    for (u32 i = 0; i < nx; i++) {
        u64 carry = 0, factor = x[i];
        if (factor == 0) continue;
        for (u32 j = 0; j < ny; j++) {
            u128 product = (u128) factor * y[j] + out[i + j] + carry;
            out[i + j] = (u64) product;
            carry = (u64) (product >> 64);
        }
        out[i + ny] = carry;
    }
}

// out[0, 2n) = x^2: each cross product once, doubled, plus the diagonal squares.
static void square_basecase(u64 *out, const u64 *x, u32 n) {
    memset(out, 0, (usize) 2 * n * sizeof(u64));
    for (u32 i = 0; i < n; i++) {
        u64 carry = 0, factor = x[i];
        for (u32 j = i + 1; j < n; j++) {
            u128 product = (u128) factor * x[j] + out[i + j] + carry;
            out[i + j] = (u64) product;
            carry = (u64) (product >> 64);
        }
        out[i + n] = carry;
    }
    u64 top = 0;
    for (u32 i = 0; i < 2 * n; i++) {
        u64 word = out[i];
        out[i] = word << 1 | top;
        top = word >> 63;
    }
    u128 carry = 0;
    for (u32 i = 0; i < n; i++) {
        u128 square = (u128) x[i] * x[i];
        carry += (u128) out[2 * i] + (u64) square;
        out[2 * i] = (u64) carry;
        carry >>= 64;
        carry += (u128) out[2 * i + 1] + (u64) (square >> 64);
        out[2 * i + 1] = (u64) carry;
        carry >>= 64;
    }
    assert(top == 0 && carry == 0);
}

// Scratch for multiply_limbs with this many limbs in its longer operand.
static usize multiply_scratch(u32 limbs) {
    usize total = 0;
    while (limbs >= KARATSUBA_LIMBS) {
        u32 half = (limbs + 1) / 2;
        total += 4 * (usize) half + 4;
        limbs = half + 1;
    }
    return total;
}

/* out[0, nx + ny) = x * y with nx >= ny; out never aliases an input. Karatsuba splits
 * balanced operands at half = ceil(nx / 2): x0*y0 and x1*y1 land in their final
 * positions, and (x0 + x1)(y0 + y1) minus both supplies the middle term. */
static void multiply_limbs(
    u64 *out, const u64 *x, u32 nx, const u64 *y, u32 ny, bool square, u64 *scratch
) {
    u32 half = (nx + 1) / 2;
    if (ny < KARATSUBA_LIMBS || ny <= half) {
        if (square) square_basecase(out, x, nx);
        else multiply_basecase(out, x, nx, y, ny);
        return;
    }
    u32 high_x = nx - half, high_y = ny - half, total = nx + ny;
    multiply_limbs(out, x, half, y, half, square, scratch);
    multiply_limbs(out + 2 * half, x + half, high_x, y + half, high_y, square, scratch);
    u64 *sum_x = scratch, *sum_y = scratch + half + 1, *middle = scratch + 2 * half + 2;
    u64 *rest = middle + 2 * half + 2;
    memcpy(sum_x, x, half * sizeof(u64));
    sum_x[half] = add_limbs(sum_x, x + half, high_x, 0);
    sum_x[half] = increment_limbs(sum_x + high_x, half - high_x, sum_x[half]);
    u32 sum_count = half + 1;
    if (!square) {
        memcpy(sum_y, y, half * sizeof(u64));
        sum_y[half] = add_limbs(sum_y, y + half, high_y, 0);
        sum_y[half] = increment_limbs(sum_y + high_y, half - high_y, sum_y[half]);
    }
    multiply_limbs(middle, sum_x, sum_count, square ? sum_x : sum_y, sum_count, square, rest);
    u32 middle_count = 2 * sum_count;
    u64 borrow = subtract_limbs(middle, out, 2 * half, 0);
    borrow = decrement_limbs(middle + 2 * half, middle_count - 2 * half, borrow);
    assert(borrow == 0);
    borrow = subtract_limbs(middle, out + 2 * half, high_x + high_y, 0);
    borrow = decrement_limbs(middle + high_x + high_y, middle_count - high_x - high_y, borrow);
    assert(borrow == 0);
    // The middle term fits below the product's top, so its remaining limbs are zero.
    u32 middle_used = normalized_count(middle, middle_count);
    assert(middle_used <= total - half);
    u64 carry = add_limbs(out + half, middle, middle_used, 0);
    carry = increment_limbs(out + half + middle_used, total - half - middle_used, carry);
    assert(carry == 0);
    (void) borrow;
    (void) carry;
}

MalBigInt *mal_bigint_multiply(MalHeap *heap, const MalBigInt *left, const MalBigInt *right) {
    if (left->digit_count <= 1 && right->digit_count <= 1) {
        return bigint_from_inline(heap, left->sign * right->sign,
            (u128) left->data.inline_digits[0] * right->data.inline_digits[0]);
    }
    if (left->digit_count <= 2 && right->digit_count <= 2 &&
        mal_bigint_bit_length(left) + mal_bigint_bit_length(right) <= 128) {
        return bigint_from_inline(heap, left->sign * right->sign,
            inline_magnitude(left) * inline_magnitude(right));
    }
    if (left->sign == 0 || right->sign == 0) return mal_bigint_new(heap, 0);
    if ((u64) mal_bigint_bit_length(left) + mal_bigint_bit_length(right) - 1 > MAL_BIGINT_MAX_BITS) {
        bigint_size_error(heap);
        return nullptr;
    }
    if (left->digit_count < right->digit_count) {
        const MalBigInt *swap = left;
        left = right;
        right = swap;
    }
    BigBuffer buffer;
    buffer_init(&buffer);
    u32 count = left->digit_count + right->digit_count;
    if (!buffer_reserve(heap, &buffer, count)) return nullptr;
    usize scratch_count = multiply_scratch(left->digit_count);
    u64 *scratch = nullptr;
    if (scratch_count != 0) {
        scratch = malloc(scratch_count * sizeof(u64));
        if (scratch == nullptr) {
            buffer_dispose(&buffer);
            bigint_oom(heap);
            return nullptr;
        }
    }
    const u64 *x = mal_bigint_digits(left), *y = mal_bigint_digits(right);
    multiply_limbs(buffer.digits, x, left->digit_count, y, right->digit_count, x == y, scratch);
    free(scratch);
    buffer.count = count;
    return buffer_publish(heap, &buffer, left->sign * right->sign);
}

MalBigInt *mal_bigint_divide(MalHeap *heap, const MalBigInt *left, const MalBigInt *right, bool remainder) {
    if (right->sign == 0) {
        mal_vm_throw_error(mal_vm_from_heap(heap), MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Division by zero");
        return nullptr;
    }
    if (left->digit_count <= 2 && right->digit_count <= 2) {
        u128 a = inline_magnitude(left), b = inline_magnitude(right);
        u128 result;
        if (left->digit_count <= 1 && right->digit_count <= 1) {
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
    const u64 *v = mal_bigint_digits(right);
    if (!buffer_copy(heap, &dividend, left)) goto failure;
    if (n == 1) {
        u64 tail = divide_word(dividend.digits, dividend.count, v[0]);
        if (!remainder) return buffer_publish(heap, &dividend, left->sign * right->sign);
        buffer_dispose(&dividend);
        return bigint_from_inline(heap, left->sign, tail);
    }
    if (!buffer_reserve(heap, &dividend, left->digit_count + 1)
        || !buffer_reserve(heap, &divisor, n)
        || !buffer_reserve(heap, &quotient, m + 1)) goto failure;
    // Knuth's algorithm D on normalized operands.
    u32 shift = (u32) __builtin_clzll(v[n - 1]);
    dividend.digits[left->digit_count] = 0;
    if (shift != 0) {
        u64 carry = 0;
        for (u32 i = 0; i < left->digit_count; i++) {
            u64 word = dividend.digits[i];
            dividend.digits[i] = word << shift | carry;
            carry = word >> (64 - shift);
        }
        dividend.digits[left->digit_count] = carry;
        carry = 0;
        for (u32 i = 0; i < n; i++) {
            divisor.digits[i] = v[i] << shift | carry;
            carry = v[i] >> (64 - shift);
        }
        assert(carry == 0);
    } else {
        memcpy(divisor.digits, v, n * sizeof(u64));
    }
    u64 *u = dividend.digits;
    const u64 *d = divisor.digits;
    u64 high = d[n - 1], second = d[n - 2], reciprocal = reciprocal_word(high);
    for (u32 step = m + 1; step != 0; step--) {
        u32 j = step - 1;
        u64 estimate, rest;
        bool rest_overflow = false;
        // Normalization makes the estimate at most two too large; the second divisor
        // limb corrects it before the full multiply and subtract.
        if (u[j + n] >= high) {
            estimate = UINT64_MAX;
            rest = u[j + n - 1] + high;
            rest_overflow = rest < high;
        } else {
            estimate = divide_2by1(u[j + n], u[j + n - 1], high, reciprocal, &rest);
        }
        while (!rest_overflow
            && (u128) estimate * second > ((u128) rest << 64 | u[j + n - 2])) {
            estimate--;
            rest += high;
            rest_overflow = rest < high;
        }
        u64 borrow = 0, carry = 0;
        for (u32 i = 0; i < n; i++) {
            u128 product = (u128) estimate * d[i] + carry;
            carry = (u64) (product >> 64);
            u128 difference = (u128) u[j + i] - (u64) product - borrow;
            u[j + i] = (u64) difference;
            borrow = (u64) (difference >> 127);
        }
        u128 top = (u128) u[j + n] - carry - borrow;
        u[j + n] = (u64) top;
        if ((u64) (top >> 127) != 0) {
            estimate--;
            u[j + n] += add_limbs(u + j, d, n, 0);
        }
        quotient.digits[j] = estimate;
    }
    buffer_dispose(&divisor);
    if (remainder) {
        buffer_dispose(&quotient);
        if (shift != 0) {
            for (u32 i = 0; i < n; i++) u[i] = u[i] >> shift | u[i + 1] << (64 - shift);
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

static u64 twos_word(const MalBigInt *value, u32 index, u64 *carry) {
    u64 word = index < value->digit_count ? mal_bigint_digits(value)[index] : 0;
    if (value->sign >= 0) return word;
    u128 bits = (u128) ~word + *carry;
    *carry = (u64) (bits >> 64);
    return (u64) bits;
}

static void twos_to_magnitude(BigBuffer *buffer, u64 top_mask) {
    u128 carry = 1;
    for (u32 i = 0; i < buffer->count; i++) {
        carry += ~buffer->digits[i];
        buffer->digits[i] = (u64) carry;
        carry >>= 64;
    }
    if (buffer->count != 0) buffer->digits[buffer->count - 1] &= top_mask;
}

MalBigInt *mal_bigint_bitwise(MalHeap *heap, const MalBigInt *left, const MalBigInt *right, char operation) {
    u32 count = (left->digit_count > right->digit_count ? left->digit_count : right->digit_count) + 1;
    if (operation == '&' && (left->sign >= 0 || right->sign >= 0)) {
        if (left->sign >= 0) count = left->digit_count;
        if (right->sign >= 0 && right->digit_count < count) count = right->digit_count;
        if (count == 0) return mal_bigint_new(heap, 0);
        if (count == 1) return bigint_from_inline(heap, 1, mal_bigint_low_u64(left) & mal_bigint_low_u64(right));
    }
    if (left->sign >= 0 && right->sign >= 0 && left->digit_count <= 2 && right->digit_count <= 2) {
        u128 a = inline_magnitude(left), b = inline_magnitude(right);
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
        u64 x = twos_word(left, i, &a_carry), y = twos_word(right, i, &b_carry);
        buffer.digits[i] = operation == '&' ? x & y : operation == '|' ? x | y : x ^ y;
    }
    bool negative = operation == '&' ? left->sign < 0 && right->sign < 0
        : operation == '|' ? left->sign < 0 || right->sign < 0 : (left->sign < 0) != (right->sign < 0);
    buffer.count = count;
    if (negative) twos_to_magnitude(&buffer, UINT64_MAX);
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
    u32 words = (u32) (amount / 64), bits = (u32) (amount % 64);
    BigBuffer buffer;
    buffer_init(&buffer);
    const u64 *digits = mal_bigint_digits(value);
    if (!right) {
        u32 count_out = (length + (u32) amount + 63) / 64;
        if (!buffer_reserve(heap, &buffer, count_out)) return nullptr;
        buffer.count = count_out;
        memset(buffer.digits, 0, buffer.count * sizeof(u64));
        u64 carry = 0;
        for (u32 i = 0; i < value->digit_count; i++) {
            buffer.digits[words + i] = digits[i] << bits | carry;
            carry = bits == 0 ? 0 : digits[i] >> (64 - bits);
        }
        if (carry != 0) buffer.digits[words + value->digit_count] = carry;
    } else {
        u32 count_out = value->digit_count - words;
        if (!buffer_reserve(heap, &buffer, count_out + 1)) return nullptr;
        for (u32 i = 0; i < count_out; i++) {
            u64 part = digits[i + words] >> bits;
            if (bits != 0 && i + words + 1 < value->digit_count) part |= digits[i + words + 1] << (64 - bits);
            buffer.digits[i] = part;
        }
        buffer.count = normalized_count(buffer.digits, count_out);
        if (value->sign < 0 && magnitude_low_bits(value, (u32) amount)) {
            u64 carry = increment_limbs(buffer.digits, buffer.count, 1);
            if (carry != 0) buffer.digits[buffer.count++] = carry;
        }
    }
    return buffer_publish(heap, &buffer, value->sign);
}

MalBigInt *mal_bigint_from_wrapped(MalHeap *heap, u64 bits, u32 width, bool is_signed) {
    assert(width >= 1 && width <= 64);
    u64 mask = width == 64 ? UINT64_MAX : (UINT64_C(1) << width) - 1;
    u64 twos = bits & mask;
    bool negative = is_signed && (twos & (UINT64_C(1) << (width - 1))) != 0;
    return bigint_from_inline(heap, negative ? -1 : 1, negative ? ((u64) 0 - twos) & mask : twos);
}

MalBigInt *mal_bigint_width(MalHeap *heap, const MalBigInt *value, u64 bits, bool is_signed) {
    if (bits == 0 || value->sign == 0) return mal_bigint_new(heap, 0);
    u32 length = mal_bigint_bit_length(value);
    if (is_signed) {
        if (bits > length || (value->sign < 0 && bits == length
                && !magnitude_low_bits(value, length - 1))) return (MalBigInt *) value;
    } else if (value->sign > 0 && bits >= length) return (MalBigInt *) value;
    if (bits <= 64) return mal_bigint_from_wrapped(heap, mal_bigint_low_u64(value), (u32) bits, is_signed);
    if (bits <= 128) {
        const u64 *digits = mal_bigint_digits(value);
        u128 magnitude = digits[0];
        if (value->digit_count > 1) magnitude |= (u128) digits[1] << 64;
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
    u32 count = ((u32) bits + 63) / 64;
    BigBuffer buffer;
    buffer_init(&buffer);
    if (!buffer_reserve(heap, &buffer, count)) return nullptr;
    u64 carry = 1;
    for (u32 i = 0; i < count; i++) buffer.digits[i] = twos_word(value, i, &carry);
    u64 mask = bits % 64 != 0 ? (UINT64_C(1) << (bits % 64)) - 1 : UINT64_MAX;
    buffer.digits[count - 1] &= mask;
    bool negative = is_signed
        && (buffer.digits[count - 1] & (UINT64_C(1) << ((bits - 1) % 64))) != 0;
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
    if (value->digit_count <= 2) {
        u128 magnitude = inline_magnitude(value);
        if (radix == 10) {
            if (value->digit_count <= 1) {
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
            if (value->digit_count <= 1) {
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
        const u64 *digits = mal_bigint_digits(value);
        for (usize i = digits_out; i != 0; i--) {
            u32 bit = (u32) ((i - 1) * shift), word = bit / 64, offset = bit % 64;
            u64 part = digits[word] >> offset;
            if (offset != 0 && word + 1 < value->digit_count) part |= digits[word + 1] << (64 - offset);
            *cursor++ = alphabet[part & ((1u << shift) - 1)];
        }
        MalString *result = bigint_ascii(heap, text, length);
        free(text);
        return result;
    }
    // Each pass divides by the largest power of the radix in a limb.
    u64 chunk_base = (u64) radix;
    u32 chunk_digits = 1;
    while (chunk_base <= UINT64_MAX / (u64) radix) { chunk_base *= (u64) radix; chunk_digits++; }
    u32 chunk_bits = 63 - (u32) __builtin_clzll(chunk_base);
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
        u64 chunk = divide_word(buffer.digits, buffer.count, chunk_base);
        buffer.count = normalized_count(buffer.digits, buffer.count);
        u32 width = buffer.count == 0 ? 0 : chunk_digits, written = 0;
        if (radix == 10) {
            do { *--cursor = (byte) ('0' + chunk % 10); chunk /= 10; written++; }
            while (chunk != 0 || written < width);
        } else {
            do { *--cursor = alphabet[chunk % (u32) radix]; chunk /= (u32) radix; written++; }
            while (chunk != 0 || written < width);
        }
    } while (buffer.count != 0);
    if (value->sign < 0) *--cursor = '-';
    buffer_dispose(&buffer);
    MalString *result = bigint_ascii(heap, cursor, (usize) (end - cursor));
    free(text);
    return result;
}
