#include "heap_string.h"

#include <string.h>

u64 mal_string_hash_code_units(const c16 *code_units, usize length) {
    u64 hash = 0xcbf29ce484222325;

    for (usize i = 0; i < length; i++) {
        c16 code_unit = code_units[i];
        hash ^= (u8) (code_unit & 0xFF);
        hash *= 0x100000001b3;
        hash ^= (u8) (code_unit >> 8);
        hash *= 0x100000001b3;
    }

    return hash;
}

void mal_string_init_copy(MalHeap *heap, MalString *string, const c16 *code_units, usize length) {
    c16 *owned_code_units = mal_heap_alloc_raw(heap, sizeof(c16) * length);

    if (length > 0) {
        memcpy(owned_code_units, code_units, sizeof(c16) * length);
    }

    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_OWNED;
    string->hash = mal_string_hash_code_units(code_units, length);
    string->length = length;
    string->code_units = owned_code_units;
}

void mal_string_init_external(MalString *string, const c16 *code_units, usize length) {
    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_EXTERNAL;
    string->hash = mal_string_hash_code_units(code_units, length);
    string->length = length;
    string->code_units = code_units;
}

MalString *mal_string_new_copy(MalHeap *heap, const c16 *code_units, usize length) {
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_string_init_copy(heap, string, code_units, length);

    return string;
}

MalString *mal_string_new_external(MalHeap *heap, const c16 *code_units, usize length) {
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_string_init_external(string, code_units, length);

    return string;
}

MalString *mal_string_new_owned(MalHeap *heap, const c16 *code_units, usize length) {
    // Takes ownership of `code_units` (a mal_heap_alloc_raw buffer) — no copy. The
    // cell allocation may run a GC, but an unowned RAW buffer is never swept (the
    // sweep only walks CELL blocks), so `code_units` survives until we adopt it.
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_OWNED;
    string->hash = mal_string_hash_code_units(code_units, length);
    string->length = length;
    string->code_units = code_units;

    return string;
}

MalString *mal_string_new_ascii(MalHeap *heap, const byte *bytes, usize length) {
    c16 *code_units = mal_heap_alloc_raw(heap, sizeof(c16) * length);

    for (usize i = 0; i < length; i++) {
        code_units[i] = (u8) bytes[i];
    }

    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_OWNED;
    string->hash = mal_string_hash_code_units(code_units, length);
    string->length = length;
    string->code_units = code_units;

    return string;
}

const c16 *mal_string_code_units(const MalString *string) {
    return string->code_units;
}

usize mal_string_length(const MalString *string) {
    return string->length;
}

u64 mal_string_hash(const MalString *string) {
    return string->hash;
}

MalStringStorage mal_string_storage(const MalString *string) {
    return string->storage;
}

bool mal_string_equals(const MalString *left, const MalString *right) {
    if (left == right) {
        return true;
    }

    if (left->hash != right->hash || left->length != right->length) {
        return false;
    }

    return memcmp(left->code_units, right->code_units, sizeof(c16) * left->length) == 0;
}

i32 mal_string_compare(const MalString *left, const MalString *right) {
    usize min_length = left->length < right->length ? left->length : right->length;

    for (usize i = 0; i < min_length; i++) {
        c16 left_code_unit = left->code_units[i];
        c16 right_code_unit = right->code_units[i];

        if (left_code_unit < right_code_unit) {
            return -1;
        }

        if (left_code_unit > right_code_unit) {
            return 1;
        }
    }

    if (left->length < right->length) {
        return -1;
    }

    if (left->length > right->length) {
        return 1;
    }

    return 0;
}
