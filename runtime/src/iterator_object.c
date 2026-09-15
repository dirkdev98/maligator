#include "./iterator_object.h"

#include "./map_object.h"
#include "./table.h"

static bool mal_iterator_kind_uses_table(MalIteratorKind kind) {
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
    iterator->table_pinned = mal_iterator_kind_uses_table(kind);
    if (iterator->table_pinned) {
        iterator->pinned_table = mal_map_object_ensure_entries(
            mal_value_to_map_object(target));
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

void mal_iterator_object_release_table_pin(MalIteratorObject *iterator) {
    if (iterator == nullptr || !iterator->table_pinned) return;
    mal_table_unpin(iterator->pinned_table);
    iterator->pinned_table = nullptr;
    iterator->table_pinned = false;
}
