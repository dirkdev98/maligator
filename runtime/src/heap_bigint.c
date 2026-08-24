#include "heap_bigint.h"

#include <stdlib.h>

#include "heap_string.h"
#include "vm.h"

void mal_bigint_init(MalBigInt *bigint, i128 value) {
    mal_heap_header_init(&bigint->header, MAL_HEAP_BIGINT);
    bigint->value = value;
}

MalBigInt *mal_bigint_new(MalHeap *heap, i128 value) {
    MalVm *owner = nullptr;
    usize cache_index = 0;
    if (value >= MAL_SMALL_BIGINT_CACHE_MIN &&
        value < MAL_SMALL_BIGINT_CACHE_MIN + MAL_SMALL_BIGINT_CACHE_CAPACITY) {
        owner = mal_vm_from_heap(heap);
        if (owner->small_bigint_cache == nullptr) {
            owner->small_bigint_cache = calloc(
                MAL_SMALL_BIGINT_CACHE_CAPACITY,
                sizeof(*owner->small_bigint_cache));
            if (owner->small_bigint_cache == nullptr) abort();
        }
        cache_index = (usize) (value - MAL_SMALL_BIGINT_CACHE_MIN);
        MalBigInt *cached = owner->small_bigint_cache[cache_index];
        if (cached != nullptr) {
            return cached;
        }
    }

    MalBigInt *bigint = mal_heap_alloc(heap, sizeof(MalBigInt), MAL_HEAP_BIGINT);
    mal_bigint_init(bigint, value);

    if (owner != nullptr) {
        owner->small_bigint_cache[cache_index] = bigint;
    }

    return bigint;
}

i128 mal_bigint_value(const MalBigInt *bigint) {
    return bigint->value;
}

static byte *mal_bigint_write_u64_decimal(
    byte *out, u64 value, usize min_digits
) {
    byte reverse[20];
    usize digits = 0;
    do {
        reverse[digits++] = (byte) ('0' + value % 10);
        value /= 10;
    } while (value != 0);
    while (digits < min_digits) {
        reverse[digits++] = '0';
    }
    while (digits > 0) {
        *out++ = reverse[--digits];
    }
    return out;
}

static MalString *mal_bigint_to_decimal_string(MalHeap *heap, i128 value) {
    if (value == 0) {
        return mal_string_new_ascii(heap, "0", 1);
    }

    static const u128 chunk_base = (u128) 10000000000000000000ULL;
    bool negative = value < 0;
    u128 magnitude = negative ? (~(u128) value + 1) : (u128) value;
    u64 chunks[3];
    usize chunk_count = 0;
    do {
        chunks[chunk_count++] = (u64) (magnitude % chunk_base);
        magnitude /= chunk_base;
    } while (magnitude != 0);

    byte buffer[40];
    byte *cursor = buffer;
    if (negative) {
        *cursor++ = '-';
    }
    cursor = mal_bigint_write_u64_decimal(
        cursor, chunks[--chunk_count], 1);
    while (chunk_count > 0) {
        cursor = mal_bigint_write_u64_decimal(
            cursor, chunks[--chunk_count], 19);
    }
    return mal_string_new_ascii(
        heap, buffer, (usize) (cursor - buffer));
}

MalString *mal_bigint_to_string(MalHeap *heap, i128 value, i32 radix) {
    if (radix < 2 || radix > 36) {
        radix = 10;
    }

    if (radix == 10) {
        return mal_bigint_to_decimal_string(heap, value);
    }

    if (value == 0) {
        return mal_string_new_ascii(heap, "0", 1);
    }

    bool negative = value < 0;
    // Two's-complement magnitude, correct even for the i128 minimum.
    u128 magnitude = negative ? (~(u128) value + 1) : (u128) value;

    // 128 binary digits is the worst case, plus sign.
    byte buffer[140];
    usize length = 0;
    i32 shift = radix == 2 ? 1 :
        radix == 4 ? 2 :
        radix == 8 ? 3 :
        radix == 16 ? 4 :
        radix == 32 ? 5 : 0;
    if (shift != 0) {
        u128 mask = (u128) radix - 1;
        while (magnitude > 0) {
            i32 digit = (i32) (magnitude & mask);
            buffer[length++] = digit < 10
                ? (byte) ('0' + digit)
                : (byte) ('a' + digit - 10);
            magnitude >>= shift;
        }
    } else {
        while (magnitude > 0) {
            i32 digit = (i32) (magnitude % (u128) radix);
            buffer[length++] = digit < 10
                ? (byte) ('0' + digit)
                : (byte) ('a' + digit - 10);
            magnitude /= (u128) radix;
        }
    }
    if (negative) {
        buffer[length++] = '-';
    }

    // Reverse into final order.
    for (usize i = 0; i < length / 2; i++) {
        byte tmp = buffer[i];
        buffer[i] = buffer[length - 1 - i];
        buffer[length - 1 - i] = tmp;
    }

    return mal_string_new_ascii(heap, buffer, length);
}
