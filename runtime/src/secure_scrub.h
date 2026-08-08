#pragma once

#include "./defaults.h"

/**
 * Overwrite secret-bearing storage before it is released or reused.
 *
 * Lives in its own translation unit, and writes through a volatile cursor, so
 * neither the optimizer nor LTO can drop the stores as dead on the last use of
 * a buffer. Null-safe; `length` is the full allocated capacity, not the
 * currently exposed length.
 */
void mal_secure_scrub(void *bytes, usize length);
