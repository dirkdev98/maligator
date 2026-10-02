#include "./iterator_object.h"

#include "./map_object.h"
#include "./table.h"

static bool mal_iterator_kind_uses_collection(MalIteratorKind kind) {
    return kind == MAL_ITERATOR_MAP_KEYS
        || kind == MAL_ITERATOR_MAP_VALUES
        || kind == MAL_ITERATOR_MAP_ENTRIES
        || kind == MAL_ITERATOR_SET_VALUES
        || kind == MAL_ITERATOR_SET_ENTRIES;
}

void mal_iterator_object_init(
    MalHeap *heap,
    MalIteratorObject *iterator,
    MalObject *prototype,
    MalIteratorKind kind,
    MalValue target
) {
    mal_object_init(heap, &iterator->object, MAL_HEAP_ITERATOR_OBJECT, prototype);
    iterator->kind = kind;
    iterator->target = target;
    iterator->index = 0;
    iterator->done = false;
    iterator->collection_pinned = mal_iterator_kind_uses_collection(kind);
    if (kind == MAL_ITERATOR_SET_VALUES || kind == MAL_ITERATOR_SET_ENTRIES) {
        iterator->pinned_set = mal_set_object_storage(mal_value_to_set_object(target));
        mal_set_storage_pin(iterator->pinned_set);
    } else if (iterator->collection_pinned) {
        iterator->pinned_table = mal_value_to_map_object(target)->entries;
        mal_table_pin(iterator->pinned_table);
    } else {
        iterator->pinned_table = nullptr;
    }
}

MalIteratorObject *mal_iterator_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalIteratorKind kind,
    MalValue target
) {
    MalIteratorObject *iterator = mal_heap_alloc(heap, sizeof(MalIteratorObject), MAL_HEAP_ITERATOR_OBJECT);
    mal_iterator_object_init(heap, iterator, prototype, kind, target);

    return iterator;
}

void mal_iterator_object_finalize_collection_pin(MalIteratorObject *iterator) {
    if (iterator == nullptr || !iterator->collection_pinned) return;
    if (iterator->kind == MAL_ITERATOR_SET_VALUES || iterator->kind == MAL_ITERATOR_SET_ENTRIES) {
        mal_set_storage_unpin(iterator->pinned_set);
    } else {
        mal_table_unpin(iterator->pinned_table);
    }
    iterator->pinned_table = nullptr;
    iterator->collection_pinned = false;
}

void mal_iterator_object_release_collection_pin(MalIteratorObject *iterator) {
    if (iterator == nullptr || !iterator->collection_pinned) return;
    bool set_cursor = iterator->kind == MAL_ITERATOR_SET_VALUES || iterator->kind == MAL_ITERATOR_SET_ENTRIES;
    MalSetObject *set = set_cursor ? mal_value_to_set_object(iterator->target) : nullptr;
    mal_iterator_object_finalize_collection_pin(iterator);
    if (set != nullptr) mal_set_object_compact(set);
}
