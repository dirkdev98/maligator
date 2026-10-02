#pragma once

#include <math.h>
#include <stdlib.h>

#include "defaults.h"
#include "heap_bigint.h"
#include "heap_string.h"
#include "perf_stats.h"
#include "value.h"

/** Equality domain for a stored key. */
typedef enum MalKeyKind {
    MAL_KEY_INDEX,
    MAL_KEY_STRING,
    MAL_KEY_SYMBOL,
    MAL_KEY_NUMBER,
    MAL_KEY_OBJECT,
    MAL_KEY_STATIC,
} MalKeyKind;

/**
 * Tagged key wrapper used by property storage and general tables. `kind` is
 * fully determined by `value`; table and shape entries therefore store only
 * the value and reconstruct the transient wrapper on read.
 */
typedef struct MalKey {
    MalKeyKind kind;
    MalValue value;
} MalKey;

static inline MalKeyKind mal_key_kind_of(MalValue value) {
    if (mal_value_is_string(value)) {
        return MAL_KEY_STRING;
    }
    if (mal_value_is_symbol(value)) {
        return MAL_KEY_SYMBOL;
    }
    if (mal_value_is_object(value)) {
        return MAL_KEY_OBJECT;
    }
    if (mal_value_is_int32(value)) {
        return MAL_KEY_INDEX;
    }
    if (mal_value_is_f64(value)) {
        f64 number = mal_value_to_f64(value);
        if (number >= 0 && number < (f64) UINT32_MAX && (f64) (u32) number == number) {
            return MAL_KEY_INDEX;
        }
    }
    if (mal_value_is_nil(value) || mal_value_is_boolean(value)) {
        return MAL_KEY_STATIC;
    }
    return MAL_KEY_NUMBER;
}

// Canonical bits implement SameValueZero while keeping Number and BigInt distinct.
static inline MalKey mal_collection_key_from_value(MalValue value) {
    if (mal_value_is_string(value)) {
        return (MalKey) {.kind = MAL_KEY_STRING, .value = value};
    }

    if (mal_value_is_symbol(value)) {
        return (MalKey) {.kind = MAL_KEY_SYMBOL, .value = value};
    }

    if (mal_value_is_object(value)) {
        return (MalKey) {.kind = MAL_KEY_OBJECT, .value = value};
    }

    if (mal_value_is_int32(value)) {
        return (MalKey) {.kind = MAL_KEY_NUMBER, .value = mal_value_from_f64((f64) mal_value_to_i32(value))};
    }

    if (value == MAL_VALUE_NEGATIVE_ZERO) {
        return (MalKey) {.kind = MAL_KEY_NUMBER, .value = mal_value_from_f64(0.0)};
    }

    if (mal_value_is_f64(value)) {
        f64 number = mal_value_to_f64(value);

        if (number == 0.0) {
            return (MalKey) {.kind = MAL_KEY_NUMBER, .value = mal_value_from_f64(0.0)};
        }

        if (isnan(number)) {
            return (MalKey) {.kind = MAL_KEY_NUMBER, .value = mal_value_new_nan()};
        }

        return (MalKey) {.kind = MAL_KEY_NUMBER, .value = value};
    }

    if (value == MAL_VALUE_NAN || value == MAL_VALUE_POSITIVE_INFINITY || value == MAL_VALUE_NEGATIVE_INFINITY) {
        return (MalKey) {.kind = MAL_KEY_NUMBER, .value = value};
    }

    if (mal_value_is_bigint(value)) {
        return (MalKey) {.kind = MAL_KEY_NUMBER, .value = value};
    }

    return (MalKey) {.kind = MAL_KEY_STATIC, .value = value};
}


static inline MalKey mal_key_from_value(MalValue value) {
    return (MalKey) {.kind = mal_key_kind_of(value), .value = value};
}

/**
 * Construct an integer property key in ECMAScript's 0..2^32-2 array-index
 * domain. Values above INT32_MAX use the existing exact f64 Number encoding.
 */
static inline MalKey mal_key_index_signed(i64 index) {
    if (index < 0 || (u64) index >= UINT32_MAX) {
        abort();
    }
    return (MalKey) {
        .kind = MAL_KEY_INDEX,
        .value = mal_value_from_u32((u32) index),
    };
}

static inline MalKey mal_key_index_unsigned(u64 index) {
    if (index >= UINT32_MAX) {
        abort();
    }
    return (MalKey) {
        .kind = MAL_KEY_INDEX,
        .value = mal_value_from_u32((u32) index),
    };
}

// Select before conversion so unsigned callers cannot wrap through i32.
#define mal_key_index(index) _Generic((index), \
    u32: mal_key_index_unsigned, \
    u64: mal_key_index_unsigned, \
    default: mal_key_index_signed \
)(index)

static inline u32 mal_key_index_value(MalKey key) {
    if (key.kind != MAL_KEY_INDEX) {
        abort();
    }
    return mal_value_is_int32(key.value)
        ? (u32) mal_value_to_i32(key.value)
        : (u32) mal_value_to_f64(key.value);
}

/**
 * String keys compare by code units and BigInt keys by numeric value; all
 * other key values compare by their canonicalized bits.
 */
static inline bool mal_key_value_equals(MalValue left, MalValue right) {
    MAL_PERF_COUNT(key_equals_calls);
    if (left == right) {
        MAL_PERF_COUNT(key_pointer_hits);
        return true;
    }
    if (mal_value_is_string(left) && mal_value_is_string(right)) {
        MAL_PERF_COUNT(key_string_fallbacks);
        return mal_string_equals(mal_value_to_string(left), mal_value_to_string(right));
    }
    if (mal_value_is_bigint(left) && mal_value_is_bigint(right)) {
        return mal_bigint_value(mal_value_to_bigint(left)) ==
            mal_bigint_value(mal_value_to_bigint(right));
    }
    MAL_PERF_COUNT(key_non_string_misses);
    return false;
}

static inline u64 mal_key_hash_mix(u64 value) {
    value ^= value >> 30;
    value *= 0xbf58476d1ce4e5b9;
    value ^= value >> 27;
    value *= 0x94d049bb133111eb;
    value ^= value >> 31;

    return value;
}

static inline u64 mal_key_hash_value(MalValue value) {
    if (mal_value_is_string(value)) {
        return mal_key_hash_mix(mal_string_hash(mal_value_to_string(value)));
    }
    if (mal_value_is_bigint(value)) {
        u128 bits = (u128) mal_bigint_value(mal_value_to_bigint(value));
        u64 low = (u64) bits;
        u64 high = (u64) (bits >> 64);
        return mal_key_hash_mix(low ^ mal_key_hash_mix(high ^ 0x9e3779b97f4a7c15ull));
    }

    return mal_key_hash_mix(value);
}
