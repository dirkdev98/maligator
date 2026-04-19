#include "value.h"
#include "value_ops.h"

MalValue mal_ops_add(MalValue left, MalValue right) {
    if (mal_value_is_int32(left) && mal_value_is_int32(right)) {
        return mal_value_from_i32(mal_value_to_i32(left) + mal_value_to_i32(right));
    }

    return mal_value_new_undefined();
}

MalValue mal_ops_multiply(MalValue left, MalValue right) {
    if (mal_value_is_int32(left) && mal_value_is_int32(right)) {
        return mal_value_from_i32(mal_value_to_i32(left) * mal_value_to_i32(right));
    }

    return mal_value_new_undefined();
}
