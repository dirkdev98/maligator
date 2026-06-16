#pragma once

#include "./defaults.h"

typedef struct MalVm MalVm;

/**
 * Install the Date constructor, its statics (now/parse/UTC), and
 * Date.prototype on the VM intrinsics + globalThis.
 */
void mal_builtin_date_install(MalVm *vm);

/**
 * Current time in integral milliseconds since the epoch (for Intl.DateTimeFormat
 * format() with no argument).
 */
f64 mal_date_now_ms(void);

/**
 * Decompose a time value (ms since epoch) into LOCAL civil components (month is
 * 1-12) for Intl.DateTimeFormat. Returns false for a non-finite time value.
 */
bool mal_date_to_local_components(f64 time_value, i32 *year, i32 *month, i32 *day, i32 *hour, i32 *minute, i32 *second);
