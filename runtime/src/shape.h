#pragma once

#include <stdlib.h>
#include <string.h>

#include "./defaults.h"
#include "heap.h"
#include "property_store.h"
#include "table.h"
#include "value_ops.h"

/**
 * Dynamic keys stop extending shapes at the normal limit, bounding shape-tree
 * growth under churn. Immortal compiler/runtime keys may use the wider absolute
 * limit so stable framework records do not dictionarize at their 33rd field.
 */
#define MAL_SHAPE_DYNAMIC_INLINE_SLOTS 32
#define MAL_SHAPE_MAX_INLINE_SLOTS 64

typedef struct MalShape MalShape;
typedef struct MalShapeTransition MalShapeTransition;
typedef struct MalShapeTransitionIndex MalShapeTransitionIndex;

typedef enum MalFieldRepresentation : u8 {
    MAL_FIELD_TAGGED,
    MAL_FIELD_I32,
    MAL_FIELD_F64,
    MAL_FIELD_HEAP,
} MalFieldRepresentation;

#define MAL_FIELD_OFFSET_BITS 10
#define MAL_FIELD_OFFSET_MASK ((1u << MAL_FIELD_OFFSET_BITS) - 1u)
#define MAL_FIELD_INVALID UINT16_MAX

static inline u16 mal_shape_field(MalFieldRepresentation representation, u16 offset) {
    if (representation > MAL_FIELD_HEAP || offset > MAL_FIELD_OFFSET_MASK) abort();
    return (u16) (((u16) representation << MAL_FIELD_OFFSET_BITS) | offset);
}

static inline MalFieldRepresentation mal_shape_field_representation(u16 field) {
    return (MalFieldRepresentation) (field >> MAL_FIELD_OFFSET_BITS);
}

static inline u16 mal_shape_field_offset(u16 field) {
    return field & MAL_FIELD_OFFSET_MASK;
}

static inline usize mal_shape_field_size(MalFieldRepresentation representation) {
    switch (representation) {
        case MAL_FIELD_TAGGED: return sizeof(MalValue);
        case MAL_FIELD_I32: return sizeof(i32);
        case MAL_FIELD_F64: return sizeof(f64);
        case MAL_FIELD_HEAP: return sizeof(MalHeapHeader *);
    }
    abort();
}

static inline bool mal_shape_value_as_i32(MalValue value, i32 *out) {
    if (mal_value_is_int32(value)) {
        *out = mal_value_to_i32(value);
        return true;
    }
    f64 number;
    if (!mal_ops_try_number_as_f64(value, &number) ||
        !(number >= INT32_MIN && number <= INT32_MAX) ||
        (number == 0.0 && signbit(number))) {
        return false;
    }
    i32 integer = (i32) number;
    if ((f64) integer != number) return false;
    *out = integer;
    return true;
}

/** The layout's heap_fields map licenses this unchecked raw-reference load. */
static inline MalHeapHeader *mal_shape_field_load_heap(const void *payload, u16 field) {
    MalHeapHeader *value;
    memcpy(&value, (const byte *) payload + mal_shape_field_offset(field), sizeof(value));
    return value;
}

static inline i32 mal_shape_field_load_i32(const void *payload, u16 field) {
    i32 value;
    memcpy(&value, (const byte *) payload + mal_shape_field_offset(field), sizeof(value));
    return value;
}

/** Field offsets address the field payload, excluding the ordinary object's prototype word. */
static inline MalValue mal_shape_field_load(const void *payload, u16 field) {
    const byte *address = (const byte *) payload + mal_shape_field_offset(field);
    MalFieldRepresentation representation = mal_shape_field_representation(field);
    if (representation == MAL_FIELD_TAGGED) {
        MalValue value;
        memcpy(&value, address, sizeof(value));
        return value;
    }
    if (representation == MAL_FIELD_I32) {
        i32 value;
        memcpy(&value, address, sizeof(value));
        return mal_value_from_i32(value);
    }
    if (representation == MAL_FIELD_F64) {
        f64 value;
        memcpy(&value, address, sizeof(value));
        return mal_value_from_f64_convert_nan(value);
    }
    MalHeapHeader *value;
    memcpy(&value, address, sizeof(value));
    return MAL_VALUE_OBJECT | ((uptr) value & MAKS_PTR);
}

static inline bool mal_shape_field_try_load_number(
    const void *payload, u16 field, f64 *out
) {
    const byte *address = (const byte *) payload + mal_shape_field_offset(field);
    switch (mal_shape_field_representation(field)) {
        case MAL_FIELD_I32: {
            i32 value;
            memcpy(&value, address, sizeof(value));
            *out = (f64) value;
            return true;
        }
        case MAL_FIELD_F64:
            memcpy(out, address, sizeof(*out));
            return true;
        case MAL_FIELD_TAGGED:
            return mal_ops_try_number_as_f64(mal_shape_field_load(payload, field), out);
        case MAL_FIELD_HEAP:
            return false;
    }
    abort();
}

/** A representation mismatch leaves the payload untouched; callers own GC barriers. */
static inline bool mal_shape_field_try_store(void *payload, u16 field, MalValue value) {
    byte *address = (byte *) payload + mal_shape_field_offset(field);
    switch (mal_shape_field_representation(field)) {
        case MAL_FIELD_TAGGED:
            memcpy(address, &value, sizeof(value));
            return true;
        case MAL_FIELD_I32: {
            i32 integer;
            if (!mal_shape_value_as_i32(value, &integer)) return false;
            memcpy(address, &integer, sizeof(integer));
            return true;
        }
        case MAL_FIELD_F64: {
            f64 number;
            if (!mal_ops_try_number_as_f64(value, &number)) return false;
            memcpy(address, &number, sizeof(number));
            return true;
        }
        case MAL_FIELD_HEAP: {
            if ((value & MAL_VALUE_CLASS_MASK) != MAL_VALUE_OBJECT) return false;
            MalHeapHeader *pointer = mal_value_to_heap(value);
            memcpy(address, &pointer, sizeof(pointer));
            return true;
        }
    }
    abort();
}

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

typedef struct MalShapeProp {
    MalValue key;
    /** Logical ordinal survives representation changes and physical field packing. */
    u32 slot;
    u8 attrs;
    u16 field;
} MalShapeProp;

static_assert(sizeof(MalShapeProp) <= 16, "MalShapeProp outgrew 16 bytes (one per shaped property)");

struct MalShape {
    MalHeapHeader header;
    u16 inline_count;
    u16 payload_bytes;
    MalShapeProp *props;
    union {
        struct {
            MalShapeTransitionIndex *transition_index;
            MalShapeTransition *transitions;
        };
        /** Compact variants have no transitions; two bits encode each field. */
        u64 representations[2];
    };
    /** Null on the canonical tagged layout; compact variants share its logical identity. */
    MalShape *logical;
    /** Canonical shapes own this list; variants link the next list member. */
    MalShape *compact_next;
    /** Property-ordinal maps, independent of physical field order. */
    u64 heap_fields;
    u64 tagged_fields;
};

static inline bool mal_shape_is_compact(const MalShape *shape) {
    return shape->logical != nullptr;
}

static inline MalShape *mal_shape_logical(MalShape *shape) {
    return shape->logical == nullptr ? shape : shape->logical;
}

static inline bool mal_shape_same_logical(const MalShape *left, const MalShape *right) {
    const MalShape *left_logical = left->logical == nullptr ? left : left->logical;
    const MalShape *right_logical = right->logical == nullptr ? right : right->logical;
    return left_logical == right_logical;
}

static inline bool mal_shape_can_add_property(const MalShape *shape, MalKey key) {
    if (shape->inline_count < MAL_SHAPE_DYNAMIC_INLINE_SLOTS) return true;
    return shape->inline_count < MAL_SHAPE_MAX_INLINE_SLOTS
        && key.kind == MAL_KEY_STRING && mal_value_is_string(key.value)
        && mal_value_to_heap(key.value)->storage == MAL_HEAP_STORAGE_IMMORTAL;
}

static_assert(sizeof(MalShape) <= 64, "MalShape outgrew its 64-byte layout budget");

/** Intern an exact physical layout, with a tagged fallback after bounded representation diversity. */
MalShape *mal_shape_compact_from_values(MalShape *shape, const MalValue *values, u32 count);
MalShape *mal_shape_widen_field(MalShape *shape, u32 ordinal, MalValue value);

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
