#include "heap_string.h"

#include <string.h>

void mal_string_init_copy(MalHeap *heap, MalString *string, const byte *bytes, usize length) {
    byte *owned_bytes = mal_heap_alloc_raw(heap, length);

    if (length > 0) {
        memcpy(owned_bytes, bytes, length);
    }

    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_OWNED;
    string->length = length;
    string->bytes = owned_bytes;
}

void mal_string_init_external(MalString *string, const byte *bytes, usize length) {
    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_EXTERNAL;
    string->length = length;
    string->bytes = bytes;
}

MalString *mal_string_new_copy(MalHeap *heap, const byte *bytes, usize length) {
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_string_init_copy(heap, string, bytes, length);

    return string;
}

MalString *mal_string_new_external(MalHeap *heap, const byte *bytes, usize length) {
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_string_init_external(string, bytes, length);

    return string;
}

const byte *mal_string_bytes(const MalString *string) {
    return string->bytes;
}

usize mal_string_length(const MalString *string) {
    return string->length;
}

MalStringStorage mal_string_storage(const MalString *string) {
    return string->storage;
}
