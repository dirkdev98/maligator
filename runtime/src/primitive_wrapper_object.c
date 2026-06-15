#include "./primitive_wrapper_object.h"

#include "array_object.h"
#include "heap_string.h"

MalPrimitiveWrapperObject *mal_primitive_wrapper_object_new(
    MalHeap *heap,
    MalObject *prototype,
    MalPrimitiveWrapperKind kind,
    MalValue primitive_data
) {
    MalPrimitiveWrapperObject *wrapper = mal_heap_alloc(
        heap,
        sizeof(MalPrimitiveWrapperObject),
        MAL_HEAP_PRIMITIVE_WRAPPER_OBJECT
    );
    mal_object_init(heap, &wrapper->object, MAL_HEAP_PRIMITIVE_WRAPPER_OBJECT, prototype);
    wrapper->kind = kind;
    wrapper->primitive_data = primitive_data;

    return wrapper;
}

bool mal_primitive_wrapper_string_exotic_own(
    MalHeap *heap,
    MalObject *object,
    MalKey key,
    MalPropertyDesc *desc_out
) {
    if (object->header.type != MAL_HEAP_PRIMITIVE_WRAPPER_OBJECT) {
        return false;
    }
    MalPrimitiveWrapperObject *wrapper = (MalPrimitiveWrapperObject *) object;
    if (wrapper->kind != MAL_PRIMITIVE_WRAPPER_STRING) {
        return false;
    }

    MalString *data = mal_value_to_string(wrapper->primitive_data);

    // The own `length` is non-writable, non-enumerable, non-configurable.
    if (mal_array_key_is_length(key)) {
        *desc_out = (MalPropertyDesc) {
            .flags = MAL_PROPERTY_NONE,
            .value = mal_value_from_i32((i32) mal_string_length(data)),
            .getter = mal_value_new_undefined(),
            .setter = mal_value_new_undefined(),
        };
        return true;
    }

    // An in-bounds integer index is a non-writable, enumerable, non-configurable
    // single-code-unit data property. The borrowed code unit stays alive with
    // the wrapper's [[StringData]] string.
    if (key.kind == MAL_KEY_INDEX) {
        i32 index = mal_value_to_i32(key.value);
        if (index >= 0 && (usize) index < mal_string_length(data)) {
            *desc_out = (MalPropertyDesc) {
                .flags = MAL_PROPERTY_ENUMERABLE,
                .value = mal_value_from_string(
                    mal_string_new_external(heap, mal_string_code_units(data) + index, 1)
                ),
                .getter = mal_value_new_undefined(),
                .setter = mal_value_new_undefined(),
            };
            return true;
        }
    }

    return false;
}
