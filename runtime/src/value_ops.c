#include "value.h"
#include "value_ops.h"

void mal_ops_add(MalValue left, MalValue right) {
    if (mal_value_is_int32(left) && mal_value_is_int32(right)) {
        MalValue value = mal_value_from_i32(mal_value_to_i32(left) + mal_value_to_i32(right));
    }
}
