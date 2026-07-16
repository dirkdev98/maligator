#include "object.h"

#include <assert.h>
#include <stdlib.h>

static u64 g_slot_coallocations = 0;
static u64 g_slot_grow_migrations = 0;
static u64 g_slot_dictionary_migrations = 0;

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
    object->immutable_prototype = false;
    object->watched_method_proto = false;
    object->slots_owned = false;
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

MalObject *mal_object_new_shaped_one(MalHeap *heap, MalObject *prototype, MalShape *shape,
                                     MalValue value) {
    assert(shape->inline_count == 1);
    MalObject *object =
        mal_heap_alloc(heap, sizeof(MalObject) + sizeof(MalValue), MAL_HEAP_OBJECT);
    mal_object_init(heap, object, MAL_HEAP_OBJECT, prototype);
    object->shape = shape;
    object->slots = (MalValue *) (object + 1);
    object->slots[0] = value;
    g_slot_coallocations++;
    return object;
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
