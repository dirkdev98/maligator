#pragma once

#include "./defaults.h"
#include "heap.h"

typedef struct MalString MalString;
typedef struct MalSymbol MalSymbol;
typedef struct MalObject MalObject;
typedef struct MalFunctionObject MalFunctionObject;
typedef struct MalNativeFunctionObject MalNativeFunctionObject;
typedef struct MalArrayObject MalArrayObject;

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
#define MASK_UINT32_SIGN 0x0000000080000000
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
// This would mean that we have another 16-bits available, and could potentially store the MalHeapHeader inline.
// The downside is that we constrain ourselves to a 4GB heap
#define MAL_VALUE_PTR (MAL_VALUE_STATIC | 0x0002000000000000)


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

/**
 * Box a heap allocation.
 */
MalValue mal_value_from_heap(MalHeapHeader *heap);

/**
 * Check if the value is heap-backed.
 */
bool mal_value_is_heap(MalValue value);

/**
 * Unbox a heap allocation.
 */
MalHeapHeader *mal_value_to_heap(MalValue value);

/**
 * Unbox a const heap allocation.
 */
const MalHeapHeader *mal_value_to_heap_const(MalValue value);

/**
 * Read the heap type tag.
 */
MalHeapType mal_value_heap_type(MalValue value);

/**
 * Check if the value has the given heap type.
 */
bool mal_value_is_heap_type(MalValue value, MalHeapType type);

/**
 * Check if the value is a string.
 */
bool mal_value_is_string(MalValue value);

/**
 * Check if the value is a symbol.
 */
bool mal_value_is_symbol(MalValue value);

/**
 * Check if the value is an object.
 */
bool mal_value_is_object(MalValue value);

/**
 * Check if the value is a function object.
 */
bool mal_value_is_function_object(MalValue value);

/**
 * Check if the value is a native function object.
 */
bool mal_value_is_native_function_object(MalValue value);

/**
 * Check if the value is an array object.
 */
bool mal_value_is_array_object(MalValue value);

/**
 * Check if the value is callable.
 */
bool mal_value_is_callable(MalValue value);

/**
 * Unbox a string.
 */
MalString *mal_value_to_string(MalValue value);

/**
 * Unbox a symbol.
 */
MalSymbol *mal_value_to_symbol(MalValue value);

/**
 * Unbox an object.
 */
MalObject *mal_value_to_object(MalValue value);

/**
 * Unbox a function object.
 */
MalFunctionObject *mal_value_to_function_object(MalValue value);

/**
 * Unbox a native function object.
 */
MalNativeFunctionObject *mal_value_to_native_function_object(MalValue value);

/**
 * Unbox an array object.
 */
MalArrayObject *mal_value_to_array_object(MalValue value);

/**
 * Box a string.
 */
MalValue mal_value_from_string(MalString *string);

/**
 * Box a symbol.
 */
MalValue mal_value_from_symbol(MalSymbol *symbol);

/**
 * Box an object.
 */
MalValue mal_value_from_object(MalObject *object);

/**
 * Box a function object.
 */
MalValue mal_value_from_function_object(MalFunctionObject *function);

/**
 * Box a native function object.
 */
MalValue mal_value_from_native_function_object(MalNativeFunctionObject *function);

/**
 * Box an array object.
 */
MalValue mal_value_from_array_object(MalArrayObject *array);

/**
 * Check if the value is truthy.
 */
bool mal_value_is_truthy(MalValue value);

/**
 * Print a debug representation.
 */
void mal_value_debug(MalValue value);
