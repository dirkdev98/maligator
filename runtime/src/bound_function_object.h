#pragma once

#include "./defaults.h"
#include "object.h"

typedef struct MalBoundFunctionObject {
    MalObject object;
    MalValue target;
    MalValue bound_this;
    i32 bound_count;
    /** Trailing argument vector coallocated after the two metadata slots. */
    MalValue *bound_args;
} MalBoundFunctionObject;

static_assert(sizeof(MalBoundFunctionObject) <= 80,
              "bound function outgrew its packed layout");

#define MAL_BOUND_INLINE_ARGS 8

/**
 * Result of unwrapping a (possibly nested) bound function chain into a direct
 * callee, this value and argument list.
 */
typedef struct MalBoundResolution {
    MalValue callee;
    MalValue this_value;
    const MalValue *args;
    i32 arg_count;

    /**
     * Owned merged-argument storage when bound arguments were prepended, to be
     * freed by the caller after the call. Null for input aliases and inline merges.
     */
    MalValue *owned_args;
    /** Whether `args` contains a merged bound-argument list. */
    bool args_merged;
} MalBoundResolution;

/**
 * Allocate a bound function, its metadata slots, and bound arguments in one
 * managed cell.
 */
MalBoundFunctionObject *mal_bound_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalValue target,
    MalValue bound_this,
    const MalValue *bound_args,
    i32 bound_count
);

/** Install the bound function's `length`, then `name`, in coallocated shape slots. */
void mal_bound_function_object_init_metadata(
    MalBoundFunctionObject *bound,
    MalKey length_key,
    MalValue length,
    MalKey name_key,
    MalValue name
);

/**
 * Unwrap a bound function chain, prepending each level's bound arguments.
 *
 * When use_bound_this is false (construct semantics) the bound this values
 * are ignored and the input this value is kept.
 */
MalBoundResolution mal_bound_function_object_resolve(
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    bool use_bound_this,
    MalValue *inline_args,
    i32 inline_capacity
);
