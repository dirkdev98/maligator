#include "checked_size.h"

bool mal_checked_size_growth(
    usize current, usize required, usize initial, usize limit, usize *out
) {
    if (required > limit || current > limit || initial > limit) {
        return false;
    }
    usize capacity = current == 0 ? initial : current;
    if (capacity == 0 && required != 0) {
        return false;
    }
    while (capacity < required) {
        if (capacity > limit / 2) {
            capacity = limit;
        } else {
            capacity *= 2;
        }
    }
    *out = capacity;
    return true;
}
