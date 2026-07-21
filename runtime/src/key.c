#include "key.h"

#include "heap_string.h"

bool mal_key_value_equals(MalValue left, MalValue right) {
    if (left == right) {
        return true;
    }
    if (mal_value_is_string(left) && mal_value_is_string(right)) {
        return mal_string_equals(mal_value_to_string(left), mal_value_to_string(right));
    }
    return false;
}
