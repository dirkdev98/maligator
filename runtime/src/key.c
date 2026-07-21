#include "key.h"

#include "heap_string.h"
#include "perf_stats.h"

bool mal_key_value_equals(MalValue left, MalValue right) {
    MAL_PERF_COUNT(key_equals_calls);
    if (left == right) {
        MAL_PERF_COUNT(key_pointer_hits);
        return true;
    }
    if (mal_value_is_string(left) && mal_value_is_string(right)) {
        MAL_PERF_COUNT(key_string_fallbacks);
        return mal_string_equals(mal_value_to_string(left), mal_value_to_string(right));
    }
    MAL_PERF_COUNT(key_non_string_misses);
    return false;
}
