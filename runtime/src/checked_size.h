#pragma once

#include "./defaults.h"

/** Checked size arithmetic bounded by an explicit caller-provided limit. */
static inline bool mal_checked_size_add(usize left, usize right, usize limit, usize *out) {
    if (left > limit || right > limit - left) {
        return false;
    }
    *out = left + right;
    return true;
}

static inline bool mal_checked_size_multiply(usize left, usize right, usize limit, usize *out) {
    if (left != 0 && right > limit / left) {
        return false;
    }
    *out = left * right;
    return true;
}

bool mal_checked_size_growth(
    usize current, usize required, usize initial, usize limit, usize *out);
