#include "array_object.h"

#include "heap_string.h"
#include "object_ops.h"

void mal_array_object_init(MalHeap *heap, MalArrayObject *array, MalObject *prototype) {
    mal_object_init(heap, &array->object, MAL_HEAP_ARRAY_OBJECT, prototype);
    array->length = 0;
}

MalArrayObject *mal_array_object_new(MalHeap *heap, MalObject *prototype) {
    MalArrayObject *array = mal_heap_alloc(heap, sizeof(MalArrayObject), MAL_HEAP_ARRAY_OBJECT);
    mal_array_object_init(heap, array, prototype);

    return array;
}

u32 mal_array_object_length(const MalArrayObject *array) {
    return array->length;
}

void mal_array_object_set_length(MalArrayObject *array, u32 length) {
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
        if (index >= 0 && (u32) index >= array->length) {
            array->length = (u32) index + 1;
        }

        return mal_object_set(&array->object, key, value);
    }

    if (mal_array_key_is_length(key)) {
        // TODO(arrays): shrinking should also delete the now out-of-range elements.
        if (mal_value_is_int32(value) && mal_value_to_i32(value) >= 0) {
            array->length = (u32) mal_value_to_i32(value);
        }
        return true;
    }

    return mal_object_set(&array->object, key, value);
}
