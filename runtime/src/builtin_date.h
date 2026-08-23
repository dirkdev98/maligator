#pragma once

#include "./defaults.h"
#include "intrinsics.h"

typedef struct MalVm MalVm;

/**
 * Install the Date constructor, its statics (now/parse/UTC), and
 * Date.prototype on the VM intrinsics + globalThis.
 */
void mal_builtin_date_install(MalVm *vm);

/** Exact locked Date statics after intrinsic-receiver proof. Coercive callers
 * keep every argument value rooted for the duration of parse/UTC. */
MalValue mal_builtin_date_now_known(void);
MalValue mal_builtin_date_parse_known(MalVm *vm, const MalValue *args, i32 arg_count);
MalValue mal_builtin_date_utc_known(MalVm *vm, const MalValue *args, i32 arg_count);

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

/** Fixed locale-insensitive formatter used when Intl.DateTimeFormat is absent. */
MalValue mal_date_fallback_locale_string(MalVm *vm, f64 time_value, i32 which);
