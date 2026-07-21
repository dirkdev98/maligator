#include "./shape.h"

#include <stdlib.h>
#include <string.h>

#include "./heap_string.h"
#include "./value.h"
#include "./perf_stats.h"

static_assert(MAL_SHAPE_FIND_CALLER_COUNT == MAL_PERF_SHAPE_CALLER_COUNT, "shape caller stats mismatch");

#define MAL_SHAPE_TRANSITION_INDEX_THRESHOLD 8

/** A transition edge: parent + (key, attrs) -> child. */
struct MalShapeTransition {
    MalValue key;
    MalShape *child;
    MalShapeTransition *next;
    u8 attrs;
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
        if (mal_string_storage(string) == MAL_STRING_STORAGE_CONS) return false;
        hash = mal_string_hash(string);
    } else {
        hash = key.value;
    }
    hash ^= (u64) attrs + 0x9e3779b97f4a7c15ULL + (hash << 6) + (hash >> 2);
    *out = hash;
    return true;
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

/**
 * The immortal empty shape (0 properties). Baked into static storage like other
 * compile-time-immortal cells, so the future GC neither collects nor traces it.
 */
static MalShape g_empty_shape = {
    .header = MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_SHAPE),
    .inline_count = 0,
    .props = nullptr,
    .transition_index = nullptr,
    .transitions = nullptr,
};

MalShape *mal_shape_empty(void) {
    return &g_empty_shape;
}

bool mal_shape_attrs_are_default(u8 attrs) {
    return attrs
        == (u8) (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
}

i32 mal_shape_find(const MalShape *shape, MalKey key, MalShapeFindCaller caller) {
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
    return -1;
}

MalShape *mal_shape_from_string_keys(struct MalString **keys, u32 count) {
    MalShape *shape = mal_shape_empty();
    for (u32 i = 0; i < count; ++i) {
        MalKey key = {.kind = MAL_KEY_STRING, .value = mal_value_from_string(keys[i])};
        shape = mal_shape_add_property(
            shape, key,
            (u8) (MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE));
    }
    return shape;
}

MalShape *mal_shape_add_property(MalShape *shape, MalKey key, u8 attrs) {
    // Reuse an existing transition so all objects that add the same property in
    // the same order share one child shape (the interning that makes shapes pay).
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
    child->header = (MalHeapHeader){.type = MAL_HEAP_SHAPE, .storage = MAL_HEAP_STORAGE_DYNAMIC};
    child->inline_count = shape->inline_count + 1;
    child->props = malloc(sizeof(MalShapeProp) * child->inline_count);
    if (shape->inline_count > 0) {
        memcpy(child->props, shape->props, sizeof(MalShapeProp) * shape->inline_count);
    }
    child->props[shape->inline_count] = (MalShapeProp){
        .key = key.value,
        .attrs = attrs,
        .slot = shape->inline_count,
    };
    child->transition_index = nullptr;
    child->transitions = nullptr;

    MalShapeTransition *transition = malloc(sizeof(MalShapeTransition));
    transition->key = key.value;
    transition->attrs = attrs;
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

static void mal_shape_visit_child_keys(MalShape *shape, void (*visit)(MalValue)) {
    for (MalShapeTransition *transition = shape->transitions;
         transition != nullptr; transition = transition->next) {
        visit(transition->key);
        mal_shape_visit_child_keys(transition->child, visit);
    }
}

void mal_shape_visit_transition_keys(void (*visit)(MalValue)) {
    mal_shape_visit_child_keys(&g_empty_shape, visit);
}
