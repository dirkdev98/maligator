#pragma once

#include "./defaults.h"
#include "heap.h"
#include "property_store.h"
#include "table.h"

/**
 * Dynamic keys stop extending shapes at the normal limit, bounding shape-tree
 * growth under churn. Immortal compiler/runtime keys may use the wider absolute
 * limit so stable framework records do not dictionarize at their 33rd field.
 */
#define MAL_SHAPE_DYNAMIC_INLINE_SLOTS 32
#define MAL_SHAPE_MAX_INLINE_SLOTS 64

/**
 * Hidden-class shape support. A MalShape is the
 * interned description of an object's named-property layout: an ordered
 * key -> slot map shared by every object with the same structure. An object in
 * "shaped" state stores its named property values inline in a slots array keyed
 * by the shape, instead of a per-object MalTable.
 *
 * Implementation note / deviation from the locked doc: the doc's struct embeds
 * `MalValue slots[]` inline in MalObject, but MalObject is the first member of
 * ~20 exotic subtypes, so it cannot end in a flexible array. We therefore keep a
 * `MalValue *slots` pointer on the object and use a 2-state model (shaped <->
 * dictionary). One-slot ordinary objects place that value in the slack of the
 * existing 48-byte managed-cell class; larger and grown objects use a separate
 * buffer. Object identity is the MalObject address, which never moves, so a
 * coallocated slot migrates rather than reallocating its cell. Index (array) keys never enter a shape;
 * anything a shape can't represent (delete, accessors, descriptor transitions,
 * a sealed/frozen object, an integer key) drops the object to dictionary mode
 * (a plain MalTable — exactly today's behavior), so the change is additive.
 *
 * Each heap owns a transition tree rooted at its empty shape; adding a named
 * property (key + attrs) transitions to a child, interned so objects in that
 * isolate that add the same keys in the same order share one shape.
 */

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

/** One named property in a shape: its key, slot index, and attribute flags. */
typedef struct MalShapeProp {
    /** Key value; the equality domain is derived on read (mal_key_kind_of).
     * Shapes only ever hold string/symbol keys. */
    MalValue key;
    /** Inline slot index in the object's slots buffer. */
    u32 slot;
    /** MalPropertyFlags for the data property (writable/enumerable/configurable). */
    u8 attrs;
} MalShapeProp;

static_assert(sizeof(MalShapeProp) <= 16, "MalShapeProp outgrew 16 bytes (one per shaped property)");

struct MalShape {
    MalHeapHeader header; /* MAL_HEAP_SHAPE */
    /** Number of named properties / inline slots. */
    u32 inline_count;
    /** `inline_count` ordered props (insertion order); null for the empty shape. */
    MalShapeProp *props;
    /** Optional side index for high-fanout transition sets. */
    MalShapeTransitionIndex *transition_index;
    /** Children, one per distinct added (key, attrs); singly linked. */
    MalShapeTransition *transitions;
};

static inline bool mal_shape_can_add_property(const MalShape *shape, MalKey key) {
    if (shape->inline_count < MAL_SHAPE_DYNAMIC_INLINE_SLOTS) return true;
    return shape->inline_count < MAL_SHAPE_MAX_INLINE_SLOTS
        && key.kind == MAL_KEY_STRING && mal_value_is_string(key.value)
        && mal_value_to_heap(key.value)->storage == MAL_HEAP_STORAGE_IMMORTAL;
}

static_assert(sizeof(MalShape) <= 32, "MalShape outgrew its 32-byte size class");

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
