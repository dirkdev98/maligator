#pragma once

#include <stdlib.h>
#include <string.h>

#include "./defaults.h"
#include "heap.h"
#include "property_store.h"
#include "table.h"
#include "value_ops.h"

/**
 * Beyond this many properties an object drops to dictionary mode, which bounds
 * shape-tree growth under churn. Framework records such as Express requests and
 * responses carry 40 to 50 properties.
 */
#define MAL_SHAPE_MAX_INLINE_SLOTS 64

typedef struct MalShape MalShape;
typedef struct MalShapeTransition MalShapeTransition;
typedef struct MalShapeTransitionIndex MalShapeTransitionIndex;

/**
 * Immutable proof that one shaped-object layout is the exact default-data
 * extension of another. Plans are built once and then reused by guarded bulk
 * initialization; shapes and their property arrays never mutate or move.
 */
typedef struct MalShapeAppendPlan {
    MalShape *source;
    MalShape *final;
} MalShapeAppendPlan;

static_assert(sizeof(MalShapeAppendPlan) <= 16,
              "MalShapeAppendPlan outgrew two pointers");

typedef enum MalShapeFindCaller {
    MAL_SHAPE_FIND_GET_OWN,
    MAL_SHAPE_FIND_DEFINE_OWN,
    MAL_SHAPE_FIND_DELETE_OWN,
    MAL_SHAPE_FIND_SET_OWN,
    MAL_SHAPE_FIND_LOAD_IC,
    MAL_SHAPE_FIND_STORE_IC,
    MAL_SHAPE_FIND_CALLER_COUNT,
} MalShapeFindCaller;

/** A shaped property's value lives in tagged field `slot` of its object's payload. */
typedef struct MalShapeProp {
    MalValue key;
    u32 slot;
    u8 attrs;
} MalShapeProp;

static_assert(sizeof(MalShapeProp) <= 16, "MalShapeProp outgrew 16 bytes (one per shaped property)");

struct MalShape {
    MalHeapHeader header;
    u16 inline_count;
    MalShapeProp *props;
    MalShapeTransitionIndex *transition_index;
    MalShapeTransition *transitions;
};

static inline bool mal_shape_can_add_property(const MalShape *shape) {
    return shape->inline_count < MAL_SHAPE_MAX_INLINE_SLOTS;
}

static_assert(sizeof(MalShape) <= 64, "MalShape outgrew its 64-byte layout budget");

/** Initialize/free the transition tree owned by `heap`. */
void mal_shape_heap_init(MalHeap *heap);
void mal_shape_heap_free(MalHeap *heap);

/** The heap-owned empty shape: root of one isolate's transition tree. */
static inline MalShape *mal_shape_root(MalHeap *heap) {
    return heap->shape_root;
}

/**
 * Process-lifetime transitionless empty sentinel used after an object becomes a
 * dictionary. New shaped objects start at mal_shape_root(heap), never here.
 */
MalShape *mal_shape_dictionary_empty(void);

/** Multi-property shape lookup, including the per-thread hashed lookup cache. */
i32 mal_shape_find_wide(
    const MalShape *shape, MalKey key, MalShapeFindCaller caller);

/**
 * Index of `key` in the shape's props, or -1 if absent. Empty and single-property
 * shapes dominate short-lived host/framework objects, so resolve them at the call
 * site without paying an out-of-line lookup/cache setup. Wider shapes retain the
 * shared hashed implementation.
 */
static inline i32 mal_shape_find(
    const MalShape *shape, MalKey key, MalShapeFindCaller caller
) {
    if (shape->inline_count > 1) {
        return mal_shape_find_wide(shape, key, caller);
    }

    MalPerfShapeStats *stats =
        mal_perf_stats_enabled ? &mal_perf_stats.shapes[caller] : nullptr;
    if (stats != nullptr) {
        stats->calls++;
        stats->widths += shape->inline_count;
        if (shape->inline_count > stats->max_width) {
            stats->max_width = shape->inline_count;
        }
    }
    if (shape->inline_count == 0) {
        if (stats != nullptr) stats->misses++;
        return -1;
    }

    bool found = mal_key_value_equals(shape->props[0].key, key.value);
    if (stats != nullptr) {
        stats->comparisons++;
        if (stats->max_comparisons == 0) stats->max_comparisons = 1;
        if (found) {
            stats->hits++;
            if (shape->props[0].key == key.value) stats->pointer_hits++;
            else stats->content_hits++;
        } else {
            stats->misses++;
        }
    }
    return found ? 0 : -1;
}

/**
 * The child shape reached by adding a data property `key` with `attrs`,
 * interned: repeated additions of the same (key, attrs) from the same parent
 * return the same child. The new property occupies slot `shape->inline_count`.
 */
MalShape *mal_shape_add_property(MalShape *shape, MalKey key, u8 attrs);

/**
 * Return the interned sealed/frozen variant of `shape`. Property order, keys,
 * and slots are unchanged; configurable is cleared on every property and
 * writable is additionally cleared when `clear_writable` is true.
 */
MalShape *mal_shape_set_integrity(MalShape *shape, bool clear_writable);

/** True for a default data-property attribute set (writable+enumerable+configurable). */
bool mal_shape_attrs_are_default(u8 attrs);

/**
 * Build (interning) the shape of an object whose `count` string keys are added,
 * in order, as default data properties. Materializes a static object literal's
 * final shape in one step so the literal need not transition property-by-property.
 */
MalShape *mal_shape_from_string_keys(MalHeap *heap, struct MalString **keys, u32 count);

/** Visit keys retained by one heap's transition tree during GC root scanning. */
void mal_shape_visit_transition_keys(MalHeap *heap, void (*visit)(MalValue));
