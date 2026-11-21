#pragma once

#include "./defaults.h"
#include "object.h"

/**
 * A compact cell: the prototype word, then the `length` and `name` fields, then the
 * bound state and the bound arguments. Property growth moves the fields out of the
 * cell, as for any compact object whose inline payload is full.
 */
typedef struct MalBoundFunctionObject {
    MalObject object;
    MalObject *prototype;
    MalValue metadata[2];
    MalValue target;
    MalValue bound_this;
    i32 bound_count;
} MalBoundFunctionObject;

static_assert(sizeof(MalBoundFunctionObject) <= 64,
              "bound function outgrew its packed layout");

/** [[BoundArguments]], coallocated after the cell. */
static inline MalValue *mal_bound_function_object_args(const MalBoundFunctionObject *bound) {
    return (MalValue *) (bound + 1);
}

#define MAL_BOUND_INLINE_ARGS 16

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

/** Install the bound function's `length`, then `name`, in its inline fields. */
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

/**
 * The new.target that a bound chain's [[Construct]] forwards to its final target:
 * each level whose bound function equals new.target replaces it with that level's target.
 */
MalValue mal_bound_function_object_new_target(MalValue callee, MalValue new_target);
