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
    return MAL_VALUE_INT32 | value;
}

i32 mal_value_to_i32(MalValue value) {
    return value & MASK_INT32;
}

bool mal_value_is_int32(MalValue value) {
    auto v = value & MAL_VALUE_INT32;

    return v == MAL_VALUE_INT32;
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
