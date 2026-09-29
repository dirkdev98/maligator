#include "./shape.h"

#include <stdlib.h>
#include <string.h>

#include "./heap_string.h"
#include "./value.h"
#include "./perf_stats.h"

static_assert(MAL_SHAPE_FIND_CALLER_COUNT == MAL_PERF_SHAPE_CALLER_COUNT, "shape caller stats mismatch");

#define MAL_SHAPE_TRANSITION_INDEX_THRESHOLD 8
#define MAL_SHAPE_FIND_CACHE_SET_COUNT 512
#define MAL_SHAPE_FIND_CACHE_WAYS 2
#define MAL_SHAPE_FIND_CACHE_THRESHOLD 4
#define MAL_SHAPE_COMPACT_VARIANT_LIMIT 8

typedef struct MalShapeFindCacheSet {
    const MalShape *shape[MAL_SHAPE_FIND_CACHE_WAYS];
    MalValue key[MAL_SHAPE_FIND_CACHE_WAYS];
    u64 hash[MAL_SHAPE_FIND_CACHE_WAYS];
    i32 result[MAL_SHAPE_FIND_CACHE_WAYS];
    u8 next_victim;
} MalShapeFindCacheSet;

static_assert(sizeof(MalShapeFindCacheSet) == (sizeof(void *) == 8 ? 64 : 56),
              "two-way shape cache set must retain its pointer-width-specific layout");

static _Thread_local MalShapeFindCacheSet
    mal_shape_find_cache[MAL_SHAPE_FIND_CACHE_SET_COUNT];

typedef enum MalShapeTransitionKind {
    MAL_SHAPE_TRANSITION_ADD,
    MAL_SHAPE_TRANSITION_SEAL,
    MAL_SHAPE_TRANSITION_FREEZE,
} MalShapeTransitionKind;

/** An interned layout edge: property append or uniform integrity transition. */
struct MalShapeTransition {
    MalValue key;
    MalShape *child;
    MalShapeTransition *next;
    u8 attrs;
    u8 kind;
};

typedef struct MalShapeTransitionIndexSlot {
    u64 hash;
    MalShapeTransition *transition;
} MalShapeTransitionIndexSlot;

struct MalShapeTransitionIndex {
    u32 capacity;
    u32 size;
    bool complete;
    MalShapeTransitionIndexSlot slots[];
};

static bool mal_shape_transition_hash(MalKey key, u8 attrs, u64 *out) {
    u64 hash;
    if (mal_value_is_string(key.value)) {
        MalString *string = mal_value_to_string(key.value);
        hash = mal_string_hash(string);
    } else {
        hash = key.value;
    }
    hash ^= (u64) attrs + 0x9e3779b97f4a7c15ULL + (hash << 6) + (hash >> 2);
    *out = hash;
    return true;
}

static bool mal_shape_find_hash(MalKey key, u64 *out) {
    if (mal_value_is_string(key.value)) {
        MalString *string = mal_value_to_string(key.value);
        *out = mal_string_hash(string);
        return true;
    }
    *out = key.value;
    return true;
}

static MalShapeFindCacheSet *mal_shape_find_cache_set(
    const MalShape *shape, u64 hash) {
    uintptr_t pointer = (uintptr_t) shape >> 4;
    usize slot = (usize) (pointer ^ hash ^ (hash >> 32))
        & (MAL_SHAPE_FIND_CACHE_SET_COUNT - 1);
    return &mal_shape_find_cache[slot];
}

static void mal_shape_find_cache_fill(
    MalShapeFindCacheSet *set, const MalShape *shape, MalValue key,
    u64 hash, i32 result
) {
    u8 way = set->shape[0] == nullptr ? 0
        : set->shape[1] == nullptr ? 1
        : set->next_victim;
    set->shape[way] = shape;
    set->key[way] = key;
    set->hash[way] = hash;
    set->result[way] = result;
    set->next_victim = way ^ 1;
}

static void mal_shape_find_record_cached(
    const MalShape *shape, MalKey key, MalShapeFindCaller caller, i32 result) {
    if (!mal_perf_stats_enabled) return;
    MalPerfShapeStats *stats = &mal_perf_stats.shapes[caller];
    stats->calls++;
    stats->widths += shape->inline_count;
    stats->comparisons++;
    if (result >= 0) {
        stats->hits++;
        if (shape->props[result].key == key.value) stats->pointer_hits++;
        else stats->content_hits++;
    } else {
        stats->misses++;
    }
    if (shape->inline_count > stats->max_width) {
        stats->max_width = shape->inline_count;
    }
    if (stats->max_comparisons == 0) stats->max_comparisons = 1;
}

static MalShapeTransitionIndex *mal_shape_transition_index_new(u32 capacity) {
    MalShapeTransitionIndex *index = calloc(
        1, sizeof(MalShapeTransitionIndex) + sizeof(MalShapeTransitionIndexSlot) * capacity);
    index->capacity = capacity;
    index->complete = true;
    return index;
}

static void mal_shape_transition_index_insert(
    MalShapeTransitionIndex *index, u64 hash, MalShapeTransition *transition
) {
    usize mask = index->capacity - 1;
    usize slot = hash & mask;
    while (index->slots[slot].transition != nullptr) {
        slot = (slot + 1) & mask;
    }
    index->slots[slot] = (MalShapeTransitionIndexSlot) {
        .hash = hash,
        .transition = transition,
    };
    index->size++;
}

static MalShapeTransitionIndex *mal_shape_transition_index_grow(
    MalShapeTransitionIndex *old
) {
    MalShapeTransitionIndex *index = mal_shape_transition_index_new(old->capacity * 2);
    index->complete = old->complete;
    for (u32 i = 0; i < old->capacity; i++) {
        MalShapeTransitionIndexSlot slot = old->slots[i];
        if (slot.transition != nullptr) {
            mal_shape_transition_index_insert(index, slot.hash, slot.transition);
        }
    }
    free(old);
    return index;
}

static MalShapeTransitionIndex *mal_shape_transition_index_add(
    MalShapeTransitionIndex *index, MalShapeTransition *transition
) {
    MalKey key = mal_key_from_value(transition->key);
    u64 hash;
    if (!mal_shape_transition_hash(key, transition->attrs, &hash)) {
        index->complete = false;
        return index;
    }
    if ((index->size + 1) * 2 > index->capacity) {
        index = mal_shape_transition_index_grow(index);
    }
    mal_shape_transition_index_insert(index, hash, transition);
    return index;
}

static MalShapeTransitionIndex *mal_shape_transition_index_build(
    MalShapeTransition *transitions
) {
    MalShapeTransitionIndex *index =
        mal_shape_transition_index_new(MAL_SHAPE_TRANSITION_INDEX_THRESHOLD * 2);
    for (MalShapeTransition *transition = transitions;
         transition != nullptr; transition = transition->next) {
        if (transition->kind != MAL_SHAPE_TRANSITION_ADD) continue;
        index = mal_shape_transition_index_add(index, transition);
    }
    MAL_PERF_COUNT(shape_transition_index_builds);
    return index;
}

static MalShapeTransition *mal_shape_transition_index_find(
    MalShapeTransitionIndex *index, MalKey key, u8 attrs, u64 hash
) {
    usize mask = index->capacity - 1;
    usize slot = hash & mask;
    while (index->slots[slot].transition != nullptr) {
        MAL_PERF_COUNT(shape_transition_index_probes);
        MalShapeTransitionIndexSlot candidate = index->slots[slot];
        if (candidate.hash == hash && candidate.transition->attrs == attrs &&
            mal_key_value_equals(candidate.transition->key, key.value)) {
            return candidate.transition;
        }
        slot = (slot + 1) & mask;
    }
    return nullptr;
}

/** Transitionless sentinel for objects that have moved to dictionary storage. */
static MalShape g_dictionary_empty_shape = {
    .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_SHAPE),
    .inline_count = 0,
    .props = nullptr,
    .transition_index = nullptr,
    .transitions = nullptr,
};

static void mal_shape_init_empty(MalShape *shape) {
    *shape = (MalShape) {
        .header = {.type = MAL_HEAP_SHAPE, .storage = MAL_HEAP_STORAGE_DYNAMIC},
        .inline_count = 0,
        .props = nullptr,
        .transition_index = nullptr,
        .transitions = nullptr,
    };
}

static u64 mal_shape_all_fields(u32 count) {
    return count == 64 ? UINT64_MAX : (UINT64_C(1) << count) - 1;
}

static MalFieldRepresentation mal_shape_value_representation(MalValue value) {
    if (mal_value_is_int32(value)) return MAL_FIELD_I32;
    if (mal_ops_is_number(value)) {
        i32 integer;
        return mal_shape_value_as_i32(value, &integer) ? MAL_FIELD_I32 : MAL_FIELD_F64;
    }
    if ((value & MAL_VALUE_CLASS_MASK) == MAL_VALUE_OBJECT) return MAL_FIELD_HEAP;
    return MAL_FIELD_TAGGED;
}

static bool mal_shape_values_fit_variant(
    const MalShape *variant, const MalValue *values, u32 count
) {
    for (u32 slot = 0; slot < count; slot++) {
        MalValue value = values[slot];
        switch (mal_shape_field_representation(variant->props[slot].field)) {
            case MAL_FIELD_I32: {
                i32 integer;
                if (!mal_shape_value_as_i32(value, &integer)) return false;
                break;
            }
            case MAL_FIELD_F64:
                if (!mal_ops_is_number(value)) return false;
                break;
            case MAL_FIELD_HEAP:
                if ((value & MAL_VALUE_CLASS_MASK) != MAL_VALUE_OBJECT) return false;
                break;
            case MAL_FIELD_TAGGED:
                break;
        }
    }
    return true;
}

static MalFieldRepresentation mal_shape_representation_at(
    const u64 representations[2], u32 slot
) {
    return (MalFieldRepresentation)
        ((representations[slot / 32] >> ((slot % 32) * 2)) & 3u);
}

static MalFieldRepresentation mal_shape_join_representation(
    MalFieldRepresentation left, MalFieldRepresentation right
) {
    if (left == right) return left;
    if ((left == MAL_FIELD_I32 || left == MAL_FIELD_F64) &&
        (right == MAL_FIELD_I32 || right == MAL_FIELD_F64)) {
        return MAL_FIELD_F64;
    }
    return MAL_FIELD_TAGGED;
}

static void mal_shape_join_preferred(
    MalShape *logical, u64 representations[2]
) {
    const MalShape *preferred = logical->compact_next;
    if (preferred == nullptr ||
        (representations[0] == preferred->representations[0] &&
         representations[1] == preferred->representations[1])) {
        return;
    }
    for (u32 slot = 0; slot < logical->inline_count; slot++) {
        MalFieldRepresentation joined = mal_shape_join_representation(
            mal_shape_representation_at(representations, slot),
            mal_shape_representation_at(preferred->representations, slot));
        u32 index = slot / 32;
        u32 shift = (slot % 32) * 2;
        representations[index] = (representations[index] & ~(UINT64_C(3) << shift))
            | ((u64) joined << shift);
    }
}

static void mal_shape_compact_promote(MalShape *logical, MalShape *variant) {
    if (logical->compact_next == variant) return;
    for (MalShape *cursor = logical->compact_next;
         cursor != nullptr; cursor = cursor->compact_next) {
        if (cursor->compact_next != variant) continue;
        cursor->compact_next = variant->compact_next;
        variant->compact_next = logical->compact_next;
        logical->compact_next = variant;
        return;
    }
    abort();
}

static MalShape *mal_shape_compact_find(
    MalShape *logical, const u64 representations[2], u32 *variant_count
) {
    *variant_count = 0;
    for (MalShape *variant = logical->compact_next;
         variant != nullptr; variant = variant->compact_next) {
        (*variant_count)++;
        if (variant->representations[0] == representations[0] &&
            variant->representations[1] == representations[1]) {
            return variant;
        }
    }
    return nullptr;
}

static MalShape *mal_shape_compact_new(
    MalShape *logical, const u64 representations[2], bool prefer
) {
    MalShape *compact = malloc(sizeof(*compact));
    if (compact == nullptr) abort();
    *compact = (MalShape) {
        .header = {.type = MAL_HEAP_SHAPE, .storage = MAL_HEAP_STORAGE_DYNAMIC},
        .inline_count = logical->inline_count,
        .representations = {representations[0], representations[1]},
        .logical = logical,
        .compact_next = prefer ? logical->compact_next : nullptr,
    };
    if (logical->inline_count != 0) {
        compact->props = malloc(sizeof(*compact->props) * logical->inline_count);
        if (compact->props == nullptr) abort();
        memcpy(compact->props, logical->props,
               sizeof(*compact->props) * logical->inline_count);
    }

    u16 offset = 0;
    // Packing wider fields first removes alignment holes without changing property order.
    for (usize width = sizeof(MalValue); width >= sizeof(i32); width /= 2) {
        for (u32 slot = 0; slot < compact->inline_count; slot++) {
            MalFieldRepresentation representation =
                mal_shape_representation_at(representations, slot);
            if (mal_shape_field_size(representation) != width) continue;
            compact->props[slot].field = mal_shape_field(representation, offset);
            offset += (u16) width;
            if (representation == MAL_FIELD_HEAP) {
                compact->heap_fields |= UINT64_C(1) << slot;
            } else if (representation == MAL_FIELD_TAGGED) {
                compact->tagged_fields |= UINT64_C(1) << slot;
            }
        }
    }
    compact->payload_bytes = offset;
    if (prefer || logical->compact_next == nullptr) {
        logical->compact_next = compact;
    } else {
        MalShape *tail = logical->compact_next;
        while (tail->compact_next != nullptr) tail = tail->compact_next;
        tail->compact_next = compact;
    }
    return compact;
}

MalShape *mal_shape_compact_from_values(MalShape *shape, const MalValue *values, u32 count) {
    if (shape == nullptr || count != shape->inline_count ||
        count > MAL_SHAPE_MAX_INLINE_SLOTS || (count != 0 && values == nullptr)) {
        abort();
    }
    MalShape *logical = mal_shape_logical(shape);
    MalShape *preferred = logical->compact_next;
    if (preferred != nullptr && mal_shape_values_fit_variant(preferred, values, count)) {
        return preferred;
    }
    // Packing either remaining field cannot shrink a two-field cell with one tagged value.
    if (count == 2 &&
        (mal_shape_value_representation(values[1]) == MAL_FIELD_TAGGED ||
         mal_shape_value_representation(values[0]) == MAL_FIELD_TAGGED)) {
        return logical;
    }
    u64 representations[2] = {0, 0};
    for (u32 slot = 0; slot < count; slot++) {
        representations[slot / 32] |=
            (u64) mal_shape_value_representation(values[slot]) << ((slot % 32) * 2);
    }
    if (representations[0] == 0 && representations[1] == 0) return logical;
    mal_shape_join_preferred(logical, representations);
    if (representations[0] == 0 && representations[1] == 0) return logical;
    if (mal_shape_is_compact(shape) &&
        shape->representations[0] == representations[0] &&
        shape->representations[1] == representations[1]) {
        mal_shape_compact_promote(logical, shape);
        return shape;
    }
    u32 variant_count;
    MalShape *compact = mal_shape_compact_find(logical, representations, &variant_count);
    if (compact != nullptr) {
        mal_shape_compact_promote(logical, compact);
        return compact;
    }
    if (variant_count >= MAL_SHAPE_COMPACT_VARIANT_LIMIT) return logical;
    return mal_shape_compact_new(logical, representations, true);
}

MalShape *mal_shape_widen_field(MalShape *shape, u32 ordinal, MalValue value) {
    if (!mal_shape_is_compact(shape) || ordinal >= shape->inline_count) abort();
    MalFieldRepresentation old =
        mal_shape_field_representation(shape->props[ordinal].field);
    MalFieldRepresentation next = old == MAL_FIELD_I32 && mal_ops_is_number(value)
        ? MAL_FIELD_F64 : MAL_FIELD_TAGGED;
    u64 representations[2] = {shape->representations[0], shape->representations[1]};
    u32 index = ordinal / 32;
    u32 shift = (ordinal % 32) * 2;
    representations[index] = (representations[index] & ~(UINT64_C(3) << shift))
        | ((u64) next << shift);
    MalShape *logical = shape->logical;
    if (shape->inline_count == 2 &&
        (mal_shape_representation_at(representations, 0) == MAL_FIELD_TAGGED ||
         mal_shape_representation_at(representations, 1) == MAL_FIELD_TAGGED)) {
        return logical;
    }
    if (representations[0] == 0 && representations[1] == 0) return logical;
    mal_shape_join_preferred(logical, representations);
    if (representations[0] == 0 && representations[1] == 0) return logical;
    u32 variant_count;
    MalShape *variant = mal_shape_compact_find(logical, representations, &variant_count);
    if (variant != nullptr) {
        mal_shape_compact_promote(logical, variant);
        return variant;
    }
    if (variant_count >= MAL_SHAPE_COMPACT_VARIANT_LIMIT) return logical;
    return mal_shape_compact_new(logical, representations, true);
}

void mal_shape_heap_init(MalHeap *heap) {
    heap->shape_root = malloc(sizeof(MalShape));
    mal_shape_init_empty(heap->shape_root);
    memset(mal_shape_find_cache, 0, sizeof(mal_shape_find_cache));
}

static void mal_shape_free_children(MalShape *shape) {
    MalShape *compact = shape->compact_next;
    while (compact != nullptr) {
        MalShape *next = compact->compact_next;
        free(compact->props);
        free(compact);
        compact = next;
    }
    shape->compact_next = nullptr;
    MalShapeTransition *transition = shape->transitions;
    while (transition != nullptr) {
        MalShapeTransition *next = transition->next;
        mal_shape_free_children(transition->child);
        free(transition->child->transition_index);
        free(transition->child->props);
        free(transition->child);
        free(transition);
        transition = next;
    }
}

void mal_shape_heap_free(MalHeap *heap) {
    if (heap->shape_root == nullptr) return;
    mal_shape_free_children(heap->shape_root);
    free(heap->shape_root->transition_index);
    free(heap->shape_root);
    heap->shape_root = nullptr;
    // The TLS cache may otherwise retain freed pointers into a later heap lifetime.
    memset(mal_shape_find_cache, 0, sizeof(mal_shape_find_cache));
}

MalShape *mal_shape_dictionary_empty(void) {
    return &g_dictionary_empty_shape;
}

bool mal_shape_attrs_are_default(u8 attrs) {
    return attrs
        == (u8) (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
}

i32 mal_shape_find_wide(const MalShape *shape, MalKey key, MalShapeFindCaller caller) {
    if (shape->logical != nullptr) shape = shape->logical;
    // Empty and single-property shapes are handled by the header fast path.
    if (shape->inline_count <= 1) abort();
    u64 hash = 0;
    MalShapeFindCacheSet *cache_set = nullptr;
    if (shape->inline_count >= MAL_SHAPE_FIND_CACHE_THRESHOLD
        && mal_shape_find_hash(key, &hash)) {
        cache_set = mal_shape_find_cache_set(shape, hash);
        for (u8 way = 0; way < MAL_SHAPE_FIND_CACHE_WAYS; way++) {
            if (cache_set->shape[way] == shape && cache_set->hash[way] == hash
                && mal_key_value_equals(cache_set->key[way], key.value)) {
                cache_set->next_victim = way ^ 1;
                mal_shape_find_record_cached(
                    shape, key, caller, cache_set->result[way]);
                return cache_set->result[way];
            }
        }
    }
    for (u32 i = 0; i < shape->inline_count; ++i) {
        if (mal_key_value_equals(shape->props[i].key, key.value)) {
            if (mal_perf_stats_enabled) {
                MalPerfShapeStats *stats = &mal_perf_stats.shapes[caller];
                u64 comparisons = (u64) i + 1;
                stats->calls++;
                stats->hits++;
                stats->widths += shape->inline_count;
                stats->comparisons += comparisons;
                if (shape->inline_count > stats->max_width) stats->max_width = shape->inline_count;
                if (comparisons > stats->max_comparisons) stats->max_comparisons = comparisons;
                if (shape->props[i].key == key.value) stats->pointer_hits++;
                else stats->content_hits++;
            }
            if (cache_set != nullptr) {
                mal_shape_find_cache_fill(
                    cache_set, shape, shape->props[i].key, hash, (i32) i);
            }
            return (i32) i;
        }
    }
    if (mal_perf_stats_enabled) {
        MalPerfShapeStats *stats = &mal_perf_stats.shapes[caller];
        stats->calls++;
        stats->misses++;
        stats->widths += shape->inline_count;
        stats->comparisons += shape->inline_count;
        if (shape->inline_count > stats->max_width) stats->max_width = shape->inline_count;
        if (shape->inline_count > stats->max_comparisons) stats->max_comparisons = shape->inline_count;
    }
    if (cache_set != nullptr && mal_value_is_string(key.value)) {
        MalString *string = mal_value_to_string(key.value);
        // The untraced cache may retain dynamic atoms because their VM roots outlive it.
        if (string->header.storage == MAL_HEAP_STORAGE_IMMORTAL ||
            string->property_atom) {
            mal_shape_find_cache_fill(cache_set, shape, key.value, hash, -1);
        }
    }
    return -1;
}

MalShape *mal_shape_from_string_keys(MalHeap *heap, struct MalString **keys, u32 count) {
    MalShape *shape = mal_shape_root(heap);
    for (u32 i = 0; i < count; ++i) {
        MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(keys[i])};
        shape = mal_shape_add_property(
            shape, key,
            (u8) (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE));
    }
    return shape;
}

MalShape *mal_shape_add_property(MalShape *shape, MalKey key, u8 attrs) {
    shape = mal_shape_logical(shape);
    if (shape->inline_count >= MAL_SHAPE_MAX_INLINE_SLOTS) abort();
    u64 comparisons = 0;
    MalShapeTransition *match = nullptr;
    bool search_list = true;
    if (shape->transition_index != nullptr) {
        u64 hash;
        if (mal_shape_transition_hash(key, attrs, &hash)) {
            MAL_PERF_COUNT(shape_transition_index_lookups);
            match = mal_shape_transition_index_find(shape->transition_index, key, attrs, hash);
            if (match != nullptr) {
                MAL_PERF_COUNT(shape_transition_index_hits);
                search_list = false;
            } else if (shape->transition_index->complete) {
                search_list = false;
            }
        }
    }
    if (search_list) {
        for (MalShapeTransition *transition = shape->transitions;
             transition != nullptr; transition = transition->next) {
            if (transition->kind != MAL_SHAPE_TRANSITION_ADD) continue;
            comparisons++;
            if (transition->attrs == attrs &&
                mal_key_value_equals(transition->key, key.value)) {
                match = transition;
                break;
            }
        }
    }
    if (match != nullptr) {
        if (mal_perf_stats_enabled) {
            mal_perf_stats.shape_transition_calls++;
            mal_perf_stats.shape_transition_hits++;
            mal_perf_stats.shape_transition_comparisons += comparisons;
            if (comparisons > mal_perf_stats.shape_transition_max_comparisons) {
                mal_perf_stats.shape_transition_max_comparisons = comparisons;
            }
            if (match->key == key.value) mal_perf_stats.shape_transition_pointer_hits++;
            else mal_perf_stats.shape_transition_content_hits++;
        }
        return match->child;
    }
    if (mal_perf_stats_enabled) {
        mal_perf_stats.shape_transition_calls++;
        mal_perf_stats.shape_transition_creates++;
        mal_perf_stats.shape_transition_comparisons += comparisons;
        if (comparisons > mal_perf_stats.shape_transition_max_comparisons) {
            mal_perf_stats.shape_transition_max_comparisons = comparisons;
        }
    }

    MalShape *child = malloc(sizeof(MalShape));
    *child = (MalShape) {
        .header = {.type = MAL_HEAP_SHAPE, .storage = MAL_HEAP_STORAGE_DYNAMIC},
        .inline_count = shape->inline_count + 1,
        .payload_bytes = (shape->inline_count + 1) * sizeof(MalValue),
        .tagged_fields = mal_shape_all_fields(shape->inline_count + 1),
    };
    child->props = malloc(sizeof(MalShapeProp) * child->inline_count);
    if (shape->inline_count > 0) {
        memcpy(child->props, shape->props, sizeof(MalShapeProp) * shape->inline_count);
    }
    child->props[shape->inline_count] = (MalShapeProp){
        .key = key.value,
        .attrs = attrs,
        .slot = shape->inline_count,
        .field = mal_shape_field(MAL_FIELD_TAGGED,
                                 (u16) (shape->inline_count * sizeof(MalValue))),
    };

    MalShapeTransition *transition = malloc(sizeof(MalShapeTransition));
    transition->key = key.value;
    transition->attrs = attrs;
    transition->kind = MAL_SHAPE_TRANSITION_ADD;
    transition->child = child;
    transition->next = shape->transitions;
    shape->transitions = transition;
    if (shape->transition_index != nullptr) {
        shape->transition_index =
            mal_shape_transition_index_add(shape->transition_index, transition);
    } else if (comparisons + 1 >= MAL_SHAPE_TRANSITION_INDEX_THRESHOLD) {
        shape->transition_index = mal_shape_transition_index_build(shape->transitions);
    }

    return child;
}

MalShape *mal_shape_set_integrity(MalShape *shape, bool clear_writable) {
    if (mal_shape_is_compact(shape)) {
        MalShape *logical = mal_shape_set_integrity(shape->logical, clear_writable);
        if (logical == shape->logical) return shape;
        u32 variant_count;
        MalShape *compact =
            mal_shape_compact_find(logical, shape->representations, &variant_count);
        // Integrity changes keep offsets unchanged, including after variant admission closes.
        return compact != nullptr ? compact
            : mal_shape_compact_new(logical, shape->representations, false);
    }
    u8 clear = (u8) MAL_PROPERTY_CONFIGURABLE;
    if (clear_writable) clear |= (u8) MAL_PROPERTY_WRITABLE;

    bool changed = false;
    for (u32 i = 0; i < shape->inline_count; i++) {
        if ((shape->props[i].attrs & clear) != 0) {
            changed = true;
            break;
        }
    }
    if (!changed) return shape;

    u8 kind = clear_writable
        ? MAL_SHAPE_TRANSITION_FREEZE
        : MAL_SHAPE_TRANSITION_SEAL;
    for (MalShapeTransition *transition = shape->transitions;
         transition != nullptr; transition = transition->next) {
        if (transition->kind == kind) return transition->child;
    }

    MalShape *child = malloc(sizeof(MalShape));
    *child = (MalShape) {
        .header = {.type = MAL_HEAP_SHAPE, .storage = MAL_HEAP_STORAGE_DYNAMIC},
        .inline_count = shape->inline_count,
        .payload_bytes = shape->payload_bytes,
        .tagged_fields = shape->tagged_fields,
    };
    child->props = malloc(sizeof(MalShapeProp) * child->inline_count);
    memcpy(
        child->props, shape->props,
        sizeof(MalShapeProp) * child->inline_count);
    for (u32 i = 0; i < child->inline_count; i++) {
        child->props[i].attrs &= (u8) ~clear;
    }

    MalShapeTransition *transition = malloc(sizeof(MalShapeTransition));
    transition->key = 0;
    transition->attrs = 0;
    transition->kind = kind;
    transition->child = child;
    transition->next = shape->transitions;
    shape->transitions = transition;
    return child;
}

static void mal_shape_visit_child_keys(MalShape *shape, void (*visit)(MalValue)) {
    for (MalShapeTransition *transition = shape->transitions;
         transition != nullptr; transition = transition->next) {
        if (transition->kind == MAL_SHAPE_TRANSITION_ADD) {
            visit(transition->key);
        }
        mal_shape_visit_child_keys(transition->child, visit);
    }
}

void mal_shape_visit_transition_keys(MalHeap *heap, void (*visit)(MalValue)) {
    mal_shape_visit_child_keys(mal_shape_root(heap), visit);
}
