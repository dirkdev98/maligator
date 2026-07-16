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
    /*
     * State flags packed into one byte (:1 bitfields) that sits in the word the
     * 3-byte header shares with them, so they cost nothing before the first
     * 8-aligned pointer. Written rarely (mostly at init / intrinsics setup),
     * read on the MOP path as a single masked load.
     */
    /** [[Extensible]]. */
    bool extensible : 1;
    /**
     * Set only on %Array.prototype% and %Object.prototype% (at intrinsics init).
     * Lets the low-level MOP invalidate the array fast-elements protector
     * (mal_array_elements_protector) when an integer-index property is defined on,
     * or the prototype changed of, one of those objects — without a vm handle.
     */
    bool fast_elements_proto : 1;
    /**
     * [[IsRawJSON]] marker for JSON.rawJSON results. An internal slot (not a
     * property), so it stays invisible to getOwnPropertyNames/Symbols.
     */
    bool is_raw_json : 1;
    /**
     * Immutable-prototype exotic object (e.g. %Object.prototype%): [[SetPrototypeOf]]
     * rejects any change to a different prototype (SetImmutablePrototype).
     */
    bool immutable_prototype : 1;
    /**
     * Set on built-in prototypes and watched namespace/constructor objects at
     * intrinsics init. Any define/set/delete/reparent breaks the monotonic method
     * protector, disabling cached values that assume those objects are unmodified.
     */
    bool watched_method_proto : 1;
    /** `slots` points to a separately malloc-owned buffer. False for empty,
     * one-slot coallocated, and compiler-emitted stack objects. */
    bool slots_owned : 1;
    MalShape *shape;
    struct MalObject *prototype;
    /** Inline named-property values for the shape; null in dictionary mode. */
    MalValue *slots;
    /** Dictionary/overflow table (named + index props); null until needed. */
    MalTable *overflow;
} MalObject;

// Size-class guard: MalObject is the base of ~30 heap types, so it must stay in
// the 48-byte class (4 pointers + a 3-byte header + a flag byte = 40). A new
// field that pushed it past 48 would bump every object type up a class.
static_assert(sizeof(MalObject) <= 48, "MalObject outgrew its 48-byte size class");
static_assert(sizeof(MalObject) + sizeof(MalValue) <= 48,
              "MalObject plus one coallocated slot outgrew its 48-byte size class");
static_assert(sizeof(MalObject) % alignof(MalValue) == 0,
              "MalObject trailing slot is misaligned");

/**
 * Initialize object state in caller-provided storage.
 */
void mal_object_init(MalHeap *heap, MalObject *object, MalHeapType type, MalObject *prototype);

/**
 * Allocate and initialize a new ordinary object.
 */
MalObject *mal_object_new(MalHeap *heap, MalObject *prototype);

/** Allocate an ordinary object directly in a known shape. A one-slot shape uses
 * the slack in the object's existing 48-byte managed-cell class. */
MalObject *mal_object_new_shaped_one(MalHeap *heap, MalObject *prototype, MalShape *shape,
                                     MalValue value);

/** Grow shaped slot storage without reallocating coallocated managed cells. */
void mal_object_grow_slots(MalObject *object, u32 old_count, u32 new_count);

/** Release separately-owned slots and clear the object's slot state. */
void mal_object_release_slots(MalObject *object);

/** Record a coallocated slot buffer being abandoned during dictionarization. */
void mal_object_record_slot_dictionary_migration(MalObject *object);

u64 mal_object_slot_coallocation_count(void);
u64 mal_object_slot_grow_migration_count(void);
u64 mal_object_slot_dictionary_migration_count(void);
