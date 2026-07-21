#pragma once

#include "./defaults.h"

/** Checked size arithmetic bounded by an explicit caller-provided limit. */
bool mal_checked_size_add(usize left, usize right, usize limit, usize *out);

bool mal_checked_size_multiply(usize left, usize right, usize limit, usize *out);

bool mal_checked_size_growth(
    usize current, usize required, usize initial, usize limit, usize *out);
