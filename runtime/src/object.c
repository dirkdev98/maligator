#include "object.h"

#include <assert.h>
#include <stdlib.h>
#include <string.h>

#include "perf_stats.h"

static u64 g_slot_coallocations = 0;
static u64 g_slot_grow_migrations = 0;
static u64 g_slot_dictionary_migrations = 0;

u64 mal_prototype_chain_epoch = 1;

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
    (void) heap;

    mal_heap_header_init(&object->header, type);
    object->shape = mal_shape_empty();
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

void mal_object_set_shaped_values(
    MalObject *object, MalShape *shape, const MalValue *values, u32 count
) {
    assert(object->shape == mal_shape_empty());
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
