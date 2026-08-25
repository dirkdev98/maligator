#include "./shape.h"

#include <stdlib.h>
#include <string.h>

#include "./heap_string.h"
#include "./value.h"
#include "./perf_stats.h"

static_assert(MAL_SHAPE_FIND_CALLER_COUNT == MAL_PERF_SHAPE_CALLER_COUNT, "shape caller stats mismatch");

#define MAL_SHAPE_TRANSITION_INDEX_THRESHOLD 8
#define MAL_SHAPE_FIND_CACHE_SIZE 1024
#define MAL_SHAPE_FIND_CACHE_THRESHOLD 4

typedef struct MalShapeFindCacheEntry {
    const MalShape *shape;
    MalValue key;
    u64 hash;
    i32 result;
} MalShapeFindCacheEntry;

static _Thread_local MalShapeFindCacheEntry
    mal_shape_find_cache[MAL_SHAPE_FIND_CACHE_SIZE];

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
        if (mal_string_storage(string) == MAL_STRING_STORAGE_CONS) return false;
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
        if (mal_string_storage(string) == MAL_STRING_STORAGE_CONS) return false;
        *out = mal_string_hash(string);
        return true;
    }
    *out = key.value;
    return true;
}

static MalShapeFindCacheEntry *mal_shape_find_cache_entry(
    const MalShape *shape, u64 hash) {
    uintptr_t pointer = (uintptr_t) shape >> 4;
    usize slot = (usize) (pointer ^ hash ^ (hash >> 32))
        & (MAL_SHAPE_FIND_CACHE_SIZE - 1);
    return &mal_shape_find_cache[slot];
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

void mal_shape_heap_init(MalHeap *heap) {
    heap->shape_root = malloc(sizeof(MalShape));
    mal_shape_init_empty(heap->shape_root);
    memset(mal_shape_find_cache, 0, sizeof(mal_shape_find_cache));
}

static void mal_shape_free_children(MalShape *shape) {
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
    // The TLS direct map may otherwise retain freed shape/key pointers into a
    // later heap lifetime on this thread.
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
    // Empty and single-property shapes are handled by the header fast path.
    if (shape->inline_count <= 1) abort();
    u64 hash = 0;
    MalShapeFindCacheEntry *cached = nullptr;
    if (shape->inline_count >= MAL_SHAPE_FIND_CACHE_THRESHOLD
        && mal_shape_find_hash(key, &hash)) {
        cached = mal_shape_find_cache_entry(shape, hash);
        if (cached->shape == shape && cached->hash == hash
            && mal_key_value_equals(cached->key, key.value)) {
            mal_shape_find_record_cached(shape, key, caller, cached->result);
            return cached->result;
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
            if (cached != nullptr) {
                *cached = (MalShapeFindCacheEntry) {
                    .shape = shape,
                    .key = shape->props[i].key,
                    .hash = hash,
                    .result = (i32) i,
                };
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
    if (cached != nullptr && mal_value_is_string(key.value)
        && mal_value_to_string(key.value)->header.storage
            == MAL_HEAP_STORAGE_IMMORTAL) {
        *cached = (MalShapeFindCacheEntry) {
            .shape = shape,
            .key = key.value,
            .hash = hash,
            .result = -1,
        };
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
    child->header = (MalHeapHeader) {
        .type = MAL_HEAP_SHAPE,
        .storage = MAL_HEAP_STORAGE_DYNAMIC,
    };
    child->inline_count = shape->inline_count;
    child->props = malloc(sizeof(MalShapeProp) * child->inline_count);
    memcpy(
        child->props, shape->props,
        sizeof(MalShapeProp) * child->inline_count);
    for (u32 i = 0; i < child->inline_count; i++) {
        child->props[i].attrs &= (u8) ~clear;
    }
    child->transition_index = nullptr;
    child->transitions = nullptr;

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
