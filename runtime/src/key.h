#pragma once

#include <stdlib.h>

#include "defaults.h"
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
    if (mal_value_is_nil(value) || mal_value_is_boolean(value)) {
        return MAL_KEY_STATIC;
    }
    return MAL_KEY_NUMBER;
}

static inline MalKey mal_key_from_value(MalValue value) {
    return (MalKey) {.kind = mal_key_kind_of(value), .value = value};
}

/**
 * Construct an integer property key in the engine's explicit 0..INT32_MAX
 * property-index domain. Larger ECMAScript property names remain string keys.
 */
static inline MalKey mal_key_index_signed(i64 index) {
    if (index < 0 || index > INT32_MAX) {
        abort();
    }
    return (MalKey) {
        .kind = MAL_KEY_INDEX,
        .value = mal_value_from_i32((i32) index),
    };
}

static inline MalKey mal_key_index_unsigned(u64 index) {
    if (index > INT32_MAX) {
        abort();
    }
    return mal_key_index_signed((i64) index);
}

// Select before conversion so unsigned callers cannot wrap through i32.
#define mal_key_index(index) _Generic((index), \
    u32: mal_key_index_unsigned, \
    u64: mal_key_index_unsigned, \
    default: mal_key_index_signed \
)(index)

/** String keys compare by code units; all other key values compare by bits. */
bool mal_key_value_equals(MalValue left, MalValue right);
