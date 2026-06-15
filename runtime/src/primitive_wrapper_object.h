#pragma once

#include "./defaults.h"
#include "object.h"
#include "property_store.h"
#include "value.h"

typedef struct MalVm MalVm;
typedef struct MalHeap MalHeap;

/**
 * The primitive type wrapped by a MalPrimitiveWrapperObject. Mirrors the spec's
 * distinction between the [[StringData]] / [[NumberData]] / [[BooleanData]] /
 * [[SymbolData]] / [[BigIntData]] internal slots so the matching prototype
 * methods can brand-check their receiver.
 */
typedef enum MalPrimitiveWrapperKind {
    MAL_PRIMITIVE_WRAPPER_STRING,
    MAL_PRIMITIVE_WRAPPER_NUMBER,
    MAL_PRIMITIVE_WRAPPER_BOOLEAN,
    MAL_PRIMITIVE_WRAPPER_SYMBOL,
    MAL_PRIMITIVE_WRAPPER_BIGINT,
} MalPrimitiveWrapperKind;

/**
 * A primitive wrapper exotic object: `new String("x")`, `new Number(1)`,
 * `new Boolean(false)`, `Object(symbol)`, `Object(1n)`, etc. Holds the wrapped
 * primitive in [[PrimitiveData]]. String wrappers additionally expose
 * integer-indexed single-code-unit own data properties plus a non-writable,
 * non-configurable own `length`; the index/length exoticness is handled in the
 * VM property machinery, not in the property table.
 */
typedef struct MalPrimitiveWrapperObject {
    MalObject object;
    MalPrimitiveWrapperKind kind;
    MalValue primitive_data;
} MalPrimitiveWrapperObject;

/**
 * Allocate and initialize a new primitive wrapper object holding primitive_data.
 */
MalPrimitiveWrapperObject *mal_primitive_wrapper_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalPrimitiveWrapperKind kind,
    MalValue primitive_data
);

/**
 * String exotic [[GetOwnProperty]]: a String wrapper exposes its [[StringData]]
 * code units as own integer-indexed single-code-unit data properties (value,
 * non-writable, enumerable, non-configurable) plus a non-writable,
 * non-enumerable, non-configurable own `length`. The single-character value is
 * materialized on `heap`.
 *
 * Returns true and fills `*desc_out` when `key` names such an exotic own
 * property of a String wrapper. Returns false for any non-string wrapper, an
 * out-of-range index, or any other key (the caller falls through to the
 * ordinary property table). `object` may be any object; this is a no-op unless
 * it is a String wrapper, so callers can probe it unconditionally.
 */
bool mal_primitive_wrapper_string_exotic_own(
    MalHeap *heap,
    MalObject *object,
    MalKey key,
    MalPropertyDesc *desc_out
);
