#include "./regexp_object.h"

void mal_regexp_object_init(MalHeap *heap, MalRegExpObject *regexp, MalObject *prototype) {
    mal_object_init(heap, &regexp->object, MAL_HEAP_REGEXP_OBJECT, prototype);
    regexp->matcher = nullptr;
    regexp->source = nullptr;
    regexp->flags = nullptr;
    regexp->flag_bits = 0;
}

MalRegExpObject *mal_regexp_object_new(MalHeap *heap, MalObject *prototype) {
    MalRegExpObject *regexp = mal_heap_alloc(heap, sizeof(MalRegExpObject), MAL_HEAP_REGEXP_OBJECT);
    mal_regexp_object_init(heap, regexp, prototype);
    return regexp;
}

void mal_regexp_string_iterator_object_init(
    MalHeap *heap, MalRegExpStringIteratorObject *iterator, MalObject *prototype, MalValue regexp, MalString *string,
    bool global, bool unicode
) {
    mal_object_init(heap, &iterator->object, MAL_HEAP_REGEXP_STRING_ITERATOR_OBJECT, prototype);
    iterator->regexp = regexp;
    iterator->string = string;
    iterator->global = global;
    iterator->unicode = unicode;
    iterator->done = false;
}

MalRegExpStringIteratorObject *mal_regexp_string_iterator_object_new(
    MalHeap *heap, MalObject *prototype, MalValue regexp, MalString *string, bool global, bool unicode
) {
    MalRegExpStringIteratorObject *iterator =
        mal_heap_alloc(heap, sizeof(MalRegExpStringIteratorObject), MAL_HEAP_REGEXP_STRING_ITERATOR_OBJECT);
    mal_regexp_string_iterator_object_init(heap, iterator, prototype, regexp, string, global, unicode);
    return iterator;
}
