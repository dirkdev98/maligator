#include "bound_function_object.h"

#include <assert.h>
#include <stdlib.h>

#include "gc.h"
#include "profile.h"
#include "value.h"

static_assert(sizeof(MalBoundFunctionObject) % alignof(MalValue) == 0,
              "bound function trailing metadata slots are misaligned");

MalBoundFunctionObject *mal_bound_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalValue target,
    MalValue bound_this,
    const MalValue *bound_args,
    i32 bound_count
) {
    MalBoundFunctionObject *bound = mal_heap_alloc(
        heap, sizeof(MalBoundFunctionObject) + 2 * sizeof(MalValue),
        MAL_HEAP_BOUND_FUNCTION_OBJECT);
    mal_object_init(heap, &bound->object, MAL_HEAP_BOUND_FUNCTION_OBJECT, prototype);

    bound->target = target;
    bound->bound_this = bound_this;
    bound->bound_count = bound_count;
    bound->bound_args = bound_count > 0
        ? mal_heap_alloc_raw_profiled(
            heap, sizeof(MalValue) * bound_count,
            MAL_PROFILE_ALLOCATION_FAMILY_FUNCTION)
        : nullptr;
    for (i32 i = 0; i < bound_count; i++) {
        bound->bound_args[i] = bound_args[i];
    }

    return bound;
}

void mal_bound_function_object_init_metadata(
    MalBoundFunctionObject *bound,
    MalKey length_key,
    MalValue length,
    MalKey name_key,
    MalValue name
) {
    MalObject *object = &bound->object;
    assert(object->shape->inline_count == 0);
    assert(object->slots == nullptr);
    assert(object->overflow == nullptr);
    MalShape *shape =
        mal_shape_add_property(object->shape, length_key, MAL_PROPERTY_CONFIGURABLE);
    shape = mal_shape_add_property(shape, name_key, MAL_PROPERTY_CONFIGURABLE);
    object->shape = shape;
    object->slots = (MalValue *) (bound + 1);
    object->slots[0] = length;
    object->slots[1] = name;
    // Target metadata lookup can run user code and collect after the bound cell
    // was allocated, so it may already be old when these slots are installed.
    mal_gc_card(&object->header, length);
    mal_gc_card(&object->header, name);
}

MalBoundResolution mal_bound_function_object_resolve(
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    bool use_bound_this
) {
    MalBoundResolution resolution = {
        .callee = callee,
        .this_value = this_value,
        .args = args,
        .arg_count = arg_count,
        .owned_args = nullptr,
    };

    if (!mal_value_is_bound_function_object(callee)) {
        return resolution;
    }

    i32 prefix_count = 0;
    MalValue current = callee;
    while (mal_value_is_bound_function_object(current)) {
        MalBoundFunctionObject *bound = mal_value_to_bound_function_object(current);
        prefix_count += bound->bound_count;
        current = bound->target;
    }

    resolution.callee = current;
    resolution.arg_count = prefix_count + arg_count;

    if (prefix_count > 0) {
        resolution.owned_args = malloc(sizeof(MalValue) * resolution.arg_count);
        resolution.args = resolution.owned_args;
        for (i32 i = 0; i < arg_count; i++) {
            resolution.owned_args[prefix_count + i] = args[i];
        }
    }

    // Walking outward-in: each outer level's bound arguments sit directly
    // before the already-placed arguments, so the innermost level ends up
    // first. The innermost bound this wins.
    i32 front = prefix_count;
    current = callee;
    while (mal_value_is_bound_function_object(current)) {
        MalBoundFunctionObject *bound = mal_value_to_bound_function_object(current);
        front -= bound->bound_count;
        for (i32 i = 0; i < bound->bound_count; i++) {
            resolution.owned_args[front + i] = bound->bound_args[i];
        }

        if (use_bound_this) {
            resolution.this_value = bound->bound_this;
        }

        current = bound->target;
    }

    return resolution;
}
