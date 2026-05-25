#include "value.h"
#include "value_ops.h"

#include <math.h>

static bool mal_ops_is_number(MalValue value) {
    return mal_value_is_int32(value) || mal_value_is_f64_or_nan(value);
}

static f64 mal_ops_to_f64(MalValue value) {
    if (mal_value_is_int32(value)) {
        return mal_value_to_i32(value);
    }

    return mal_value_to_f64(value);
}

static i32 mal_ops_to_i32(MalValue value) {
    if (mal_value_is_int32(value)) {
        return mal_value_to_i32(value);
    }

    return (i32) mal_ops_to_f64(value);
}

static MalValue mal_ops_from_f64_or_i32(f64 value) {
    if (isnan(value)) {
        return mal_value_new_nan();
    }

    if (value >= INT32_MIN && value <= INT32_MAX && trunc(value) == value) {
        return mal_value_from_i32((i32) value);
    }

    return mal_value_from_f64(value);
}

MalValue mal_ops_add(MalValue left, MalValue right) {
    if (mal_value_is_int32(left) && mal_value_is_int32(right)) {
        return mal_value_from_i32(mal_value_to_i32(left) + mal_value_to_i32(right));
    }

    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        return mal_ops_from_f64_or_i32(mal_ops_to_f64(left) + mal_ops_to_f64(right));
    }

    return mal_value_new_undefined();
}

MalValue mal_ops_subtract(MalValue left, MalValue right) {
    if (mal_value_is_int32(left) && mal_value_is_int32(right)) {
        return mal_value_from_i32(mal_value_to_i32(left) - mal_value_to_i32(right));
    }

    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        return mal_ops_from_f64_or_i32(mal_ops_to_f64(left) - mal_ops_to_f64(right));
    }

    return mal_value_new_undefined();
}

MalValue mal_ops_multiply(MalValue left, MalValue right) {
    if (mal_value_is_int32(left) && mal_value_is_int32(right)) {
        return mal_value_from_i32(mal_value_to_i32(left) * mal_value_to_i32(right));
    }

    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        return mal_ops_from_f64_or_i32(mal_ops_to_f64(left) * mal_ops_to_f64(right));
    }

    return mal_value_new_undefined();
}

MalValue mal_ops_divide(MalValue left, MalValue right) {
    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        return mal_ops_from_f64_or_i32(mal_ops_to_f64(left) / mal_ops_to_f64(right));
    }

    return mal_value_new_undefined();
}

MalValue mal_ops_remainder(MalValue left, MalValue right) {
    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        return mal_ops_from_f64_or_i32(fmod(mal_ops_to_f64(left), mal_ops_to_f64(right)));
    }

    return mal_value_new_undefined();
}

MalValue mal_ops_bit_and(MalValue left, MalValue right) {
    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        return mal_value_from_i32(mal_ops_to_i32(left) & mal_ops_to_i32(right));
    }

    return mal_value_new_undefined();
}

MalValue mal_ops_bit_or(MalValue left, MalValue right) {
    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        return mal_value_from_i32(mal_ops_to_i32(left) | mal_ops_to_i32(right));
    }

    return mal_value_new_undefined();
}

MalValue mal_ops_bit_xor(MalValue left, MalValue right) {
    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        return mal_value_from_i32(mal_ops_to_i32(left) ^ mal_ops_to_i32(right));
    }

    return mal_value_new_undefined();
}

MalValue mal_ops_shift_left(MalValue left, MalValue right) {
    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        return mal_value_from_i32(mal_ops_to_i32(left) << (mal_ops_to_i32(right) & 0x1F));
    }

    return mal_value_new_undefined();
}

MalValue mal_ops_shift_right(MalValue left, MalValue right) {
    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        return mal_value_from_i32(mal_ops_to_i32(left) >> (mal_ops_to_i32(right) & 0x1F));
    }

    return mal_value_new_undefined();
}

MalValue mal_ops_shift_right_unsigned(MalValue left, MalValue right) {
    if (mal_ops_is_number(left) && mal_ops_is_number(right)) {
        u32 result = (u32) mal_ops_to_i32(left) >> (mal_ops_to_i32(right) & 0x1F);

        if ((result & (u32) MASK_UINT32_SIGN) == 0) {
            return mal_value_from_i32((i32) result);
        }

        return mal_value_from_f64(result);
    }

    return mal_value_new_undefined();
}
