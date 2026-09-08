#pragma once

#include "value.h"
#include "unicode.h"

typedef struct MalVm MalVm;

/**
 * Install the Intl namespace object and its service constructors/prototypes on
 * the VM intrinsics + globalThis.
 */
void mal_builtin_intl_install(MalVm *vm);

/**
 * String.prototype.localeCompare's collation: compares `this_string` against
 * `that_value` with a Collator built from (locales, options). Returns a Number
 * (-1/0/1), or undefined with a pending throw.
 */
MalValue mal_intl_locale_compare(MalVm *vm, MalValue this_string, MalValue that_value, MalValue locales, MalValue options);

/**
 * Number.prototype.toLocaleString: format `number` with a transient
 * Intl.NumberFormat built from (locales, options). Returns a String, or
 * undefined with a pending throw.
 */
MalValue mal_intl_number_to_locale_string(MalVm *vm, f64 number, MalValue locales, MalValue options);

/**
 * Date.prototype.toLocale{,Date,Time}String: format `time_value` with a
 * transient Intl.DateTimeFormat from (locales, options). `which`: 0 both date +
 * time, 1 date only, 2 time only (the default styles when options omit them).
 */
MalValue mal_intl_date_to_locale_string(MalVm *vm, f64 time_value, MalValue locales, MalValue options, i32 which);

// Canonicalize the entire locale list before selecting the first requested case mapping.
bool mal_intl_case_locale(MalVm *vm, MalValue locales, MalUnicodeLocale *locale);
