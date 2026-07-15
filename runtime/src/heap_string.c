#include "heap_string.h"

#include <stdlib.h>
#include <string.h>

#include "gc.h"

bool mal_checked_size_add(usize left, usize right, usize limit, usize *out) {
    if (left > limit || right > limit - left) {
        return false;
    }
    *out = left + right;
    return true;
}

bool mal_checked_size_multiply(usize left, usize right, usize limit, usize *out) {
    if (left != 0 && right > limit / left) {
        return false;
    }
    *out = left * right;
    return true;
}

bool mal_checked_size_growth(usize current, usize required, usize initial, usize limit, usize *out) {
    if (required > limit || current > limit || initial > limit) {
        return false;
    }
    usize capacity = current == 0 ? initial : current;
    if (capacity == 0 && required != 0) {
        return false;
    }
    while (capacity < required) {
        if (capacity > limit / 2) {
            capacity = limit;
        } else {
            capacity *= 2;
        }
    }
    *out = capacity;
    return true;
}

static void mal_string_require_valid_length(usize length) {
    // Raw constructors have no VM/completion channel. VM-aware producers must
    // preflight and throw; reaching this guard is an internal invariant failure.
    if (length > MAL_STRING_MAX_CODE_UNITS) {
        abort();
    }
}

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
    mal_string_require_valid_length(length);
    c16 *owned_code_units = mal_heap_alloc_raw(heap, sizeof(c16) * length);

    if (length > 0) {
        memcpy(owned_code_units, code_units, sizeof(c16) * length);
    }

    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_OWNED;
    string->hash_valid = false;
    string->length = length;
    string->code_units = owned_code_units;
}

void mal_string_init_external(MalString *string, const c16 *code_units, usize length) {
    mal_string_require_valid_length(length);
    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_EXTERNAL;
    string->hash_valid = false;
    string->length = length;
    string->code_units = code_units;
}

MalString *mal_string_new_copy(MalHeap *heap, const c16 *code_units, usize length) {
    mal_string_require_valid_length(length);
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_string_init_copy(heap, string, code_units, length);

    return string;
}

MalString *mal_string_new_external(MalHeap *heap, const c16 *code_units, usize length) {
    mal_string_require_valid_length(length);
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_string_init_external(string, code_units, length);

    return string;
}

MalString *mal_string_new_dependent(MalHeap *heap, MalString *parent, usize offset, usize length) {
    mal_string_require_valid_length(length);
    if (parent == nullptr) {
        abort();
    }
    mal_string_require_valid_length(parent->length);

    // A dependent string stores an interior pointer, so make that pointer stable
    // before retaining the ultimate flat parent.
    const c16 *parent_code_units = mal_string_code_units(parent);

    usize end;
    if (!mal_checked_size_add(offset, length, parent->length, &end) ||
        end > parent->length) {
        abort();
    }

    MalString *flat_parent;
    switch (parent->storage) {
        case MAL_STRING_STORAGE_OWNED:
        case MAL_STRING_STORAGE_EXTERNAL:
            flat_parent = parent;
            break;
        case MAL_STRING_STORAGE_DEPENDENT:
            flat_parent = parent->parent;
            if (flat_parent == nullptr ||
                (flat_parent->storage != MAL_STRING_STORAGE_OWNED &&
                 flat_parent->storage != MAL_STRING_STORAGE_EXTERNAL)) {
                abort();
            }
            break;
        case MAL_STRING_STORAGE_CONS:
            // mal_string_code_units above converts cons strings in place.
            abort();
        default:
            abort();
    }

    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_DEPENDENT;
    string->hash_valid = false;
    string->parent = flat_parent;
    string->length = length;
    string->code_units = offset == 0 ? parent_code_units : parent_code_units + offset;

    mal_gc_card(&string->header, mal_value_from_string(flat_parent));
    if (mal_gc_marking_active) {
        mal_gc_satb_record(mal_value_from_string(flat_parent));
    }

    return string;
}

bool mal_string_new_cons_checked(MalHeap *heap, MalString *left, MalString *right, MalString **out) {
    if (left == nullptr || right == nullptr || out == nullptr) {
        abort();
    }
    if (left->length == 0 || right->length == 0) {
        abort();
    }

    usize length;
    if (!mal_checked_size_add(left->length, right->length, MAL_STRING_MAX_CODE_UNITS, &length)) {
        return false;
    }

    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_CONS;
    string->hash_valid = false;
    string->left = left;
    string->length = length;
    string->right = right;

    MalValue left_value = mal_value_from_string(left);
    MalValue right_value = mal_value_from_string(right);
    mal_gc_card(&string->header, left_value);
    mal_gc_card(&string->header, right_value);
    if (mal_gc_marking_active) {
        // Black allocation during an incremental mark must publish both new edges.
        mal_gc_satb_record(left_value);
        mal_gc_satb_record(right_value);
    }

    *out = string;
    return true;
}

MalString *mal_string_new_owned(MalHeap *heap, const c16 *code_units, usize length) {
    mal_string_require_valid_length(length);
    // Takes ownership of `code_units` (a mal_heap_alloc_raw buffer) — no copy. The
    // cell allocation may run a GC, but an unowned RAW buffer is never swept (the
    // sweep only walks CELL blocks), so `code_units` survives until we adopt it.
    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_OWNED;
    string->hash_valid = false;
    string->length = length;
    string->code_units = code_units;

    return string;
}

MalString *mal_string_new_ascii(MalHeap *heap, const byte *bytes, usize length) {
    mal_string_require_valid_length(length);
    c16 *code_units = mal_heap_alloc_raw(heap, sizeof(c16) * length);

    for (usize i = 0; i < length; i++) {
        code_units[i] = (u8) bytes[i];
    }

    MalString *string = mal_heap_alloc(heap, sizeof(MalString), MAL_HEAP_STRING);
    mal_heap_header_init(&string->header, MAL_HEAP_STRING);
    string->storage = MAL_STRING_STORAGE_OWNED;
    string->hash_valid = false;
    string->length = length;
    string->code_units = code_units;

    return string;
}

const c16 *mal_string_code_units(const MalString *string) {
    MalString *mutable = (MalString *) string;
    if (mutable->storage != MAL_STRING_STORAGE_CONS) {
        return mutable->code_units;
    }

    usize capacity = 64;
    MalString **stack = malloc(sizeof(MalString *) * capacity);
    if (stack == nullptr) {
        abort();
    }

    c16 *code_units = mal_heap_alloc_raw(mal_gc_current_heap(), sizeof(c16) * mutable->length);
    usize count = 0;
    usize offset = 0;
    stack[count++] = mutable;

    while (count > 0) {
        MalString *part = stack[--count];
        if (part->storage != MAL_STRING_STORAGE_CONS) {
            usize next_offset;
            if (!mal_checked_size_add(offset, part->length, mutable->length, &next_offset)) {
                abort();
            }
            if (part->length > 0) {
                memcpy(code_units + offset, part->code_units, sizeof(c16) * part->length);
            }
            offset = next_offset;
            continue;
        }

        usize required;
        if (!mal_checked_size_add(count, 2, MAL_STRING_MAX_CODE_UNITS, &required)) {
            abort();
        }
        if (required > capacity) {
            usize grown_capacity;
            if (!mal_checked_size_growth(capacity, required, 64, MAL_STRING_MAX_CODE_UNITS, &grown_capacity)) {
                abort();
            }
            MalString **grown = realloc(stack, sizeof(MalString *) * grown_capacity);
            if (grown == nullptr) {
                abort();
            }
            stack = grown;
            capacity = grown_capacity;
        }

        stack[count++] = part->right;
        stack[count++] = part->left;
    }

    free(stack);
    if (offset != mutable->length) {
        abort();
    }

    if (mal_gc_marking_active) {
        mal_gc_satb_record(mal_value_from_string(mutable->left));
        mal_gc_satb_record(mal_value_from_string(mutable->right));
    }
    mutable->storage = MAL_STRING_STORAGE_OWNED;
    mutable->hash_valid = false;
    mutable->code_units = code_units;
    return code_units;
}

usize mal_string_length(const MalString *string) {
    return string->length;
}

u64 mal_string_hash(const MalString *string) {
    if (string->storage == MAL_STRING_STORAGE_DEPENDENT) {
        return mal_string_hash_code_units(string->code_units, string->length);
    }

    MalString *mutable = (MalString *) string;
    const c16 *code_units = mal_string_code_units(string);
    if (!mutable->hash_valid) {
        mutable->hash = mal_string_hash_code_units(code_units, string->length);
        mutable->hash_valid = true;
    }
    return mutable->hash;
}

MalStringStorage mal_string_storage(const MalString *string) {
    return string->storage;
}

bool mal_string_equals(const MalString *left, const MalString *right) {
    if (left == right) {
        return true;
    }

    if (left->length != right->length || mal_string_hash(left) != mal_string_hash(right)) {
        return false;
    }

    return memcmp(mal_string_code_units(left), mal_string_code_units(right), sizeof(c16) * left->length) == 0;
}

i32 mal_string_compare(const MalString *left, const MalString *right) {
    usize min_length = left->length < right->length ? left->length : right->length;
    const c16 *left_code_units = mal_string_code_units(left);
    const c16 *right_code_units = mal_string_code_units(right);

    for (usize i = 0; i < min_length; i++) {
        c16 left_code_unit = left_code_units[i];
        c16 right_code_unit = right_code_units[i];

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
