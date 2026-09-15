#include "object.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

#include "perf_stats.h"

static u64 g_slot_coallocations = 0;
static u64 g_slot_grow_migrations = 0;
static u64 g_slot_dictionary_migrations = 0;

typedef struct MalPrototypeCacheDependency {
    MalObject *object;
    void *cache;
    struct MalPrototypeCacheDependency *object_prev;
    struct MalPrototypeCacheDependency *object_next;
    struct MalPrototypeCacheDependency *cache_prev;
    struct MalPrototypeCacheDependency *cache_next;
    struct MalPrototypeCacheDependency *free_next;
} MalPrototypeCacheDependency;

#define MAL_PROTOTYPE_DEPENDENCY_BUCKET_BITS 12
#define MAL_PROTOTYPE_DEPENDENCY_BUCKET_COUNT \
    ((usize) 1 << MAL_PROTOTYPE_DEPENDENCY_BUCKET_BITS)
#define MAL_PROTOTYPE_DEPENDENCY_BLOCK_NODES 256

typedef struct MalPrototypeCacheDependencyBlock {
    struct MalPrototypeCacheDependencyBlock *next;
    MalPrototypeCacheDependency nodes[MAL_PROTOTYPE_DEPENDENCY_BLOCK_NODES];
} MalPrototypeCacheDependencyBlock;

static _Thread_local MalPrototypeCacheDependency **g_prototype_object_dependencies = nullptr;
static _Thread_local MalPrototypeCacheDependency **g_prototype_cache_dependencies = nullptr;
static _Thread_local MalPrototypeCacheDependency *g_prototype_dependency_free = nullptr;
static _Thread_local MalPrototypeCacheDependencyBlock *g_prototype_dependency_blocks = nullptr;
static _Thread_local usize g_prototype_dependency_active = 0;

void mal_vm_property_cache_invalidate(void *cache);

u64 mal_prototype_chain_epoch = 1;

static usize mal_prototype_dependency_hash(const void *pointer) {
    u64 hash = (u64) (uptr) pointer;
    hash ^= hash >> 30;
    hash *= UINT64_C(0xbf58476d1ce4e5b9);
    hash ^= hash >> 27;
    hash *= UINT64_C(0x94d049bb133111eb);
    hash ^= hash >> 31;
    return (usize) hash & (MAL_PROTOTYPE_DEPENDENCY_BUCKET_COUNT - 1);
}

static MalPrototypeCacheDependency *mal_prototype_dependency_alloc(void) {
    if (g_prototype_object_dependencies == nullptr) {
        g_prototype_object_dependencies =
            calloc(MAL_PROTOTYPE_DEPENDENCY_BUCKET_COUNT,
                   sizeof(*g_prototype_object_dependencies));
        g_prototype_cache_dependencies =
            calloc(MAL_PROTOTYPE_DEPENDENCY_BUCKET_COUNT,
                   sizeof(*g_prototype_cache_dependencies));
        if (g_prototype_object_dependencies == nullptr ||
            g_prototype_cache_dependencies == nullptr) {
            abort();
        }
    }
    if (g_prototype_dependency_free == nullptr) {
        MalPrototypeCacheDependencyBlock *block = malloc(sizeof(*block));
        if (block == nullptr) abort();
        block->next = g_prototype_dependency_blocks;
        g_prototype_dependency_blocks = block;
        for (usize i = 0; i < MAL_PROTOTYPE_DEPENDENCY_BLOCK_NODES; i++) {
            block->nodes[i].free_next = g_prototype_dependency_free;
            g_prototype_dependency_free = &block->nodes[i];
        }
    }
    MalPrototypeCacheDependency *dependency = g_prototype_dependency_free;
    g_prototype_dependency_free = dependency->free_next;
    *dependency = (MalPrototypeCacheDependency){0};
    g_prototype_dependency_active++;
    return dependency;
}

static void mal_prototype_dependency_unlink(MalPrototypeCacheDependency *dependency) {
    usize object_bucket = mal_prototype_dependency_hash(dependency->object);
    if (dependency->object_prev == nullptr) {
        g_prototype_object_dependencies[object_bucket] = dependency->object_next;
    } else {
        dependency->object_prev->object_next = dependency->object_next;
    }
    if (dependency->object_next != nullptr) {
        dependency->object_next->object_prev = dependency->object_prev;
    }

    usize cache_bucket = mal_prototype_dependency_hash(dependency->cache);
    if (dependency->cache_prev == nullptr) {
        g_prototype_cache_dependencies[cache_bucket] = dependency->cache_next;
    } else {
        dependency->cache_prev->cache_next = dependency->cache_next;
    }
    if (dependency->cache_next != nullptr) {
        dependency->cache_next->cache_prev = dependency->cache_prev;
    }

    *dependency = (MalPrototypeCacheDependency) {
        .free_next = g_prototype_dependency_free,
    };
    g_prototype_dependency_free = dependency;
    g_prototype_dependency_active--;
}

static void mal_prototype_dependency_link(
    MalPrototypeCacheDependency *dependency, MalObject *object, void *cache
) {
    usize object_bucket = mal_prototype_dependency_hash(object);
    usize cache_bucket = mal_prototype_dependency_hash(cache);
    dependency->object = object;
    dependency->cache = cache;
    dependency->object_next = g_prototype_object_dependencies[object_bucket];
    if (dependency->object_next != nullptr) {
        dependency->object_next->object_prev = dependency;
    }
    g_prototype_object_dependencies[object_bucket] = dependency;
    dependency->cache_next = g_prototype_cache_dependencies[cache_bucket];
    if (dependency->cache_next != nullptr) {
        dependency->cache_next->cache_prev = dependency;
    }
    g_prototype_cache_dependencies[cache_bucket] = dependency;
}

void mal_object_bump_prototype_chain_epoch(void) {
    // Zero is the fail-closed exhausted state: exact-chain fills and hits reject
    // it permanently, so no dormant cache row can become valid after wraparound.
    if (mal_prototype_chain_epoch != 0) {
        if (mal_prototype_chain_epoch == UINT64_MAX) {
            mal_prototype_chain_epoch = 0;
        } else {
            mal_prototype_chain_epoch++;
        }
    }
    MAL_PERF_COUNT(prototype_epoch_invalidations);
}

void mal_object_unregister_prototype_cache(void *cache) {
    MAL_PERF_COUNT(prototype_dependency_unregister_calls);
    if (g_prototype_cache_dependencies == nullptr) {
        return;
    }
    usize bucket = mal_prototype_dependency_hash(cache);
    MalPrototypeCacheDependency *dependency = g_prototype_cache_dependencies[bucket];
    while (dependency != nullptr) {
        MAL_PERF_COUNT(prototype_dependency_unregister_scan_steps);
        MalPrototypeCacheDependency *next = dependency->cache_next;
        if (dependency->cache == cache) {
            MAL_PERF_COUNT(prototype_dependency_unregister_removed);
            mal_prototype_dependency_unlink(dependency);
        }
        dependency = next;
    }
}

void mal_object_invalidate_prototype_dependents(MalObject *object) {
    MAL_PERF_COUNT(prototype_dependency_invalidate_calls);
    if (g_prototype_object_dependencies == nullptr) {
        return;
    }
    usize bucket = mal_prototype_dependency_hash(object);
    for (;;) {
        MalPrototypeCacheDependency *dependency =
            g_prototype_object_dependencies[bucket];
        while (dependency != nullptr && dependency->object != object) {
            MAL_PERF_COUNT(prototype_dependency_invalidate_scan_steps);
            dependency = dependency->object_next;
        }
        if (dependency == nullptr) {
            break;
        }
        MAL_PERF_COUNT(prototype_dependency_invalidate_scan_steps);
        void *cache = dependency->cache;
        mal_vm_property_cache_invalidate(cache);
        MAL_PERF_COUNT(prototype_dependency_invalidate_removed);
        // Remove the complete registration, not only the node for `object`.
        // Otherwise sibling prototype nodes could later invalidate a reused row.
        mal_object_unregister_prototype_cache(cache);
    }
}

bool mal_object_register_prototype_cache(
    MalObject *receiver, MalObject *holder, void *cache,
    bool include_receiver
) {
    MAL_PERF_COUNT(prototype_dependency_register_calls);
    mal_object_unregister_prototype_cache(cache);
    if (include_receiver) mal_object_mark_as_prototype(receiver);
    for (MalObject *cursor = include_receiver ? receiver : receiver->prototype;
         cursor != nullptr; cursor = cursor->prototype) {
        MalPrototypeCacheDependency *dependency = mal_prototype_dependency_alloc();
        MAL_PERF_COUNT(prototype_dependency_register_nodes);
        mal_prototype_dependency_link(dependency, cursor, cache);
        if (cursor == holder) {
            return true;
        }
    }
    if (holder == nullptr) {
        return true;
    }
    MAL_PERF_COUNT(prototype_dependency_register_failures);
    mal_object_unregister_prototype_cache(cache);
    return false;
}

void mal_object_release_idle_prototype_dependencies(void) {
    if (g_prototype_dependency_active != 0) {
        return;
    }
    MalPrototypeCacheDependencyBlock *block = g_prototype_dependency_blocks;
    while (block != nullptr) {
        MalPrototypeCacheDependencyBlock *next = block->next;
        free(block);
        block = next;
    }
    g_prototype_dependency_blocks = nullptr;
    g_prototype_dependency_free = nullptr;
    free(g_prototype_object_dependencies);
    free(g_prototype_cache_dependencies);
    g_prototype_object_dependencies = nullptr;
    g_prototype_cache_dependencies = nullptr;
}

u64 mal_object_slot_coallocation_count(void) {
    return g_slot_coallocations;
}

u64 mal_object_slot_grow_migration_count(void) {
    return g_slot_grow_migrations;
}

u64 mal_object_slot_dictionary_migration_count(void) {
    return g_slot_dictionary_migrations;
}

void mal_object_init(MalHeap *heap, MalObject *object, MalHeapType type, MalObject *prototype) {
    mal_heap_header_init(&object->header, type);
    object->shape = mal_shape_root(heap);
    object->slots = nullptr;
    // Overflow/dictionary table is allocated lazily: a fresh object is empty
    // (shaped), and only index/symbol keys or dictionary transitions create it.
    object->overflow = nullptr;
    object->prototype = prototype;
    object->extensible = true;
    object->fast_elements_proto = false;
    object->is_raw_json = false;
    object->is_arguments = false;
    object->immutable_prototype = false;
    object->is_prototype = false;
    object->watched_method_proto = false;
    object->slots_owned = false;
    object->has_captured_stack = false;
    object->has_error_data = false;
    object->primordial_locked = false;
    object->primordial_locking = false;
    object->overflow_private_only = false;
    mal_object_mark_as_prototype(prototype);
}

MalObject *mal_object_new(MalHeap *heap, MalObject *prototype) {
    MalObject *object = mal_heap_alloc(heap, sizeof(MalObject), MAL_HEAP_OBJECT);
    mal_object_init(heap, object, MAL_HEAP_OBJECT, prototype);
    return object;
}

MalObject *mal_object_try_new(MalHeap *heap, MalObject *prototype) {
    MalObject *object = mal_heap_try_alloc(heap, sizeof(MalObject), MAL_HEAP_OBJECT);
    if (object == nullptr) return nullptr;
    mal_object_init(heap, object, MAL_HEAP_OBJECT, prototype);
    return object;
}

MalObject *mal_object_new_shaped(MalHeap *heap, MalObject *prototype, MalShape *shape,
                                 const MalValue *values, u32 count) {
    assert(count >= 1 && count <= MAL_SHAPE_MAX_INLINE_SLOTS);
    assert(shape->inline_count == count);
    MalObject *object =
        mal_heap_alloc(heap, sizeof(MalObject) + sizeof(MalValue) * count, MAL_HEAP_OBJECT);
    mal_object_init(heap, object, MAL_HEAP_OBJECT, prototype);
    object->shape = shape;
    object->slots = (MalValue *) (object + 1);
    memcpy(object->slots, values, sizeof(MalValue) * count);
    g_slot_coallocations++;
    return object;
}

MalObject *mal_object_try_new_shaped(
    MalHeap *heap, MalObject *prototype, MalShape *shape,
    const MalValue *values, u32 count
) {
    assert(count >= 1 && count <= MAL_SHAPE_MAX_INLINE_SLOTS);
    assert(shape->inline_count == count);
    MalObject *object = mal_heap_try_alloc(
        heap, sizeof(MalObject) + sizeof(MalValue) * count, MAL_HEAP_OBJECT);
    if (object == nullptr) return nullptr;
    mal_object_init(heap, object, MAL_HEAP_OBJECT, prototype);
    object->shape = shape;
    object->slots = (MalValue *) (object + 1);
    memcpy(object->slots, values, sizeof(MalValue) * count);
    g_slot_coallocations++;
    return object;
}

void mal_object_set_shaped_values(
    MalObject *object, MalShape *shape, const MalValue *values, u32 count
) {
    assert(object->shape->inline_count == 0);
    assert(object->slots == nullptr);
    assert(object->overflow == nullptr);
    assert(shape->inline_count == count);
    if (mal_object_note_prototype_mutation(object)) {
        MAL_PERF_COUNT(prototype_epoch_shaped_invalidations);
    }
    object->shape = shape;
    if (count == 0) {
        return;
    }
    object->slots = malloc(sizeof(MalValue) * count);
    object->slots_owned = true;
    for (u32 i = 0; i < count; i++) {
        object->slots[i] = values[i];
    }
}

void mal_object_grow_slots(MalObject *object, u32 old_count, u32 new_count) {
    if (object->slots_owned) {
        object->slots = realloc(object->slots, sizeof(MalValue) * new_count);
        return;
    }

    MalValue *slots = malloc(sizeof(MalValue) * new_count);
    for (u32 i = 0; i < old_count; ++i) {
        slots[i] = object->slots[i];
    }
    if (old_count > 0 && object->header.storage == MAL_HEAP_STORAGE_DYNAMIC) {
        g_slot_grow_migrations++;
    }
    object->slots = slots;
    object->slots_owned = true;
}

void mal_object_record_slot_dictionary_migration(MalObject *object) {
    if (object->slots != nullptr && !object->slots_owned
        && object->header.storage == MAL_HEAP_STORAGE_DYNAMIC) {
        g_slot_dictionary_migrations++;
    }
}

void mal_object_release_slots(MalObject *object) {
    if (object->slots_owned) {
        free(object->slots);
    }
    object->slots = nullptr;
    object->slots_owned = false;
}
