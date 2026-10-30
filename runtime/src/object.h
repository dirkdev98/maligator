#pragma once

#include <assert.h>
#include <stddef.h>
#include <string.h>

#include "./defaults.h"
#include "gc.h"
#include "heap.h"
#include "shape.h"
#include "table.h"
#include "value.h"

typedef struct MalObjectStorage {
    struct MalObject *prototype;
    void *fields;
    MalTable *overflow;
} MalObjectStorage;

typedef enum MalObjectStorageKind {
    MAL_OBJECT_COMPACT,
    MAL_OBJECT_EMBEDDED,
    MAL_OBJECT_EXTERNAL,
} MalObjectStorageKind;

/** Ordinary cells keep their prototype and fields after this prefix. Exotic
 * cells embed MalObjectStorage immediately after it; generalized ordinary cells
 * replace the prototype word with a pointer to separately owned storage. */
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
    /** Fields point to a separately malloc-owned buffer. */
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
    /** A for-in key Array, which JavaScript never sees, so iterating it observes no protocol. */
    bool for_in_keys : 1;
    u8 storage_kind : 2;
    /** Property count for packed fields; tagged entry capacity otherwise. */
    u8 slot_capacity;
    /** Original cell size class capacity beyond the prototype word, in eight-byte units. */
    u8 inline_payload_eights;
    MalShape *shape;
} MalObject;

typedef struct MalEmbeddedObject {
    MalObject object;
    MalObjectStorage storage;
} MalEmbeddedObject;

static inline const MalObjectStorage *mal_object_storage_const(const MalObject *object) {
    if (object->storage_kind == MAL_OBJECT_EMBEDDED) {
        return (const MalObjectStorage *) (object + 1);
    }
    MalObjectStorage *storage;
    memcpy(&storage, object + 1, sizeof(storage));
    return storage;
}

/**
 * Whether `object` can take another shaped property. Past the ordinary bound only
 * capacity reserved for a constructor's declared fields keeps it shaped, so map-like
 * growth still reaches dictionary mode.
 */
static inline bool mal_object_can_add_shaped_property(const MalObject *object) {
    u32 count = object->shape->inline_count;
    return count < MAL_SHAPE_ORDINARY_SLOTS || count < object->slot_capacity;
}

static inline MalObjectStorage *mal_object_storage(MalObject *object) {
    return (MalObjectStorage *) mal_object_storage_const(object);
}

static inline MalObject *mal_object_prototype(const MalObject *object) {
    if (object->storage_kind != MAL_OBJECT_EXTERNAL) {
        MalObject *prototype;
        memcpy(&prototype, object + 1, sizeof(prototype));
        return prototype;
    }
    return mal_object_storage_const(object)->prototype;
}

static inline void *mal_object_fields(const MalObject *object) {
    if (object->storage_kind == MAL_OBJECT_COMPACT) {
        return object->slot_capacity == 0 ? nullptr
            : (void *) ((u8 *) (object + 1) + sizeof(void *));
    }
    return mal_object_storage_const(object)->fields;
}

// Very large generated functions otherwise call these instead of inlining them.
static inline __attribute__((always_inline)) void *mal_object_fields_nonempty(
    const MalObject *object
) {
    if (__builtin_expect(object->storage_kind == MAL_OBJECT_COMPACT, 1)) {
        return (u8 *) (object + 1) + sizeof(void *);
    }
    return mal_object_storage_const(object)->fields;
}

// Every cache hit inlines this guard; a trap keeps it one instruction past the compare.
static inline __attribute__((always_inline)) void mal_object_field_check(
    const MalObject *object, u32 ordinal
) {
    if (__builtin_expect(ordinal >= object->shape->inline_count, 0)) __builtin_trap();
}

/** A field whose slot the caller's shape match already proves in range. */
static inline __attribute__((always_inline)) MalValue mal_object_field_load_shaped(
    const MalObject *object, u32 ordinal
) {
    return ((const MalValue *) mal_object_fields_nonempty(object))[ordinal];
}

static inline __attribute__((always_inline)) MalValue mal_object_field_load(
    const MalObject *object, u32 ordinal
) {
    mal_object_field_check(object, ordinal);
    return mal_object_field_load_shaped(object, ordinal);
}

static inline MalTable *mal_object_overflow(const MalObject *object) {
    return object->storage_kind == MAL_OBJECT_COMPACT
        ? nullptr : mal_object_storage_const(object)->overflow;
}

static inline bool mal_object_has_public_overflow(const MalObject *object) {
    return mal_object_overflow(object) != nullptr && !object->overflow_private_only;
}

/** Whether a dead object has finalizer work: outside storage to free or caches to invalidate. */
static inline bool mal_object_finalizes(const MalObject *object) {
    return object->has_captured_stack || object->is_prototype || object->slots_owned ||
        object->storage_kind == MAL_OBJECT_EXTERNAL || mal_object_overflow(object) != nullptr;
}

static_assert(sizeof(MalObject) == 8 + sizeof(void *),
              "ordinary object identity prefix grew");
static_assert(sizeof(MalObjectStorage) == 3 * sizeof(void *),
              "object sidecar grew");
static_assert(sizeof(MalEmbeddedObject) == sizeof(MalObject) + sizeof(MalObjectStorage),
              "exotic object base grew");
static_assert(offsetof(MalEmbeddedObject, storage) == sizeof(MalObject),
              "embedded storage must follow the object prefix");
static_assert((sizeof(MalObject) + sizeof(void *)) % alignof(MalValue) == 0,
              "compact payload must be aligned for tagged fields");

void mal_object_set_prototype_pointer(MalObject *object, MalObject *prototype);
void mal_object_set_fields_pointer(MalObject *object, void *fields);
void mal_object_set_overflow_pointer(MalObject *object, MalTable *overflow);
/** Store to a field whose slot the caller's shape match already proves in range. */
static inline void mal_object_field_store_shaped(
    MalObject *object, u32 ordinal, MalValue value
) {
    MalValue *field = (MalValue *) mal_object_fields_nonempty(object) + ordinal;
    if (!mal_gc_marking_active && !mal_value_is_heap(value)) {
        *field = value;
        return;
    }
    if (mal_gc_marking_active) mal_gc_satb_record(*field);
    *field = value;
    mal_gc_card(&object->header, value);
}

static inline void mal_object_field_store(MalObject *object, u32 ordinal, MalValue value) {
    mal_object_field_check(object, ordinal);
    mal_object_field_store_shaped(object, ordinal, value);
}

void mal_object_field_initialize(
    MalObject *object, const MalShape *shape, u32 ordinal, MalValue value);

/**
 * Initialize object state in caller-provided storage.
 */
void mal_object_init(MalHeap *heap, MalObject *object, MalHeapType type, MalObject *prototype);
void mal_object_init_embedded_stack(
    MalHeap *heap, MalEmbeddedObject *wrapper, MalObject *prototype,
    MalShape *shape, MalValue *slots);

/** Mark an object as participating in another object's prototype chain. */
static inline void mal_object_mark_as_prototype(MalObject *object) {
    if (object != nullptr && !object->is_prototype) {
        object->is_prototype = true;
    }
}

static inline bool mal_object_is_locked_primordial(const MalObject *object) {
    return object != nullptr && object->primordial_locked;
}


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
