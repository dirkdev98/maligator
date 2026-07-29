#pragma once

#include <stdlib.h>

#include "defaults.h"
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

/** String keys compare by code units; all other key values compare by bits. */
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
    MAL_PERF_COUNT(key_non_string_misses);
    return false;
}
