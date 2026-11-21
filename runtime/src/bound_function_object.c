#include "bound_function_object.h"

#include <assert.h>
#include <stdlib.h>

#include "gc.h"
#include "perf_stats.h"
#include "value.h"

static_assert(sizeof(MalBoundFunctionObject) % alignof(MalValue) == 0,
              "bound function trailing arguments are misaligned");
static_assert(offsetof(MalBoundFunctionObject, metadata) == sizeof(MalObject) + sizeof(void *),
              "compact bound function fields must follow the prototype word");

MalBoundFunctionObject *mal_bound_function_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalValue target,
    MalValue bound_this,
    const MalValue *bound_args,
    i32 bound_count
) {
    MalBoundFunctionObject *bound = mal_heap_alloc(
        heap,
        sizeof(MalBoundFunctionObject) + (usize) bound_count * sizeof(MalValue),
        MAL_HEAP_BOUND_FUNCTION_OBJECT);
    MalHeapHeader header = bound->object.header;
    bound->object = (MalObject) {
        .header = header,
        .extensible = true,
        .storage_kind = MAL_OBJECT_COMPACT,
        // The metadata fields follow; bound state after them must never be grown into.
        .inline_payload_eights = 2,
        .shape = mal_shape_root(heap),
    };
    bound->prototype = prototype;
    mal_object_mark_as_prototype(prototype);

    bound->target = target;
    bound->bound_this = bound_this;
    bound->bound_count = bound_count;
    MalValue *args = mal_bound_function_object_args(bound);
    for (i32 i = 0; i < bound_count; i++) {
        args[i] = bound_args[i];
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
    assert(mal_object_fields(object) == nullptr);
    assert(mal_object_overflow(object) == nullptr);
    MalShape *shape =
        mal_shape_add_property(object->shape, length_key, MAL_PROPERTY_CONFIGURABLE);
    shape = mal_shape_add_property(shape, name_key, MAL_PROPERTY_CONFIGURABLE);
    object->slot_capacity = 2;
    object->shape = shape;
    mal_object_field_initialize(object, shape, 0, length);
    mal_object_field_initialize(object, shape, 1, name);
    // Target metadata lookup can run user code and collect after the bound cell
    // was allocated, so it may already be old when these slots are installed.
    mal_gc_card(&object->header, length);
    mal_gc_card(&object->header, name);
}

MalValue mal_bound_function_object_new_target(MalValue callee, MalValue new_target) {
    while (mal_value_is_bound_function_object(callee)) {
        MalValue target = mal_value_to_bound_function_object(callee)->target;
        if (new_target == callee) new_target = target;
        callee = target;
    }
    return new_target;
}

MalBoundResolution mal_bound_function_object_resolve(
    MalValue callee,
    MalValue this_value,
    const MalValue *args,
    i32 arg_count,
    bool use_bound_this,
    MalValue *inline_args,
    i32 inline_capacity
) {
    MalBoundResolution resolution = {
        .callee = callee,
        .this_value = this_value,
        .args = args,
        .arg_count = arg_count,
        .owned_args = nullptr,
        .args_merged = false,
    };

    if (!mal_value_is_bound_function_object(callee)) {
        return resolution;
    }
    MAL_PERF_COUNT(bound_function_resolutions);

    i32 prefix_count = 0;
    MalValue current = callee;
    while (mal_value_is_bound_function_object(current)) {
        MalBoundFunctionObject *bound = mal_value_to_bound_function_object(current);
        prefix_count += bound->bound_count;
        if (use_bound_this) resolution.this_value = bound->bound_this;
        current = bound->target;
    }

    resolution.callee = current;
    resolution.arg_count = prefix_count + arg_count;
    resolution.args_merged = prefix_count > 0;
    if (prefix_count == 0) return resolution;

    MalValue *merged_args = nullptr;
    if (prefix_count > 0) {
        if (resolution.arg_count <= inline_capacity) {
            merged_args = inline_args;
        } else {
            resolution.owned_args = malloc(sizeof(MalValue) * resolution.arg_count);
            merged_args = resolution.owned_args;
        }
        resolution.args = merged_args;
        for (i32 i = 0; i < arg_count; i++) {
            merged_args[prefix_count + i] = args[i];
        }
    }

    // Walking outward-in: each outer level's bound arguments sit directly
    // before the already-placed arguments, so the innermost level ends up
    // first.
    i32 front = prefix_count;
    current = callee;
    while (mal_value_is_bound_function_object(current)) {
        MalBoundFunctionObject *bound = mal_value_to_bound_function_object(current);
        front -= bound->bound_count;
        for (i32 i = 0; i < bound->bound_count; i++) {
            merged_args[front + i] = mal_bound_function_object_args(bound)[i];
        }

        current = bound->target;
    }

    return resolution;
}
