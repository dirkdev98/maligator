#pragma once

#include "./defaults.h"

/**
 * NaN-Boxed MalValue representation.
 *
 * A f64 is a 1 sign bit, 11 exponent bits and 52 mantissa bits.
 * NaN values are represented by 0b01111111111100000...00. The first mantissa
 * bit is used for signaling that an exception should be thrown, so it should always be 0.
 *
 * Pointers are at most 48-bits. So we have 11 NaN bits, 48 pointer bits (or other values) + the first mantissa bit reserved.
 * Which leaves the sign bit and the 2nd, 3rd and 4th mantissa bits to encode data.
 *
 * We use the sign bit to determine if we have an inline value for various static things like null, undefined, true,
 * false which are then encoded on the lower bits.
 *
 * The dynamic values use the 3 left over mantissa bits to differentiate between the different dynamic uses.
 */
typedef u64 MalValue;

// Various masking constants.
#define MASK_SIGN_BIT 0x8000000000000000
#define MASK_EXPONENT_BITS 0x7FF0000000000000
#define MASK_QUIET_NAN 0x0008000000000000
#define MASK_INT32 0x00000000FFFFFFFF
#define MAKS_PTR 0x0000FFFFFFFFFFFF

// Inline static values. We have lots of bits here to play with, so if it makes sense to add more things, we should do that.
// i.e things like -0, +0 etc could be a good usecase.
#define MAL_VALUE_STATIC (MASK_QUIET_NAN | MASK_EXPONENT_BITS)
#define MAL_VALUE_NAN (MAL_VALUE_STATIC | 0x01)
#define MAL_VALUE_NULL (MAL_VALUE_STATIC | 0x02)
#define MAL_VALUE_UNDEFINED (MAL_VALUE_STATIC | 0x03)
#define MAL_VALUE_TRUE (MAL_VALUE_STATIC | 0x04)
#define MAL_VALUE_FALSE (MAL_VALUE_STATIC | 0x05)
#define MAL_VALUE_NEGATIVE_ZERO (MAL_VALUE_STATIC | 0x06)


// Inline dynamic values. We have room for 7 items (3 bits).
// Some other use cases might be to inline symbols, packaged strings, or differentiate types to pointer values.
#define MAL_VALUE_DYNAMIC (MAL_VALUE_STATIC | MASK_SIGN_BIT)
#define MAL_VALUE_INT32 (MAL_VALUE_STATIC | 0x0001000000000000)
// We have a decision at some point to go from 48-bit pointers to 32-bit pointers.
// This means that we have another 16-bits available, and could potentially store the MalHeapHeader inline.
// The downside is that we constrain ourselves to a 4GB heap
#define MAL_VALUE_PTR (MAL_VALUE_STATIC | 0x0002000000000000)

typedef enum MalValueType {
    SYMBOL = 1,
    STRING = 2,
    // etc.
} MalValueType;

// Note that this will prob always be a 64-bit aligned, so we have plenty of room to store more things.
typedef struct MalHeapHeader {
    MalValueType type;
} MalHeapHeader;

typedef struct MalHeapSymbol {
    MalHeapHeader header;
} MalHeapSymbol;


/**
 * Reinterpret f64 as MalValue
 */
MalValue mal_value_from_f64(f64 value);

/**
 * Reinterpret f64 as MalValue + convert any NaN to our only NaN.
 */
MalValue mal_value_from_f64_convert_nan(f64 value);

/**
 * Reinterpret a MalValue as a f64
 */
f64 mal_value_to_f64(MalValue value);


/**
 * Returns true if the value is a f64
 */
bool mal_value_is_f64(MalValue value);

/**
 * Returns true if the value is a f64 or NaN
 */
bool mal_value_is_f64_or_nan(MalValue value);

/**
 * Create a new NaN value.
 */
MalValue mal_value_new_nan();

/**
 * Check if the provided value is a NaN
 */
bool mal_value_is_nan(MalValue value);

/**
 * Create a new null value.
 */
MalValue mal_value_new_null();

/**
 * Check if the provided value is a null
 */
bool mal_value_is_null(MalValue value);


/**
 * Create a new undefined value.
 */
MalValue mal_value_new_undefined();

/**
 * Check if the provided value is an undefined
 */
bool mal_value_is_undefined(MalValue value);

/**
 * Check if the value is null or undefined.
 */
bool mal_value_is_nil(MalValue value);

/**
 * Create a new MalValue from a boolean
 */
MalValue mal_value_new_boolean(bool value);

/**
 * Check if the MalValue is a boolean.
 */
bool mal_value_is_boolean(MalValue value);

/**
 * Convert MalValue to a boolean.
 */
bool mal_value_to_boolean(MalValue value);

/**
 * Create a MalValue from an i32
 */
MalValue mal_value_from_i32(i32 value);

/**
 * Extract the i32 from a MalValue
 */
i32 mal_value_to_i32(MalValue value);

/**
 * Check if the value is an i32
 */
bool mal_value_is_int32(MalValue value);

bool mal_value_is_truthy(MalValue value);

void mal_value_debug(MalValue value);
