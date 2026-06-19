#pragma once

#include "./defaults.h"
#include "heap.h"
#include "property_store.h"
#include "table.h"

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
 * separate `MalValue *slots` buffer on the object (a single allocation, far
 * cheaper than the old table) and use a 2-state model (shaped <-> dictionary)
 * with realloc-on-grow rather than the 3-state inline+overflow ladder. Object
 * identity is the MalObject address, which never moves, so growing the slots
 * buffer on a shape transition is sound. Index (array) keys never enter a shape;
 * anything a shape can't represent (delete, non-default attrs, accessors, a
 * sealed/frozen object, an integer key) drops the object to dictionary mode (a
 * plain MalTable — exactly today's behavior), so the change is additive.
 *
 * Shapes form a transition tree rooted at the immortal empty shape; adding a
 * named property (key + attrs) transitions to a child, interned so every object
 * that adds the same keys in the same order shares one shape.
 */

typedef struct MalShape MalShape;
typedef struct MalShapeTransition MalShapeTransition;

/** One named property in a shape: its key, attribute flags, and slot index. */
typedef struct MalShapeProp {
    MalKey key;
    /** MalPropertyFlags for a default data property (writable/enumerable/configurable). */
    u8 attrs;
    /** Inline slot index in the object's slots buffer. */
    u32 slot;
} MalShapeProp;

struct MalShape {
    MalHeapHeader header; /* MAL_HEAP_SHAPE */
    /** Number of named properties / inline slots. */
    u32 inline_count;
    /** `inline_count` ordered props (insertion order); null for the empty shape. */
    MalShapeProp *props;
    /** Parent in the transition tree (null for the empty shape). */
    MalShape *parent;
    /** Children, one per distinct added (key, attrs); singly linked. */
    MalShapeTransition *transitions;
};

/** The immortal empty shape: the root of the transition tree (0 properties). */
MalShape *mal_shape_empty(void);

/**
 * Index of `key` in the shape's props, or -1 if absent. String keys compare by
 * content; other key kinds by value bits (matching the table's key equality).
 */
i32 mal_shape_find(const MalShape *shape, MalKey key);

/**
 * The child shape reached by adding a default data property `key` with `attrs`,
 * interned: repeated additions of the same (key, attrs) from the same parent
 * return the same child. The new property occupies slot `shape->inline_count`.
 */
MalShape *mal_shape_add_property(MalShape *shape, MalKey key, u8 attrs);

/** True for a default data-property attribute set (writable+enumerable+configurable). */
bool mal_shape_attrs_are_default(u8 attrs);
