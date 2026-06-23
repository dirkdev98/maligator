#pragma once

#include "./defaults.h"
#include "heap.h"
#include "shape.h"
#include "table.h"
#include "value.h"

/**
 * Ordinary object (and the base of every exotic subtype). Named properties live
 * in one of two states:
 *   - shaped: `shape` (non-empty) describes the layout; the values are in
 *     `slots[0 .. shape->inline_count)`; `overflow` is null.
 *   - dictionary: `shape` is the empty shape and all properties live in the
 *     `overflow` MalTable (exactly the pre-shapes behavior).
 * Index (integer) keys are never in a shape; they always live in `overflow`,
 * which is lazily allocated on first need.
 */
typedef struct MalObject {
    MalHeapHeader header;
    MalShape *shape;
    struct MalObject *prototype;
    bool extensible;
    /**
     * Set only on %Array.prototype% and %Object.prototype% (at intrinsics init).
     * Lets the low-level MOP invalidate the array fast-elements protector
     * (mal_array_elements_protector) when an integer-index property is defined on,
     * or the prototype changed of, one of those objects — without a vm handle. Free:
     * fits the padding after `extensible`.
     */
    bool fast_elements_proto;
    /** Inline named-property values for the shape; null in dictionary mode. */
    MalValue *slots;
    /** Dictionary/overflow table (named + index props); null until needed. */
    MalTable *overflow;
} MalObject;

/**
 * Initialize object state in caller-provided storage.
 */
void mal_object_init(MalHeap *heap, MalObject *object, MalHeapType type, MalObject *prototype);

/**
 * Allocate and initialize a new ordinary object.
 */
MalObject *mal_object_new(MalHeap *heap, MalObject *prototype);
