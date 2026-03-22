#include "value.h"
#include "value_ops.h"

void mal_ops_add(MalThread *thread, MalEnv *env, MalValue *out, MalValue left, MalValue right) {
    if (mal_value_is_int32(left) && mal_value_is_int32(right)) {
        *out = mal_value_from_i32(mal_value_to_i32(left) + mal_value_to_i32(right));

        MAL_RESULT_RETURN(MAL_NORMAL);
    }

    MAL_RESULT_RETURN(MAL_THROW);
}
