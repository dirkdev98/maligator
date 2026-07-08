#pragma once

#include "./defaults.h"
#include "heap.h"

typedef struct MalString MalString;
typedef struct MalSymbol MalSymbol;
typedef struct MalBigInt MalBigInt;
typedef struct MalArrayBufferObject MalArrayBufferObject;
typedef struct MalTypedArrayObject MalTypedArrayObject;
typedef struct MalDataViewObject MalDataViewObject;
typedef struct MalWeakRefObject MalWeakRefObject;
typedef struct MalFinalizationRegistryObject MalFinalizationRegistryObject;
typedef struct MalObject MalObject;
typedef struct MalFunctionObject MalFunctionObject;
typedef struct MalNativeFunctionObject MalNativeFunctionObject;
typedef struct MalBoundFunctionObject MalBoundFunctionObject;
typedef struct MalArrayObject MalArrayObject;
typedef struct MalMapObject MalMapObject;
typedef struct MalIteratorObject MalIteratorObject;
typedef struct MalModuleNamespaceObject MalModuleNamespaceObject;
typedef struct MalPromiseObject MalPromiseObject;
typedef struct MalIteratorHelperObject MalIteratorHelperObject;
typedef struct MalPrimitiveWrapperObject MalPrimitiveWrapperObject;
typedef struct MalDateObject MalDateObject;
typedef struct MalIntlObject MalIntlObject;
typedef struct MalRegExpObject MalRegExpObject;
typedef struct MalRegExpStringIteratorObject MalRegExpStringIteratorObject;
typedef struct MalResponseObject MalResponseObject;
typedef struct MalRequestObject MalRequestObject;
typedef struct MalHeadersObject MalHeadersObject;
typedef struct MalUrlObject MalUrlObject;
typedef struct MalUrlSearchParamsObject MalUrlSearchParamsObject;
typedef struct MalEventTargetObject MalEventTargetObject;

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
// Raw f64 infinities collide with the tag space check (exponent all ones), so
// they get static encodings like NaN does.
#define MAL_VALUE_POSITIVE_INFINITY (MAL_VALUE_STATIC | 0x07)
#define MAL_VALUE_NEGATIVE_INFINITY (MAL_VALUE_STATIC | 0x08)
// The "empty"/uninitialized sentinel: a let/const/class binding in its temporal
// dead zone. Never a real JS value; reading one throws ReferenceError.
#define MAL_VALUE_EMPTY (MAL_VALUE_STATIC | 0x09)
// The array-hole sentinel: marks an absent index inside an array's dense element
// vector (distinct from a present `undefined`). Never escapes to JS — a read of a
// hole resolves like a missing own property (proto lookup; HasProperty is false).
// A static (non-pointer) value, so GC tracing skips it.
#define MAL_VALUE_ARRAY_HOLE (MAL_VALUE_STATIC | 0x0A)


// Inline dynamic values. We have room for 7 items (3 bits).
// Some other use cases might be to inline symbols, packaged strings, or differentiate types to pointer values.
#define MAL_VALUE_DYNAMIC (MAL_VALUE_STATIC | MASK_SIGN_BIT)
#define MAL_VALUE_INT32 (MAL_VALUE_STATIC | 0x0001000000000000)
// We have a decision at some point to go from 48-bit pointers to 32-bit pointers.
// This would mean that we have another 16-bits available, and could potentially store the MalHeapHeader inline.
// The downside is that we constrain ourselves to a 4GB heap
#define MAL_VALUE_PTR (MAL_VALUE_STATIC | 0x0002000000000000)


/**
 * The numeric and tag-classification primitives below are `static inline` so
 * the interpreter's hot loop and the native-C backend's boxed fallbacks lower
 * to a few bit tests over the NaN-boxing layout instead of cross-TU calls (the
 * same treatment mal_ops_is_number already gets in value_ops.h). They depend
 * only on the heap header (heap.h, included above), so any value.h includer can
 * use them. Definitions are ordered so each callee precedes its callers.
 */

/** Reinterpret f64 as MalValue. */
static inline MalValue mal_value_from_f64(f64 value) {
    return *(MalValue *) &value;
}

/** Reinterpret a MalValue as a f64. */
static inline f64 mal_value_to_f64(MalValue value) {
    return *(f64 *) &value;
}

/** Returns true if the value is a f64. */
static inline bool mal_value_is_f64(MalValue value) {
    return (value & MASK_EXPONENT_BITS) != MASK_EXPONENT_BITS;
}

/** Create a new NaN value. */
static inline MalValue mal_value_new_nan() {
    return MAL_VALUE_NAN;
}

/** Check if the provided value is a NaN. */
static inline bool mal_value_is_nan(MalValue value) {
    return value == MAL_VALUE_NAN;
}

/** Returns true if the value is a f64 or NaN. */
static inline bool mal_value_is_f64_or_nan(MalValue value) {
    return mal_value_is_nan(value) || mal_value_is_f64(value);
}

/** Reinterpret f64 as MalValue + convert any NaN to our only NaN. */
static inline MalValue mal_value_from_f64_convert_nan(f64 value) {
    MalValue mal_value = mal_value_from_f64(value);
    if ((mal_value & MASK_EXPONENT_BITS) == MASK_EXPONENT_BITS) {
        if (value > 0) {
            return MAL_VALUE_POSITIVE_INFINITY;
        }
        if (value < 0) {
            return MAL_VALUE_NEGATIVE_INFINITY;
        }
        return MAL_VALUE_NAN;
    }
    return mal_value;
}

/** Create a new null value. */
static inline MalValue mal_value_new_null() {
    return MAL_VALUE_NULL;
}

/** Check if the provided value is a null. */
static inline bool mal_value_is_null(MalValue value) {
    return value == MAL_VALUE_NULL;
}

/** Create a new undefined value. */
static inline MalValue mal_value_new_undefined() {
    return MAL_VALUE_UNDEFINED;
}

/** Check if the provided value is an undefined. */
static inline bool mal_value_is_undefined(MalValue value) {
    return value == MAL_VALUE_UNDEFINED;
}

/** Check if the value is null or undefined. */
static inline bool mal_value_is_nil(MalValue value) {
    return mal_value_is_null(value) || mal_value_is_undefined(value);
}

/** Create the uninitialized ("empty") sentinel for a binding in its TDZ. */
static inline MalValue mal_value_new_empty() {
    return MAL_VALUE_EMPTY;
}

/** Check if the value is the uninitialized ("empty") sentinel. */
static inline bool mal_value_is_empty(MalValue value) {
    return value == MAL_VALUE_EMPTY;
}

/** Create the array-hole sentinel (an absent slot in a dense element vector). */
static inline MalValue mal_value_new_array_hole() {
    return MAL_VALUE_ARRAY_HOLE;
}

/** Check if the value is the array-hole sentinel. */
static inline bool mal_value_is_array_hole(MalValue value) {
    return value == MAL_VALUE_ARRAY_HOLE;
}

/** Create a new MalValue from a boolean. */
static inline MalValue mal_value_new_boolean(bool value) {
    return value ? MAL_VALUE_TRUE : MAL_VALUE_FALSE;
}

/** Check if the MalValue is a boolean. */
static inline bool mal_value_is_boolean(MalValue value) {
    return value == MAL_VALUE_TRUE || value == MAL_VALUE_FALSE;
}

/** Convert MalValue to a boolean. */
static inline bool mal_value_to_boolean(MalValue value) {
    return value == MAL_VALUE_TRUE;
}

/** Create a MalValue from an i32. */
static inline MalValue mal_value_from_i32(i32 value) {
    return MAL_VALUE_INT32 | (u32) value;
}

/**
 * Box a u32 as a Number: an int32 when it fits the signed range, otherwise an
 * f64. Array lengths and other u32 quantities exceed INT32_MAX, where a plain
 * mal_value_from_i32 cast would wrap to a negative value.
 */
static inline MalValue mal_value_from_u32(u32 value) {
    if (value <= (u32) INT32_MAX) {
        return MAL_VALUE_INT32 | value;
    }
    f64 as_f64 = (f64) value;
    return *(MalValue *) &as_f64;
}

/** Extract the i32 from a MalValue. */
static inline i32 mal_value_to_i32(MalValue value) {
    return (i32) (value & MASK_INT32);
}

/** Check if the value is an i32. */
static inline bool mal_value_is_int32(MalValue value) {
    return (value & MAL_VALUE_INT32) == MAL_VALUE_INT32;
}

/** Box a heap allocation. */
static inline MalValue mal_value_from_heap(MalHeapHeader *heap) {
    return MAL_VALUE_PTR | ((uptr) heap & MAKS_PTR);
}

/** Check if the value is heap-backed. */
static inline bool mal_value_is_heap(MalValue value) {
    return (value & MAL_VALUE_PTR) == MAL_VALUE_PTR;
}

/** Unbox a heap allocation. */
static inline MalHeapHeader *mal_value_to_heap(MalValue value) {
    return (MalHeapHeader *) (uptr) (value & MAKS_PTR);
}

/** Unbox a const heap allocation. */
static inline const MalHeapHeader *mal_value_to_heap_const(MalValue value) {
    return (const MalHeapHeader *) (uptr) (value & MAKS_PTR);
}

/** Read the heap type tag. */
static inline MalHeapType mal_value_heap_type(MalValue value) {
    return mal_value_to_heap_const(value)->type;
}

/** Check if the value has the given heap type. */
static inline bool mal_value_is_heap_type(MalValue value, MalHeapType type) {
    return mal_value_is_heap(value) && mal_value_heap_type(value) == type;
}

/** Check if the value is a string. */
static inline bool mal_value_is_string(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_STRING);
}

/** Check if the value is a symbol. */
static inline bool mal_value_is_symbol(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_SYMBOL);
}

/** Check if the value is a BigInt. */
static inline bool mal_value_is_bigint(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_BIGINT);
}

/** Check if the value is an object. */
static inline bool mal_value_is_object(MalValue value) {
    if (!mal_value_is_heap(value)) {
        return false;
    }
    MalHeapType type = mal_value_heap_type(value);
    return type == MAL_HEAP_OBJECT ||
        type == MAL_HEAP_PRIMITIVE_WRAPPER_OBJECT ||
        type == MAL_HEAP_FUNCTION_OBJECT ||
        type == MAL_HEAP_NATIVE_FUNCTION_OBJECT ||
        type == MAL_HEAP_BOUND_FUNCTION_OBJECT ||
        type == MAL_HEAP_ARRAY_OBJECT ||
        type == MAL_HEAP_MAP_OBJECT ||
        type == MAL_HEAP_SET_OBJECT ||
        type == MAL_HEAP_ITERATOR_OBJECT ||
        type == MAL_HEAP_GENERATOR_OBJECT ||
        type == MAL_HEAP_ARRAY_BUFFER_OBJECT ||
        type == MAL_HEAP_TYPED_ARRAY_OBJECT ||
        type == MAL_HEAP_DATA_VIEW_OBJECT ||
        type == MAL_HEAP_PROMISE_OBJECT ||
        type == MAL_HEAP_ITERATOR_HELPER_OBJECT ||
        type == MAL_HEAP_MODULE_NAMESPACE_OBJECT ||
        type == MAL_HEAP_PROXY_OBJECT ||
        type == MAL_HEAP_DATE_OBJECT ||
        type == MAL_HEAP_INTL_OBJECT ||
        type == MAL_HEAP_REGEXP_OBJECT ||
        type == MAL_HEAP_REGEXP_STRING_ITERATOR_OBJECT ||
        type == MAL_HEAP_WEAK_REF_OBJECT ||
        type == MAL_HEAP_FINALIZATION_REGISTRY_OBJECT ||
        type == MAL_HEAP_RESPONSE_OBJECT ||
        type == MAL_HEAP_REQUEST_OBJECT ||
        type == MAL_HEAP_HEADERS_OBJECT ||
        type == MAL_HEAP_URL_OBJECT ||
        type == MAL_HEAP_URL_SEARCH_PARAMS_OBJECT ||
        type == MAL_HEAP_EVENT_TARGET_OBJECT;
}

/**
 * Check if the value is a function object.
 */
bool mal_value_is_function_object(MalValue value);

/**
 * Check if the value is a native function object.
 */
bool mal_value_is_native_function_object(MalValue value);

/**
 * Check if the value is a bound function object.
 */
bool mal_value_is_bound_function_object(MalValue value);

/**
 * Check if the value is an array object.
 */
bool mal_value_is_array_object(MalValue value);

/** Module namespace exotic object accessors. */
bool mal_value_is_module_namespace_object(MalValue value);
MalModuleNamespaceObject *mal_value_to_module_namespace_object(MalValue value);
MalValue mal_value_from_module_namespace_object(MalModuleNamespaceObject *ns);

/**
 * Check if the value is a Map/WeakMap instance.
 */
bool mal_value_is_map_object(MalValue value);

/**
 * Check if the value is a Set/WeakSet instance.
 */
bool mal_value_is_set_object(MalValue value);

/**
 * Check if the value is a built-in iterator instance.
 */
bool mal_value_is_iterator_object(MalValue value);

/**
 * Check if the value is a generator instance.
 */
bool mal_value_is_generator_object(MalValue value);

/**
 * Check if the value is an ArrayBuffer / SharedArrayBuffer.
 */
bool mal_value_is_array_buffer_object(MalValue value);

/**
 * Check if the value is a TypedArray view.
 */
bool mal_value_is_typed_array_object(MalValue value);

/**
 * Check if the value is a DataView.
 */
bool mal_value_is_data_view_object(MalValue value);

bool mal_value_is_weak_ref_object(MalValue value);

bool mal_value_is_finalization_registry_object(MalValue value);

/**
 * Check if the value is a Promise instance.
 */
bool mal_value_is_promise_object(MalValue value);

/**
 * Check if the value is an Iterator Helper instance.
 */
bool mal_value_is_iterator_helper_object(MalValue value);

/**
 * Check if the value is a primitive wrapper exotic object (new String/Number/
 * Boolean(...), Object(primitive)).
 */
bool mal_value_is_primitive_wrapper(MalValue value);

/**
 * Unbox / box a primitive wrapper object.
 */
MalPrimitiveWrapperObject *mal_value_to_primitive_wrapper(MalValue value);
MalValue mal_value_from_primitive_wrapper(MalPrimitiveWrapperObject *wrapper);

/**
 * Date exotic object predicate + box/unbox (holds the [[DateValue]] slot).
 */
bool mal_value_is_date_object(MalValue value);
MalDateObject *mal_value_to_date_object(MalValue value);
MalValue mal_value_from_date_object(MalDateObject *date);

/**
 * Intl service instance predicate + box/unbox (Locale + the formatters).
 */
bool mal_value_is_intl_object(MalValue value);
MalIntlObject *mal_value_to_intl_object(MalValue value);
MalValue mal_value_from_intl_object(MalIntlObject *intl);

/**
 * RegExp object predicate + box/unbox (holds the [[RegExpMatcher]] slot). The
 * predicate is the spec's "has [[RegExpMatcher]]" brand test.
 */
bool mal_value_is_regexp_object(MalValue value);
MalRegExpObject *mal_value_to_regexp_object(MalValue value);
MalValue mal_value_from_regexp_object(MalRegExpObject *regexp);

/** WinterTC fetch Response predicate + box/unbox. */
bool mal_value_is_response_object(MalValue value);
MalResponseObject *mal_value_to_response_object(MalValue value);
MalValue mal_value_from_response_object(MalResponseObject *response);

/** WinterTC fetch Request predicate + box/unbox. */
bool mal_value_is_request_object(MalValue value);
MalRequestObject *mal_value_to_request_object(MalValue value);
MalValue mal_value_from_request_object(MalRequestObject *request);

/** WinterTC fetch Headers predicate + box/unbox. */
bool mal_value_is_headers_object(MalValue value);
MalHeadersObject *mal_value_to_headers_object(MalValue value);
MalValue mal_value_from_headers_object(MalHeadersObject *headers);

/** WHATWG URL predicate + box/unbox. */
bool mal_value_is_url_object(MalValue value);
MalUrlObject *mal_value_to_url_object(MalValue value);
MalValue mal_value_from_url_object(MalUrlObject *url);

/** WHATWG URLSearchParams predicate + box/unbox. */
bool mal_value_is_url_search_params_object(MalValue value);
MalUrlSearchParamsObject *mal_value_to_url_search_params_object(MalValue value);
MalValue mal_value_from_url_search_params_object(MalUrlSearchParamsObject *params);

/** DOM EventTarget / AbortSignal predicate + box/unbox. */
bool mal_value_is_event_target_object(MalValue value);
MalEventTargetObject *mal_value_to_event_target_object(MalValue value);
MalValue mal_value_from_event_target_object(MalEventTargetObject *target);

/**
 * RegExp String Iterator predicate + box/unbox (matchAll's iterator).
 */
bool mal_value_is_regexp_string_iterator_object(MalValue value);
MalRegExpStringIteratorObject *mal_value_to_regexp_string_iterator_object(MalValue value);
MalValue mal_value_from_regexp_string_iterator_object(MalRegExpStringIteratorObject *iterator);

/**
 * Spec thisStringValue / thisNumberValue / thisBooleanValue: a matching
 * primitive passes through; a matching wrapper unwraps to its [[PrimitiveData]];
 * anything else is a brand mismatch. Returns false on mismatch, leaving *out
 * untouched, so callers throw a TypeError.
 */
bool mal_value_this_string_value(MalValue value, MalValue *out);
bool mal_value_this_number_value(MalValue value, MalValue *out);
bool mal_value_this_boolean_value(MalValue value, MalValue *out);

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
 * Unbox a BigInt.
 */
MalBigInt *mal_value_to_bigint(MalValue value);

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
 * Unbox a bound function object.
 */
MalBoundFunctionObject *mal_value_to_bound_function_object(MalValue value);

/**
 * Unbox an array object.
 */
MalArrayObject *mal_value_to_array_object(MalValue value);

/**
 * Unbox a map/set object (shared layout for all four collection types).
 */
MalMapObject *mal_value_to_map_object(MalValue value);

/**
 * Unbox a built-in iterator object.
 */
MalIteratorObject *mal_value_to_iterator_object(MalValue value);

/**
 * Unbox an ArrayBuffer / TypedArray / DataView.
 */
MalArrayBufferObject *mal_value_to_array_buffer_object(MalValue value);
MalTypedArrayObject *mal_value_to_typed_array_object(MalValue value);
MalDataViewObject *mal_value_to_data_view_object(MalValue value);
MalWeakRefObject *mal_value_to_weak_ref_object(MalValue value);
MalFinalizationRegistryObject *mal_value_to_finalization_registry_object(MalValue value);

/**
 * Unbox a Promise instance.
 */
MalPromiseObject *mal_value_to_promise_object(MalValue value);

/**
 * Unbox an Iterator Helper instance.
 */
MalIteratorHelperObject *mal_value_to_iterator_helper_object(MalValue value);

/**
 * Box a string. Inline (a single tagged-pointer or) so a constant string key in
 * the emitted native-C backend folds to an immediate instead of a cross-TU call
 * per hot-loop property access (the emitted TU links -O2 with no LTO).
 */
static inline MalValue mal_value_from_string(MalString *string) {
    return mal_value_from_heap((MalHeapHeader *) string);
}

/**
 * Box a symbol.
 */
MalValue mal_value_from_symbol(MalSymbol *symbol);

/**
 * Box a BigInt. Inline for the same reason as mal_value_from_string (the backend
 * emits it for a BigInt literal key/value).
 */
static inline MalValue mal_value_from_bigint(MalBigInt *bigint) {
    return mal_value_from_heap((MalHeapHeader *) bigint);
}

/**
 * Box an object. Inline for the same reason as mal_value_from_string.
 */
static inline MalValue mal_value_from_object(MalObject *object) {
    return mal_value_from_heap((MalHeapHeader *) object);
}

/**
 * Box a function object.
 */
MalValue mal_value_from_function_object(MalFunctionObject *function);

/**
 * Box a native function object.
 */
MalValue mal_value_from_native_function_object(MalNativeFunctionObject *function);

/**
 * Box a bound function object.
 */
MalValue mal_value_from_bound_function_object(MalBoundFunctionObject *bound);

/**
 * Box an array object.
 */
MalValue mal_value_from_array_object(MalArrayObject *array);

/**
 * Box a map/set object.
 */
MalValue mal_value_from_map_object(MalMapObject *map);

/**
 * Box a built-in iterator object.
 */
MalValue mal_value_from_iterator_object(MalIteratorObject *iterator);

/**
 * Box an ArrayBuffer / TypedArray / DataView.
 */
MalValue mal_value_from_array_buffer_object(MalArrayBufferObject *buffer);
MalValue mal_value_from_typed_array_object(MalTypedArrayObject *array);
MalValue mal_value_from_data_view_object(MalDataViewObject *view);
MalValue mal_value_from_weak_ref_object(MalWeakRefObject *ref);
MalValue mal_value_from_finalization_registry_object(MalFinalizationRegistryObject *reg);

/**
 * Box a Promise instance.
 */
MalValue mal_value_from_promise_object(MalPromiseObject *promise);

/**
 * Box an Iterator Helper instance.
 */
MalValue mal_value_from_iterator_helper_object(MalIteratorHelperObject *helper);

/**
 * Check if the value is truthy.
 */
bool mal_value_is_truthy(MalValue value);

/**
 * Print a debug representation.
 */
void mal_value_debug(MalValue value);
