#include "object.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

#include "gc.h"
#include "heap.h"
#include "perf_stats.h"
#include "profile.h"

// Diagnostic counters describe the isolate on the current mutator thread.

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
    for (MalObject *cursor = include_receiver ? receiver : mal_object_prototype(receiver);
         cursor != nullptr; cursor = mal_object_prototype(cursor)) {
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

bool mal_object_register_constructor_layout_cache(
    MalObject *constructor, MalObject *prototype, void *cache
) {
    mal_object_unregister_prototype_cache(cache);
    mal_object_mark_as_prototype(constructor);
    mal_object_mark_as_prototype(prototype);

    MalPrototypeCacheDependency *constructor_dependency =
        mal_prototype_dependency_alloc();
    MAL_PERF_COUNT(prototype_dependency_register_nodes);
    mal_prototype_dependency_link(constructor_dependency, constructor, cache);
    for (MalObject *cursor = prototype; cursor != nullptr; cursor = mal_object_prototype(cursor)) {
        MalPrototypeCacheDependency *dependency = mal_prototype_dependency_alloc();
        MAL_PERF_COUNT(prototype_dependency_register_nodes);
        mal_prototype_dependency_link(dependency, cursor, cache);
    }
    return true;
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
    return mal_object_slot_coallocations;
}

u64 mal_object_slot_grow_migration_count(void) {
    return mal_object_slot_grow_migrations;
}

u64 mal_object_slot_dictionary_migration_count(void) {
    return mal_object_slot_dictionary_migrations;
}

static MalObjectStorage *mal_object_externalize(MalObject *object) {
    if (object->storage_kind != MAL_OBJECT_COMPACT) {
        return mal_object_storage(object);
    }
    MalObjectStorage *storage = malloc(sizeof(*storage));
    if (storage == nullptr) abort();
    *storage = (MalObjectStorage) {
        .prototype = mal_object_prototype(object),
        .fields = mal_object_fields(object),
    };
    memcpy(object + 1, &storage, sizeof(storage));
    object->storage_kind = MAL_OBJECT_EXTERNAL;
    return storage;
}

void mal_object_set_prototype_pointer(MalObject *object, MalObject *prototype) {
    if (object->storage_kind == MAL_OBJECT_COMPACT) {
        memcpy(object + 1, &prototype, sizeof(prototype));
    } else {
        mal_object_storage(object)->prototype = prototype;
    }
}

void mal_object_set_fields_pointer(MalObject *object, void *fields) {
    if (object->storage_kind == MAL_OBJECT_COMPACT &&
        fields == (u8 *) (object + 1) + sizeof(void *)) {
        return;
    }
    mal_object_externalize(object)->fields = fields;
}

void mal_object_set_overflow_pointer(MalObject *object, MalTable *overflow) {
    if (overflow == nullptr && object->storage_kind == MAL_OBJECT_COMPACT) return;
    mal_object_externalize(object)->overflow = overflow;
}

static u8 mal_object_inline_payload_eights(usize allocation_size) {
    usize base = sizeof(MalObject) + sizeof(void *);
    usize capacity = mal_heap_allocation_charge(allocation_size) - base;
    assert(capacity % sizeof(MalValue) == 0 && capacity / sizeof(MalValue) <= UINT8_MAX);
    return (u8) (capacity / sizeof(MalValue));
}

static u32 mal_object_inline_slot_capacity(MalObject *object) {
    if (object->slots_owned || object->storage_kind == MAL_OBJECT_EMBEDDED ||
        (object->storage_kind != MAL_OBJECT_COMPACT &&
         mal_object_fields(object) != (u8 *) (object + 1) + sizeof(void *))) {
        return 0;
    }
    if (object->inline_payload_eights == 0) {
        if (object->header.storage != MAL_HEAP_STORAGE_DYNAMIC) return 0;
        // Before inline growth, slot capacity still describes the original allocation.
        usize allocation_size = sizeof(MalObject) + sizeof(void *)
            + sizeof(MalValue) * object->slot_capacity;
        object->inline_payload_eights = mal_object_inline_payload_eights(allocation_size);
    }
    return object->inline_payload_eights < MAL_SHAPE_MAX_INLINE_SLOTS
        ? object->inline_payload_eights : MAL_SHAPE_MAX_INLINE_SLOTS;
}

void mal_object_field_initialize(
    MalObject *object, const MalShape *shape, u32 ordinal, MalValue value
) {
    assert(ordinal < shape->inline_count);
    ((MalValue *) mal_object_fields(object))[ordinal] = value;
    mal_gc_card(&object->header, value);
}

static void mal_object_init_payload(
    MalHeap *heap, MalObject *object, MalObject *prototype,
    MalObjectStorageKind storage_kind, MalShape *shape
) {
    MalHeapHeader header = object->header;
    *object = (MalObject) {
        .header = header,
        .extensible = true,
        .storage_kind = storage_kind,
        .shape = shape == nullptr ? mal_shape_root(heap) : shape,
    };
    if (storage_kind == MAL_OBJECT_COMPACT) {
        memcpy(object + 1, &prototype, sizeof(prototype));
    } else {
        *mal_object_storage(object) = (MalObjectStorage) {.prototype = prototype};
    }
    mal_object_mark_as_prototype(prototype);
}

void mal_object_init(MalHeap *heap, MalObject *object, MalHeapType type, MalObject *prototype) {
    mal_heap_header_init(heap, &object->header, type);
    mal_object_init_payload(heap, object, prototype, MAL_OBJECT_EMBEDDED, nullptr);
}

void mal_object_init_embedded_stack(
    MalHeap *heap, MalEmbeddedObject *wrapper, MalObject *prototype,
    MalShape *shape, MalValue *slots
) {
    mal_object_init(heap, &wrapper->object, MAL_HEAP_OBJECT, prototype);
    wrapper->object.header.storage = MAL_HEAP_STORAGE_IMMORTAL;
    wrapper->object.shape = shape;
    wrapper->storage.fields = slots;
    wrapper->object.slot_capacity = (u8) shape->inline_count;
}

MalObject *mal_object_new(MalHeap *heap, MalObject *prototype) {
    MalObject *object = mal_heap_alloc(
        heap, sizeof(MalObject) + sizeof(void *), MAL_HEAP_OBJECT);
    mal_object_init_payload(heap, object, prototype, MAL_OBJECT_COMPACT, nullptr);
    return object;
}

MalObject *mal_object_try_new(MalHeap *heap, MalObject *prototype) {
    MalObject *object = mal_heap_try_alloc(
        heap, sizeof(MalObject) + sizeof(void *), MAL_HEAP_OBJECT);
    if (object == nullptr) return nullptr;
    mal_object_init_payload(heap, object, prototype, MAL_OBJECT_COMPACT, nullptr);
    return object;
}

MalObject *mal_object_new_reserved(MalHeap *heap, MalObject *prototype, u8 capacity) {
    if (capacity == 0) return mal_object_new(heap, prototype);
    MalObject *object = mal_heap_alloc(
        heap, sizeof(MalObject) + sizeof(void *) + sizeof(MalValue) * capacity,
        MAL_HEAP_OBJECT);
    mal_object_init_payload(heap, object, prototype, MAL_OBJECT_COMPACT, nullptr);
    object->slot_capacity = capacity;
    mal_object_slot_coallocations++;
    return object;
}

// Records have a few fields; a libc memcpy call per construction costs more than the copy.
static inline __attribute__((always_inline)) void mal_object_copy_initial_fields(
    MalValue *fields, const MalValue *values, u32 count
) {
    switch (count) {
        case 8: fields[7] = values[7]; [[fallthrough]];
        case 7: fields[6] = values[6]; [[fallthrough]];
        case 6: fields[5] = values[5]; [[fallthrough]];
        case 5: fields[4] = values[4]; [[fallthrough]];
        case 4: fields[3] = values[3]; [[fallthrough]];
        case 3: fields[2] = values[2]; [[fallthrough]];
        case 2: fields[1] = values[1]; [[fallthrough]];
        case 1: fields[0] = values[0]; return;
        default: memcpy(fields, values, sizeof(MalValue) * count); return;
    }
}

MalObject *mal_object_new_shaped(MalHeap *heap, MalObject *prototype, MalShape *shape,
                                 const MalValue *values, u32 count) {
    assert(count >= 1 && count <= MAL_SHAPE_MAX_INLINE_SLOTS);
    assert(shape->inline_count == count);
    MalObject *object = mal_heap_alloc(
        heap, sizeof(MalObject) + sizeof(void *) + sizeof(MalValue) * count,
        MAL_HEAP_OBJECT);
    mal_object_init_payload(heap, object, prototype, MAL_OBJECT_COMPACT, shape);
    object->slot_capacity = (u8) count;
    mal_object_copy_initial_fields(mal_object_fields_nonempty(object), values, count);
    mal_object_slot_coallocations++;
    return object;
}

MalObject *mal_object_try_new_shaped(
    MalHeap *heap, MalObject *prototype, MalShape *shape,
    const MalValue *values, u32 count
) {
    assert(count >= 1 && count <= MAL_SHAPE_MAX_INLINE_SLOTS);
    assert(shape->inline_count == count);
    MalObject *object = mal_heap_try_alloc(
        heap, sizeof(MalObject) + sizeof(void *) + sizeof(MalValue) * count,
        MAL_HEAP_OBJECT);
    if (object == nullptr) return nullptr;
    mal_object_init_payload(heap, object, prototype, MAL_OBJECT_COMPACT, shape);
    object->slot_capacity = (u8) count;
    mal_object_copy_initial_fields(mal_object_fields_nonempty(object), values, count);
    mal_object_slot_coallocations++;
    return object;
}

// Owned slot arrays are raw heap cells like dictionary entries: growing a record one
// property at a time otherwise paid a libc malloc, realloc and free per step.
static MalValue *mal_object_slots_alloc(u32 capacity) {
    return mal_heap_alloc_raw_profiled(
        mal_gc_current_heap(), sizeof(MalValue) * capacity,
        MAL_PROFILE_ALLOCATION_FAMILY_OBJECT);
}

void mal_object_set_shaped_values(
    MalObject *object, MalShape *shape, const MalValue *values, u32 count
) {
    assert(object->shape->inline_count == 0);
    assert(mal_object_fields(object) == nullptr);
    assert(mal_object_overflow(object) == nullptr);
    assert(shape->inline_count == count);
    if (mal_object_note_prototype_mutation(object)) {
        MAL_PERF_COUNT(prototype_epoch_shaped_invalidations);
    }
    if (count == 0) {
        object->shape = shape;
        return;
    }
    MalValue *slots = mal_object_slots_alloc(count);
    memcpy(slots, values, sizeof(MalValue) * count);
    mal_object_set_fields_pointer(object, slots);
    object->shape = shape;
    object->slots_owned = true;
    object->slot_capacity = (u8) count;
}

void mal_object_grow_slots(MalObject *object, u32 old_count, u32 new_count) {
    assert(new_count <= MAL_SHAPE_MAX_INLINE_SLOTS);
    if (new_count <= object->slot_capacity) return;
    u32 inline_capacity = mal_object_inline_slot_capacity(object);
    if (new_count <= inline_capacity) {
        object->slot_capacity = (u8) inline_capacity;
        return;
    }
    u32 capacity = object->slot_capacity < 4 ? 4 : object->slot_capacity;
    while (capacity < new_count) {
        capacity = capacity < MAL_SHAPE_MAX_INLINE_SLOTS / 2
            ? capacity * 2
            : MAL_SHAPE_MAX_INLINE_SLOTS;
    }
    // Spare slots stay invisible until callers initialize them and publish the shape.
    if (object->slots_owned) {
        MalValue *slots = gc_realloc_raw_profiled(
            mal_gc_current_heap(), mal_object_fields(object), sizeof(MalValue) * capacity,
            MAL_PROFILE_ALLOCATION_FAMILY_OBJECT);
        mal_object_set_fields_pointer(object, slots);
        object->slot_capacity = (u8) capacity;
        return;
    }

    MalValue *slots = mal_object_slots_alloc(capacity);
    MalValue *old_slots = mal_object_fields(object);
    for (u32 i = 0; i < old_count; ++i) {
        slots[i] = old_slots[i];
    }
    if (old_count > 0 && object->header.storage == MAL_HEAP_STORAGE_DYNAMIC) {
        mal_object_slot_grow_migrations++;
    }
    mal_object_set_fields_pointer(object, slots);
    object->slots_owned = true;
    object->slot_capacity = (u8) capacity;
}

void mal_object_record_slot_dictionary_migration(MalObject *object) {
    if (mal_object_fields(object) != nullptr && !object->slots_owned
        && object->header.storage == MAL_HEAP_STORAGE_DYNAMIC) {
        mal_object_slot_dictionary_migrations++;
    }
}

void mal_object_release_slots(MalObject *object) {
    if (object->slots_owned) {
        gc_free_raw(mal_gc_current_heap(), mal_object_fields(object));
    }
    if (object->storage_kind != MAL_OBJECT_COMPACT) {
        mal_object_storage(object)->fields = nullptr;
    }
    object->slots_owned = false;
    object->slot_capacity = 0;
}
