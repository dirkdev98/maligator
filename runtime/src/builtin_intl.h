#pragma once

#include "value.h"
#include "unicode.h"

typedef struct MalVm MalVm;

/**
 * Entry points an installed Intl component offers to built-ins outside the Intl
 * namespace. Each component fills only the ones it implements.
 */
typedef struct MalIntlServiceOperations {
    /** Free an instance's native handle; returns the external bytes it charged. */
    usize (*release)(void *handle);
    bool (*case_locale)(MalVm *vm, MalValue locales, MalUnicodeLocale *locale);
    MalValue (*locale_compare_range)(MalVm *vm, MalValue source, usize start, usize length, MalValue that, MalValue locales, MalValue options);
    MalValue (*locale_compare_prepared_range)(MalVm *vm, MalValue source, usize start, usize length, MalValue that, const byte *locale, usize locale_length, u8 options);
    MalValue (*locale_compare_prepared_tag)(MalVm *vm, MalValue source, MalValue that, MalString *locale, u8 options);
    MalValue (*number_to_locale_string)(MalVm *vm, f64 number, MalValue locales, MalValue options);
    MalValue (*date_to_locale_string)(MalVm *vm, f64 time_value, MalValue locales, MalValue options, i32 which);
} MalIntlServiceOperations;

/** Install the Intl namespace with its locale floor (Locale, getCanonicalLocales, supportedValuesOf). */
void mal_intl_install_namespace(MalVm *vm);

/** Install one service onto the already installed namespace. */
void mal_intl_install_collator(MalVm *vm);
void mal_intl_install_plural_rules(MalVm *vm);
void mal_intl_install_number_format(MalVm *vm);
void mal_intl_install_date_time_format(MalVm *vm);
void mal_intl_install_list_format(MalVm *vm);
void mal_intl_install_display_names(MalVm *vm);
void mal_intl_install_relative_time_format(MalVm *vm);
void mal_intl_install_segmenter(MalVm *vm);
void mal_intl_install_duration_format(MalVm *vm);

extern const MalIntlServiceOperations mal_intl_namespace_operations;
extern const MalIntlServiceOperations mal_intl_collator_operations;
extern const MalIntlServiceOperations mal_intl_plural_rules_operations;
extern const MalIntlServiceOperations mal_intl_number_format_operations;
extern const MalIntlServiceOperations mal_intl_date_time_format_operations;
extern const MalIntlServiceOperations mal_intl_list_format_operations;
extern const MalIntlServiceOperations mal_intl_relative_time_format_operations;
extern const MalIntlServiceOperations mal_intl_duration_format_operations;

/*
 * The locale-sensitive built-ins outside the namespace. Each uses its Intl service
 * when the current realm installed it, and otherwise the locale-insensitive
 * behaviour ECMA-402 permits for an implementation without that service.
 */

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

MalValue mal_intl_locale_compare_prepared(MalVm *vm, MalValue this_string, MalValue that, const byte *locale, usize locale_length, u8 options);

/** The prepared comparison with its canonical locale tag still a string constant. */
MalValue mal_intl_locale_compare_prepared_tag(MalVm *vm, MalValue this_string, MalValue that, MalString *locale, u8 options);

MalValue mal_intl_locale_compare_range(MalVm *vm, MalValue source, usize start, usize length, MalValue that, MalValue locales, MalValue options);
MalValue mal_intl_locale_compare_prepared_range(MalVm *vm, MalValue source, usize start, usize length, MalValue that, const byte *locale, usize locale_length, u8 options);
