#include <stdio.h>
#include "value.h"

MalValue mal_value_from_f64(f64 value) {
    return *(MalValue *) &value;
}

MalValue mal_value_from_f64_convert_nan(f64 value) {
    auto mal_value = mal_value_from_f64(value);
    auto v = mal_value & MASK_EXPONENT_BITS;

    if (v == MASK_EXPONENT_BITS) {
        return mal_value_new_nan();
    }

    return mal_value;
}

f64 mal_value_to_f64(MalValue value) {
    return *(f64 *) &value;
}

bool mal_value_is_f64(MalValue value) {
    return (value & MASK_EXPONENT_BITS) != MASK_EXPONENT_BITS;
}

bool mal_value_is_f64_or_nan(MalValue value) {
    return mal_value_is_nan(value) || mal_value_is_f64(value);
}

MalValue mal_value_new_nan() {
    return MAL_VALUE_NAN;
}

bool mal_value_is_nan(MalValue value) {
    return value == MAL_VALUE_NAN;
}

MalValue mal_value_new_null() {
    return MAL_VALUE_NULL;
}

bool mal_value_is_null(MalValue value) {
    return value == MAL_VALUE_NULL;
}

MalValue mal_value_new_undefined() {
    return MAL_VALUE_UNDEFINED;
}

bool mal_value_is_undefined(MalValue value) {
    return value == MAL_VALUE_UNDEFINED;
}

bool mal_value_is_nil(MalValue value) {
    return mal_value_is_null(value) || mal_value_is_undefined(value);
}

MalValue mal_value_new_boolean(bool value) {
    if (value) {
        return MAL_VALUE_TRUE;
    } else {
        return MAL_VALUE_FALSE;
    }
}

bool mal_value_is_boolean(MalValue value) {
    return value == MAL_VALUE_TRUE || value == MAL_VALUE_FALSE;
}

bool mal_value_to_boolean(MalValue value) {
    return value == MAL_VALUE_TRUE;
}

MalValue mal_value_from_i32(i32 value) {
    return MAL_VALUE_INT32 | (u32) value;
}

i32 mal_value_to_i32(MalValue value) {
    return value & MASK_INT32;
}

bool mal_value_is_int32(MalValue value) {
    auto v = value & MAL_VALUE_INT32;

    return v == MAL_VALUE_INT32;
}

MalValue mal_value_from_heap(MalHeapHeader *heap) {
    return MAL_VALUE_PTR | ((uptr) heap & MAKS_PTR);
}

bool mal_value_is_heap(MalValue value) {
    auto v = value & MAL_VALUE_PTR;

    return v == MAL_VALUE_PTR;
}

MalHeapHeader *mal_value_to_heap(MalValue value) {
    return (MalHeapHeader *) (uptr) (value & MAKS_PTR);
}

const MalHeapHeader *mal_value_to_heap_const(MalValue value) {
    return (const MalHeapHeader *) (uptr) (value & MAKS_PTR);
}

MalHeapType mal_value_heap_type(MalValue value) {
    return mal_value_to_heap_const(value)->type;
}

bool mal_value_is_heap_type(MalValue value, MalHeapType type) {
    if (!mal_value_is_heap(value)) {
        return false;
    }

    return mal_value_heap_type(value) == type;
}

bool mal_value_is_string(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_STRING);
}

bool mal_value_is_symbol(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_SYMBOL);
}

bool mal_value_is_object(MalValue value) {
    if (!mal_value_is_heap(value)) {
        return false;
    }

    auto type = mal_value_heap_type(value);

    return type == MAL_HEAP_OBJECT ||
        type == MAL_HEAP_FUNCTION_OBJECT ||
        type == MAL_HEAP_NATIVE_FUNCTION_OBJECT ||
        type == MAL_HEAP_ARRAY_OBJECT;
}

bool mal_value_is_function_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_FUNCTION_OBJECT);
}

bool mal_value_is_native_function_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_NATIVE_FUNCTION_OBJECT);
}

bool mal_value_is_array_object(MalValue value) {
    return mal_value_is_heap_type(value, MAL_HEAP_ARRAY_OBJECT);
}

bool mal_value_is_callable(MalValue value) {
    return mal_value_is_function_object(value) || mal_value_is_native_function_object(value);
}

MalString *mal_value_to_string(MalValue value) {
    return (MalString *) mal_value_to_heap(value);
}

MalSymbol *mal_value_to_symbol(MalValue value) {
    return (MalSymbol *) mal_value_to_heap(value);
}

MalObject *mal_value_to_object(MalValue value) {
    return (MalObject *) mal_value_to_heap(value);
}

MalFunctionObject *mal_value_to_function_object(MalValue value) {
    return (MalFunctionObject *) mal_value_to_heap(value);
}

MalNativeFunctionObject *mal_value_to_native_function_object(MalValue value) {
    return (MalNativeFunctionObject *) mal_value_to_heap(value);
}

MalArrayObject *mal_value_to_array_object(MalValue value) {
    return (MalArrayObject *) mal_value_to_heap(value);
}

MalValue mal_value_from_string(MalString *string) {
    return mal_value_from_heap((MalHeapHeader *) string);
}

MalValue mal_value_from_symbol(MalSymbol *symbol) {
    return mal_value_from_heap((MalHeapHeader *) symbol);
}

MalValue mal_value_from_object(MalObject *object) {
    return mal_value_from_heap((MalHeapHeader *) object);
}

MalValue mal_value_from_function_object(MalFunctionObject *function) {
    return mal_value_from_heap((MalHeapHeader *) function);
}

MalValue mal_value_from_native_function_object(MalNativeFunctionObject *function) {
    return mal_value_from_heap((MalHeapHeader *) function);
}

MalValue mal_value_from_array_object(MalArrayObject *array) {
    return mal_value_from_heap((MalHeapHeader *) array);
}

bool mal_value_is_truthy(MalValue value) {
    if (mal_value_is_nil(value)) {
        return false;
    }

    if (mal_value_is_boolean(value)) {
        return mal_value_to_boolean(value);
    }

    if (mal_value_is_nan(value)) {
        return false;
    }

    if (mal_value_is_f64(value)) {
        return mal_value_to_f64(value) != 0;
    }

    if (mal_value_is_int32(value)) {
        return mal_value_to_i32(value) != 0;
    }

    // TODO: Empty string

    // TODO: Might need to check `valueOf` & BooleanData fields.

    // Any object is truthy.
    return true;
}

void mal_value_debug(MalValue value) {
    if (mal_value_is_nan(value)) {
        printf("NaN");
        return;
    }

    if (mal_value_is_f64(value)) {
        printf("%f", mal_value_to_f64(value));
        return;
    }

    if (mal_value_is_boolean(value)) {
        auto b = mal_value_to_boolean(value);
        printf("%s", b ? "true" : "false");

        return;
    }

    if (mal_value_is_undefined(value)) {
        printf("undefined");
        return;
    }

    if (mal_value_is_null(value)) {
        printf("null");
        return;
    }

    if (mal_value_is_int32(value)) {
        printf("%d", mal_value_to_i32(value));
        return;
    }

    printf("[unknown]");
}
