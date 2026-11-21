#include "builtin_intl.h"

#include <stdlib.h>

#include "builtin_date.h"
#include "gc.h"
#include "heap_string.h"
#include "intrinsics.h"
#include "language_components.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

// Locale-insensitive fallbacks, permitted by ECMA-402 for an implementation
// without the backing service. These entry points stay out of line: with link-time
// optimization their callers would otherwise each carry both paths.

// localeCompare → UTF-16 code-unit ordering. `this_string` is already a String
// (the caller coerced it); ToString `that_value` (may throw on a Symbol).
static __attribute__((noinline)) MalValue intl_fallback_locale_compare(MalVm *vm, MalValue this_string, usize start, usize length, MalValue that_value) {
    MalValue roots[2] = {this_string, that_value};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);

    MalString *b = nullptr;
    if (!mal_vm_to_string(vm, roots[1], &b)) {
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    roots[1] = mal_value_from_string(b);
    (void) mal_string_code_units(mal_value_to_string(roots[1]));
    c16 stack[MAL_STRING_UTF16_SCRATCH_UNITS];
    c16 *scratch;
    const c16 *ua = mal_string_range_utf16(mal_value_to_string(roots[0]), start, length, stack, &scratch);
    b = mal_value_to_string(roots[1]);
    usize la = length;
    usize lb = mal_string_length(b);
    const c16 *ub = mal_string_code_units(b);
    usize n = la < lb ? la : lb;
    i32 comparison = la == lb ? 0 : (la < lb ? -1 : 1);
    for (usize i = 0; i < n; i++) {
        if (ua[i] != ub[i]) {
            comparison = ua[i] < ub[i] ? -1 : 1;
            break;
        }
    }
    free(scratch);
    mal_gc_unroot(&root_span);
    return mal_value_from_i32(comparison);
}

// Number.toLocaleString → base-10 Number::toString.
static MalValue intl_fallback_number_to_locale_string(MalVm *vm, f64 number) {
    return mal_value_from_string(mal_ops_to_string(&vm->heap, mal_ops_number_value(number)));
}

// Date.toLocale{,Date,Time}String → fixed non-localized civil-time render (which:
// 0 date+time, 1 date, 2 time). Non-finite time → "Invalid Date" (as toString does).
static MalValue intl_fallback_date_to_locale_string(MalVm *vm, f64 time_value, i32 which) {
    return mal_date_fallback_locale_string(vm, time_value, which);
}

/** The service operations when the current realm installed the service, else null. */
static const MalIntlServiceOperations *intl_installed_service(
    MalVm *vm, MalIntrinsic installed, MalLanguageComponentId component) {
    if (mal_value_is_undefined(vm->intrinsics[installed])) return nullptr;
    return mal_language_component_operations(component);
}

__attribute__((noinline)) bool mal_intl_case_locale(MalVm *vm, MalValue locales, MalUnicodeLocale *locale) {
    const MalIntlServiceOperations *intl = intl_installed_service(
        vm, MAL_INTRINSIC_INTL, MAL_LANGUAGE_COMPONENT_INTL);
    if (intl == nullptr) {
        *locale = MAL_UNICODE_LOCALE_ROOT;
        return true;
    }
    return intl->case_locale(vm, locales, locale);
}

__attribute__((noinline)) MalValue mal_intl_locale_compare_range(MalVm *vm, MalValue this_string, usize start, usize length, MalValue that_value, MalValue locales, MalValue options) {
    const MalIntlServiceOperations *collator = intl_installed_service(
        vm, MAL_INTRINSIC_INTL_COLLATOR_CONSTRUCTOR, MAL_LANGUAGE_COMPONENT_INTL_COLLATOR);
    if (collator == nullptr) return intl_fallback_locale_compare(vm, this_string, start, length, that_value);
    return collator->locale_compare_range(vm, this_string, start, length, that_value, locales, options);
}

__attribute__((noinline)) MalValue mal_intl_locale_compare_prepared_range(MalVm *vm, MalValue this_string, usize start, usize length, MalValue that, const byte *locale, usize locale_length, u8 options) {
    const MalIntlServiceOperations *collator = intl_installed_service(
        vm, MAL_INTRINSIC_INTL_COLLATOR_CONSTRUCTOR, MAL_LANGUAGE_COMPONENT_INTL_COLLATOR);
    if (collator == nullptr) return intl_fallback_locale_compare(vm, this_string, start, length, that);
    return collator->locale_compare_prepared_range(vm, this_string, start, length, that, locale, locale_length, options);
}

__attribute__((noinline)) MalValue mal_intl_locale_compare_prepared_tag(MalVm *vm, MalValue this_string, MalValue that, MalString *locale, u8 options) {
    const MalIntlServiceOperations *collator = intl_installed_service(
        vm, MAL_INTRINSIC_INTL_COLLATOR_CONSTRUCTOR, MAL_LANGUAGE_COMPONENT_INTL_COLLATOR);
    if (collator == nullptr) return intl_fallback_locale_compare(vm, this_string, 0, mal_string_length(mal_value_to_string(this_string)), that);
    return collator->locale_compare_prepared_tag(vm, this_string, that, locale, options);
}

MalValue mal_intl_locale_compare(MalVm *vm, MalValue this_string, MalValue that, MalValue locales, MalValue options) {
    return mal_intl_locale_compare_range(vm, this_string, 0, mal_string_length(mal_value_to_string(this_string)), that, locales, options);
}

MalValue mal_intl_locale_compare_prepared(MalVm *vm, MalValue this_string, MalValue that, const byte *locale, usize locale_length, u8 options) {
    return mal_intl_locale_compare_prepared_range(vm, this_string, 0, mal_string_length(mal_value_to_string(this_string)), that, locale, locale_length, options);
}

__attribute__((noinline)) MalValue mal_intl_number_to_locale_string(MalVm *vm, f64 number, MalValue locales, MalValue options) {
    const MalIntlServiceOperations *number_format = intl_installed_service(
        vm, MAL_INTRINSIC_INTL_NUMBER_FORMAT_CONSTRUCTOR, MAL_LANGUAGE_COMPONENT_INTL_NUMBER_FORMAT);
    if (number_format == nullptr) return intl_fallback_number_to_locale_string(vm, number);
    return number_format->number_to_locale_string(vm, number, locales, options);
}

__attribute__((noinline)) MalValue mal_intl_date_to_locale_string(MalVm *vm, f64 time_value, MalValue locales, MalValue options, i32 which) {
    const MalIntlServiceOperations *date_time_format = intl_installed_service(
        vm, MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_CONSTRUCTOR, MAL_LANGUAGE_COMPONENT_INTL_DATE_TIME_FORMAT);
    if (date_time_format == nullptr) return intl_fallback_date_to_locale_string(vm, time_value, which);
    return date_time_format->date_to_locale_string(vm, time_value, locales, options, which);
}
