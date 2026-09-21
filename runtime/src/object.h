#pragma once

#include "./defaults.h"
#include "heap.h"
#include "shape.h"
#include "table.h"
#include "value.h"

/**
 * Ordinary object (and the base of every exotic subtype). Named properties live
 * in one of two states:
 *   - shaped: `shape` describes the public string layout; the values are in
 *     `slots[0 .. shape->inline_count)`. `overflow` may contain only private
 *     names, which cannot affect public property resolution.
 *   - dictionary: `shape` is the empty shape and all properties live in the
 *     `overflow` MalTable (exactly the pre-shapes behavior).
 * Index (integer) keys are never in a shape; they always live in `overflow`,
 * which is lazily allocated on first need.
 */
typedef struct MalObject {
    MalHeapHeader header;
    /*
     * State flags packed into bitfields that sit in the padding before the first
     * 8-aligned pointer, so they do not enlarge the object base.
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
    /** Arguments exotic-object brand used by Object.prototype.toString. */
    bool is_arguments : 1;
    /**
     * Immutable-prototype exotic object (e.g. %Object.prototype%): [[SetPrototypeOf]]
     * rejects any change to a different prototype (SetImmutablePrototype).
     */
    bool immutable_prototype : 1;
    /** Structural mutations of this object can invalidate a dependent property
     * cache because it is a prototype or an exact dictionary receiver. */
    bool is_prototype : 1;
    /**
     * Set on built-in prototypes and watched namespace/constructor objects at
     * intrinsics init. Any define/set/delete/reparent breaks the monotonic method
     * protector, disabling cached values that assume those objects are unmodified.
     */
    bool watched_method_proto : 1;
    /** `slots` points to a separately malloc-owned buffer. False for empty,
     * coallocated, and compiler-emitted stack objects. */
    bool slots_owned : 1;
    /** A private Error.captureStackTrace id must be released at finalization. */
    bool has_captured_stack : 1;
    /** ECMAScript [[ErrorData]] internal slot; never exposed as a property. */
    bool has_error_data : 1;
    /** This object belongs to the protected ECMAScript primordial graph. */
    bool primordial_locked : 1;
    /** DFS marker used only while a Realm's primordial graph is finalized. */
    bool primordial_locking : 1;
    /** A non-null overflow table contains private names only. */
    bool overflow_private_only : 1;
    /** Allocated entries in `slots`; visible entries remain shape->inline_count. */
    u8 slot_capacity;
    MalShape *shape;
    struct MalObject *prototype;
    /** Inline named-property values for the shape; null in dictionary mode. */
    MalValue *slots;
    /** Dictionary/overflow table (named + index props); null until needed. */
    MalTable *overflow;
} MalObject;

static inline bool mal_object_has_public_overflow(const MalObject *object) {
    return object->overflow != nullptr && !object->overflow_private_only;
}

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

/** Mark an object as participating in another object's prototype chain. */
static inline void mal_object_mark_as_prototype(MalObject *object) {
    if (object != nullptr && !object->is_prototype) {
        object->is_prototype = true;
    }
}

static inline bool mal_object_is_locked_primordial(const MalObject *object) {
    return object != nullptr && object->primordial_locked;
}

/**
 * Current process-wide prototype-chain validity epoch. Zero permanently disables
 * exact-chain caching after the theoretical u64 version space is exhausted.
 */
extern u64 mal_prototype_chain_epoch;

/** Cold half of prototype-chain invalidation; callers use the inline flag guard. */
void mal_object_bump_prototype_chain_epoch(void);

/** Register/remove VM-owned cache rows from chain-local mutation dependencies. */
bool mal_object_register_prototype_cache(
	MalObject *receiver, MalObject *holder, void *cache,
	bool include_receiver);

bool mal_object_register_constructor_layout_cache(
	MalObject *constructor, MalObject *prototype, void *cache);
void mal_object_unregister_prototype_cache(void *cache);
void mal_object_invalidate_prototype_dependents(MalObject *object);
/** Release pooled dependency storage when the current thread has no live rows. */
void mal_object_release_idle_prototype_dependencies(void);

/**
 * Invalidate inherited/negative cache guards when a structurally-relevant
 * mutation occurs on an object that has served as a prototype. The overwhelmingly
 * common instance-object case folds to one flag test and no call.
 */
static inline bool mal_object_note_prototype_mutation(MalObject *object) {
    if (object == nullptr || !object->is_prototype) {
        return false;
    }
    mal_object_invalidate_prototype_dependents(object);
    mal_object_bump_prototype_chain_epoch();
    return true;
}

/**
 * Allocate and initialize a new ordinary object.
 */
MalObject *mal_object_new(MalHeap *heap, MalObject *prototype);

/** Fallible ordinary-object constructor used by VM operations with completion checks. */
MalObject *mal_object_try_new(MalHeap *heap, MalObject *prototype);

/** Allocate an empty object with hidden capacity for later shape transitions. */
MalObject *mal_object_new_reserved(MalHeap *heap, MalObject *prototype, u8 capacity);

/** Allocate an ordinary object and its known inline slots in one managed cell. */
MalObject *mal_object_new_shaped(MalHeap *heap, MalObject *prototype, MalShape *shape,
                                 const MalValue *values, u32 count);
MalObject *mal_object_try_new_shaped(MalHeap *heap, MalObject *prototype, MalShape *shape,
                                     const MalValue *values, u32 count);

/** Install a known final shape and bulk-copy its values into one exact slot buffer. */
void mal_object_set_shaped_values(
    MalObject *object, MalShape *shape, const MalValue *values, u32 count
);

/** Grow shaped slot storage without reallocating coallocated managed cells. */
void mal_object_grow_slots(MalObject *object, u32 old_count, u32 new_count);

/** Release separately-owned slots and clear the object's slot state. */
void mal_object_release_slots(MalObject *object);

/** Record a coallocated slot buffer being abandoned during dictionarization. */
void mal_object_record_slot_dictionary_migration(MalObject *object);

u64 mal_object_slot_coallocation_count(void);
u64 mal_object_slot_grow_migration_count(void);
u64 mal_object_slot_dictionary_migration_count(void);
