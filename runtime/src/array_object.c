#include "array_object.h"

#include <stdlib.h>

#include "gc.h"
#include "heap_string.h"
#include "object_ops.h"

// Largest gap (new index minus the current dense_count) the dense vector will span
// with holes. A store beyond this is treated as sparse: the array deoptimizes to
// table storage rather than allocate a mostly-hole vector.
#define MAL_ARRAY_DENSE_MAX_GAP 1024u

void mal_array_object_init(MalHeap *heap, MalArrayObject *array, MalObject *prototype) {
    mal_object_init(heap, &array->object, MAL_HEAP_ARRAY_OBJECT, prototype);
    array->length = 0;
    array->length_writable = true;
    array->elements = nullptr;
    array->capacity = 0;
    array->dense_count = 0;
    array->dense_deopted = false;
}

bool mal_array_object_is_dense(const MalArrayObject *array) {
    return array->elements != nullptr;
}

bool mal_array_object_dense_get(const MalArrayObject *array, u32 index, MalValue *out) {
    if (array->elements == nullptr || index >= array->dense_count) {
        return false;
    }
    MalValue value = array->elements[index];
    if (mal_value_is_array_hole(value)) {
        return false;
    }
    *out = value;
    return true;
}

bool mal_array_object_dense_has(const MalArrayObject *array, u32 index) {
    MalValue ignored;
    return mal_array_object_dense_get(array, index, &ignored);
}

/** Ensure `elements` has room for at least `needed` slots (geometric growth). */
static bool mal_array_object_dense_reserve(MalArrayObject *array, u32 needed) {
    if (needed <= array->capacity) {
        return true;
    }
    u32 capacity = array->capacity == 0 ? 4 : array->capacity;
    while (capacity < needed) {
        capacity *= 2;
    }
    MalValue *grown = realloc(array->elements, sizeof(MalValue) * capacity);
    if (grown == nullptr) {
        return false;
    }
    array->elements = grown;
    array->capacity = capacity;
    return true;
}

MalArrayDenseStore mal_array_object_dense_store(MalArrayObject *array, u32 index, MalValue value) {
    // Overwrite within the existing dense region (shade the replaced reference).
    if (array->elements != nullptr && index < array->dense_count) {
        mal_gc_write_barrier(array->elements[index]);
        array->elements[index] = value;
        mal_gc_card(&array->object.header, value); // old array -> young element
        return MAL_ARRAY_DENSE_APPLIED;
    }

    // Extending (or lazily creating) the vector: reject a gap large enough that the
    // hole fill would waste memory — the caller deoptimizes to table storage.
    if (index >= array->dense_count + MAL_ARRAY_DENSE_MAX_GAP) {
        return MAL_ARRAY_DENSE_NEEDS_TABLE;
    }
    if (!mal_array_object_dense_reserve(array, index + 1)) {
        return MAL_ARRAY_DENSE_NEEDS_TABLE;
    }
    // Fill the gap [dense_count, index) with holes, then place the value.
    for (u32 i = array->dense_count; i < index; i++) {
        array->elements[i] = mal_value_new_array_hole();
    }
    array->elements[index] = value;
    array->dense_count = index + 1;
    mal_gc_card(&array->object.header, value); // old array -> young element
    return MAL_ARRAY_DENSE_APPLIED;
}

void mal_array_object_dense_delete(MalArrayObject *array, u32 index) {
    if (array->elements == nullptr || index >= array->dense_count) {
        return;
    }
    mal_gc_write_barrier(array->elements[index]);
    array->elements[index] = mal_value_new_array_hole();
}

MalArrayObject *mal_array_object_new(MalHeap *heap, MalObject *prototype) {
    MalArrayObject *array = mal_heap_alloc(heap, sizeof(MalArrayObject), MAL_HEAP_ARRAY_OBJECT);
    mal_array_object_init(heap, array, prototype);

    return array;
}

u32 mal_array_object_length(const MalArrayObject *array) {
    return array->length;
}

/**
 * Spec ArraySetLength deletion: drop own index elements at or past
 * new_length, highest first, stopping at the first non-configurable one.
 * Returns the length actually achieved (one past a blocking element, or
 * new_length when all deletions succeeded).
 */
static u32 mal_array_object_shrink(MalArrayObject *array, u32 new_length) {
    MalTable *properties = mal_object_properties(&array->object);

    // Collect the index keys at or past new_length.
    u32 *indices = nullptr;
    usize count = 0;
    usize capacity = 0;

    MalTableIter iter;
    mal_table_iter_init(&iter, properties, MAL_TABLE_ITER_STORAGE);

    MalKey key;
    void *entry;
    while (mal_table_iter_next(&iter, &key, &entry)) {
        if (key.kind != MAL_KEY_INDEX) {
            continue;
        }

        i32 index = mal_value_to_i32(key.value);
        if (index >= 0 && (u32) index >= new_length) {
            if (count == capacity) {
                capacity = capacity == 0 ? 8 : capacity * 2;
                indices = realloc(indices, sizeof(u32) * capacity);
            }
            indices[count++] = (u32) index;
        }
    }

    // Descending order so a non-configurable element fixes the final length.
    for (usize i = 0; i < count; i++) {
        for (usize j = i + 1; j < count; j++) {
            if (indices[j] > indices[i]) {
                u32 tmp = indices[i];
                indices[i] = indices[j];
                indices[j] = tmp;
            }
        }
    }

    u32 achieved = new_length;
    for (usize i = 0; i < count; i++) {
        MalKey index_key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) indices[i])};
        if (!mal_object_delete_own(&array->object, index_key)) {
            achieved = indices[i] + 1;
            break;
        }
    }

    free(indices);
    return achieved;
}

void mal_array_object_set_length(MalArrayObject *array, u32 length) {
    if (length < array->length) {
        // Table sparse indices (only present on deopted arrays) may block the shrink
        // at a non-configurable element; dense elements are always configurable, so
        // they never block — just truncate the dense region to the achieved length.
        length = mal_array_object_shrink(array, length);
        if (array->elements != nullptr && array->dense_count > length) {
            array->dense_count = length;
        }
    }

    array->length = length;
}

bool mal_array_key_is_length(MalKey key) {
    if (key.kind != MAL_KEY_STRING || !mal_value_is_string(key.value)) {
        return false;
    }

    MalString *string = mal_value_to_string(key.value);
    const c16 *code_units = mal_string_code_units(string);
    return mal_string_length(string) == 6 &&
        code_units[0] == 'l' &&
        code_units[1] == 'e' &&
        code_units[2] == 'n' &&
        code_units[3] == 'g' &&
        code_units[4] == 't' &&
        code_units[5] == 'h';
}

bool mal_array_object_store(MalArrayObject *array, MalKey key, MalValue value) {
    if (key.kind == MAL_KEY_INDEX) {
        i32 index = mal_value_to_i32(key.value);
        bool grows = index >= 0 && (u32) index >= array->length;
        // Growing an index past length also writes length, which is refused when
        // length is non-writable.
        if (grows && !array->length_writable) {
            return false;
        }
        // Store the element FIRST and commit the length grow only if it succeeded:
        // a non-extensible array rejects a fresh index, and a rejected store must
        // not bump length (ArrayDefineOwnProperty 10.4.2.1 steps 3-4).
        if (!mal_object_set(&array->object, key, value)) {
            return false;
        }
        if (grows) {
            array->length = (u32) index + 1;
        }
        return true;
    }

    if (mal_array_key_is_length(key)) {
        // Accept an int32 or an f64 that is a valid array length (some callers
        // pass 𝔽(len) as a double); other numbers are left for [[Set]] to ignore.
        f64 number = mal_value_is_int32(value)
            ? (f64) mal_value_to_i32(value)
            : (mal_value_is_f64(value) ? mal_value_to_f64(value) : -1.0);
        if (number >= 0 && (f64) (u32) number == number) {
            u32 new_length = (u32) number;
            // This is the array [[Set]] path (arrays don't override [[Set]], so a
            // write delegates here). OrdinarySetWithOwnDescriptor rejects any write
            // to a non-writable data property regardless of whether the new value
            // equals the current one, so `Set(frozenArray, "length", len)` fails and
            // the caller throws (e.g. `Object.freeze([]).push()` must throw).
            if (!array->length_writable) {
                return false;
            }
            mal_array_object_set_length(array, new_length);
            // ArraySetLength returns false when a non-configurable element blocks
            // the shrink (set_length then leaves length at that element + 1).
            return array->length == new_length;
        }
        return true;
    }

    return mal_object_set(&array->object, key, value);
}
