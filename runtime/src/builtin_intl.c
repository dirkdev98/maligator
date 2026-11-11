#include "builtin_intl.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "ascii.h"
#include "array_object.h"
#include "builtin_date.h"
#include "builtin_iterator.h"
#include "builtin_object.h"
#include "checked_size.h"
#include "ecma_whitespace.h"
#include "heap_bigint.h"
#include "mal_number_format.h"
#include "number_text.h"
#include "gc.h"
#include "heap_string.h"
#include "intl_object.h"
#include "intrinsics.h"
#include "mal_i18n.h"
#if MAL_TEMPORAL && MAL_INTL_HAS_DURATION_FORMAT
#include "temporal_object.h"
#include "temporal_rs/Duration.h"
#endif
#include "shape.h"
#include "value_ops.h"
#include "utf16.h"
#include "vm.h"
#include "vm_ops.h"

// Locale-insensitive fallbacks for the non-namespace locale-sensitive methods
// (String.localeCompare / Number.toLocaleString / Date.toLocale*String), used when
// the backing Intl service is absent — either the whole Intl surface is off
// (MAL_INTL=0) or just that service (engine.intl.features drops it). ECMA-402
// permits this for an Intl-less implementation. Defined only when the service is
// off (`#if !MAL_INTL_<SERVICE>`), so there is no unused-function warning when it is
// on; consumed by both the in-namespace dispatch and the MAL_INTL=0 stubs below.

#if !MAL_INTL_HAS_COLLATOR
// localeCompare → UTF-16 code-unit ordering. `this_string` is already a String
// (the caller coerced it); ToString `that_value` (may throw on a Symbol).
static MalValue intl_fallback_locale_compare(MalVm *vm, MalValue this_string, usize start, usize length, MalValue that_value) {
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
#endif

#if !MAL_INTL_HAS_NUMBER_FORMAT
// Number.toLocaleString → base-10 Number::toString.
static MalValue intl_fallback_number_to_locale_string(MalVm *vm, f64 number) {
    return mal_value_from_string(mal_ops_to_string(&vm->heap, mal_ops_number_value(number)));
}
#endif

#if !MAL_INTL_HAS_DATE_TIME_FORMAT
// Date.toLocale{,Date,Time}String → fixed non-localized civil-time render (which:
// 0 date+time, 1 date, 2 time). Non-finite time → "Invalid Date" (as toString does).
static MalValue intl_fallback_date_to_locale_string(MalVm *vm, f64 time_value, i32 which) {
    return mal_date_fallback_locale_string(vm, time_value, which);
}
#endif

#if MAL_INTL

/*
 * Intl (ECMA-402). The JS-spec glue — option-bag parsing, coercions, locale
 * negotiation, the result-shaping abstract operations — lives here in C; the
 * mal_i18n shim exposes only flat ICU4X primitives. Each service instance is a
 * MalIntlObject carrying an (optional) Rust-owned ICU4X handle + per-kind data.
 */

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Copy a (must-be-ASCII) MalString into a NUL-terminated byte buffer. */
static bool intl_tag_utf8(const MalString *s, byte *buf, usize cap, usize *out_len) {
    usize n = mal_string_length(s);
    if (n + 1 > cap) {
        return false;
    }
    const c16 *units = mal_string_code_units(s);
    for (usize i = 0; i < n; i++) {
        if (units[i] > 0x7F) {
            return false;
        }
        buf[i] = (byte) units[i];
    }
    buf[n] = '\0';
    *out_len = n;
    return true;
}

static bool intl_string_eq_ascii(const MalString *s, const char *ascii) {
    return mal_string_equals_ascii(s, ascii);
}

/** Decode a UTF-8 byte buffer (ICU4X formatter output) into a JS UTF-16 string. */
static MalValue intl_string_from_utf8(MalVm *vm, const byte *raw, usize len) {
    // `byte` is signed char: read each octet unsigned so the lead-byte
    // classification (b < 0x80 / b & 0xE0 / ...) is correct for >= 0x80 bytes.
    // A malformed octet can expand to a surrogate pair, so the buffer is sized
    // for the 2-units-per-byte worst case.
    const unsigned char *bytes = (const unsigned char *) raw;
    usize ascii_len = 0;
    while (ascii_len < len && bytes[ascii_len] < 0x80) {
        ascii_len++;
    }
    if (ascii_len == len) {
        return mal_value_from_string(mal_string_new_ascii(&vm->heap, raw, len));
    }
    c16 stack_units[256];
    usize capacity = 2 * len + 1;
    bool heap_allocated = capacity > countof(stack_units);
    c16 *units = heap_allocated
        ? malloc(sizeof(c16) * capacity)
        : stack_units;
    if (units == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    usize n = 0;
    usize i = 0;
    while (i < len) {
        unsigned char b = bytes[i];
        u32 cp;
        if (b < 0x80) {
            cp = b;
            i += 1;
        } else if ((b & 0xE0) == 0xC0 && i + 1 < len) {
            cp = ((u32) (b & 0x1F) << 6) | (u32) (bytes[i + 1] & 0x3F);
            i += 2;
        } else if ((b & 0xF0) == 0xE0 && i + 2 < len) {
            cp = ((u32) (b & 0x0F) << 12) | ((u32) (bytes[i + 1] & 0x3F) << 6) | (u32) (bytes[i + 2] & 0x3F);
            i += 3;
        } else if ((b & 0xF8) == 0xF0 && i + 3 < len) {
            cp = ((u32) (b & 0x07) << 18) | ((u32) (bytes[i + 1] & 0x3F) << 12) | ((u32) (bytes[i + 2] & 0x3F) << 6) | (u32) (bytes[i + 3] & 0x3F);
            i += 4;
        } else {
            cp = 0xFFFD;
            i += 1;
        }
        if (cp <= 0xFFFF) {
            units[n++] = (c16) cp;
        } else {
            mal_utf16_emit_pair(cp, units + n);
            n += 2;
        }
    }
    MalValue result = mal_value_from_string(mal_string_new_copy(&vm->heap, units, n));
    if (heap_allocated) {
        free(units);
    }
    return result;
}

typedef i32 (*IntlLocaleFn)(const uint8_t *, size_t, uint8_t *, int32_t);

/**
 * Call a (tag -> string) shim function with probe-then-fill. Returns the result
 * MalString, or null with *invalid set when the shim reports -1 (invalid tag).
 */
static MalString *intl_call_locale_fn(MalVm *vm, IntlLocaleFn fn, const MalString *tag, bool *invalid) {
    byte in[320];
    usize in_len;
    *invalid = false;
    if (!intl_tag_utf8(tag, in, sizeof(in), &in_len)) {
        *invalid = true;
        return nullptr;
    }
    byte out[320];
    i32 n = fn(in, in_len, out, (i32) sizeof(out));
    if (n < 0) {
        *invalid = true;
        return nullptr;
    }
    if (n <= (i32) sizeof(out)) {
        return mal_string_new_ascii(&vm->heap, out, (usize) n);
    }
    byte *big = malloc((usize) n);
    fn(in, in_len, big, n);
    MalString *result = mal_string_new_ascii(&vm->heap, big, (usize) n);
    free(big);
    return result;
}

/** Preserve the first-day keyword's absent state separately from an empty value. */
static MalString *intl_locale_field_string(MalVm *vm, const MalString *tag, i32 field) {
    byte in[320];
    usize in_len;
    if (!intl_tag_utf8(tag, in, sizeof(in), &in_len)) {
        return mal_string_new_ascii(&vm->heap, (const byte *) "", 0);
    }
    byte out[160];
    i32 n = mal_i18n_locale_field(in, in_len, field, out, (i32) sizeof(out));
    if (n == MAL_LOCALE_FIELD_ABSENT) return nullptr;
    if (n < 0) {
        return mal_string_new_ascii(&vm->heap, (const byte *) "", 0);
    }
    return mal_string_new_ascii(&vm->heap, out, (usize) (n <= (i32) sizeof(out) ? n : (i32) sizeof(out)));
}

/** Define an enumerable index element on a result array and bump its length. */
static void intl_array_push(MalVm *vm, MalArrayObject *array, u32 index, MalValue value) {
    (void) vm;
    if (mal_array_object_dense_store(array, index, value) ==
        MAL_ARRAY_DENSE_APPLIED) {
        if (index >= mal_array_object_length(array)) {
            array->length = index + 1;
        }
        return;
    }
    (void) mal_array_object_store(array, mal_key_index(index), value);
}

/** Set a configurable, non-writable @@toStringTag on an object. */
static void intl_set_to_string_tag(MalVm *vm, MalObject *object, const char *tag) {
    MalPropertyDesc desc = mal_intrinsic_data_desc(
        mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) tag)), MAL_PROPERTY_CONFIGURABLE
    );
    mal_object_define_own(object, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_TO_STRING_TAG), &desc);
}

/** Define a configurable accessor `get <name>` on a prototype. */
static void intl_define_getter(MalVm *vm, MalObject *prototype, const char *name, MalNativeFunctionCallback callback) {
    byte display[64];
    snprintf((char *) display, sizeof(display), "get %s", name);
    mal_intrinsic_define_getter(
        vm, prototype, (const byte *) name, display, callback,
        MAL_PROPERTY_CONFIGURABLE);
}

static bool intl_this(MalVm *vm, MalValue this_value, MalIntlKind kind, MalIntlObject **out, const char *what) {
    if (!mal_value_is_intl_object(this_value) || mal_value_to_intl_object(this_value)->kind != kind) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, what);
        return false;
    }
    *out = mal_value_to_intl_object(this_value);
    return true;
}

/** Resolve a prototype from new_target (OrdinaryCreateFromConstructor flavored). */
static MalObject *intl_resolve_prototype(MalVm *vm, MalValue new_target, MalIntrinsic fallback) {
    // Called as a function (or internally, e.g. from localeCompare): use the
    // service's own prototype rather than reading new_target.prototype.
    if (mal_value_is_undefined(new_target)) {
        return mal_value_to_object(vm->intrinsics[fallback]);
    }
    MalObject *prototype;
    return mal_vm_get_prototype_from_constructor(vm, new_target, fallback, &prototype) ? prototype : nullptr;
}

// ---------------------------------------------------------------------------
// CanonicalizeLocaleList + Intl.getCanonicalLocales
// ---------------------------------------------------------------------------

/** Canonicalize one tag (a MalString); returns null + throws RangeError if invalid. */
static MalString *intl_canonicalize(MalVm *vm, const MalString *tag) {
    bool invalid;
    MalString *result = intl_call_locale_fn(vm, mal_i18n_canonicalize_locale, tag, &invalid);
    if (invalid) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Incorrect locale information provided");
        return nullptr;
    }
    return result;
}

static bool intl_array_contains(MalVm *vm, MalArrayObject *array, u32 count, const MalString *needle) {
    (void) vm;
    for (u32 i = 0; i < count; i++) {
        MalValue existing;
        if (mal_array_object_dense_get(array, i, &existing) &&
            mal_value_is_string(existing) &&
            mal_string_equals(mal_value_to_string(existing), needle)) {
            return true;
        }
    }
    return false;
}

static MalArrayObject *intl_canonicalize_locale_list(MalVm *vm, MalValue locales) {
    if (mal_value_is_null(locales)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "locale list cannot be null");
        return nullptr;
    }
    MalValue roots[4] = {locales, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED, MAL_VALUE_UNDEFINED};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, countof(roots));
    roots[1] = mal_value_from_array_object(mal_intrinsic_new_array(vm, 0));
    u32 count = 0;
    if (mal_value_is_undefined(roots[0])) goto done;
    if (mal_value_is_string(roots[0]) ||
        (mal_value_is_intl_object(roots[0]) && mal_value_to_intl_object(roots[0])->kind == MAL_INTL_LOCALE)) {
        MalString *tag = mal_value_is_string(roots[0]) ? mal_value_to_string(roots[0]) : mal_value_to_string(mal_value_to_intl_object(roots[0])->data);
        MalString *canonical = intl_canonicalize(vm, tag);
        if (canonical == nullptr) goto failed;
        roots[2] = mal_value_from_string(canonical);
        intl_array_push(vm, mal_value_to_array_object(roots[1]), 0, roots[2]);
        goto done;
    }
    // ToObject: a primitive list reads its length and elements through its wrapper.
    if (!mal_value_is_object(roots[0])) roots[0] = mal_builtin_object_box_primitive(vm, roots[0]);
    MalValue length_value;
    if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, "length"), &length_value)) goto failed;
    f64 length_number;
    if (!mal_vm_to_number(vm, length_value, &length_number)) goto failed;
    u64 length = (u64) mal_ops_number_to_length(length_number);
    for (u64 i = 0; i < length; i++) {
        MalKey property_key = i < UINT32_MAX ? mal_key_index(i) : mal_key_from_value(mal_value_from_string(mal_ops_to_string(&vm->heap, mal_ops_number_value((f64) i))));
        roots[3] = property_key.value;
        bool present = mal_vm_has_property(vm, roots[0], property_key);
        if (vm->completion.kind == MAL_COMPLETION_THROW) goto failed;
        if (!present) continue;
        property_key.value = roots[3];
        if (!mal_vm_get_property(vm, roots[0], property_key, &roots[2])) goto failed;
        MalValue element = roots[2];
        if (!mal_value_is_string(element) && !mal_value_is_object(element)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "locale list element must be a String or Object");
            goto failed;
        }
        MalString *tag;
        if (mal_value_is_intl_object(element) && mal_value_to_intl_object(element)->kind == MAL_INTL_LOCALE)
            tag = mal_value_to_string(mal_value_to_intl_object(element)->data);
        else if (!mal_vm_to_string(vm, element, &tag)) goto failed;
        roots[2] = mal_value_from_string(tag);
        MalString *canonical = intl_canonicalize(vm, mal_value_to_string(roots[2]));
        if (canonical == nullptr) goto failed;
        roots[2] = mal_value_from_string(canonical);
        if (!intl_array_contains(vm, mal_value_to_array_object(roots[1]), count, canonical))
            intl_array_push(vm, mal_value_to_array_object(roots[1]), count++, roots[2]);
    }
 done:
    MalArrayObject *result = mal_value_to_array_object(roots[1]);
    mal_gc_unroot(&root_span);
    return result;
 failed:
    mal_gc_unroot(&root_span);
    return nullptr;
}

static MalValue intl_get_canonical_locales(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) this_value;
    (void) nt;
    (void) cl;
    MalArrayObject *result = intl_canonicalize_locale_list(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (result == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_from_array_object(result);
}

// ---------------------------------------------------------------------------
// Intl.supportedValuesOf uses curated, sorted lists rather than ICU enumeration.
// ---------------------------------------------------------------------------

static const char *const SUPPORTED_CALENDARS[] = {
    "buddhist", "chinese", "coptic", "dangi", "ethioaa", "ethiopic", "gregory", "hebrew",
    "indian", "islamic", "iso8601", "japanese", "persian", "roc",
};
static const char *const SUPPORTED_COLLATIONS[] = {
    "compat", "dict", "emoji", "eor", "phonebk", "pinyin", "stroke", "trad", "unihan", "zhuyin",
};
static const char *const SUPPORTED_CURRENCIES[] = {
    "AUD", "BRL", "CAD", "CHF", "CNY", "EUR", "GBP", "HKD", "INR", "JPY",
    "KRW", "MXN", "NOK", "NZD", "RUB", "SEK", "SGD", "TRY", "USD", "ZAR",
};
static const char *const SUPPORTED_NUMBERING_SYSTEMS[] = {
    "arab", "arabext", "beng", "deva", "fullwide", "gujr", "guru", "hanidec", "khmr", "knda",
    "laoo", "latn", "mlym", "mymr", "orya", "tamldec", "telu", "thai", "tibt",
};
static const char *const SUPPORTED_TIME_ZONES[] = {
    "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Europe/Amsterdam", "Europe/London",
    "Europe/Paris", "UTC", "America/Chicago", "America/Los_Angeles", "America/New_York",
};
#include "intl_unit_ids.h"

static int intl_compare_cstr(const void *a, const void *b) {
    return strcmp(*(const char *const *) a, *(const char *const *) b);
}

static MalValue intl_supported_values_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) this_value;
    (void) nt;
    (void) cl;
    MalString *key;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &key)) {
        return mal_value_new_undefined();
    }

    const char *const *values = nullptr;
    usize count = 0;
    if (intl_string_eq_ascii(key, "calendar")) {
        values = SUPPORTED_CALENDARS;
        count = countof(SUPPORTED_CALENDARS);
    } else if (intl_string_eq_ascii(key, "collation")) {
        values = SUPPORTED_COLLATIONS;
        count = countof(SUPPORTED_COLLATIONS);
    } else if (intl_string_eq_ascii(key, "currency")) {
        values = SUPPORTED_CURRENCIES;
        count = countof(SUPPORTED_CURRENCIES);
    } else if (intl_string_eq_ascii(key, "numberingSystem")) {
        values = SUPPORTED_NUMBERING_SYSTEMS;
        count = countof(SUPPORTED_NUMBERING_SYSTEMS);
    } else if (intl_string_eq_ascii(key, "timeZone")) {
        values = SUPPORTED_TIME_ZONES;
        count = countof(SUPPORTED_TIME_ZONES);
    } else if (intl_string_eq_ascii(key, "unit")) {
        values = SUPPORTED_UNITS;
        count = countof(SUPPORTED_UNITS);
    } else {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid key for supportedValuesOf");
        return mal_value_new_undefined();
    }

    const char **sorted = malloc(count * sizeof(char *));
    if (sorted == nullptr) { mal_vm_throw_allocation_error(vm); return mal_value_new_undefined(); }
    for (usize i = 0; i < count; i++) {
        sorted[i] = values[i];
    }
    qsort(sorted, count, sizeof(char *), intl_compare_cstr);

    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    MalValue result_value = mal_value_from_array_object(result);
    MalRootSpan root;
    mal_gc_root(&root, &result_value, 1);
    (void) mal_array_object_fresh_dense_reserve_exact(result, (u32) count);
    for (usize i = 0; i < count; i++) {
        intl_array_push(vm, result, (u32) i, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) sorted[i])));
    }
    free(sorted);
    mal_gc_unroot(&root);
    return result_value;
}

// ---------------------------------------------------------------------------
// Intl.Locale
// ---------------------------------------------------------------------------

static bool intl_option_string(MalVm *vm, MalValue options, const char *name, MalString **out, bool *present);
static bool intl_option_bool(MalVm *vm, MalValue options, const char *name, bool *out, bool *present);
static void intl_resolved_set(MalVm *vm, MalObject *object, const char *name, MalValue value);

static bool intl_ascii_alpha(byte c) { return (c | 0x20) >= 'a' && (c | 0x20) <= 'z'; }
static bool intl_ascii_digit(byte c) { return c >= '0' && c <= '9'; }
static bool intl_ascii_alnum(byte c) { return intl_ascii_alpha(c) || intl_ascii_digit(c); }

/** A string option as ASCII; false (no throw) for a unit no locale subtag can hold. */
static bool intl_option_ascii(MalString *value, char *out, usize cap, usize *len) {
    usize n = mal_string_length(value);
    if (n >= cap) return false;
    for (usize i = 0; i < n; i++) {
        c16 unit = mal_string_code_unit_at(value, i);
        if (unit == 0 || unit > 0x7F) return false;
        out[i] = (char) unit;
    }
    out[n] = '\0';
    *len = n;
    return true;
}

static bool intl_all(const char *s, usize from, usize to, bool (*pred)(byte)) {
    for (usize i = from; i < to; i++) {
        if (!pred((byte) s[i])) return false;
    }
    return true;
}

// unicode_language_subtag, unicode_script_subtag and unicode_region_subtag.
static bool intl_language_subtag(const char *s, usize n) {
    return ((n >= 2 && n <= 3) || (n >= 5 && n <= 8)) && intl_all(s, 0, n, intl_ascii_alpha);
}
static bool intl_script_subtag(const char *s, usize n) {
    return n == 4 && intl_all(s, 0, n, intl_ascii_alpha);
}
static bool intl_region_subtag(const char *s, usize n) {
    return (n == 2 && intl_all(s, 0, n, intl_ascii_alpha)) || (n == 3 && intl_all(s, 0, n, intl_ascii_digit));
}

/** unicode_variant_subtag (- unicode_variant_subtag)*, without duplicates. */
static bool intl_variants_subtags(const char *s, usize n) {
    usize start = 0;
    while (start <= n) {
        usize end = start;
        while (end < n && s[end] != '-') end++;
        usize len = end - start;
        bool ok = ((len >= 5 && len <= 8) && intl_all(s, start, end, intl_ascii_alnum)) ||
            (len == 4 && intl_ascii_digit((byte) s[start]) && intl_all(s, start + 1, end, intl_ascii_alnum));
        if (!ok) return false;
        for (usize prev = 0; prev < start;) {
            usize prev_end = prev;
            while (s[prev_end] != '-') prev_end++;
            if (prev_end - prev == len && strncasecmp(s + prev, s + start, len) == 0) return false;
            prev = prev_end + 1;
        }
        start = end + 1;
    }
    return true;
}

/** The `type` nonterminal: alphanum{3,8} (- alphanum{3,8})*. */
static bool intl_type_subtags(const char *s, usize n) {
    usize start = 0;
    while (start <= n) {
        usize end = start;
        while (end < n && s[end] != '-') end++;
        usize len = end - start;
        if (len < 3 || len > 8 || !intl_all(s, start, end, intl_ascii_alnum)) return false;
        start = end + 1;
    }
    return true;
}

/** Reads a string option for the Locale constructor; `*present` is false when undefined. */
static bool intl_locale_option(MalVm *vm, MalValue options, const char *name, char *out, usize cap, usize *len, bool *present, bool *ascii) {
    MalString *value;
    if (!intl_option_string(vm, options, name, &value, present)) return false;
    *ascii = !*present || intl_option_ascii(value, out, cap, len);
    return true;
}

static MalValue intl_locale_range_error(MalVm *vm) {
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Incorrect locale information provided");
    return mal_value_new_undefined();
}

// The Unicode-extension keyword options in the order the constructor reads them.
typedef enum { LOCALE_TYPE, LOCALE_FIRST_DAY, LOCALE_HOUR_CYCLE, LOCALE_CASE_FIRST, LOCALE_BOOLEAN } IntlLocaleOptionKind;
static const struct {
    const char *option;
    const char *key;
    IntlLocaleOptionKind kind;
} LOCALE_KEYWORDS[] = {
    {"calendar", "ca", LOCALE_TYPE},
    {"collation", "co", LOCALE_TYPE},
    {"firstDayOfWeek", "fw", LOCALE_FIRST_DAY},
    {"hourCycle", "hc", LOCALE_HOUR_CYCLE},
    {"caseFirst", "kf", LOCALE_CASE_FIRST},
    {"numeric", "kn", LOCALE_BOOLEAN},
    {"numberingSystem", "nu", LOCALE_TYPE},
};

static bool intl_one_of(const char *value, const char *const *values) {
    for (; *values != nullptr; values++) {
        if (strcmp(value, *values) == 0) return true;
    }
    return false;
}

/** Append `text` (of `n` bytes) to the tag buffer; false when it would not fit. */
static bool intl_tag_append(char *buf, usize cap, usize *len, const char *text, usize n) {
    if (*len + n >= cap) return false;
    memcpy(buf + *len, text, n);
    *len += n;
    buf[*len] = '\0';
    return true;
}

static MalValue intl_locale_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Intl.Locale must be called with new");
        return mal_value_new_undefined();
    }

    MalValue tag_arg = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    if (!mal_value_is_string(tag_arg) && !mal_value_is_object(tag_arg)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "locale tag must be a String or Object");
        return mal_value_new_undefined();
    }
    MalString *base_tag;
    if (mal_value_is_intl_object(tag_arg) && mal_value_to_intl_object(tag_arg)->kind == MAL_INTL_LOCALE) {
        base_tag = mal_value_to_string(mal_value_to_intl_object(tag_arg)->data);
    } else if (!mal_vm_to_string(vm, tag_arg, &base_tag)) {
        return mal_value_new_undefined();
    }
    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    if (mal_value_is_null(options)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Intl.Locale options must be an object");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {mal_value_from_string(base_tag), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();

    // The tag is canonicalized before the options apply, then once more after.
    bool invalid;
    MalString *canonical = intl_call_locale_fn(vm, mal_i18n_canonicalize_locale, base_tag, &invalid);
    if (invalid) {
        intl_locale_range_error(vm);
        goto done;
    }
    roots[1] = mal_value_from_string(canonical);

    // UpdateLanguageId.
    char parts[4][96];
    usize part_len[4];
    static const i32 part_fields[4] = {
        MAL_LOCALE_FIELD_LANGUAGE, MAL_LOCALE_FIELD_SCRIPT, MAL_LOCALE_FIELD_REGION, MAL_LOCALE_FIELD_VARIANTS,
    };
    static const char *const part_options[4] = {"language", "script", "region", "variants"};
    static bool (*const part_valid[4])(const char *, usize) = {
        intl_language_subtag, intl_script_subtag, intl_region_subtag, intl_variants_subtags,
    };
    for (usize i = 0; i < 4; i++) {
        bool present;
        bool ascii;
        if (!intl_locale_option(vm, options, part_options[i], parts[i], sizeof(parts[i]), &part_len[i], &present, &ascii)) {
            goto done;
        }
        if (present) {
            if (!ascii || !part_valid[i](parts[i], part_len[i])) {
                intl_locale_range_error(vm);
                goto done;
            }
            continue;
        }
        MalString *field = intl_locale_field_string(vm, canonical, part_fields[i]);
        if (!intl_option_ascii(field, parts[i], sizeof(parts[i]), &part_len[i])) {
            intl_locale_range_error(vm);
            goto done;
        }
    }
    char tag[400];
    usize tag_len = 0;
    tag[0] = '\0';
    for (usize i = 0; i < 4; i++) {
        if (part_len[i] == 0) continue;
        if ((tag_len > 0 && !intl_tag_append(tag, sizeof(tag), &tag_len, "-", 1)) ||
            !intl_tag_append(tag, sizeof(tag), &tag_len, parts[i], part_len[i])) {
            intl_locale_range_error(vm);
            goto done;
        }
    }

    // The extensions follow the base name in the canonical tag.
    char canonical_ascii[400];
    usize canonical_len;
    MalString *base_name = intl_locale_field_string(vm, canonical, MAL_LOCALE_FIELD_BASE_NAME);
    if (!intl_option_ascii(canonical, canonical_ascii, sizeof(canonical_ascii), &canonical_len)) {
        intl_locale_range_error(vm);
        goto done;
    }
    const char *extensions = canonical_ascii + mal_string_length(base_name);

    // MakeLocaleRecord: each keyword option replaces or adds its -u- keyword.
    char values[countof(LOCALE_KEYWORDS)][96];
    bool set[countof(LOCALE_KEYWORDS)] = {false};
    for (usize k = 0; k < countof(LOCALE_KEYWORDS); k++) {
        usize len = 0;
        if (LOCALE_KEYWORDS[k].kind == LOCALE_BOOLEAN) {
            bool value;
            bool present;
            if (!intl_option_bool(vm, options, LOCALE_KEYWORDS[k].option, &value, &present)) goto done;
            if (present) {
                snprintf(values[k], sizeof(values[k]), "%s", value ? "true" : "false");
                set[k] = true;
            }
            continue;
        }
        bool present;
        bool ascii;
        if (!intl_locale_option(vm, options, LOCALE_KEYWORDS[k].option, values[k], sizeof(values[k]), &len, &present, &ascii)) {
            goto done;
        }
        if (!present) continue;
        static const char *const hour_cycles[] = {"h11", "h12", "h23", "h24", nullptr};
        static const char *const case_firsts[] = {"upper", "lower", "false", nullptr};
        static const char *const weekdays[] = {"sun", "mon", "tue", "wed", "thu", "fri", "sat", "sun"};
        bool valid = ascii;
        switch (LOCALE_KEYWORDS[k].kind) {
            case LOCALE_HOUR_CYCLE: valid = valid && intl_one_of(values[k], hour_cycles); break;
            case LOCALE_CASE_FIRST: valid = valid && intl_one_of(values[k], case_firsts); break;
            case LOCALE_FIRST_DAY:
                // WeekdayToString maps "0" through "7" to weekday names.
                if (valid && len == 1 && values[k][0] >= '0' && values[k][0] <= '7') {
                    snprintf(values[k], sizeof(values[k]), "%s", weekdays[values[k][0] - '0']);
                    len = 3;
                }
                valid = valid && intl_type_subtags(values[k], len);
                break;
            default: valid = valid && intl_type_subtags(values[k], len); break;
        }
        if (!valid) {
            intl_locale_range_error(vm);
            goto done;
        }
        for (usize i = 0; i < len; i++) values[k][i] = (char) ((byte) values[k][i] | (intl_ascii_alpha((byte) values[k][i]) ? 0x20 : 0));
        set[k] = true;
    }

    // Copy the extensions, rewriting the -u- extension (inserted before -x-).
    const char *u_start = nullptr;
    const char *u_end = nullptr;
    const char *x_start = nullptr;
    for (const char *p = extensions; *p != '\0';) {
        const char *token = p + 1;
        const char *token_end = token;
        while (*token_end != '\0' && *token_end != '-') token_end++;
        if (token_end - token == 1) {
            if (u_start != nullptr && u_end == nullptr) u_end = p;
            if (*token == 'x') {
                x_start = p;
                break;
            }
            if (*token == 'u') u_start = p;
        }
        p = token_end;
    }
    if (u_start != nullptr && u_end == nullptr) u_end = x_start != nullptr ? x_start : extensions + strlen(extensions);
    const char *insert_at = u_start != nullptr ? u_start : (x_start != nullptr ? x_start : extensions + strlen(extensions));
    if (!intl_tag_append(tag, sizeof(tag), &tag_len, extensions, (usize) (insert_at - extensions))) {
        intl_locale_range_error(vm);
        goto done;
    }
    bool any_keyword = false;
    for (usize k = 0; k < countof(LOCALE_KEYWORDS); k++) any_keyword |= set[k];
    if (u_start != nullptr || any_keyword) {
        bool ok = intl_tag_append(tag, sizeof(tag), &tag_len, "-u", 2);
        if (u_start != nullptr) {
            // Keep attributes and the keywords the options leave alone.
            const char *p = u_start + 2;
            bool skipping = false;
            while (ok && p < u_end) {
                const char *token = p + 1;
                const char *token_end = token;
                while (token_end < u_end && *token_end != '-') token_end++;
                if (token_end - token == 2) {
                    skipping = false;
                    for (usize k = 0; k < countof(LOCALE_KEYWORDS); k++) {
                        if (set[k] && strncmp(token, LOCALE_KEYWORDS[k].key, 2) == 0) skipping = true;
                    }
                }
                if (!skipping) ok = intl_tag_append(tag, sizeof(tag), &tag_len, p, (usize) (token_end - p));
                p = token_end;
            }
        }
        for (usize k = 0; ok && k < countof(LOCALE_KEYWORDS); k++) {
            if (!set[k]) continue;
            ok = intl_tag_append(tag, sizeof(tag), &tag_len, "-", 1) &&
                intl_tag_append(tag, sizeof(tag), &tag_len, LOCALE_KEYWORDS[k].key, 2) &&
                intl_tag_append(tag, sizeof(tag), &tag_len, "-", 1) &&
                intl_tag_append(tag, sizeof(tag), &tag_len, values[k], strlen(values[k]));
        }
        if (!ok) {
            intl_locale_range_error(vm);
            goto done;
        }
    }
    const char *rest = u_end != nullptr ? u_end : insert_at;
    if (!intl_tag_append(tag, sizeof(tag), &tag_len, rest, strlen(rest))) {
        intl_locale_range_error(vm);
        goto done;
    }

    MalString *assembled = mal_string_new_ascii(&vm->heap, (const byte *) tag, tag_len);
    roots[1] = mal_value_from_string(assembled);
    MalString *final_tag = intl_call_locale_fn(vm, mal_i18n_canonicalize_locale, assembled, &invalid);
    if (invalid) {
        intl_locale_range_error(vm);
        goto done;
    }
    roots[1] = mal_value_from_string(final_tag);
    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_LOCALE_PROTOTYPE);
    if (prototype == nullptr) goto done;
    result = mal_value_from_intl_object(
        mal_intl_object_new(&vm->heap, prototype, MAL_INTL_LOCALE, nullptr, mal_value_from_string(final_tag)));
done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue intl_locale_field_getter(MalVm *vm, MalValue this_value, i32 field, bool as_bool, bool undef_if_empty) {
    MalIntlObject *locale;
    if (!intl_this(vm, this_value, MAL_INTL_LOCALE, &locale, "Intl.Locale.prototype getter called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    MalString *value = intl_locale_field_string(vm, mal_value_to_string(locale->data), field);
    if (value == nullptr) return mal_value_new_undefined();
    usize len = mal_string_length(value);
    if (as_bool) {
        return mal_value_new_boolean(len > 0 && !intl_string_eq_ascii(value, "false"));
    }
    if (undef_if_empty && len == 0) {
        return mal_value_new_undefined();
    }
    return mal_value_from_string(value);
}

#define LOCALE_GETTER(fn_name, field_id, as_bool, undef_empty)                                                    \
    static MalValue fn_name(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) { \
        (void) args;                                                                                              \
        (void) arg_count;                                                                                         \
        (void) nt;                                                                                                \
        (void) cl;                                                                                                \
        return intl_locale_field_getter(vm, this_value, field_id, as_bool, undef_empty);                          \
    }

LOCALE_GETTER(intl_locale_get_base_name, MAL_LOCALE_FIELD_BASE_NAME, false, false)
LOCALE_GETTER(intl_locale_get_language, MAL_LOCALE_FIELD_LANGUAGE, false, false)
LOCALE_GETTER(intl_locale_get_script, MAL_LOCALE_FIELD_SCRIPT, false, true)
LOCALE_GETTER(intl_locale_get_region, MAL_LOCALE_FIELD_REGION, false, true)
LOCALE_GETTER(intl_locale_get_variants, MAL_LOCALE_FIELD_VARIANTS, false, true)
LOCALE_GETTER(intl_locale_get_calendar, MAL_LOCALE_FIELD_CALENDAR, false, true)
LOCALE_GETTER(intl_locale_get_collation, MAL_LOCALE_FIELD_COLLATION, false, true)
LOCALE_GETTER(intl_locale_get_hour_cycle, MAL_LOCALE_FIELD_HOUR_CYCLE, false, true)
LOCALE_GETTER(intl_locale_get_case_first, MAL_LOCALE_FIELD_CASE_FIRST, false, true)
LOCALE_GETTER(intl_locale_get_numeric, MAL_LOCALE_FIELD_NUMERIC, true, false)
LOCALE_GETTER(intl_locale_get_numbering_system, MAL_LOCALE_FIELD_NUMBERING_SYSTEM, false, true)
LOCALE_GETTER(intl_locale_get_first_day_of_week, MAL_LOCALE_FIELD_FIRST_DAY_OF_WEEK, false, false)

static MalValue intl_locale_to_string(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *locale;
    if (!intl_this(vm, this_value, MAL_INTL_LOCALE, &locale, "Intl.Locale.prototype.toString called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    return locale->data;
}

static MalValue intl_locale_transform(MalVm *vm, MalValue this_value, IntlLocaleFn fn) {
    MalIntlObject *locale;
    if (!intl_this(vm, this_value, MAL_INTL_LOCALE, &locale, "Intl.Locale.prototype method called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    bool invalid;
    MalString *result = intl_call_locale_fn(vm, fn, mal_value_to_string(locale->data), &invalid);
    if (invalid) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Incorrect locale information provided");
        return mal_value_new_undefined();
    }
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_INTL_LOCALE_PROTOTYPE]);
    MalIntlObject *out = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_LOCALE, nullptr, mal_value_from_string(result));
    return mal_value_from_intl_object(out);
}

static MalValue intl_locale_maximize(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    return intl_locale_transform(vm, this_value, mal_i18n_locale_maximize);
}

static MalValue intl_locale_minimize(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    return intl_locale_transform(vm, this_value, mal_i18n_locale_minimize);
}

static MalValue intl_locale_get_text_info(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *locale;
    if (!intl_this(vm, this_value, MAL_INTL_LOCALE, &locale, "Intl.Locale.prototype.getTextInfo called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    byte tag[320];
    usize tag_len;
    i32 direction = intl_tag_utf8(mal_value_to_string(locale->data), tag, sizeof(tag), &tag_len)
        ? mal_i18n_locale_direction((const uint8_t *) tag, tag_len) : -1;
    MalObject *info = mal_intrinsic_new_object(vm);
    MalValue rooted = mal_value_from_object(info);
    MalRootSpan root;
    mal_gc_root(&root, &rooted, 1);
    intl_resolved_set(vm, info, "direction", mal_value_from_string(mal_intrinsic_ascii(vm, direction == 1 ? "rtl" : "ltr")));
    mal_gc_unroot(&root);
    return rooted;
}

static void intl_install_locale(MalVm *vm, MalObject *intl_object) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "Locale"), 1, intl_locale_constructor
    );
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_INTL_LOCALE_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_INTL_LOCALE_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_INTL_LOCALE_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_INTL_LOCALE_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    intl_set_to_string_tag(vm, prototype, "Intl.Locale");

    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, intl_locale_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "maximize", 0, intl_locale_maximize);
    mal_intrinsic_define_method_n(vm, prototype, "minimize", 0, intl_locale_minimize);
    mal_intrinsic_define_method_n(vm, prototype, "getTextInfo", 0, intl_locale_get_text_info);

    intl_define_getter(vm, prototype, "baseName", intl_locale_get_base_name);
    intl_define_getter(vm, prototype, "language", intl_locale_get_language);
    intl_define_getter(vm, prototype, "script", intl_locale_get_script);
    intl_define_getter(vm, prototype, "region", intl_locale_get_region);
    intl_define_getter(vm, prototype, "variants", intl_locale_get_variants);
    intl_define_getter(vm, prototype, "calendar", intl_locale_get_calendar);
    intl_define_getter(vm, prototype, "collation", intl_locale_get_collation);
    intl_define_getter(vm, prototype, "hourCycle", intl_locale_get_hour_cycle);
    intl_define_getter(vm, prototype, "caseFirst", intl_locale_get_case_first);
    intl_define_getter(vm, prototype, "numeric", intl_locale_get_numeric);
    intl_define_getter(vm, prototype, "numberingSystem", intl_locale_get_numbering_system);
    intl_define_getter(vm, prototype, "firstDayOfWeek", intl_locale_get_first_day_of_week);

    mal_intrinsic_define_data(vm, intl_object, "Locale", vm->intrinsics[MAL_INTRINSIC_INTL_LOCALE_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

// ---------------------------------------------------------------------------
// Shared option + locale-resolution helpers (used by the formatter services)
// ---------------------------------------------------------------------------

/** GetOption(options, name, "string"): false on a pending throw. Reads through a
 * primitive's prototype chain too (CoerceOptionsToObject semantics); only a
 * null/undefined options bag is treated as "no options present". */
static bool intl_option_string(MalVm *vm, MalValue options, const char *name, MalString **out, bool *present) {
    *present = false;
    if (mal_value_is_undefined(options) || mal_value_is_null(options)) {
        return true;
    }
    MalValue value;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, name), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) {
        return true;
    }
    if (!mal_vm_to_string(vm, value, out)) {
        return false;
    }
    *present = true;
    return true;
}

/** GetOption(options, name, "boolean"). Reads through a primitive's prototype
 * chain too; only a null/undefined options bag is "no options present". */
static bool intl_option_bool(MalVm *vm, MalValue options, const char *name, bool *out, bool *present) {
    *present = false;
    *out = false;
    if (mal_value_is_undefined(options) || mal_value_is_null(options)) {
        return true;
    }
    MalValue value;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, name), &value)) {
        return false;
    }
    if (mal_value_is_undefined(value)) {
        return true;
    }
    *out = mal_value_is_truthy(value);
    *present = true;
    return true;
}

/**
 * GetOption(options, name, "string", values, fallback): returns the matched
 * value (interned), validating membership in `values` and throwing RangeError
 * otherwise. `fallback` (may be null) is returned when the option is absent.
 * Sets *ok=false on a pending throw.
 */
static MalString *intl_option_enum(
    MalVm *vm, MalValue options, const char *name, const char *const *values, usize value_count, const char *fallback, bool *ok
) {
    *ok = true;
    bool present;
    MalString *value = nullptr;
    if (!intl_option_string(vm, options, name, &value, &present)) {
        *ok = false;
        return nullptr;
    }
    if (!present || value == nullptr) {
        return fallback != nullptr ? mal_intrinsic_ascii(vm, (const byte *) fallback) : nullptr;
    }
    for (usize i = 0; i < value_count; i++) {
        if (intl_string_eq_ascii(value, values[i])) {
            return mal_intrinsic_ascii(vm, (const byte *) values[i]);
        }
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid option value");
    *ok = false;
    return nullptr;
}

/**
 * IsWellFormedUnicodeBcp47TypeNonterminal: one or more "-"-separated segments of
 * 3..8 alphanumerics (the `type` production used for numberingSystem/calendar/
 * collation options).
 */
static bool intl_is_valid_unicode_type(const MalString *s) {
    usize n = mal_string_length(s);
    const c16 *u = mal_string_code_units(s);
    usize seg = 0;
    usize i = 0;
    while (i <= n) {
        if (i == n || u[i] == '-') {
            if (seg < 3 || seg > 8) {
                return false;
            }
            seg = 0;
            i++;
            continue;
        }
        c16 c = u[i];
        bool alnum = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
        if (!alnum) {
            return false;
        }
        seg++;
        i++;
    }
    return n > 0;
}

/**
 * GetOptionsObject(options): undefined -> a fresh options object; an Object ->
 * itself; any other value -> TypeError. Returns false with a pending throw.
 */
static bool intl_get_options_object(MalVm *vm, MalValue options, MalValue *out) {
    if (mal_value_is_undefined(options)) {
        // OrdinaryObjectCreate(null): a null-prototype bag so option reads do not
        // observe getters installed on Object.prototype.
        *out = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
        return true;
    }
    if (mal_value_is_object(options)) {
        *out = options;
        return true;
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "options must be an object");
    return false;
}

/** GetOption(options, "localeMatcher", «"lookup","best fit"», "best fit"); value ignored. */
static bool intl_check_locale_matcher(MalVm *vm, MalValue options) {
    static const char *const values[] = {"lookup", "best fit"};
    bool ok;
    intl_option_enum(vm, options, "localeMatcher", values, countof(values), "best fit", &ok);
    return ok;
}

/**
 * Shared `<Service>.supportedLocalesOf(locales, options)`: CanonicalizeLocaleList
 * then validate the options bag (null -> TypeError; localeMatcher validated).
 * With all-locales compiled data we "support" every requested locale, so the
 * canonical list is returned as-is.
 */
static MalValue intl_supported_locales_of_impl(MalVm *vm, const MalValue *args, i32 arg_count) {
    MalArrayObject *result = intl_canonicalize_locale_list(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (result == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    if (mal_value_is_null(options)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "options must be an object");
        return mal_value_new_undefined();
    }
    if (!intl_check_locale_matcher(vm, options)) {
        return mal_value_new_undefined();
    }
    return mal_value_from_array_object(result);
}

/** ResolveLocale (simplified): the first canonical requested locale, else "en-US". */
static MalString *intl_resolve_locale(MalVm *vm, MalValue locales) {
    if (mal_value_is_undefined(locales)) {
        return mal_intrinsic_ascii(vm, "en-US");
    }
    if (mal_value_is_string(locales)) {
        return intl_canonicalize(vm, mal_value_to_string(locales));
    }
    if (mal_value_is_intl_object(locales) &&
        mal_value_to_intl_object(locales)->kind == MAL_INTL_LOCALE) {
        return mal_value_to_string(mal_value_to_intl_object(locales)->data);
    }

    MalArrayObject *list = intl_canonicalize_locale_list(vm, locales);
    if (list == nullptr) {
        return nullptr;
    }
    MalValue first;
    if (mal_array_object_dense_get(list, 0, &first) && mal_value_is_string(first)) {
        return mal_value_to_string(first);
    }
    return mal_intrinsic_ascii(vm, "en-US");
}

bool mal_intl_case_locale(MalVm *vm, MalValue locales, MalUnicodeLocale *locale) {
    MalString *tag = intl_resolve_locale(vm, locales);
    if (tag == nullptr) return false;
    const c16 *units = mal_string_code_units(tag);
    usize length = mal_string_length(tag);
    *locale = MAL_UNICODE_LOCALE_ROOT;
    if (length >= 2 && (length == 2 || units[2] == '-')) {
        if ((units[0] == 't' && units[1] == 'r') || (units[0] == 'a' && units[1] == 'z')) *locale = MAL_UNICODE_LOCALE_TURKIC;
        else if (units[0] == 'l' && units[1] == 't') *locale = MAL_UNICODE_LOCALE_LITHUANIAN;
    }
    return true;
}

static void intl_resolved_set(MalVm *vm, MalObject *object, const char *name, MalValue value) {
    mal_intrinsic_define_data(vm, object, name, value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
}

/** Read an engine-owned Intl metadata object's exact own data slot. */
static bool intl_data_get_key(MalValue data, MalKey key, MalValue *out) {
    if (!mal_value_is_object(data)) {
        return false;
    }
    MalPropertyLookup lookup = mal_object_get_own(
        mal_value_to_object(data), key);
    if (!lookup.present || (lookup.desc.flags & MAL_PROPERTY_ACCESSOR)) {
        return false;
    }
    *out = lookup.desc.value;
    return true;
}

static bool intl_data_get(
    MalVm *vm, MalValue data, const char *name, MalValue *out) {
    return intl_data_get_key(
        data, mal_intrinsic_string_key(vm, name), out);
}

/** A fresh object copying the named keys out of an instance's stored template. */
static MalValue intl_resolved_copy(MalVm *vm, MalValue template_value, const char *const *keys, usize key_count) {
    assert(key_count <= MAL_SHAPE_MAX_INLINE_SLOTS);
    MalString *shape_keys[MAL_SHAPE_MAX_INLINE_SLOTS];
    MalValue values[MAL_SHAPE_MAX_INLINE_SLOTS];
    u32 count = 0;
    for (usize i = 0; i < key_count; i++) {
        MalKey key = mal_intrinsic_string_key(vm, keys[i]);
        MalValue value = mal_value_new_undefined();
        (void) intl_data_get_key(template_value, key, &value);
        // Omit keys the instance never set (e.g. an unspecified dateStyle).
        if (!mal_value_is_undefined(value)) {
            shape_keys[count] = mal_value_to_string(key.value);
            values[count++] = value;
        }
    }
    if (count == 0) {
        return mal_value_from_object(mal_intrinsic_new_object(vm));
    }
    MalShape *shape = mal_shape_from_string_keys(
        &vm->heap, shape_keys, count);
    return mal_vm_create_object_shaped(vm, shape, values, count);
}

#if MAL_INTL_HAS_NUMBER_FORMAT || MAL_INTL_HAS_RELATIVE_TIME_FORMAT
/** CoerceOptionsToObject: undefined creates a null-prototype bag; all other
 * non-null values pass through ToObject. */
static bool intl_coerce_options_to_object(MalVm *vm, MalValue options, MalValue *out) {
    if (mal_value_is_undefined(options)) {
        *out = mal_value_from_object(mal_object_new(&vm->heap, nullptr));
        return true;
    }
    if (mal_value_is_null(options)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "options must not be null");
        return false;
    }
    *out = mal_value_is_object(options) ? options : mal_builtin_object_box_primitive(vm, options);
    return true;
}
#endif

#if MAL_INTL_HAS_NUMBER_FORMAT
/** DefaultNumberOption for the integer digit options supported by the backend. */
static bool intl_number_option(MalVm *vm, MalValue value, i32 minimum, i32 maximum, i32 *out, bool *present) {
    if (mal_value_is_undefined(value)) {
        *present = false;
        return true;
    }
    f64 number;
    if (!mal_vm_to_number(vm, value, &number)) {
        return false;
    }
    if (!isfinite(number) || number < minimum || number > maximum) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "number option out of range");
        return false;
    }
    *present = true;
    *out = (i32) floor(number);
    return true;
}

// Raw digit values stay rooted until the later option getters and coercions finish.
static bool intl_number_format_digits(
    MalVm *vm, MalValue options, bool percent, i32 *minimum_integer, i32 *minimum_fraction, i32 *maximum_fraction,
    i32 *minimum_significant, i32 *maximum_significant, bool *has_significant,
    MalValue *rounding_out, i32 *rounding_code, i32 *increment,
    MalValue *priority_out, i32 *priority_code, MalValue *trailing_out, bool *strip_zero
) {
    MalValue roots[7] = {options, mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool result = false, present;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "minimumIntegerDigits"), &roots[1]) || !intl_number_option(vm, roots[1], 1, 21, minimum_integer, &present)) goto done;
    if (!present) *minimum_integer = 1;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "minimumFractionDigits"), &roots[2]) ||
        !mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "maximumFractionDigits"), &roots[3]) ||
        !mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "minimumSignificantDigits"), &roots[4]) ||
        !mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "maximumSignificantDigits"), &roots[5]) ||
        !mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "roundingIncrement"), &roots[6])) goto done;
    if (!intl_number_option(vm, roots[6], 1, 5000, increment, &present)) goto done;
    if (!present) *increment = 1;
    static const i32 INCREMENTS[] = {1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500, 5000};
    bool valid_increment = false;
    for (usize i = 0; i < countof(INCREMENTS); i++) valid_increment |= *increment == INCREMENTS[i];
    if (!valid_increment) { mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid roundingIncrement"); goto done; }
    static const char *const ROUNDINGS[] = {"halfExpand", "ceil", "floor", "expand", "trunc", "halfCeil", "halfFloor", "halfTrunc", "halfEven"};
    bool ok;
    MalString *rounding = intl_option_enum(vm, options, "roundingMode", ROUNDINGS, countof(ROUNDINGS), "halfExpand", &ok);
    if (!ok) goto done;
    *rounding_out = mal_value_from_string(rounding);
    *rounding_code = 0;
    for (usize i = 0; i < countof(ROUNDINGS); i++) if (intl_string_eq_ascii(rounding, ROUNDINGS[i])) *rounding_code = (i32) i;
    static const char *const PRIORITIES[] = {"auto", "morePrecision", "lessPrecision"};
    MalString *priority = intl_option_enum(vm, options, "roundingPriority", PRIORITIES, countof(PRIORITIES), "auto", &ok);
    if (!ok) goto done;
    *priority_out = mal_value_from_string(priority);
    *priority_code = intl_string_eq_ascii(priority, "morePrecision") ? 1 : intl_string_eq_ascii(priority, "lessPrecision") ? 2 : 0;
    static const char *const ZEROS[] = {"auto", "stripIfInteger"};
    MalString *trailing = intl_option_enum(vm, options, "trailingZeroDisplay", ZEROS, countof(ZEROS), "auto", &ok);
    if (!ok) goto done;
    *trailing_out = mal_value_from_string(trailing);
    *strip_zero = intl_string_eq_ascii(trailing, "stripIfInteger");
    bool significant = !mal_value_is_undefined(roots[4]) || !mal_value_is_undefined(roots[5]) || *priority_code != 0;
    bool fraction = !significant || *priority_code != 0;
    *has_significant = significant;
    if (significant) {
        bool minimum_present, maximum_present;
        if (!intl_number_option(vm, roots[4], 1, 21, minimum_significant, &minimum_present)) goto done;
        if (!minimum_present) *minimum_significant = 1;
        if (!intl_number_option(vm, roots[5], *minimum_significant, 21, maximum_significant, &maximum_present)) goto done;
        if (!maximum_present) *maximum_significant = 21;
    }
    if (fraction) {
        bool minimum_present, maximum_present;
        if (!intl_number_option(vm, roots[2], 0, 100, minimum_fraction, &minimum_present) || !intl_number_option(vm, roots[3], 0, 100, maximum_fraction, &maximum_present)) goto done;
        i32 maximum_default = *increment != 1 ? 0 : percent ? 0 : 3;
        if (!minimum_present) *minimum_fraction = 0;
        if (!maximum_present) *maximum_fraction = *minimum_fraction > maximum_default ? *minimum_fraction : maximum_default;
        if (*minimum_fraction > *maximum_fraction) { mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "minimumFractionDigits exceeds maximumFractionDigits"); goto done; }
    }
    if (*increment != 1) {
        if (significant) { mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "roundingIncrement requires fraction precision"); goto done; }
        if (*minimum_fraction != *maximum_fraction) { mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "roundingIncrement requires equal fraction digits"); goto done; }
    }
    result = true;
 done:
    mal_gc_unroot(&root);
    return result;
}

#endif

#if MAL_INTL_HAS_COLLATOR
static MalValue intl_collator_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    MalValue roots[9] = {
        arg_count > 0 ? args[0] : mal_value_new_undefined(),
        arg_count > 1 ? args[1] : mal_value_new_undefined(), new_target,
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 9);
    MalValue result = mal_value_new_undefined();
    MalString *locale = intl_resolve_locale(vm, roots[0]);
    if (locale == nullptr) {
        goto done;
    }

    roots[3] = mal_value_from_string(locale);
    static const char *const USAGES[] = {"sort", "search"};
    static const char *const CASE_FIRST_VALUES[] = {"upper", "lower", "false"};
    static const char *const SENSITIVITIES[] = {"base", "accent", "case", "variant"};
    bool ok;
    bool present;
    MalString *usage = intl_option_enum(vm, roots[1], "usage", USAGES, countof(USAGES), "sort", &ok);
    if (!ok) {
        goto done;
    }
    roots[4] = mal_value_from_string(usage);
    if (!intl_check_locale_matcher(vm, roots[1])) {
        goto done;
    }
    MalString *collation = nullptr;
    if (!intl_option_string(vm, roots[1], "collation", &collation, &present)) {
        goto done;
    }
    if (collation != nullptr && !intl_is_valid_unicode_type(collation)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid collation");
        goto done;
    }
    if (collation == nullptr) collation = mal_intrinsic_ascii(vm, "default");
    roots[7] = mal_value_from_string(collation);
    bool numeric_present;
    bool numeric = false;
    if (!intl_option_bool(vm, roots[1], "numeric", &numeric, &numeric_present)) {
        goto done;
    }
    MalString *case_first = intl_option_enum(
        vm, roots[1], "caseFirst", CASE_FIRST_VALUES, countof(CASE_FIRST_VALUES), "false", &ok);
    if (!ok) {
        goto done;
    }
    i32 case_first_code = 0;
    if (intl_string_eq_ascii(case_first, "upper")) case_first_code = 1;
    else if (intl_string_eq_ascii(case_first, "lower")) case_first_code = 2;
    roots[6] = mal_value_from_string(case_first);
    MalString *sensitivity = intl_option_enum(
        vm, roots[1], "sensitivity", SENSITIVITIES, countof(SENSITIVITIES), "variant", &ok);
    if (!ok) {
        goto done;
    }
    roots[5] = mal_value_from_string(sensitivity);
    i32 strength = 2;
    i32 case_level = 0;
    if (intl_string_eq_ascii(sensitivity, "base")) strength = 0;
    else if (intl_string_eq_ascii(sensitivity, "accent")) strength = 1;
    else if (intl_string_eq_ascii(sensitivity, "case")) {
        strength = 0;
        case_level = 1;
    }
    bool ignore_present;
    bool ignore_punctuation = false;
    if (!intl_option_bool(vm, roots[1], "ignorePunctuation", &ignore_punctuation, &ignore_present)) {
        goto done;
    }
    locale = mal_value_to_string(roots[3]);
    byte locale_buf[160];
    usize locale_len;
    if (!intl_tag_utf8(locale, locale_buf, sizeof(locale_buf), &locale_len)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid locale");
        goto done;
    }
    void *handle = mal_i18n_collator_new(locale_buf, locale_len, strength, case_level, numeric ? 1 : 0, case_first_code);
    if (handle == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not create collator for locale");
        goto done;
    }

    roots[8] = mal_value_from_object(mal_intrinsic_new_object(vm));
    intl_resolved_set(vm, mal_value_to_object(roots[8]), "locale", roots[3]);
    intl_resolved_set(vm, mal_value_to_object(roots[8]), "usage", roots[4]);
    intl_resolved_set(vm, mal_value_to_object(roots[8]), "sensitivity", roots[5]);
    intl_resolved_set(vm, mal_value_to_object(roots[8]), "ignorePunctuation", mal_value_new_boolean(ignore_punctuation));
    intl_resolved_set(vm, mal_value_to_object(roots[8]), "collation", roots[7]);
    intl_resolved_set(vm, mal_value_to_object(roots[8]), "numeric", mal_value_new_boolean(numeric));
    intl_resolved_set(vm, mal_value_to_object(roots[8]), "caseFirst", roots[6]);

    MalObject *prototype = intl_resolve_prototype(vm, roots[2], MAL_INTRINSIC_INTL_COLLATOR_PROTOTYPE);
    if (prototype == nullptr) {
        mal_i18n_collator_free(handle);
        goto done;
    }
    MalIntlObject *collator = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_COLLATOR, handle, roots[8]);
    result = mal_value_from_intl_object(collator);
 done:
    mal_gc_unroot(&root_span);
    return result;
}

static MalValue intl_collator_compare_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    MalValue roots[3] = {
        mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0),
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, countof(roots));
    MalString *x;
    MalString *y;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &x)) {
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    roots[1] = mal_value_from_string(x);
    if (!mal_vm_to_string(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), &y)) {
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    roots[2] = mal_value_from_string(y);
    // Flatten both while rooted, then reacquire every moving-heap pointer before
    // taking the contiguous views handed to Rust.
    x = mal_value_to_string(roots[1]);
    (void) mal_string_code_units(x);
    y = mal_value_to_string(roots[2]);
    (void) mal_string_code_units(y);
    MalIntlObject *collator = mal_value_to_intl_object(roots[0]);
    x = mal_value_to_string(roots[1]);
    y = mal_value_to_string(roots[2]);
    i32 result = mal_i18n_collator_compare_utf16(
        collator->handle,
        (const uint16_t *) mal_string_code_units(x), mal_string_length(x),
        (const uint16_t *) mal_string_code_units(y), mal_string_length(y)
    );
    mal_gc_unroot(&root_span);
    return mal_value_from_i32(result);
}

static MalValue intl_collator_get_compare(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *collator;
    if (!intl_this(vm, this_value, MAL_INTL_COLLATOR, &collator, "get Intl.Collator.prototype.compare called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(collator->bound)) {
        MalValue slots[1] = {this_value};
        MalNativeFunctionObject *fn = mal_native_function_object_new_with_slots(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, ""), intl_collator_compare_callback, slots, 1
        );
        collator->bound = mal_value_from_native_function_object(fn);
        // Lazily cached bound compare fn on a possibly-old Intl object -> young fn.
        mal_gc_card(&collator->object.header, collator->bound);
    }
    return collator->bound;
}

static MalValue intl_collator_resolved_options(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *collator;
    if (!intl_this(vm, this_value, MAL_INTL_COLLATOR, &collator, "Intl.Collator.prototype.resolvedOptions called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    static const char *const keys[] = {"locale", "usage", "sensitivity", "ignorePunctuation", "collation", "numeric", "caseFirst"};
    return intl_resolved_copy(vm, collator->data, keys, countof(keys));
}

static MalValue intl_collator_supported_locales_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) this_value;
    (void) nt;
    (void) cl;
    return intl_supported_locales_of_impl(vm, args, arg_count);
}

#endif // MAL_INTL_HAS_COLLATOR — collator service statics

// String.prototype.localeCompare: a real Collator when the service is present,
// else the UTF-16 code-unit fallback. Always defined (builtin_string.c calls it).
MalValue mal_intl_locale_compare_range(MalVm *vm, MalValue this_string, usize start, usize length, MalValue that_value, MalValue locales, MalValue options) {
#if MAL_INTL_HAS_COLLATOR
    MalValue roots[5] = {
        this_string, that_value,
        mal_value_new_undefined(), locales, options,
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, countof(roots));
    // builtin_string.c already performed the receiver's observable ToString.
    MalString *that;
    if (!mal_vm_to_string(vm, roots[1], &that)) {
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    roots[1] = mal_value_from_string(that);

    bool use_default = mal_value_is_undefined(roots[3]) && mal_value_is_undefined(roots[4]);
    void *compare_handle = nullptr;
    if (!use_default) {
        MalValue ctor_args[2] = {roots[3], roots[4]};
        // Preserve the constructor's native-frame contract while retaining all observable inputs.
        vm->gc_native_frames++;
        roots[2] = intl_collator_constructor(
            vm, mal_value_new_undefined(), ctor_args, 2,
            mal_value_new_undefined(), mal_value_new_undefined());
        vm->gc_native_frames--;
        if (!mal_value_is_intl_object(roots[2])) {
            mal_gc_unroot(&root_span);
            return mal_value_new_undefined(); // a pending throw from the constructor
        }
        compare_handle = mal_value_to_intl_object(roots[2])->handle;
    }

    // Finish all flattening that may allocate before borrowing the bounded source view.
    (void) mal_string_code_units(mal_value_to_string(roots[1]));
    c16 stack[MAL_STRING_UTF16_SCRATCH_UNITS];
    c16 *scratch;
    const c16 *left_units = mal_string_range_utf16(mal_value_to_string(roots[0]), start, length, stack, &scratch);
    that = mal_value_to_string(roots[1]);
    i32 result = use_default
        ? mal_i18n_default_collator_compare_utf16(
            (const uint16_t *) left_units, length,
            (const uint16_t *) mal_string_code_units(that), mal_string_length(that))
        : mal_i18n_collator_compare_utf16(
            compare_handle,
            (const uint16_t *) left_units, length,
            (const uint16_t *) mal_string_code_units(that), mal_string_length(that));
    free(scratch);
    if (result < -1 || result > 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not create collator for locale");
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    mal_gc_unroot(&root_span);
    return mal_value_from_i32(result);
#else
    (void) locales;
    (void) options;
    return intl_fallback_locale_compare(vm, this_string, start, length, that_value);
#endif
}

#if MAL_INTL_HAS_COLLATOR
static void intl_install_collator(MalVm *vm, MalObject *intl_object) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "Collator"), 0, intl_collator_constructor
    );
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_INTL_COLLATOR_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_INTL_COLLATOR_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_INTL_COLLATOR_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_INTL_COLLATOR_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    intl_set_to_string_tag(vm, prototype, "Intl.Collator");

    mal_intrinsic_define_method_n(vm, constructor_object, "supportedLocalesOf", 1, intl_collator_supported_locales_of);
    intl_define_getter(vm, prototype, "compare", intl_collator_get_compare);
    mal_intrinsic_define_method_n(vm, prototype, "resolvedOptions", 0, intl_collator_resolved_options);

    mal_intrinsic_define_data(vm, intl_object, "Collator", vm->intrinsics[MAL_INTRINSIC_INTL_COLLATOR_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

#endif // MAL_INTL_HAS_COLLATOR — install

// ---------------------------------------------------------------------------
// Intl.PluralRules
// ---------------------------------------------------------------------------

#if MAL_INTL_HAS_PLURAL_RULES
static const char *const PLURAL_CATEGORIES[6] = {"zero", "one", "two", "few", "many", "other"};

static MalValue intl_plural_rules_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    MalValue locales = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    MalValue roots[7] = {locales, options, new_target, mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_PLURAL_RULES_PROTOTYPE);
    if (prototype == nullptr) {
        goto done;
    }
    roots[3] = mal_value_from_object(prototype);
    MalString *locale = intl_resolve_locale(vm, locales);
    if (locale == nullptr) {
        goto done;
    }
    roots[4] = mal_value_from_string(locale);
    if (!intl_check_locale_matcher(vm, options)) {
        goto done;
    }
    static const char *const TYPES[] = {"cardinal", "ordinal"};
    bool ok;
    MalString *type = intl_option_enum(vm, options, "type", TYPES, countof(TYPES), "cardinal", &ok);
    if (!ok) {
        goto done;
    }
    roots[5] = mal_value_from_string(type);
    bool ordinal = intl_string_eq_ascii(type, "ordinal");

    byte locale_buf[160];
    usize locale_len;
    if (!intl_tag_utf8(locale, locale_buf, sizeof(locale_buf), &locale_len)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid locale");
        goto done;
    }
    void *handle = mal_i18n_plural_rules_new(locale_buf, locale_len, ordinal ? 1 : 0);
    if (handle == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not create plural rules for locale");
        goto done;
    }

    MalObject *resolved = mal_intrinsic_new_object(vm);
    roots[6] = mal_value_from_object(resolved);
    intl_resolved_set(vm, resolved, "locale", mal_value_from_string(locale));
    intl_resolved_set(vm, resolved, "type", mal_value_from_string(type));
    intl_resolved_set(vm, resolved, "minimumIntegerDigits", mal_value_from_i32(1));
    intl_resolved_set(vm, resolved, "minimumFractionDigits", mal_value_from_i32(0));
    intl_resolved_set(vm, resolved, "maximumFractionDigits", mal_value_from_i32(3));

    MalIntlObject *rules = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_PLURAL_RULES, handle, mal_value_from_object(resolved));
    result = mal_value_from_intl_object(rules);
 done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue intl_plural_rules_select(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    MalIntlObject *rules;
    if (!intl_this(vm, this_value, MAL_INTL_PLURAL_RULES, &rules, "Intl.PluralRules.prototype.select called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    f64 number;
    if (!mal_vm_to_number(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &number)) {
        return mal_value_new_undefined();
    }
    i32 category = mal_i18n_plural_category(rules->handle, number);
    if (category < 0 || category > 5) {
        category = 5;
    }
    return mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) PLURAL_CATEGORIES[category]));
}

static MalValue intl_plural_rules_resolved_options(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *rules;
    if (!intl_this(vm, this_value, MAL_INTL_PLURAL_RULES, &rules, "Intl.PluralRules.prototype.resolvedOptions called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    static const char *const keys[] = {"locale", "type", "minimumIntegerDigits", "minimumFractionDigits", "maximumFractionDigits"};
    return intl_resolved_copy(vm, rules->data, keys, countof(keys));
}

static MalValue intl_plural_rules_supported_locales_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) this_value;
    (void) nt;
    (void) cl;
    return intl_supported_locales_of_impl(vm, args, arg_count);
}

static void intl_install_plural_rules(MalVm *vm, MalObject *intl_object) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "PluralRules"), 0, intl_plural_rules_constructor
    );
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_INTL_PLURAL_RULES_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_INTL_PLURAL_RULES_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_INTL_PLURAL_RULES_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_INTL_PLURAL_RULES_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    intl_set_to_string_tag(vm, prototype, "Intl.PluralRules");

    mal_intrinsic_define_method_n(vm, constructor_object, "supportedLocalesOf", 1, intl_plural_rules_supported_locales_of);
    mal_intrinsic_define_method_n(vm, prototype, "select", 1, intl_plural_rules_select);
    mal_intrinsic_define_method_n(vm, prototype, "resolvedOptions", 0, intl_plural_rules_resolved_options);

    mal_intrinsic_define_data(vm, intl_object, "PluralRules", vm->intrinsics[MAL_INTRINSIC_INTL_PLURAL_RULES_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

#endif // MAL_INTL_HAS_PLURAL_RULES

// Exact decimal inputs share rounding and UTF-16 numeric parts across output paths.

static i32 intl_data_int(MalVm *vm, MalValue data, const char *key, i32 fallback) {
    MalValue value;
    if (intl_data_get(vm, data, key, &value) && mal_ops_is_number(value)) {
        return (i32) mal_ops_number_as_f64(value);
    }
    return fallback;
}

static MalString *intl_data_string(MalVm *vm, MalValue data, const char *key) {
    MalValue value;
    if (intl_data_get(vm, data, key, &value) && mal_value_is_string(value)) {
        return mal_value_to_string(value);
    }
    return nullptr;
}

#if MAL_INTL_HAS_NUMBER_FORMAT
/** signDisplay values in FFI-code order (mirrors mal_i18n.h / SignDisplay in lib.rs). */
static const char *const INTL_SIGN_DISPLAYS[] = {"auto", "never", "always", "exceptZero", "negative"};

/** Maps a resolved signDisplay string to its mal_i18n_number_format code (0..4). */
static i32 intl_sign_display_code(MalString *sign_display) {
    if (sign_display != nullptr) {
        for (usize i = 0; i < countof(INTL_SIGN_DISPLAYS); i++) {
            if (intl_string_eq_ascii(sign_display, INTL_SIGN_DISPLAYS[i])) {
                return (i32) i;
            }
        }
    }
    return 0; // "auto"
}

typedef enum IntlSignTag { INTL_SIGN_NONE, INTL_SIGN_POSITIVE, INTL_SIGN_NEGATIVE } IntlSignTag;

/**
 * Mirrors fixed_decimal's Decimal::apply_sign_display for the two non-finite
 * shapes the Rust formatter never sees (NaN, +/-Infinity): NaN has no sign and
 * counts as zero-valued (so exceptZero/negative suppress it like a
 * rounded-to-zero value), while Infinity's sign follows the input's sign bit
 * and never counts as zero.
 */
static IntlSignTag intl_apply_sign_display(i32 sign_display_code, IntlSignTag sign, bool is_zero) {
    switch (sign_display_code) {
        case 1: // never
            return INTL_SIGN_NONE;
        case 2: // always
            return sign == INTL_SIGN_NEGATIVE ? INTL_SIGN_NEGATIVE : INTL_SIGN_POSITIVE;
        case 3: // exceptZero
            if (is_zero) {
                return INTL_SIGN_NONE;
            }
            return sign == INTL_SIGN_NEGATIVE ? INTL_SIGN_NEGATIVE : INTL_SIGN_POSITIVE;
        case 4: // negative
            if (sign != INTL_SIGN_NEGATIVE || is_zero) {
                return INTL_SIGN_NONE;
            }
            return INTL_SIGN_NEGATIVE;
        default: // auto
            return sign == INTL_SIGN_NEGATIVE ? INTL_SIGN_NEGATIVE : INTL_SIGN_NONE;
    }
}

/** Locale-agnostic ±∞ / NaN rendering for non-finite inputs (en symbols), honoring signDisplay. */
static MalValue intl_nonfinite_number(MalVm *vm, f64 number, i32 sign_display_code) {
    if (isnan(number)) {
        IntlSignTag tag = intl_apply_sign_display(sign_display_code, INTL_SIGN_NONE, true);
        c16 units[4];
        usize n = 0;
        if (tag == INTL_SIGN_POSITIVE) {
            units[n++] = '+';
        }
        units[n++] = 'N';
        units[n++] = 'a';
        units[n++] = 'N';
        return mal_value_from_string(mal_string_new_copy(&vm->heap, units, n));
    }
    IntlSignTag start = number < 0 ? INTL_SIGN_NEGATIVE : INTL_SIGN_NONE;
    IntlSignTag tag = intl_apply_sign_display(sign_display_code, start, false);
    c16 units[2];
    usize n = 0;
    if (tag == INTL_SIGN_NEGATIVE) {
        units[n++] = '-';
    } else if (tag == INTL_SIGN_POSITIVE) {
        units[n++] = '+';
    }
    units[n++] = 0x221E; // U+221E INFINITY
    return mal_value_from_string(mal_string_new_copy(&vm->heap, units, n));
}

static MalValue intl_numeric_result(MalVm *vm, const c16 *units, usize length, const MalI18nNumericPart *spans, usize span_count, bool to_parts, bool with_unit);

typedef struct IntlNumericInput {
    const byte *text;
    usize length;
    i32 kind;
    u32 radix;
    byte *allocation;
} IntlNumericInput;

static bool intl_numeric_input(MalVm *vm, MalValue *value, byte *stack, usize capacity, IntlNumericInput *input) {
    MalValue primitive = *value;
    if (mal_value_is_object(primitive) && !mal_vm_to_primitive(vm, primitive, MAL_TO_PRIMITIVE_NUMBER, &primitive)) return false;
    *value = primitive;
    if (mal_value_is_bigint(primitive)) {
        *value = mal_value_from_string(mal_bigint_to_string(&vm->heap, mal_bigint_value(mal_value_to_bigint(primitive)), 10));
    }
    if (mal_value_is_string(*value)) {
        MalString *string = mal_value_to_string(*value);
        const c16 *units = mal_string_code_units(string);
        usize start = 0, end = mal_string_length(string);
        while (start < end && mal_ecma_is_string_whitespace(units[start])) start++;
        while (start < end && mal_ecma_is_string_whitespace(units[end - 1])) end--;
        usize length = end - start;
        if (length == 0) { input->text = (const byte *) "0"; input->length = 1; return true; }
        for (usize i = start; i < end; i++) if (units[i] > 0x7f) { input->kind = 3; return true; }
        byte *text = length <= capacity ? stack : malloc(length);
        if (text == nullptr) { mal_vm_throw_allocation_error(vm); return false; }
        if (text != stack) input->allocation = text;
        for (usize i = 0; i < length; i++) text[i] = (byte) units[start + i];
        input->text = text;
        input->length = length;
        if ((length == 8 && memcmp(text, "Infinity", 8) == 0) || (length == 9 && memcmp(text, "+Infinity", 9) == 0)) { input->kind = 4; return true; }
        if (length == 9 && memcmp(text, "-Infinity", 9) == 0) { input->kind = 5; return true; }
        if (length >= 2 && text[0] == '0') {
            u32 radix = text[1] == 'x' || text[1] == 'X' ? 16 : text[1] == 'o' || text[1] == 'O' ? 8 : text[1] == 'b' || text[1] == 'B' ? 2 : 0;
            if (radix != 0) {
                bool valid = length > 2;
                for (usize i = 2; i < length; i++) {
                    u32 ch = text[i];
                    u32 digit = ch >= '0' && ch <= '9' ? ch - '0' : ch >= 'a' && ch <= 'f' ? ch - 'a' + 10 : ch >= 'A' && ch <= 'F' ? ch - 'A' + 10 : 16;
                    if (digit >= radix) valid = false;
                }
                input->kind = valid ? 1 : 3;
                input->radix = radix;
                return true;
            }
        }
        if (mal_number_decimal_prefix_length(text, length) != length) { input->kind = 3; return true; }
        return true;
    }
    f64 number;
    if (mal_ops_is_number(*value)) number = mal_ops_number_as_f64(*value);
    else if (!mal_vm_to_number(vm, *value, &number)) return false;
    if (!isfinite(number)) { input->kind = isnan(number) ? 3 : number < 0 ? 5 : 4; return true; }
    if (number == 0 && signbit(number)) { input->kind = 2; return true; }
    usize length = mal_number_format_shortest_plain(number, stack);
    if (length == 0) {
        i32 written = mal_number_format_shortest(number, stack, (i32) capacity);
        if (written < 0 || (usize) written > capacity) { mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not convert number"); return false; }
        length = (usize) written;
    }
    input->text = stack;
    input->length = length;
    return true;
}

static MalValue intl_number_format_render(MalVm *vm, MalValue owner, MalValue input_value, bool to_parts) {
    MalValue roots[] = {owner, input_value};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalIntlObject *nf = mal_value_to_intl_object(owner);
    byte input_stack[128];
    IntlNumericInput input = {0};
    c16 stack[256];
    MalI18nNumericPart stack_spans[24];
    c16 *units = stack;
    MalI18nNumericPart *spans = stack_spans;
    if (!intl_numeric_input(vm, &roots[1], input_stack, sizeof(input_stack), &input)) goto done;
    usize spans_needed = 0;
    i32 needed = mal_i18n_number_formatter_format(nf->handle, input.text, input.length, input.kind, input.radix, (uint16_t *) units, countof(stack), to_parts ? spans : nullptr, to_parts ? countof(stack_spans) : 0, to_parts ? &spans_needed : nullptr);
    if (needed < 0) goto format_error;
    if ((usize) needed > countof(stack) || spans_needed > countof(stack_spans)) {
        usize bytes;
        if ((usize) needed > countof(stack)) {
            if (!mal_checked_size_multiply((usize) needed, sizeof(*units), SIZE_MAX, &bytes)) goto allocation_error;
            units = malloc(bytes);
            if (units == nullptr) goto allocation_error;
        }
        if (spans_needed > countof(stack_spans)) {
            if (!mal_checked_size_multiply(spans_needed, sizeof(*spans), SIZE_MAX, &bytes)) goto allocation_error;
            spans = malloc(bytes);
            if (spans == nullptr) goto allocation_error;
        }
        usize expected_parts = spans_needed;
        if (mal_i18n_number_formatter_format(nf->handle, input.text, input.length, input.kind, input.radix, (uint16_t *) units, units == stack ? countof(stack) : (usize) needed, to_parts ? spans : nullptr, to_parts ? (spans == stack_spans ? countof(stack_spans) : spans_needed) : 0, to_parts ? &spans_needed : nullptr) != needed || spans_needed != expected_parts) goto format_error;
    }
    result = intl_numeric_result(vm, units, (usize) needed, spans, spans_needed, to_parts, false);
    goto done;
 allocation_error:
    mal_vm_throw_allocation_error(vm);
    goto done;
 format_error:
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format number");
 done:
    if (input.allocation != nullptr) free(input.allocation);
    if (units != stack) free(units);
    if (spans != stack_spans) free(spans);
    mal_gc_unroot(&root);
    return result;
}

static MalValue intl_number_format_default_en_us(MalVm *vm, f64 number) {
    byte text[128];
    usize length;
    if (number == 0 && signbit(number)) {
        memcpy(text, "-0", 2);
        length = 2;
    } else {
        length = mal_number_format_shortest_plain(number, text);
        if (length == 0) {
            i32 written = mal_number_format_shortest(number, text, (i32) sizeof(text));
            if (written <= 0 || (usize) written > sizeof(text)) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not convert number");
                return mal_value_new_undefined();
            }
            length = (usize) written;
            for (usize i = 1; i < length; i++) {
                if (text[i] == '+' && text[i - 1] == 'e') {
                    memmove(text + i, text + i + 1, length - i - 1);
                    length--;
                    break;
                }
            }
        }
    }
    byte out[512];
    i32 n = mal_i18n_number_format_default_en_us(text, length, out, (i32) sizeof(out));
    if (n < 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format number");
        return mal_value_new_undefined();
    }
    if (n <= (i32) sizeof(out)) {
        return intl_string_from_utf8(vm, out, (usize) n);
    }
    byte *big = malloc((usize) n);
    if (big == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    if (mal_i18n_number_format_default_en_us(text, length, big, n) != n) {
        free(big);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format number");
        return mal_value_new_undefined();
    }
    MalValue result = intl_string_from_utf8(vm, big, (usize) n);
    free(big);
    return result;
}

static MalValue intl_number_format_value(MalVm *vm, MalIntlObject *nf, f64 number) {
    return intl_number_format_render(vm, mal_value_from_intl_object(nf), mal_ops_number_value(number), false);
}

static MalValue intl_number_format_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value; (void) callee;
    MalValue roots[14] = {arg_count >= 1 ? args[0] : mal_value_new_undefined(), arg_count >= 2 ? args[1] : mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_NUMBER_FORMAT_PROTOTYPE);
    if (prototype == nullptr) goto done;
    roots[2] = mal_value_from_object(prototype);
    MalString *locale = intl_resolve_locale(vm, roots[0]);
    if (locale == nullptr) goto done;
    roots[3] = mal_value_from_string(locale);
    if (!intl_coerce_options_to_object(vm, roots[1], &roots[1])) goto done;
    MalValue options = roots[1];
    if (!intl_check_locale_matcher(vm, options)) goto done;
    bool present;
    MalString *numbering = nullptr;
    if (!intl_option_string(vm, options, "numberingSystem", &numbering, &present)) goto done;
    if (present) {
        roots[4] = mal_value_from_string(numbering);
        if (!intl_is_valid_unicode_type(numbering)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid numberingSystem");
            goto done;
        }
    }
    static const char *const STYLES[] = {"decimal", "percent", "currency", "unit"};
    bool ok;
    MalString *style = intl_option_enum(vm, options, "style", STYLES, countof(STYLES), "decimal", &ok);
    if (!ok) goto done;
    roots[5] = mal_value_from_string(style);
    i32 style_code = 0;
    for (usize i = 0; i < countof(STYLES); i++) if (intl_string_eq_ascii(style, STYLES[i])) style_code = (i32) i;
    bool percent = style_code == 1;
    MalString *currency = nullptr;
    if (!intl_option_string(vm, options, "currency", &currency, &present)) goto done;
    if (currency == nullptr && style_code == 2) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "currency is required");
        goto done;
    }
    if (currency != nullptr) {
        bool valid = mal_string_length(currency) == 3;
        for (usize i = 0; valid && i < 3; i++) {
            c16 code = mal_string_code_unit_at(currency, i);
            valid = (code >= 'A' && code <= 'Z') || (code >= 'a' && code <= 'z');
        }
        if (!valid) { mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid currency"); goto done; }
    }
    static const char *const CURRENCY_DISPLAYS[] = {"code", "symbol", "narrowSymbol", "name"};
    (void) intl_option_enum(vm, options, "currencyDisplay", CURRENCY_DISPLAYS, countof(CURRENCY_DISPLAYS), "symbol", &ok);
    if (!ok) goto done;
    static const char *const CURRENCY_SIGNS[] = {"standard", "accounting"};
    (void) intl_option_enum(vm, options, "currencySign", CURRENCY_SIGNS, countof(CURRENCY_SIGNS), "standard", &ok);
    if (!ok) goto done;
    MalString *unit = nullptr;
    if (!intl_option_string(vm, options, "unit", &unit, &present)) goto done;
    byte unit_bytes[64];
    usize unit_len = 0;
    if (unit != nullptr) {
        roots[9] = mal_value_from_string(unit);
        if (!intl_tag_utf8(unit, unit_bytes, sizeof(unit_bytes), &unit_len) || !mal_i18n_unit_is_valid(unit_bytes, unit_len)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid unit");
            goto done;
        }
    } else if (style_code == 3) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "unit is required");
        goto done;
    }
    static const char *const UNIT_DISPLAYS[] = {"long", "short", "narrow"};
    MalString *unit_display = intl_option_enum(vm, options, "unitDisplay", UNIT_DISPLAYS, countof(UNIT_DISPLAYS), "short", &ok);
    if (!ok) goto done;
    roots[11] = mal_value_from_string(unit_display);
    i32 unit_width = intl_string_eq_ascii(unit_display, "long") ? 0 : intl_string_eq_ascii(unit_display, "narrow") ? 2 : 1;
    i32 min_integer, min_fraction = 0, max_fraction = 3;
    i32 min_significant = 0, max_significant = 0;
    bool has_significant;
    i32 rounding_code = 0, increment = 1, priority = 0;
    bool strip_zero = false;
    if (!intl_number_format_digits(vm, options, percent, &min_integer, &min_fraction, &max_fraction, &min_significant, &max_significant, &has_significant, &roots[7], &rounding_code, &increment, &roots[12], &priority, &roots[13], &strip_zero)) goto done;
    i32 grouping = 1;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "useGrouping"), &roots[8])) goto done;
    if (mal_value_is_undefined(roots[8])) {
        grouping = 1;
    } else if (mal_value_is_boolean(roots[8]) && mal_value_is_truthy(roots[8])) {
        grouping = 2;
    } else if (!mal_value_is_truthy(roots[8])) {
        grouping = 0;
    } else {
        MalString *text;
        if (!mal_vm_to_string(vm, roots[8], &text)) goto done;
        roots[8] = mal_value_from_string(text);
        if (intl_string_eq_ascii(text, "always")) { grouping = 2; }
        else if (intl_string_eq_ascii(text, "min2")) { grouping = 3; }
        else if (!intl_string_eq_ascii(text, "auto") && !intl_string_eq_ascii(text, "true") && !intl_string_eq_ascii(text, "false")) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid useGrouping");
            goto done;
        }
    }
    MalString *sign = intl_option_enum(vm, options, "signDisplay", INTL_SIGN_DISPLAYS, countof(INTL_SIGN_DISPLAYS), "auto", &ok);
    if (!ok) goto done;
    roots[6] = mal_value_from_string(sign);
    MalIntlObject *nf = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_NUMBER_FORMAT, nullptr, mal_value_new_undefined());
    roots[10] = mal_value_from_intl_object(nf);
    usize locale_len = mal_string_length(locale);
    usize numbering_len = numbering == nullptr ? 0 : mal_string_length(numbering);
    usize bytes_needed;
    if (!mal_checked_size_add(locale_len, numbering_len, SIZE_MAX - 2, &bytes_needed)) { mal_vm_throw_allocation_error(vm); goto done; }
    bytes_needed += 2;
    byte stack[256];
    byte *bytes = bytes_needed <= sizeof(stack) ? stack : malloc(bytes_needed);
    if (bytes == nullptr) { mal_vm_throw_allocation_error(vm); goto done; }
    byte *numbering_bytes = bytes + locale_len + 1;
    bool ascii = intl_tag_utf8(locale, bytes, locale_len + 1, &locale_len);
    if (numbering != nullptr) ascii = ascii && intl_tag_utf8(numbering, numbering_bytes, numbering_len + 1, &numbering_len);
    MalI18nNumberResolved native = {0};
    if (ascii) nf->handle = mal_i18n_number_formatter_new(bytes, locale_len, numbering_bytes, numbering_len, style_code, unit_bytes, unit_len, unit_width, min_integer, min_fraction, max_fraction, min_significant, max_significant, grouping, intl_sign_display_code(sign), rounding_code, increment, priority, strip_zero, &native);
    if (nf->handle != nullptr) mal_heap_charge_external(&vm->heap, native.heap_bytes);
    if (bytes != stack) free(bytes);
    if (nf->handle == nullptr) { mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not create number formatter"); goto done; }
    result = roots[10];
 done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue intl_number_format_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    MalValue owner = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    return intl_number_format_render(vm, owner, arg_count >= 1 ? args[0] : mal_value_new_undefined(), false);
}

static MalValue intl_number_format_format_to_parts(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt; (void) cl;
    MalIntlObject *nf;
    if (!intl_this(vm, this_value, MAL_INTL_NUMBER_FORMAT, &nf, "Intl.NumberFormat.prototype.formatToParts called on incompatible receiver")) return mal_value_new_undefined();
    return intl_number_format_render(vm, this_value, arg_count >= 1 ? args[0] : mal_value_new_undefined(), true);
}

static MalValue intl_number_format_get_format(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *nf;
    if (!intl_this(vm, this_value, MAL_INTL_NUMBER_FORMAT, &nf, "get Intl.NumberFormat.prototype.format called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(nf->bound)) {
        MalValue slots[1] = {this_value};
        MalNativeFunctionObject *fn = mal_native_function_object_new_with_slots(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, ""), intl_number_format_callback, slots, 1
        );
        nf->bound = mal_value_from_native_function_object(fn);
        // Lazily cached bound format fn on a possibly-old Intl object -> young fn.
        mal_gc_card(&nf->object.header, nf->bound);
    }
    return nf->bound;
}

static MalValue intl_number_format_resolved_options(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *nf;
    if (!intl_this(vm, this_value, MAL_INTL_NUMBER_FORMAT, &nf, "Intl.NumberFormat.prototype.resolvedOptions called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    MalValue roots[17];
    roots[0] = this_value;
    for (usize i = 1; i < countof(roots); i++) roots[i] = mal_value_new_undefined();
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalI18nNumberResolved native;
    mal_i18n_number_formatter_resolved(nf->handle, &native);
    static const char *const STYLES[] = {"decimal", "percent", "currency", "unit"};
    static const char *const GROUPINGS[] = {"", "auto", "always", "min2"};
    static const char *const ROUNDINGS[] = {"halfExpand", "ceil", "floor", "expand", "trunc", "halfCeil", "halfFloor", "halfTrunc", "halfEven"};
    static const char *const PRIORITIES[] = {"auto", "morePrecision", "lessPrecision"};
    static const char *const KEYS[] = {
        "locale", "numberingSystem", "style", "unit", "unitDisplay", "minimumIntegerDigits", "minimumFractionDigits", "maximumFractionDigits",
        "minimumSignificantDigits", "maximumSignificantDigits", "useGrouping", "signDisplay", "roundingIncrement",
        "roundingMode", "roundingPriority", "trailingZeroDisplay",
    };
    roots[1] = mal_value_from_string(mal_string_new_ascii(&vm->heap, native.locale, native.locale_len));
    roots[2] = mal_value_from_string(mal_string_new_ascii(&vm->heap, native.numbering, native.numbering_len));
    roots[3] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) STYLES[native.style]));
    if (native.style == 3) {
        roots[4] = mal_value_from_string(mal_string_new_ascii(&vm->heap, native.unit, native.unit_len));
        static const char *const UNIT_DISPLAYS[] = {"long", "short", "narrow"};
        roots[5] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) UNIT_DISPLAYS[native.unit_display]));
    }
    roots[6] = mal_value_from_i32(native.min_integer);
    roots[7] = mal_value_from_i32(native.min_fraction);
    roots[8] = mal_value_from_i32(native.max_fraction);
    roots[9] = mal_value_from_i32(native.min_significant);
    roots[10] = mal_value_from_i32(native.max_significant);
    roots[11] = native.grouping == 0 ? mal_value_new_boolean(false) : mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) GROUPINGS[native.grouping]));
    roots[12] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) INTL_SIGN_DISPLAYS[native.sign_display]));
    roots[13] = mal_value_from_i32(native.increment);
    roots[14] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) ROUNDINGS[native.rounding_mode]));
    roots[15] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) PRIORITIES[native.priority]));
    roots[16] = mal_value_from_string(mal_intrinsic_ascii(vm, native.strip_zero ? "stripIfInteger" : "auto"));
    MalString *keys[countof(KEYS)];
    MalValue values[countof(KEYS)];
    u32 count = 0;
    for (usize i = 0; i < countof(KEYS); i++) {
        if ((i == 3 || i == 4) && native.style != 3) continue;
        if ((i == 6 || i == 7) && native.max_significant > 0 && native.priority == 0) continue;
        if ((i == 8 || i == 9) && native.max_significant == 0) continue;
        keys[count] = mal_value_to_string(mal_intrinsic_string_key(vm, KEYS[i]).value);
        values[count++] = roots[i + 1];
    }
    MalShape *shape = mal_shape_from_string_keys(&vm->heap, keys, count);
    MalValue result = mal_vm_create_object_shaped(vm, shape, values, count);
    mal_gc_unroot(&root);
    return result;
}

static MalValue intl_number_format_supported_locales_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) this_value;
    (void) nt;
    (void) cl;
    return intl_supported_locales_of_impl(vm, args, arg_count);
}

#endif // MAL_INTL_HAS_NUMBER_FORMAT — number format service statics

// Number.prototype.toLocaleString: real NumberFormat when present, else base-10.
MalValue mal_intl_number_to_locale_string(MalVm *vm, f64 number, MalValue locales, MalValue options) {
#if MAL_INTL_HAS_NUMBER_FORMAT
    if (mal_value_is_undefined(locales) && mal_value_is_undefined(options)) {
        if (!isfinite(number)) {
            return intl_nonfinite_number(vm, number, 0);
        }
        return intl_number_format_default_en_us(vm, number);
    }
    MalValue ctor_args[2] = {locales, options};
    MalValue nf = intl_number_format_constructor(vm, mal_value_new_undefined(), ctor_args, 2, mal_value_new_undefined(), mal_value_new_undefined());
    if (!mal_value_is_intl_object(nf)) {
        return mal_value_new_undefined();
    }
    return intl_number_format_value(vm, mal_value_to_intl_object(nf), number);
#else
    (void) locales;
    (void) options;
    return intl_fallback_number_to_locale_string(vm, number);
#endif
}

#if MAL_INTL_HAS_NUMBER_FORMAT
static void intl_install_number_format(MalVm *vm, MalObject *intl_object) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "NumberFormat"), 0, intl_number_format_constructor
    );
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_INTL_NUMBER_FORMAT_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_INTL_NUMBER_FORMAT_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_INTL_NUMBER_FORMAT_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_INTL_NUMBER_FORMAT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    intl_set_to_string_tag(vm, prototype, "Intl.NumberFormat");

    mal_intrinsic_define_method_n(vm, constructor_object, "supportedLocalesOf", 1, intl_number_format_supported_locales_of);
    intl_define_getter(vm, prototype, "format", intl_number_format_get_format);
    mal_intrinsic_define_method_n(vm, prototype, "formatToParts", 1, intl_number_format_format_to_parts);
    mal_intrinsic_define_method_n(vm, prototype, "resolvedOptions", 0, intl_number_format_resolved_options);

    mal_intrinsic_define_data(vm, intl_object, "NumberFormat", vm->intrinsics[MAL_INTRINSIC_INTL_NUMBER_FORMAT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

#endif // MAL_INTL_HAS_NUMBER_FORMAT

// ---------------------------------------------------------------------------
// Intl.DateTimeFormat supports dateStyle/timeStyle; component options remain.
// ---------------------------------------------------------------------------

#if MAL_INTL_HAS_DATE_TIME_FORMAT
/** Map a style string to a code: 0 full, 1 long, 2 medium, 3 short; -1 none; -2 invalid. */
static i32 intl_date_style_code(const MalString *style) {
    if (style == nullptr) {
        return -1;
    }
    if (intl_string_eq_ascii(style, "full")) {
        return 0;
    }
    if (intl_string_eq_ascii(style, "long")) {
        return 1;
    }
    if (intl_string_eq_ascii(style, "medium")) {
        return 2;
    }
    if (intl_string_eq_ascii(style, "short")) {
        return 3;
    }
    return -2;
}

static MalValue intl_datetime_format_epoch(MalVm *vm, MalString *locale, f64 epoch, i32 date_code, i32 time_code) {
    i32 year, month, day, hour, minute, second;
    if (!mal_date_to_local_components(epoch, &year, &month, &day, &hour, &minute, &second)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid time value");
        return mal_value_new_undefined();
    }
    byte locale_buf[160];
    usize locale_len = 0;
    if (locale != nullptr) {
        intl_tag_utf8(locale, locale_buf, sizeof(locale_buf), &locale_len);
    }
    byte out[256];
    i32 n = mal_i18n_datetime_format(locale_buf, locale_len, year, month, day, hour, minute, second, date_code, time_code, out, (i32) sizeof(out));
    if (n < 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format date");
        return mal_value_new_undefined();
    }
    if (n <= (i32) sizeof(out)) {
        return intl_string_from_utf8(vm, out, (usize) n);
    }
    byte *big = malloc((usize) n);
    if (big == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    if (mal_i18n_datetime_format(locale_buf, locale_len, year, month, day, hour, minute, second, date_code, time_code, big, n) != n) {
        free(big);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format date");
        return mal_value_new_undefined();
    }
    MalValue result = intl_string_from_utf8(vm, big, (usize) n);
    free(big);
    return result;
}

static MalValue intl_datetime_format_epoch_handle(MalVm *vm, void *handle, f64 epoch) {
    i32 year, month, day, hour, minute, second;
    if (!mal_date_to_local_components(epoch, &year, &month, &day, &hour, &minute, &second)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid time value");
        return mal_value_new_undefined();
    }
    byte out[256];
    i32 n = mal_i18n_datetime_formatter_format(
        handle, year, month, day, hour, minute, second, out, (i32) sizeof(out));
    if (n < 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format date");
        return mal_value_new_undefined();
    }
    if (n <= (i32) sizeof(out)) {
        return intl_string_from_utf8(vm, out, (usize) n);
    }
    byte *big = malloc((usize) n);
    if (big == nullptr) {
        mal_vm_throw_allocation_error(vm);
        return mal_value_new_undefined();
    }
    if (mal_i18n_datetime_formatter_format(
            handle, year, month, day, hour, minute, second, big, n) != n) {
        free(big);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format date");
        return mal_value_new_undefined();
    }
    MalValue result = intl_string_from_utf8(vm, big, (usize) n);
    free(big);
    return result;
}

static MalValue intl_date_time_format_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    MalValue locales = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    MalValue roots[9] = {locales, options, new_target, mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_PROTOTYPE);
    if (prototype == nullptr) {
        goto done;
    }
    roots[3] = mal_value_from_object(prototype);
    MalString *locale = intl_resolve_locale(vm, locales);
    if (locale == nullptr) {
        goto done;
    }
    roots[4] = mal_value_from_string(locale);
    if (!intl_check_locale_matcher(vm, options)) {
        goto done;
    }
    bool present;
    MalString *date_style = nullptr;
    if (!intl_option_string(vm, options, "dateStyle", &date_style, &present)) {
        goto done;
    }
    if (date_style != nullptr) roots[5] = mal_value_from_string(date_style);
    MalString *time_style = nullptr;
    if (!intl_option_string(vm, options, "timeStyle", &time_style, &present)) {
        goto done;
    }
    if (time_style != nullptr) roots[6] = mal_value_from_string(time_style);
    i32 date_code = intl_date_style_code(date_style);
    i32 time_code = intl_date_style_code(time_style);
    if (date_code == -2 || time_code == -2) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid dateStyle/timeStyle");
        goto done;
    }
    if (date_code == -1 && time_code == -1) {
        date_code = 2; // empty options default to a medium date
    }

    byte tz[64];
    i32 tz_len = mal_i18n_local_tz_name(tz, (i32) sizeof(tz));
    MalString *time_zone = mal_string_new_ascii(&vm->heap, tz, (usize) (tz_len <= (i32) sizeof(tz) ? tz_len : (i32) sizeof(tz)));

    roots[7] = mal_value_from_string(time_zone);
    MalObject *resolved = mal_intrinsic_new_object(vm);
    roots[8] = mal_value_from_object(resolved);
    intl_resolved_set(vm, resolved, "locale", mal_value_from_string(locale));
    intl_resolved_set(vm, resolved, "calendar", mal_value_from_string(mal_intrinsic_ascii(vm, "gregory")));
    intl_resolved_set(vm, resolved, "numberingSystem", mal_value_from_string(mal_intrinsic_ascii(vm, "latn")));
    intl_resolved_set(vm, resolved, "timeZone", mal_value_from_string(time_zone));
    if (date_style != nullptr) {
        intl_resolved_set(vm, resolved, "dateStyle", mal_value_from_string(date_style));
    }
    if (time_style != nullptr) {
        intl_resolved_set(vm, resolved, "timeStyle", mal_value_from_string(time_style));
    }
    // Internal codes the format path reads back (not exposed by resolvedOptions).
    intl_resolved_set(vm, resolved, "dateStyleCode", mal_value_from_i32(date_code));
    intl_resolved_set(vm, resolved, "timeStyleCode", mal_value_from_i32(time_code));

    byte locale_buf[160];
    usize locale_len;
    if (!intl_tag_utf8(locale, locale_buf, sizeof(locale_buf), &locale_len)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not build date formatter");
        goto done;
    }
    void *handle = mal_i18n_datetime_formatter_new(
        locale_buf, locale_len, date_code, time_code);
    if (handle == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not build date formatter");
        goto done;
    }
    MalIntlObject *dtf = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_DATE_TIME_FORMAT, handle, mal_value_from_object(resolved));
    result = mal_value_from_intl_object(dtf);
 done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue intl_date_time_format_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    MalIntlObject *dtf = mal_value_to_intl_object(mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0));
    f64 epoch;
    if (arg_count < 1 || mal_value_is_undefined(args[0])) {
        epoch = mal_date_now_ms();
    } else if (!mal_vm_to_number(vm, args[0], &epoch)) {
        return mal_value_new_undefined();
    }
    return intl_datetime_format_epoch_handle(vm, dtf->handle, epoch);
}

static MalValue intl_date_time_format_get_format(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *dtf;
    if (!intl_this(vm, this_value, MAL_INTL_DATE_TIME_FORMAT, &dtf, "get Intl.DateTimeFormat.prototype.format called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    if (mal_value_is_undefined(dtf->bound)) {
        MalValue slots[1] = {this_value};
        MalNativeFunctionObject *fn = mal_native_function_object_new_with_slots(
            &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
            mal_intrinsic_ascii(vm, ""), intl_date_time_format_callback, slots, 1
        );
        dtf->bound = mal_value_from_native_function_object(fn);
        // Lazily cached bound format fn on a possibly-old Intl object -> young fn.
        mal_gc_card(&dtf->object.header, dtf->bound);
    }
    return dtf->bound;
}

static MalValue intl_date_time_format_resolved_options(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *dtf;
    if (!intl_this(vm, this_value, MAL_INTL_DATE_TIME_FORMAT, &dtf, "Intl.DateTimeFormat.prototype.resolvedOptions called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    static const char *const keys[] = {"locale", "calendar", "numberingSystem", "timeZone", "dateStyle", "timeStyle"};
    return intl_resolved_copy(vm, dtf->data, keys, countof(keys));
}

/** A date-range endpoint: ToNumber, then RangeError on a non-finite value. The
 * caller has already rejected undefined endpoints. false on a pending throw. */
static bool intl_date_range_arg(MalVm *vm, MalValue arg, f64 *out) {
    if (!mal_vm_to_number(vm, arg, out)) {
        return false;
    }
    if (!isfinite(*out)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid time value");
        return false;
    }
    return true;
}

/** PartitionDateTimeRangePattern (approximate): format both endpoints and join
 * them. ICU smart interval collapsing remains unsupported; this produces a correct,
 * readable range string and the right argument-validation behavior. */
static MalValue intl_date_time_format_range_string(MalVm *vm, MalIntlObject *dtf, MalValue start_arg, MalValue end_arg) {
    if (mal_value_is_undefined(start_arg) || mal_value_is_undefined(end_arg)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "formatRange requires two arguments");
        return mal_value_new_undefined();
    }
    f64 start;
    f64 end;
    if (!intl_date_range_arg(vm, start_arg, &start) || !intl_date_range_arg(vm, end_arg, &end)) {
        return mal_value_new_undefined();
    }
    MalValue start_str = intl_datetime_format_epoch_handle(vm, dtf->handle, start);
    if (!mal_value_is_string(start_str)) {
        return mal_value_new_undefined();
    }
    if (start == end) {
        return start_str;
    }
    MalValue end_str = intl_datetime_format_epoch_handle(vm, dtf->handle, end);
    if (!mal_value_is_string(end_str)) {
        return mal_value_new_undefined();
    }
    // Join with " – " (spaced en dash), the common interval separator.
    MalString *a = mal_value_to_string(start_str);
    MalString *b = mal_value_to_string(end_str);
    usize an = mal_string_length(a);
    usize bn = mal_string_length(b);
    usize total = an + 3 + bn;
    c16 *buf = malloc(sizeof(c16) * total);
    memcpy(buf, mal_string_code_units(a), an * sizeof(c16));
    buf[an] = ' ';
    buf[an + 1] = 0x2013;
    buf[an + 2] = ' ';
    memcpy(buf + an + 3, mal_string_code_units(b), bn * sizeof(c16));
    MalValue result = mal_value_from_string(mal_string_new_copy(&vm->heap, buf, total));
    free(buf);
    return result;
}

static MalValue intl_date_time_format_range(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    MalIntlObject *dtf;
    if (!intl_this(vm, this_value, MAL_INTL_DATE_TIME_FORMAT, &dtf, "Intl.DateTimeFormat.prototype.formatRange called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    return intl_date_time_format_range_string(
        vm, dtf, arg_count >= 1 ? args[0] : mal_value_new_undefined(), arg_count >= 2 ? args[1] : mal_value_new_undefined()
    );
}

static MalValue intl_date_time_format_range_to_parts(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    MalIntlObject *dtf;
    if (!intl_this(vm, this_value, MAL_INTL_DATE_TIME_FORMAT, &dtf, "Intl.DateTimeFormat.prototype.formatRangeToParts called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    MalValue formatted = intl_date_time_format_range_string(
        vm, dtf, arg_count >= 1 ? args[0] : mal_value_new_undefined(), arg_count >= 2 ? args[1] : mal_value_new_undefined()
    );
    if (!mal_value_is_string(formatted)) {
        return mal_value_new_undefined();
    }
    // Best-effort: a single literal part (exact field decomposition + source
    // tagging need ICU field positions, which the shim does not yet expose).
    MalArrayObject *parts = mal_intrinsic_new_array(vm, 0);
    MalObject *part = mal_intrinsic_new_object(vm);
    intl_resolved_set(vm, part, "type", mal_value_from_string(mal_intrinsic_ascii(vm, "literal")));
    intl_resolved_set(vm, part, "value", formatted);
    intl_resolved_set(vm, part, "source", mal_value_from_string(mal_intrinsic_ascii(vm, "shared")));
    intl_array_push(vm, parts, 0, mal_value_from_object(part));
    return mal_value_from_array_object(parts);
}

static MalValue intl_date_time_format_supported_locales_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) this_value;
    (void) nt;
    (void) cl;
    return intl_supported_locales_of_impl(vm, args, arg_count);
}

#endif // MAL_INTL_HAS_DATE_TIME_FORMAT — date/time format service statics

// Date.prototype.toLocale{,Date,Time}String: real DateTimeFormat when present,
// else a fixed non-localized civil-time render.
MalValue mal_intl_date_to_locale_string(MalVm *vm, f64 time_value, MalValue locales, MalValue options, i32 which) {
#if MAL_INTL_HAS_DATE_TIME_FORMAT
    if (!isfinite(time_value)) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, "Invalid Date"));
    }
    if (mal_value_is_undefined(locales) && mal_value_is_undefined(options)) {
        // The implementation's default locale is the intrinsic en-US atom.
        // With both inputs undefined CanonicalizeLocaleList and GetOption have
        // no observable user-code seams, so skip their transient list/options
        // work and use the per-method default DateTimeFormat plan directly.
        i32 date_code = which == 2 ? -1 : 2;
        i32 time_code = which == 1 ? -1 : 2;
        return intl_datetime_format_epoch(
            vm, mal_intrinsic_ascii(vm, "en-US"), time_value, date_code, time_code);
    }
    MalString *locale = intl_resolve_locale(vm, locales);
    if (locale == nullptr) {
        return mal_value_new_undefined();
    }
    bool present;
    MalString *date_style = nullptr;
    if (!intl_option_string(vm, options, "dateStyle", &date_style, &present)) {
        return mal_value_new_undefined();
    }
    MalString *time_style = nullptr;
    if (!intl_option_string(vm, options, "timeStyle", &time_style, &present)) {
        return mal_value_new_undefined();
    }
    i32 date_code = intl_date_style_code(date_style);
    i32 time_code = intl_date_style_code(time_style);
    if (date_code == -2 || time_code == -2) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid dateStyle/timeStyle");
        return mal_value_new_undefined();
    }
    // When neither style is given, apply the per-method default.
    if (date_code == -1 && time_code == -1) {
        if (which == 0) {
            date_code = 2;
            time_code = 2;
        } else if (which == 1) {
            date_code = 2;
        } else {
            time_code = 2;
        }
    }
    return intl_datetime_format_epoch(vm, locale, time_value, date_code, time_code);
#else
    (void) locales;
    (void) options;
    return intl_fallback_date_to_locale_string(vm, time_value, which);
#endif
}

#if MAL_INTL_HAS_DATE_TIME_FORMAT
static void intl_install_date_time_format(MalVm *vm, MalObject *intl_object) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "DateTimeFormat"), 0, intl_date_time_format_constructor
    );
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    intl_set_to_string_tag(vm, prototype, "Intl.DateTimeFormat");

    mal_intrinsic_define_method_n(vm, constructor_object, "supportedLocalesOf", 1, intl_date_time_format_supported_locales_of);
    intl_define_getter(vm, prototype, "format", intl_date_time_format_get_format);
    mal_intrinsic_define_method_n(vm, prototype, "formatRange", 2, intl_date_time_format_range);
    mal_intrinsic_define_method_n(vm, prototype, "formatRangeToParts", 2, intl_date_time_format_range_to_parts);
    mal_intrinsic_define_method_n(vm, prototype, "resolvedOptions", 0, intl_date_time_format_resolved_options);

    mal_intrinsic_define_data(vm, intl_object, "DateTimeFormat", vm->intrinsics[MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

#endif // MAL_INTL_HAS_DATE_TIME_FORMAT

// ---------------------------------------------------------------------------
// Intl.ListFormat — icu::list (conjunction/disjunction/unit; long/short/narrow).
// ---------------------------------------------------------------------------

#if MAL_INTL_HAS_LIST_FORMAT || MAL_INTL_HAS_RELATIVE_TIME_FORMAT
static i32 intl_length_code(const MalString *style) {
    if (style != nullptr && intl_string_eq_ascii(style, "short")) {
        return 1;
    }
    if (style != nullptr && intl_string_eq_ascii(style, "narrow")) {
        return 2;
    }
    return 0;
}
#endif

#if MAL_INTL_HAS_NUMBER_FORMAT || MAL_INTL_HAS_LIST_FORMAT || MAL_INTL_HAS_RELATIVE_TIME_FORMAT || MAL_INTL_HAS_DURATION_FORMAT
static MalObject *intl_parts_push(MalVm *vm, MalArrayObject *parts, u32 *index, const char *type, MalValue value) {
    MalValue roots[] = {mal_value_from_array_object(parts), value, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalObject *part = mal_intrinsic_new_object(vm);
    roots[2] = mal_value_from_object(part);
    intl_resolved_set(vm, part, "type", mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) type)));
    intl_resolved_set(vm, part, "value", roots[1]);
    intl_array_push(vm, parts, (*index)++, roots[2]);
    mal_gc_unroot(&root);
    return part;
}

#if MAL_INTL_HAS_NUMBER_FORMAT || MAL_INTL_HAS_DURATION_FORMAT
static MalValue intl_numeric_result(MalVm *vm, const c16 *units, usize length, const MalI18nNumericPart *spans, usize span_count, bool to_parts, bool with_unit) {
    MalValue roots[] = {mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalString *pool = mal_string_new_copy(&vm->heap, units, length);
    roots[0] = mal_value_from_string(pool);
    if (!to_parts) { mal_gc_unroot(&root); return roots[0]; }
    MalArrayObject *parts = mal_intrinsic_new_array(vm, 0);
    roots[1] = mal_value_from_array_object(parts);
    (void) mal_array_object_fresh_dense_reserve_exact(parts, (u32) span_count);
    static const char *const TYPES[] = {"literal", "integer", "group", "decimal", "fraction", "minusSign", "plusSign", "nan", "infinity", "percentSign", "unit"};
    static const char *const UNITS[] = {"year", "month", "week", "day", "hour", "minute", "second", "millisecond", "microsecond", "nanosecond"};
    u32 index = 0;
    for (usize i = 0; i < span_count; i++) {
        assert(spans[i].kind >= 0 && spans[i].kind < (i32) countof(TYPES));
        MalValue text = mal_value_from_string(mal_string_new_slice(&vm->heap, pool, spans[i].start, spans[i].len));
        MalObject *part = intl_parts_push(vm, parts, &index, TYPES[spans[i].kind], text);
        if (with_unit && spans[i].unit >= 0) {
            assert(spans[i].unit < (i32) countof(UNITS));
            intl_resolved_set(vm, part, "unit", mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) UNITS[spans[i].unit])));
        }
    }
    MalValue result = roots[1];
    mal_gc_unroot(&root);
    return result;
}
#endif

#endif

#if MAL_INTL_HAS_LIST_FORMAT
static i32 intl_list_type_code(const MalString *type) {
    if (type != nullptr && intl_string_eq_ascii(type, "disjunction")) {
        return 1;
    }
    if (type != nullptr && intl_string_eq_ascii(type, "unit")) {
        return 2;
    }
    return 0; // conjunction
}

static MalValue intl_list_format_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Intl.ListFormat must be called with new");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {
        arg_count >= 2 ? args[1] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_LIST_FORMAT_PROTOTYPE);
    if (prototype == nullptr) goto done;
    roots[1] = mal_value_from_object(prototype);
    MalString *locale = intl_resolve_locale(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (locale == nullptr) goto done;
    roots[2] = mal_value_from_string(locale);
    if (!intl_get_options_object(vm, roots[0], &roots[0]) || !intl_check_locale_matcher(vm, roots[0])) goto done;
    static const char *const TYPES[] = {"conjunction", "disjunction", "unit"};
    static const char *const STYLES[] = {"long", "short", "narrow"};
    bool ok;
    MalString *type = intl_option_enum(vm, roots[0], "type", TYPES, countof(TYPES), "conjunction", &ok);
    if (!ok) goto done;
    roots[3] = mal_value_from_string(type);
    MalString *style = intl_option_enum(vm, roots[0], "style", STYLES, countof(STYLES), "long", &ok);
    if (!ok) goto done;
    roots[4] = mal_value_from_string(style);

    MalObject *resolved = mal_intrinsic_new_object(vm);
    roots[5] = mal_value_from_object(resolved);
    intl_resolved_set(vm, resolved, "locale", roots[2]);
    intl_resolved_set(vm, resolved, "type", roots[3]);
    intl_resolved_set(vm, resolved, "style", roots[4]);
    MalIntlObject *lf = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_LIST_FORMAT, nullptr, roots[5]);
    roots[6] = mal_value_from_intl_object(lf);
    byte stack_locale[160];
    usize locale_len = mal_string_length(locale);
    byte *locale_buf = locale_len < sizeof(stack_locale) ? stack_locale : malloc(locale_len + 1);
    if (locale_buf == nullptr) {
        mal_vm_throw_allocation_error(vm);
        goto done;
    }
    if (!intl_tag_utf8(locale, locale_buf, locale_len + 1, &locale_len)) {
        if (locale_buf != stack_locale) free(locale_buf);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid list formatter locale");
        goto done;
    }
    lf->handle = mal_i18n_list_formatter_new(locale_buf, locale_len, intl_list_type_code(type), intl_length_code(style));
    if (locale_buf != stack_locale) free(locale_buf);
    if (lf->handle == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not create list formatter");
        goto done;
    }
    result = roots[6];
 done:
    mal_gc_unroot(&root);
    return result;
}

static MalArrayObject *intl_string_list_from_iterable(MalVm *vm, MalValue iterable, u32 *count_out) {
    MalValue roots[] = {
        iterable, mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalArrayObject *list = mal_intrinsic_new_array(vm, 0);
    roots[1] = mal_value_from_array_object(list);
    MalArrayObject *result = nullptr;
    *count_out = 0;
    if (mal_value_is_undefined(iterable)) {
        result = list;
        goto done;
    }
    MalIteratorRecord record;
    if (!mal_vm_get_iterator(vm, iterable, &record)) goto done;
    roots[2] = record.iterator;
    roots[3] = record.next_method;
    u32 count = 0;
    while (true) {
        bool finished;
        if (!mal_vm_iterator_step(vm, &record, &roots[4], &finished)) goto done;
        if (finished) break;
        if (!mal_value_is_string(roots[4])) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Intl.ListFormat list element must be a String");
            mal_vm_iterator_close(vm, &record);
            goto done;
        }
        if (count == INT32_MAX) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "list is too long");
            mal_vm_iterator_close(vm, &record);
            goto done;
        }
        if (mal_array_object_dense_store(list, count, roots[4]) != MAL_ARRAY_DENSE_APPLIED) {
            mal_vm_throw_allocation_error(vm);
            goto done;
        }
        list->length = ++count;
    }
    *count_out = count;
    result = list;
 done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue intl_list_format_result(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool to_parts) {
    MalIntlObject *lf;
    if (!intl_this(vm, this_value, MAL_INTL_LIST_FORMAT, &lf, "Intl.ListFormat method called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    MalValue roots[] = {this_value, mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalU16Str stack_items[16];
    MalI18nListLiteral stack_spans[17];
    c16 stack_literals[256];
    MalU16Str *items = stack_items;
    MalI18nListLiteral *spans = stack_spans;
    c16 *literals = stack_literals;
    u32 count;
    MalArrayObject *list = intl_string_list_from_iterable(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &count);
    if (list == nullptr) goto done;
    roots[1] = mal_value_from_array_object(list);
    MalArrayObject *parts = nullptr;
    u32 part_index = 0;
    if (to_parts) {
        if (count > (UINT32_MAX - 1) / 2) goto too_long;
        parts = mal_intrinsic_new_array(vm, 0);
        roots[2] = mal_value_from_array_object(parts);
    }
    if (count <= 1) {
        MalValue value = count == 0 ? mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) "")) : list->elements[0];
        if (to_parts && count == 1) intl_parts_push(vm, parts, &part_index, "element", value);
        result = to_parts ? roots[2] : value;
        goto done;
    }
    usize spans_count = (usize) count + 1;
    if (count > countof(stack_items)) {
        usize items_bytes, spans_bytes;
        if (!mal_checked_size_multiply(count, sizeof(*items), SIZE_MAX, &items_bytes) ||
            !mal_checked_size_multiply(spans_count, sizeof(*spans), SIZE_MAX, &spans_bytes)) goto too_long;
        items = malloc(items_bytes);
        spans = malloc(spans_bytes);
        if (items == nullptr || spans == nullptr) goto allocation_error;
    }
    // This private array is built only by sequential dense appends. Borrowing
    // its strings invokes no accessors, and Rust retains none of their pointers.
    assert(list->elements != nullptr && list->dense_count == count);
    for (u32 i = 0; i < count; i++) {
        MalString *element = mal_value_to_string(list->elements[i]);
        items[i].ptr = (const uint16_t *) mal_string_code_units(element);
        items[i].len = mal_string_length(element);
    }
    i32 literal_length = mal_i18n_list_formatter_literals(lf->handle, items, count, (uint16_t *) literals, countof(stack_literals), spans, spans_count);
    if (literal_length < 0) goto format_error;
    if ((usize) literal_length > countof(stack_literals)) {
        usize bytes;
        if (!mal_checked_size_multiply((usize) literal_length, sizeof(*literals), SIZE_MAX, &bytes)) goto too_long;
        literals = malloc(bytes);
        if (literals == nullptr) goto allocation_error;
        if (mal_i18n_list_formatter_literals(lf->handle, items, count, (uint16_t *) literals, (usize) literal_length, spans, spans_count) != literal_length) goto format_error;
    }
    if (to_parts) {
        MalString *pool = mal_string_new_copy(&vm->heap, literals, (usize) literal_length);
        roots[3] = mal_value_from_string(pool);
        for (usize i = 0; i < spans_count; i++) {
            if (spans[i].len != 0) {
                MalValue value = mal_value_from_string(mal_string_new_slice(&vm->heap, pool, spans[i].start, spans[i].len));
                intl_parts_push(vm, parts, &part_index, "literal", value);
            }
            if (i < count) intl_parts_push(vm, parts, &part_index, "element", list->elements[i]);
        }
        result = roots[2];
    } else {
        usize length = (usize) literal_length;
        for (u32 i = 0; i < count; i++) {
            if (!mal_checked_size_add(length, items[i].len, MAL_STRING_MAX_CODE_UNITS, &length)) goto too_long;
        }
        c16 stack_output[128];
        c16 *output = length <= countof(stack_output) ? stack_output : mal_heap_alloc_raw_profiled(&vm->heap, length * sizeof(c16), MAL_PROFILE_ALLOCATION_FAMILY_STRING);
        usize cursor = 0;
        for (usize i = 0; i < spans_count; i++) {
            memcpy(output + cursor, literals + spans[i].start, spans[i].len * sizeof(c16));
            cursor += spans[i].len;
            if (i < count) {
                memcpy(output + cursor, items[i].ptr, items[i].len * sizeof(c16));
                cursor += items[i].len;
            }
        }
        MalString *formatted = output == stack_output ? mal_string_new_copy(&vm->heap, output, length) : mal_string_new_owned(&vm->heap, output, length);
        result = mal_value_from_string(formatted);
    }
    goto done;
 too_long:
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "list is too long");
    goto done;
 allocation_error:
    mal_vm_throw_allocation_error(vm);
    goto done;
 format_error:
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format list");
 done:
    if (items != stack_items) free(items);
    if (spans != stack_spans) free(spans);
    if (literals != stack_literals) free(literals);
    mal_gc_unroot(&root);
    return result;
}

static MalValue intl_list_format_format(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    return intl_list_format_result(vm, this_value, args, arg_count, false);
}

static MalValue intl_list_format_format_to_parts(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    return intl_list_format_result(vm, this_value, args, arg_count, true);
}

static MalValue intl_list_format_resolved_options(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *lf;
    if (!intl_this(vm, this_value, MAL_INTL_LIST_FORMAT, &lf, "Intl.ListFormat.prototype.resolvedOptions called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    static const char *const keys[] = {"locale", "type", "style"};
    return intl_resolved_copy(vm, lf->data, keys, countof(keys));
}

static MalValue intl_list_format_supported_locales_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) this_value;
    (void) nt;
    (void) cl;
    return intl_supported_locales_of_impl(vm, args, arg_count);
}

static void intl_install_list_format(MalVm *vm, MalObject *intl_object) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "ListFormat"), 0, intl_list_format_constructor
    );
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_INTL_LIST_FORMAT_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_INTL_LIST_FORMAT_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_INTL_LIST_FORMAT_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_INTL_LIST_FORMAT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    intl_set_to_string_tag(vm, prototype, "Intl.ListFormat");

    mal_intrinsic_define_method_n(vm, constructor_object, "supportedLocalesOf", 1, intl_list_format_supported_locales_of);
    mal_intrinsic_define_method_n(vm, prototype, "format", 1, intl_list_format_format);
    mal_intrinsic_define_method_n(vm, prototype, "formatToParts", 1, intl_list_format_format_to_parts);
    mal_intrinsic_define_method_n(vm, prototype, "resolvedOptions", 0, intl_list_format_resolved_options);

    mal_intrinsic_define_data(vm, intl_object, "ListFormat", vm->intrinsics[MAL_INTRINSIC_INTL_LIST_FORMAT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

// ---------------------------------------------------------------------------
// Intl.DisplayNames — icu::experimental::displaynames (region/script/language).
// ---------------------------------------------------------------------------

#endif // MAL_INTL_HAS_LIST_FORMAT

#if MAL_INTL_HAS_DISPLAY_NAMES
static MalValue intl_display_names_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Intl.DisplayNames must be called with new");
        return mal_value_new_undefined();
    }
    MalValue locales = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    MalString *locale = intl_resolve_locale(vm, locales);
    if (locale == nullptr) {
        return mal_value_new_undefined();
    }
    // DisplayNames uses GetOptionsObject (options is required).
    if (!intl_get_options_object(vm, options, &options)) {
        return mal_value_new_undefined();
    }
    if (!intl_check_locale_matcher(vm, options)) {
        return mal_value_new_undefined();
    }

    static const char *const STYLES[] = {"narrow", "short", "long"};
    static const char *const TYPES[] = {"language", "region", "script", "currency", "calendar", "dateTimeField"};
    static const char *const FALLBACKS[] = {"code", "none"};
    static const char *const LANG_DISPLAY[] = {"dialect", "standard"};
    bool ok;
    MalString *style = intl_option_enum(vm, options, "style", STYLES, countof(STYLES), "long", &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }
    // `type` is required (no fallback); absent -> TypeError below.
    MalString *type = intl_option_enum(vm, options, "type", TYPES, countof(TYPES), nullptr, &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }
    if (type == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Intl.DisplayNames type option is required");
        return mal_value_new_undefined();
    }
    MalString *fallback = intl_option_enum(vm, options, "fallback", FALLBACKS, countof(FALLBACKS), "code", &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }
    MalString *language_display = intl_option_enum(vm, options, "languageDisplay", LANG_DISPLAY, countof(LANG_DISPLAY), "dialect", &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }

    MalObject *resolved = mal_intrinsic_new_object(vm);
    intl_resolved_set(vm, resolved, "locale", mal_value_from_string(locale));
    intl_resolved_set(vm, resolved, "style", mal_value_from_string(style));
    intl_resolved_set(vm, resolved, "type", mal_value_from_string(type));
    intl_resolved_set(vm, resolved, "fallback", mal_value_from_string(fallback));
    // languageDisplay is only present in resolvedOptions when type is "language".
    if (intl_string_eq_ascii(type, "language")) {
        intl_resolved_set(vm, resolved, "languageDisplay", mal_value_from_string(language_display));
    }

    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_DISPLAY_NAMES_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    MalIntlObject *dn = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_DISPLAY_NAMES, nullptr, mal_value_from_object(resolved));
    return mal_value_from_intl_object(dn);
}

static MalValue intl_display_names_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    MalIntlObject *dn;
    if (!intl_this(vm, this_value, MAL_INTL_DISPLAY_NAMES, &dn, "Intl.DisplayNames.prototype.of called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    MalString *code;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &code)) {
        return mal_value_new_undefined();
    }
    MalString *type = intl_data_string(vm, dn->data, "type");
    MalString *style = intl_data_string(vm, dn->data, "style");
    MalString *fallback = intl_data_string(vm, dn->data, "fallback");
    MalString *locale = intl_data_string(vm, dn->data, "locale");

    i32 kind;
    if (type != nullptr && intl_string_eq_ascii(type, "region")) {
        kind = 0;
    } else if (type != nullptr && intl_string_eq_ascii(type, "script")) {
        kind = 1;
    } else if (type != nullptr && intl_string_eq_ascii(type, "language")) {
        kind = 2;
    } else {
        // currency/calendar/dateTimeField: not backed by ICU here -> Fallback.
        kind = -1;
    }
    i32 style_code = 0;
    if (style != nullptr && intl_string_eq_ascii(style, "short")) {
        style_code = 1;
    } else if (style != nullptr && intl_string_eq_ascii(style, "narrow")) {
        style_code = 2;
    }

    byte locale_buf[160];
    usize locale_len = 0;
    if (locale != nullptr) {
        intl_tag_utf8(locale, locale_buf, sizeof(locale_buf), &locale_len);
    }
    byte code_buf[128];
    usize code_len;
    if (!intl_tag_utf8(code, code_buf, sizeof(code_buf), &code_len)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid code");
        return mal_value_new_undefined();
    }
    byte out[256];
    i32 n = kind >= 0 ? mal_i18n_display_name(locale_buf, locale_len, kind, style_code, code_buf, code_len, out, (i32) sizeof(out)) : -1;
    if (n == -2) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid code for Intl.DisplayNames");
        return mal_value_new_undefined();
    }
    if (n >= 0) {
        if (n <= (i32) sizeof(out)) {
            return intl_string_from_utf8(vm, out, (usize) n);
        }
        byte *big = malloc((usize) n);
        mal_i18n_display_name(locale_buf, locale_len, kind, style_code, code_buf, code_len, big, n);
        MalValue result = intl_string_from_utf8(vm, big, (usize) n);
        free(big);
        return result;
    }
    // No name found: "code" fallback returns the (canonicalized) code; "none"
    // returns undefined.
    if (fallback != nullptr && intl_string_eq_ascii(fallback, "none")) {
        return mal_value_new_undefined();
    }
    return mal_value_from_string(code);
}

static MalValue intl_display_names_resolved_options(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *dn;
    if (!intl_this(vm, this_value, MAL_INTL_DISPLAY_NAMES, &dn, "Intl.DisplayNames.prototype.resolvedOptions called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    static const char *const keys[] = {"locale", "style", "type", "fallback", "languageDisplay"};
    return intl_resolved_copy(vm, dn->data, keys, countof(keys));
}

static MalValue intl_display_names_supported_locales_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) this_value;
    (void) nt;
    (void) cl;
    return intl_supported_locales_of_impl(vm, args, arg_count);
}

static void intl_install_display_names(MalVm *vm, MalObject *intl_object) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "DisplayNames"), 2, intl_display_names_constructor
    );
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_INTL_DISPLAY_NAMES_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_INTL_DISPLAY_NAMES_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_INTL_DISPLAY_NAMES_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_INTL_DISPLAY_NAMES_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    intl_set_to_string_tag(vm, prototype, "Intl.DisplayNames");

    mal_intrinsic_define_method_n(vm, constructor_object, "supportedLocalesOf", 1, intl_display_names_supported_locales_of);
    mal_intrinsic_define_method_n(vm, prototype, "of", 1, intl_display_names_of);
    mal_intrinsic_define_method_n(vm, prototype, "resolvedOptions", 0, intl_display_names_resolved_options);

    mal_intrinsic_define_data(vm, intl_object, "DisplayNames", vm->intrinsics[MAL_INTRINSIC_INTL_DISPLAY_NAMES_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

#endif // MAL_INTL_HAS_DISPLAY_NAMES

// ---------------------------------------------------------------------------
// Intl.RelativeTimeFormat — icu::experimental::relativetime.
// ---------------------------------------------------------------------------

#if MAL_INTL_HAS_RELATIVE_TIME_FORMAT
static const char *const INTL_RELATIVE_UNITS[] = {"second", "minute", "hour", "day", "week", "month", "quarter", "year"};

/** SingularRelativeTimeUnit: map a unit string (singular or plural) to 0..7, or -1. */
static i32 intl_relative_unit_code(const MalString *unit) {
    static const char *const PLURAL[8] = {"seconds", "minutes", "hours", "days", "weeks", "months", "quarters", "years"};
    for (i32 i = 0; i < 8; i++) {
        if (intl_string_eq_ascii(unit, INTL_RELATIVE_UNITS[i]) || intl_string_eq_ascii(unit, PLURAL[i])) {
            return i;
        }
    }
    return -1;
}

static MalValue intl_relative_time_format_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Intl.RelativeTimeFormat must be called with new");
        return mal_value_new_undefined();
    }
    MalValue roots[] = {
        arg_count >= 1 ? args[0] : mal_value_new_undefined(),
        arg_count >= 2 ? args[1] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_RELATIVE_TIME_FORMAT_PROTOTYPE);
    if (prototype == nullptr) goto done;
    roots[2] = mal_value_from_object(prototype);
    MalString *locale = intl_resolve_locale(vm, roots[0]);
    if (locale == nullptr) goto done;
    roots[3] = mal_value_from_string(locale);
    // The private null-prototype default bag has no observable reads or identity.
    // The option readers treat undefined as that bag without allocating it.
    if (!mal_value_is_undefined(roots[1]) && !intl_coerce_options_to_object(vm, roots[1], &roots[1])) goto done;
    if (!intl_check_locale_matcher(vm, roots[1])) goto done;
    bool ns_present;
    MalString *numbering = nullptr;
    if (!intl_option_string(vm, roots[1], "numberingSystem", &numbering, &ns_present)) goto done;
    if (ns_present) {
        roots[4] = mal_value_from_string(numbering);
        if (!intl_is_valid_unicode_type(numbering)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid numberingSystem");
            goto done;
        }
    }
    static const char *const STYLES[] = {"long", "short", "narrow"};
    static const char *const NUMERICS[] = {"always", "auto"};
    bool ok;
    MalString *style = intl_option_enum(vm, roots[1], "style", STYLES, countof(STYLES), "long", &ok);
    if (!ok) goto done;
    roots[5] = mal_value_from_string(style);
    MalString *numeric = intl_option_enum(vm, roots[1], "numeric", NUMERICS, countof(NUMERICS), "always", &ok);
    if (!ok) goto done;
    roots[6] = mal_value_from_string(numeric);
    MalObject *resolved = mal_intrinsic_new_object(vm);
    roots[7] = mal_value_from_object(resolved);
    MalIntlObject *rtf = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_RELATIVE_TIME_FORMAT, nullptr, roots[7]);
    roots[8] = mal_value_from_intl_object(rtf);
    usize locale_len = mal_string_length(locale);
    usize numbering_len = ns_present ? mal_string_length(numbering) : 0;
    usize bytes_needed;
    if (!mal_checked_size_add(locale_len, numbering_len, SIZE_MAX - 2, &bytes_needed)) {
        mal_vm_throw_allocation_error(vm);
        goto done;
    }
    bytes_needed += 2;
    byte stack[256];
    byte *bytes = bytes_needed <= sizeof(stack) ? stack : malloc(bytes_needed);
    if (bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        goto done;
    }
    byte *numbering_bytes = bytes + locale_len + 1;
    bool ascii = intl_tag_utf8(locale, bytes, locale_len + 1, &locale_len);
    if (ns_present) ascii = ascii && intl_tag_utf8(numbering, numbering_bytes, numbering_len + 1, &numbering_len);
    MalI18nRelativeResolved native = {0};
    if (ascii) rtf->handle = mal_i18n_relative_time_new(bytes, locale_len, numbering_bytes, numbering_len, intl_length_code(style), intl_string_eq_ascii(numeric, "auto"), &native);
    if (rtf->handle != nullptr) mal_heap_charge_external(&vm->heap, native.heap_bytes);
    if (bytes != stack) free(bytes);
    if (rtf->handle == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not create relative time formatter");
        goto done;
    }
    roots[9] = native.locale_matches_input ? roots[3] : mal_value_from_string(mal_string_new_ascii(&vm->heap, native.locale, native.locale_len));
    intl_resolved_set(vm, resolved, "locale", roots[9]);
    roots[9] = mal_value_from_string(mal_string_new_ascii(&vm->heap, native.numbering_system, native.numbering_len));
    intl_resolved_set(vm, resolved, "style", roots[5]);
    intl_resolved_set(vm, resolved, "numeric", roots[6]);
    intl_resolved_set(vm, resolved, "numberingSystem", roots[9]);
    result = roots[8];
 done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue intl_relative_time_result(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool to_parts) {
    MalIntlObject *rtf;
    if (!intl_this(vm, this_value, MAL_INTL_RELATIVE_TIME_FORMAT, &rtf, "Intl.RelativeTimeFormat method called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    MalValue roots[] = {
        this_value,
        arg_count >= 1 ? args[0] : mal_value_new_undefined(),
        arg_count >= 2 ? args[1] : mal_value_new_undefined(),
        mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(),
    };
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    c16 stack[256];
    MalI18nRelativePart stack_spans[24];
    c16 *units = stack;
    MalI18nRelativePart *spans = stack_spans;
    f64 value;
    if (!mal_vm_to_number(vm, roots[1], &value)) goto done;
    MalString *unit;
    if (!mal_vm_to_string(vm, roots[2], &unit)) goto done;
    roots[2] = mal_value_from_string(unit);
    if (!isfinite(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Intl.RelativeTimeFormat value must be finite");
        goto done;
    }
    i32 unit_code = intl_relative_unit_code(unit);
    if (unit_code < 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid unit for Intl.RelativeTimeFormat");
        goto done;
    }
    usize spans_needed = 0;
    i32 needed = mal_i18n_relative_time_format(rtf->handle, value, unit_code, (uint16_t *) units, countof(stack), to_parts ? spans : nullptr, to_parts ? countof(stack_spans) : 0, to_parts ? &spans_needed : nullptr);
    if (needed < 0) goto format_error;
    if ((usize) needed > countof(stack) || spans_needed > countof(stack_spans)) {
        usize bytes;
        if ((usize) needed > countof(stack)) {
            if (!mal_checked_size_multiply((usize) needed, sizeof(*units), SIZE_MAX, &bytes)) goto allocation_error;
            units = malloc(bytes);
            if (units == nullptr) goto allocation_error;
        }
        if (spans_needed > countof(stack_spans)) {
            if (!mal_checked_size_multiply(spans_needed, sizeof(*spans), SIZE_MAX, &bytes)) goto allocation_error;
            spans = malloc(bytes);
            if (spans == nullptr) goto allocation_error;
        }
        usize expected_parts = spans_needed;
        if (mal_i18n_relative_time_format(rtf->handle, value, unit_code, (uint16_t *) units, units == stack ? countof(stack) : (usize) needed, to_parts ? spans : nullptr, to_parts ? (spans == stack_spans ? countof(stack_spans) : spans_needed) : 0, to_parts ? &spans_needed : nullptr) != needed || spans_needed != expected_parts) goto format_error;
    }
    MalString *pool = mal_string_new_copy(&vm->heap, units, (usize) needed);
    roots[3] = mal_value_from_string(pool);
    if (!to_parts) {
        result = roots[3];
        goto done;
    }
    MalArrayObject *parts = mal_intrinsic_new_array(vm, 0);
    roots[4] = mal_value_from_array_object(parts);
    roots[5] = mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) INTL_RELATIVE_UNITS[unit_code]));
    static const char *const TYPES[] = {"literal", "integer", "group", "decimal", "fraction"};
    u32 index = 0;
    for (usize i = 0; i < spans_needed; i++) {
        assert(spans[i].kind >= 0 && spans[i].kind < (i32) countof(TYPES));
        MalValue text = mal_value_from_string(mal_string_new_slice(&vm->heap, pool, spans[i].start, spans[i].len));
        MalObject *part = intl_parts_push(vm, parts, &index, TYPES[spans[i].kind], text);
        if (spans[i].kind != MAL_RELATIVE_LITERAL) intl_resolved_set(vm, part, "unit", roots[5]);
    }
    result = roots[4];
    goto done;
 allocation_error:
    mal_vm_throw_allocation_error(vm);
    goto done;
 format_error:
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format relative time");
 done:
    if (units != stack) free(units);
    if (spans != stack_spans) free(spans);
    mal_gc_unroot(&root);
    return result;
}

static MalValue intl_relative_time_format_format(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    return intl_relative_time_result(vm, this_value, args, arg_count, false);
}

static MalValue intl_relative_time_format_format_to_parts(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    return intl_relative_time_result(vm, this_value, args, arg_count, true);
}

static MalValue intl_relative_time_format_resolved_options(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *rtf;
    if (!intl_this(vm, this_value, MAL_INTL_RELATIVE_TIME_FORMAT, &rtf, "Intl.RelativeTimeFormat.prototype.resolvedOptions called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    static const char *const keys[] = {"locale", "style", "numeric", "numberingSystem"};
    return intl_resolved_copy(vm, rtf->data, keys, countof(keys));
}

static MalValue intl_relative_time_format_supported_locales_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) this_value;
    (void) nt;
    (void) cl;
    return intl_supported_locales_of_impl(vm, args, arg_count);
}

static void intl_install_relative_time_format(MalVm *vm, MalObject *intl_object) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "RelativeTimeFormat"), 0, intl_relative_time_format_constructor
    );
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_INTL_RELATIVE_TIME_FORMAT_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_INTL_RELATIVE_TIME_FORMAT_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_INTL_RELATIVE_TIME_FORMAT_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_INTL_RELATIVE_TIME_FORMAT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    intl_set_to_string_tag(vm, prototype, "Intl.RelativeTimeFormat");

    mal_intrinsic_define_method_n(vm, constructor_object, "supportedLocalesOf", 1, intl_relative_time_format_supported_locales_of);
    mal_intrinsic_define_method_n(vm, prototype, "format", 2, intl_relative_time_format_format);
    mal_intrinsic_define_method_n(vm, prototype, "formatToParts", 2, intl_relative_time_format_format_to_parts);
    mal_intrinsic_define_method_n(vm, prototype, "resolvedOptions", 0, intl_relative_time_format_resolved_options);

    mal_intrinsic_define_data(vm, intl_object, "RelativeTimeFormat", vm->intrinsics[MAL_INTRINSIC_INTL_RELATIVE_TIME_FORMAT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

#endif // MAL_INTL_HAS_RELATIVE_TIME_FORMAT

// ---------------------------------------------------------------------------
// Intl.Segmenter — icu::segmenter (grapheme / word / sentence). The segment()
// result is a Segments object (kind MAL_INTL_SEGMENTS) that is iterable and has
// containing(); iteration yields Segment Iterators (kind MAL_INTL_SEGMENT_ITERATOR).
// ---------------------------------------------------------------------------

#if MAL_INTL_HAS_SEGMENTER
static i32 intl_segment_granularity_code(const MalString *g) {
    if (g != nullptr && intl_string_eq_ascii(g, "word")) {
        return 1;
    }
    if (g != nullptr && intl_string_eq_ascii(g, "sentence")) {
        return 2;
    }
    return 0; // grapheme
}

/** Compute segment boundaries as UTF-16 indices. Caller frees both outputs.
 * Returns their count, or zero with a pending allocation exception. */
static usize intl_segment_bounds(MalVm *vm, MalString *input, i32 gran, i32 **bounds_out, u8 **wordlike_out) {
    usize len = mal_string_length(input);
    // Endpoints fit signed indices; the boundary count can be one larger.
    usize cap = len + 1;
    usize bounds_bytes;
    if (!mal_checked_size_multiply(sizeof(i32), cap, SIZE_MAX, &bounds_bytes)) {
        mal_vm_throw_allocation_error(vm);
        return 0;
    }
    i32 *bounds = malloc(bounds_bytes);
    u8 *wordlike = calloc(cap, sizeof(u8));
    if (bounds == nullptr || wordlike == nullptr) {
        free(bounds);
        free(wordlike);
        mal_vm_throw_allocation_error(vm);
        return 0;
    }
    usize n = mal_i18n_segment(gran, (const uint16_t *) mal_string_code_units(input), len, bounds, wordlike, cap);
    *bounds_out = bounds;
    *wordlike_out = wordlike;
    return n;
}

/** Build a segment data object: { segment, index, input, [isWordLike] }. */
static MalValue intl_make_segment_data(MalVm *vm, MalString *input, i32 start, i32 end, i32 gran, bool word_like) {
    MalObject *data = mal_intrinsic_new_object(vm);
    MalValue segment = mal_value_from_string(
        mal_string_new_slice(&vm->heap, input, (usize) start, (usize) (end - start))
    );
    intl_resolved_set(vm, data, "segment", segment);
    intl_resolved_set(vm, data, "index", mal_value_from_i32(start));
    intl_resolved_set(vm, data, "input", mal_value_from_string(input));
    if (gran == 1) {
        intl_resolved_set(vm, data, "isWordLike", mal_value_new_boolean(word_like));
    }
    return mal_value_from_object(data);
}

static MalValue intl_segmenter_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Intl.Segmenter must be called with new");
        return mal_value_new_undefined();
    }
    MalValue locales = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    MalString *locale = intl_resolve_locale(vm, locales);
    if (locale == nullptr) {
        return mal_value_new_undefined();
    }
    if (!intl_get_options_object(vm, options, &options)) {
        return mal_value_new_undefined();
    }
    if (!intl_check_locale_matcher(vm, options)) {
        return mal_value_new_undefined();
    }
    static const char *const GRANULARITIES[] = {"grapheme", "word", "sentence"};
    bool ok;
    MalString *granularity = intl_option_enum(vm, options, "granularity", GRANULARITIES, countof(GRANULARITIES), "grapheme", &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }

    MalObject *resolved = mal_intrinsic_new_object(vm);
    intl_resolved_set(vm, resolved, "locale", mal_value_from_string(locale));
    intl_resolved_set(vm, resolved, "granularity", mal_value_from_string(granularity));

    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_SEGMENTER_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    MalIntlObject *seg = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_SEGMENTER, nullptr, mal_value_from_object(resolved));
    return mal_value_from_intl_object(seg);
}

static MalValue intl_segmenter_segment(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    MalIntlObject *seg;
    if (!intl_this(vm, this_value, MAL_INTL_SEGMENTER, &seg, "Intl.Segmenter.prototype.segment called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    MalString *input;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &input)) {
        return mal_value_new_undefined();
    }
    // A Segments object stores the input + the resolved granularity/locale.
    MalObject *segments_data = mal_intrinsic_new_object(vm);
    intl_resolved_set(vm, segments_data, "input", mal_value_from_string(input));
    intl_resolved_set(vm, segments_data, "granularity", mal_value_from_string(intl_data_string(vm, seg->data, "granularity")));
    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_INTL_SEGMENTS_PROTOTYPE]);
    MalIntlObject *segments = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_SEGMENTS, nullptr, mal_value_from_object(segments_data));
    return mal_value_from_intl_object(segments);
}

static MalValue intl_segmenter_resolved_options(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *seg;
    if (!intl_this(vm, this_value, MAL_INTL_SEGMENTER, &seg, "Intl.Segmenter.prototype.resolvedOptions called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    static const char *const keys[] = {"locale", "granularity"};
    return intl_resolved_copy(vm, seg->data, keys, countof(keys));
}

static MalValue intl_segmenter_supported_locales_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) this_value;
    (void) nt;
    (void) cl;
    return intl_supported_locales_of_impl(vm, args, arg_count);
}

// ---- %Segments.prototype% ----

static MalValue intl_segments_containing(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    MalIntlObject *segments;
    if (!intl_this(vm, this_value, MAL_INTL_SEGMENTS, &segments, "Intl.Segments.prototype.containing called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    MalString *input = intl_data_string(vm, segments->data, "input");
    i32 gran = intl_segment_granularity_code(intl_data_string(vm, segments->data, "granularity"));
    f64 index_f;
    if (!mal_vm_to_number(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &index_f)) {
        return mal_value_new_undefined();
    }
    index_f = isnan(index_f) ? 0.0 : trunc(index_f);
    i32 len = (i32) mal_string_length(input);
    if (index_f < 0.0 || index_f >= (f64) len) {
        return mal_value_new_undefined();
    }
    i32 index = (i32) index_f;
    i32 *bounds;
    u8 *wordlike;
    usize count = intl_segment_bounds(vm, input, gran, &bounds, &wordlike);
    if (count == 0) return mal_value_new_undefined();
    MalValue result = mal_value_new_undefined();
    for (usize i = 0; i + 1 < count; i++) {
        if (index >= bounds[i] && index < bounds[i + 1]) {
            result = intl_make_segment_data(vm, input, bounds[i], bounds[i + 1], gran, wordlike[i] != 0);
            break;
        }
    }
    free(bounds);
    free(wordlike);
    return result;
}

static MalValue intl_segments_iterator(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *segments;
    if (!intl_this(vm, this_value, MAL_INTL_SEGMENTS, &segments, "Intl.Segments.prototype[@@iterator] called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    MalString *input = intl_data_string(vm, segments->data, "input");
    i32 gran = intl_segment_granularity_code(intl_data_string(vm, segments->data, "granularity"));
    i32 *bounds;
    u8 *wordlike;
    usize count = intl_segment_bounds(vm, input, gran, &bounds, &wordlike);
    if (count == 0) return mal_value_new_undefined();

    MalArrayObject *bounds_array = mal_intrinsic_new_array(vm, 0);
    MalArrayObject *wl_array = mal_intrinsic_new_array(vm, 0);
    (void) mal_array_object_fresh_dense_reserve_exact(
        bounds_array, (u32) count);
    (void) mal_array_object_fresh_dense_reserve_exact(
        wl_array, count > 0 ? (u32) count - 1 : 0);
    for (usize i = 0; i < count; i++) {
        intl_array_push(vm, bounds_array, (u32) i, mal_value_from_i32(bounds[i]));
    }
    for (usize i = 0; i + 1 < count; i++) {
        intl_array_push(vm, wl_array, (u32) i, mal_value_new_boolean(wordlike[i] != 0));
    }
    free(bounds);
    free(wordlike);

    MalObject *iter_data = mal_intrinsic_new_object(vm);
    intl_resolved_set(vm, iter_data, "input", mal_value_from_string(input));
    intl_resolved_set(vm, iter_data, "granularity", intl_data_string(vm, segments->data, "granularity") != nullptr ? mal_value_from_string(intl_data_string(vm, segments->data, "granularity")) : mal_value_new_undefined());
    intl_resolved_set(vm, iter_data, "bounds", mal_value_from_array_object(bounds_array));
    intl_resolved_set(vm, iter_data, "wordlike", mal_value_from_array_object(wl_array));
    intl_resolved_set(vm, iter_data, "pos", mal_value_from_i32(0));

    MalObject *prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_INTL_SEGMENT_ITERATOR_PROTOTYPE]);
    MalIntlObject *iter = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_SEGMENT_ITERATOR, nullptr, mal_value_from_object(iter_data));
    return mal_value_from_intl_object(iter);
}

static MalValue intl_segment_iterator_next(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *iter;
    if (!intl_this(vm, this_value, MAL_INTL_SEGMENT_ITERATOR, &iter, "Segment Iterator.prototype.next called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    MalString *input = intl_data_string(vm, iter->data, "input");
    i32 gran = intl_segment_granularity_code(intl_data_string(vm, iter->data, "granularity"));
    u32 pos = (u32) intl_data_int(vm, iter->data, "pos", 0);

    MalValue bounds_value;
    mal_vm_get_property(vm, iter->data, mal_intrinsic_string_key(vm, "bounds"), &bounds_value);
    MalValue wl_value;
    mal_vm_get_property(vm, iter->data, mal_intrinsic_string_key(vm, "wordlike"), &wl_value);

    MalValue length_value;
    mal_vm_get_property(vm, bounds_value, mal_intrinsic_string_key(vm, "length"), &length_value);
    u32 count = mal_ops_is_number(length_value) ? (u32) mal_ops_number_as_f64(length_value) : 0;
    if (pos + 1 >= count) {
        return mal_vm_create_iter_result(vm, mal_value_new_undefined(), true);
    }

    MalKey start_key = mal_key_index(pos);
    MalKey end_key = mal_key_index(pos + 1);
    MalValue start_v, end_v;
    mal_vm_get_property(vm, bounds_value, start_key, &start_v);
    mal_vm_get_property(vm, bounds_value, end_key, &end_v);
    i32 start = (i32) mal_ops_number_as_f64(start_v);
    i32 end = (i32) mal_ops_number_as_f64(end_v);
    bool word_like = false;
    MalValue wl_elem;
    if (mal_vm_get_property(vm, wl_value, start_key, &wl_elem)) {
        word_like = mal_value_is_truthy(wl_elem);
    }

    MalValue data = intl_make_segment_data(vm, input, start, end, gran, word_like);
    intl_resolved_set(vm, mal_value_to_object(iter->data), "pos", mal_value_from_i32((i32) (pos + 1)));
    return mal_vm_create_iter_result(vm, data, false);
}

static void intl_install_segmenter(MalVm *vm, MalObject *intl_object) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "Segmenter"), 0, intl_segmenter_constructor
    );
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_INTL_SEGMENTER_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_INTL_SEGMENTER_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_INTL_SEGMENTER_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_INTL_SEGMENTER_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    intl_set_to_string_tag(vm, prototype, "Intl.Segmenter");

    mal_intrinsic_define_method_n(vm, constructor_object, "supportedLocalesOf", 1, intl_segmenter_supported_locales_of);
    mal_intrinsic_define_method_n(vm, prototype, "segment", 1, intl_segmenter_segment);
    mal_intrinsic_define_method_n(vm, prototype, "resolvedOptions", 0, intl_segmenter_resolved_options);

    // %Segments.prototype%: ordinary object (no constructor, no @@toStringTag).
    MalObject *segments_proto = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    vm->intrinsics[MAL_INTRINSIC_INTL_SEGMENTS_PROTOTYPE] = mal_value_from_object(segments_proto);
    mal_intrinsic_define_method_n(vm, segments_proto, "containing", 1, intl_segments_containing);
    {
        MalNativeFunctionObject *iter_fn = mal_native_function_object_new_arity(
            &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "[Symbol.iterator]"), 0, intl_segments_iterator
        );
        MalPropertyDesc desc = mal_intrinsic_data_desc(
            mal_value_from_native_function_object(iter_fn), MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE
        );
        mal_object_define_own(segments_proto, mal_intrinsic_symbol_key(vm, MAL_INTRINSIC_SYMBOL_ITERATOR), &desc);
    }

    // %SegmentIterator.prototype% inherits %IteratorPrototype%.
    MalObject *iter_proto = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_ITERATOR_PROTOTYPE]));
    vm->intrinsics[MAL_INTRINSIC_INTL_SEGMENT_ITERATOR_PROTOTYPE] = mal_value_from_object(iter_proto);
    mal_intrinsic_define_method_n(vm, iter_proto, "next", 0, intl_segment_iterator_next);
    intl_set_to_string_tag(vm, iter_proto, "Segmenter String Iterator");

    mal_intrinsic_define_data(vm, intl_object, "Segmenter", vm->intrinsics[MAL_INTRINSIC_INTL_SEGMENTER_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

#endif

#if MAL_INTL_HAS_DURATION_FORMAT
static const struct {
    const char *unit;
    const char *display;
    i32 group;
    const char *digital_default;
} DURATION_UNITS[10] = {
    {"years", "yearsDisplay", 0, "short"},
    {"months", "monthsDisplay", 0, "short"},
    {"weeks", "weeksDisplay", 0, "short"},
    {"days", "daysDisplay", 0, "short"},
    {"hours", "hoursDisplay", 1, "numeric"},
    {"minutes", "minutesDisplay", 1, "numeric"},
    {"seconds", "secondsDisplay", 1, "numeric"},
    {"milliseconds", "millisecondsDisplay", 2, "numeric"},
    {"microseconds", "microsecondsDisplay", 2, "numeric"},
    {"nanoseconds", "nanosecondsDisplay", 2, "numeric"},
};

static const char *const DUR_STYLES_DATE[] = {"long", "short", "narrow"};
static const char *const DUR_STYLES_TIME[] = {"long", "short", "narrow", "numeric", "2-digit"};
static const char *const DUR_STYLES_SUBSEC[] = {"long", "short", "narrow", "numeric"};

/** GetOption(options, name, "string", allowed): the matched static string, or
 * null when absent; *ok=false (throw) on an out-of-list value. */
static const char *dur_get_style(MalVm *vm, MalValue options, const char *name, const char *const *allowed, usize count, bool *ok) {
    *ok = true;
    bool present;
    MalString *s = nullptr;
    if (!intl_option_string(vm, options, name, &s, &present)) {
        *ok = false;
        return nullptr;
    }
    if (!present || s == nullptr) {
        return nullptr;
    }
    for (usize i = 0; i < count; i++) {
        if (intl_string_eq_ascii(s, allowed[i])) {
            return allowed[i];
        }
    }
    mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid duration unit style");
    *ok = false;
    return nullptr;
}

static bool dur_str_eq(const char *a, const char *b) {
    return a != nullptr && strcmp(a, b) == 0;
}

static MalValue intl_duration_format_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Intl.DurationFormat must be called with new");
        return mal_value_new_undefined();
    }
    MalValue locales = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    MalValue roots[] = {locales, options, mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined(), mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    u8 styles[10], displays[10];
    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_DURATION_FORMAT_PROTOTYPE);
    if (prototype == nullptr) goto done;
    roots[2] = mal_value_from_object(prototype);
    MalString *locale = intl_resolve_locale(vm, locales);
    if (locale == nullptr) {
        goto done;
    }
    roots[3] = mal_value_from_string(locale);
    if (!intl_get_options_object(vm, options, &options)) {
        goto done;
    }
    roots[1] = options;
    if (!intl_check_locale_matcher(vm, options)) {
        goto done;
    }

    bool present;
    MalString *numbering_system = nullptr;
    if (!intl_option_string(vm, options, "numberingSystem", &numbering_system, &present)) {
        goto done;
    }
    if (present) roots[4] = mal_value_from_string(numbering_system);
    if (present && !intl_is_valid_unicode_type(numbering_system)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid numberingSystem");
        goto done;
    }

    static const char *const BASE_STYLES[] = {"long", "short", "narrow", "digital"};
    bool ok;
    MalString *base = intl_option_enum(vm, options, "style", BASE_STYLES, countof(BASE_STYLES), "short", &ok);
    if (!ok) {
        goto done;
    }
    roots[5] = mal_value_from_string(base);
    bool digital = intl_string_eq_ascii(base, "digital");
    const char *base_cstr = digital ? "digital" : (intl_string_eq_ascii(base, "long") ? "long" : (intl_string_eq_ascii(base, "narrow") ? "narrow" : "short"));

    MalObject *resolved = mal_intrinsic_new_object(vm);
    roots[6] = mal_value_from_object(resolved);
    intl_resolved_set(vm, resolved, "locale", mal_value_from_string(locale));
    intl_resolved_set(vm, resolved, "numberingSystem", mal_value_from_string(numbering_system != nullptr ? numbering_system : mal_intrinsic_ascii(vm, "latn")));
    intl_resolved_set(vm, resolved, "style", mal_value_from_string(base));

    const char *prev_style = nullptr;
    for (i32 i = 0; i < 10; i++) {
        const char *const *allowed = DURATION_UNITS[i].group == 0 ? DUR_STYLES_DATE : (DURATION_UNITS[i].group == 1 ? DUR_STYLES_TIME : DUR_STYLES_SUBSEC);
        usize allowed_n = DURATION_UNITS[i].group == 0 ? countof(DUR_STYLES_DATE) : (DURATION_UNITS[i].group == 1 ? countof(DUR_STYLES_TIME) : countof(DUR_STYLES_SUBSEC));
        const char *style = dur_get_style(vm, options, DURATION_UNITS[i].unit, allowed, allowed_n, &ok);
        if (!ok) {
            goto done;
        }
        const char *display_default = "always";
        if (style == nullptr) {
            if (digital) {
                bool is_hms = DURATION_UNITS[i].group == 1;
                if (!is_hms) {
                    display_default = "auto";
                }
                style = DURATION_UNITS[i].digital_default;
            } else {
                if (dur_str_eq(prev_style, "fractional") || dur_str_eq(prev_style, "numeric") || dur_str_eq(prev_style, "2-digit")) {
                    display_default = (i == 5 || i == 6) ? "always" : "auto";
                    style = "numeric";
                } else {
                    display_default = "auto";
                    style = base_cstr;
                }
            }
        }
        if (dur_str_eq(style, "numeric") && DURATION_UNITS[i].group == 2) {
            style = "fractional";
            display_default = "auto";
        }
        static const char *const DISPLAYS[] = {"auto", "always"};
        const char *display = dur_get_style(vm, options, DURATION_UNITS[i].display, DISPLAYS, countof(DISPLAYS), &ok);
        if (!ok) {
            goto done;
        }
        if (display == nullptr) {
            display = display_default;
        }
        if (dur_str_eq(display, "always") && dur_str_eq(style, "fractional")) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "fractional unit cannot be displayed always");
            goto done;
        }
        if (dur_str_eq(prev_style, "fractional") && !dur_str_eq(style, "fractional")) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "a unit after a fractional unit must be fractional");
            goto done;
        }
        if (dur_str_eq(prev_style, "numeric") || dur_str_eq(prev_style, "2-digit")) {
            if (!dur_str_eq(style, "fractional") && !dur_str_eq(style, "numeric") && !dur_str_eq(style, "2-digit")) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid unit style after numeric");
                goto done;
            }
            if (i == 5 || i == 6) {
                style = "2-digit";
            }
        }
        styles[i] = dur_str_eq(style, "long") ? 0 : dur_str_eq(style, "short") ? 1 : dur_str_eq(style, "narrow") ? 2 : dur_str_eq(style, "numeric") ? 3 : dur_str_eq(style, "2-digit") ? 4 : 5;
        displays[i] = dur_str_eq(display, "always");
        intl_resolved_set(vm, resolved, DURATION_UNITS[i].unit, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) (dur_str_eq(style, "fractional") ? "numeric" : style))));
        intl_resolved_set(vm, resolved, DURATION_UNITS[i].display, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) display)));
        prev_style = style;
    }

    i32 fractional_digits = -1;
    MalValue fd_value;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "fractionalDigits"), &fd_value)) goto done;
    if (!mal_value_is_undefined(fd_value)) {
        roots[8] = fd_value;
        f64 fd;
        if (!mal_vm_to_number(vm, fd_value, &fd)) {
            goto done;
        }
        if (isnan(fd) || fd < 0.0 || fd > 9.0) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "fractionalDigits out of range");
            goto done;
        }
        fractional_digits = (i32) floor(fd);
        intl_resolved_set(vm, resolved, "fractionalDigits", mal_value_from_i32(fractional_digits));
    }

    MalIntlObject *df = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_DURATION_FORMAT, nullptr, roots[6]);
    roots[7] = mal_value_from_intl_object(df);
    usize locale_len = mal_string_length(locale);
    usize numbering_len = numbering_system == nullptr ? 0 : mal_string_length(numbering_system);
    usize needed;
    if (!mal_checked_size_add(locale_len, numbering_len, SIZE_MAX - 2, &needed)) {
        mal_vm_throw_allocation_error(vm);
        goto done;
    }
    needed += 2;
    byte stack[256];
    byte *bytes = needed <= sizeof(stack) ? stack : malloc(needed);
    if (bytes == nullptr) {
        mal_vm_throw_allocation_error(vm);
        goto done;
    }
    byte *numbering = bytes + locale_len + 1;
    bool ascii = intl_tag_utf8(locale, bytes, locale_len + 1, &locale_len);
    if (numbering_system != nullptr) ascii = ascii && intl_tag_utf8(numbering_system, numbering, numbering_len + 1, &numbering_len);
    MalI18nDurationResolved native = {0};
    if (ascii) df->handle = mal_i18n_duration_new(bytes, locale_len, numbering, numbering_len, digital ? 3 : intl_string_eq_ascii(base, "long") ? 0 : intl_string_eq_ascii(base, "narrow") ? 2 : 1, fractional_digits, styles, displays, &native);
    if (df->handle != nullptr) mal_heap_charge_external(&vm->heap, native.heap_bytes);
    if (bytes != stack) free(bytes);
    if (df->handle == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not create duration formatter");
        goto done;
    }
    roots[8] = mal_value_from_string(mal_string_new_ascii(&vm->heap, native.locale, native.locale_len));
    intl_resolved_set(vm, resolved, "locale", roots[8]);
    roots[8] = mal_value_from_string(mal_string_new_ascii(&vm->heap, native.numbering, native.numbering_len));
    intl_resolved_set(vm, resolved, "numberingSystem", roots[8]);
    if (native.two_digit_hours && styles[4] == 3) intl_resolved_set(vm, resolved, "hours", mal_value_from_string(mal_intrinsic_ascii(vm, "2-digit")));
    result = roots[7];
 done:
    mal_gc_unroot(&root);
    return result;
}

// ToIntegerIfIntegral is immediate; mixed-sign and aggregate bounds follow all reads.
static bool intl_to_duration_record(MalVm *vm, MalValue input, f64 *units) {
    if (mal_value_is_string(input)) {
        MalString *text = mal_value_to_string(input);
        if (mal_i18n_duration_parse(mal_string_code_units(text), mal_string_length(text), units) == 0) return true;
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid duration string");
        return false;
    }
#if MAL_TEMPORAL
    if (mal_value_is_temporal_object(input)) {
        MalTemporalObject *object = mal_value_to_temporal_object(input);
        if (object->kind == MAL_TEMPORAL_DURATION && object->handle != nullptr) {
            units[0] = (f64) temporal_rs_Duration_years(object->handle);
            units[1] = (f64) temporal_rs_Duration_months(object->handle);
            units[2] = (f64) temporal_rs_Duration_weeks(object->handle);
            units[3] = (f64) temporal_rs_Duration_days(object->handle);
            units[4] = (f64) temporal_rs_Duration_hours(object->handle);
            units[5] = (f64) temporal_rs_Duration_minutes(object->handle);
            units[6] = (f64) temporal_rs_Duration_seconds(object->handle);
            units[7] = (f64) temporal_rs_Duration_milliseconds(object->handle);
            units[8] = temporal_rs_Duration_microseconds(object->handle);
            units[9] = temporal_rs_Duration_nanoseconds(object->handle);
            return true;
        }
    }
#endif
    if (!mal_value_is_object(input)) {
        mal_vm_throw_error(vm, mal_value_is_string(input) ? MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE : MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "duration must be an object");
        return false;
    }
    MalValue roots[] = {input, mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    bool result = false;
    bool any = false;
    static const u8 order[] = {3, 4, 8, 7, 5, 1, 9, 6, 2, 0};
    memset(units, 0, 10 * sizeof(f64));
    for (usize property = 0; property < countof(order); property++) {
        u8 unit = order[property];
        if (!mal_vm_get_property(vm, roots[0], mal_intrinsic_string_key(vm, DURATION_UNITS[unit].unit), &roots[1])) goto done;
        if (mal_value_is_undefined(roots[1])) continue;
        any = true;
        f64 value;
        if (!mal_vm_to_number(vm, roots[1], &value)) goto done;
        if (!isfinite(value) || floor(value) != value) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "duration field must be an integer");
            goto done;
        }
        units[unit] = value;
    }
    if (!any) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "duration must have at least one field");
        goto done;
    }
    result = true;
 done:
    mal_gc_unroot(&root);
    return result;
}

static MalValue intl_duration_format_result(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, bool to_parts) {
    MalIntlObject *df;
    if (!intl_this(vm, this_value, MAL_INTL_DURATION_FORMAT, &df, "Intl.DurationFormat method called on incompatible receiver")) return mal_value_new_undefined();
    MalValue roots[] = {this_value, arg_count >= 1 ? args[0] : mal_value_new_undefined()};
    MalRootSpan root;
    mal_gc_root(&root, roots, countof(roots));
    MalValue result = mal_value_new_undefined();
    c16 stack[256];
    MalI18nNumericPart stack_spans[24];
    c16 *out = stack;
    MalI18nNumericPart *spans = stack_spans;
    f64 units[10];
    if (!intl_to_duration_record(vm, roots[1], units)) goto done;
    usize spans_needed = 0;
    i32 n = mal_i18n_duration_format(df->handle, units, (uint16_t *) out, countof(stack), to_parts ? spans : nullptr, to_parts ? countof(stack_spans) : 0, to_parts ? &spans_needed : nullptr);
    if (n < 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, n == -2 ? "duration is out of range or has inconsistent signs" : "could not format duration");
        goto done;
    }
    if ((usize) n > countof(stack) || spans_needed > countof(stack_spans)) {
        usize bytes;
        if ((usize) n > countof(stack)) {
            if (!mal_checked_size_multiply((usize) n, sizeof(*out), SIZE_MAX, &bytes)) goto allocation_error;
            out = malloc(bytes);
            if (out == nullptr) goto allocation_error;
        }
        if (spans_needed > countof(stack_spans)) {
            if (!mal_checked_size_multiply(spans_needed, sizeof(*spans), SIZE_MAX, &bytes)) goto allocation_error;
            spans = malloc(bytes);
            if (spans == nullptr) goto allocation_error;
        }
        usize expected_parts = spans_needed;
        if (mal_i18n_duration_format(df->handle, units, (uint16_t *) out, out == stack ? countof(stack) : (usize) n, to_parts ? spans : nullptr, to_parts ? (spans == stack_spans ? countof(stack_spans) : spans_needed) : 0, to_parts ? &spans_needed : nullptr) != n || spans_needed != expected_parts) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format duration");
            goto done;
        }
    }
    result = intl_numeric_result(vm, out, (usize) n, spans, spans_needed, to_parts, true);
    goto done;
 allocation_error:
    mal_vm_throw_allocation_error(vm);
 done:
    if (out != stack) free(out);
    if (spans != stack_spans) free(spans);
    mal_gc_unroot(&root);
    return result;
}

static MalValue intl_duration_format_format(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    return intl_duration_format_result(vm, this_value, args, arg_count, false);
}

static MalValue intl_duration_format_format_to_parts(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    return intl_duration_format_result(vm, this_value, args, arg_count, true);
}

static MalValue intl_duration_format_resolved_options(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) args;
    (void) arg_count;
    (void) nt;
    (void) cl;
    MalIntlObject *df;
    if (!intl_this(vm, this_value, MAL_INTL_DURATION_FORMAT, &df, "Intl.DurationFormat.prototype.resolvedOptions called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    static const char *const keys[] = {
        "locale", "numberingSystem", "style",
        "years", "yearsDisplay", "months", "monthsDisplay", "weeks", "weeksDisplay",
        "days", "daysDisplay", "hours", "hoursDisplay", "minutes", "minutesDisplay",
        "seconds", "secondsDisplay", "milliseconds", "millisecondsDisplay",
        "microseconds", "microsecondsDisplay", "nanoseconds", "nanosecondsDisplay",
        "fractionalDigits",
    };
    return intl_resolved_copy(vm, df->data, keys, countof(keys));
}

static MalValue intl_duration_format_supported_locales_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) this_value;
    (void) nt;
    (void) cl;
    return intl_supported_locales_of_impl(vm, args, arg_count);
}

static void intl_install_duration_format(MalVm *vm, MalObject *intl_object) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "DurationFormat"), 0, intl_duration_format_constructor
    );
    mal_native_function_object_set_handles_new_target_prototype(constructor);
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_INTL_DURATION_FORMAT_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_INTL_DURATION_FORMAT_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_INTL_DURATION_FORMAT_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_INTL_DURATION_FORMAT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    intl_set_to_string_tag(vm, prototype, "Intl.DurationFormat");

    mal_intrinsic_define_method_n(vm, constructor_object, "supportedLocalesOf", 1, intl_duration_format_supported_locales_of);
    mal_intrinsic_define_method_n(vm, prototype, "format", 1, intl_duration_format_format);
    mal_intrinsic_define_method_n(vm, prototype, "formatToParts", 1, intl_duration_format_format_to_parts);
    mal_intrinsic_define_method_n(vm, prototype, "resolvedOptions", 0, intl_duration_format_resolved_options);

    mal_intrinsic_define_data(vm, intl_object, "DurationFormat", vm->intrinsics[MAL_INTRINSIC_INTL_DURATION_FORMAT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

#endif // MAL_INTL_HAS_DURATION_FORMAT

void mal_builtin_intl_install(MalVm *vm) {
    MalObject *intl = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    vm->intrinsics[MAL_INTRINSIC_INTL] = mal_value_from_object(intl);
    intl_set_to_string_tag(vm, intl, "Intl");

    mal_intrinsic_define_method_n(vm, intl, "getCanonicalLocales", 1, intl_get_canonical_locales);
    mal_intrinsic_define_method_n(vm, intl, "supportedValuesOf", 1, intl_supported_values_of);

    intl_install_locale(vm, intl); // floor: Intl.Locale (always present when Intl is on)
#if MAL_INTL_HAS_COLLATOR
    intl_install_collator(vm, intl);
#endif
#if MAL_INTL_HAS_PLURAL_RULES
    intl_install_plural_rules(vm, intl);
#endif
#if MAL_INTL_HAS_NUMBER_FORMAT
    intl_install_number_format(vm, intl);
#endif
#if MAL_INTL_HAS_DATE_TIME_FORMAT
    intl_install_date_time_format(vm, intl);
#endif
#if MAL_INTL_HAS_LIST_FORMAT
    intl_install_list_format(vm, intl);
#endif
#if MAL_INTL_HAS_DISPLAY_NAMES
    intl_install_display_names(vm, intl);
#endif
#if MAL_INTL_HAS_RELATIVE_TIME_FORMAT
    intl_install_relative_time_format(vm, intl);
#endif
#if MAL_INTL_HAS_SEGMENTER
    intl_install_segmenter(vm, intl);
#endif
#if MAL_INTL_HAS_DURATION_FORMAT
    intl_install_duration_format(vm, intl);
#endif
}

#else // !MAL_INTL

// engine.intl fully disabled: no ICU, no `Intl` global (typeof Intl ===
// "undefined"). The locale-sensitive non-namespace methods delegate to the
// locale-insensitive fallbacks above (all services are off here, so the
// #if !MAL_INTL_<SERVICE> helpers are all defined).

bool mal_intl_case_locale(MalVm *vm, MalValue locales, MalUnicodeLocale *locale) {
    (void) vm;
    (void) locales;
    *locale = MAL_UNICODE_LOCALE_ROOT;
    return true;
}

void mal_builtin_intl_install(MalVm *vm) {
    (void) vm; // no Intl namespace in this build
}

MalValue mal_intl_locale_compare_range(MalVm *vm, MalValue this_string, usize start, usize length, MalValue that_value, MalValue locales, MalValue options) {
    (void) locales;
    (void) options;
    return intl_fallback_locale_compare(vm, this_string, start, length, that_value);
}

MalValue mal_intl_number_to_locale_string(MalVm *vm, f64 number, MalValue locales, MalValue options) {
    (void) locales;
    (void) options;
    return intl_fallback_number_to_locale_string(vm, number);
}

MalValue mal_intl_date_to_locale_string(MalVm *vm, f64 time_value, MalValue locales, MalValue options, i32 which) {
    (void) locales;
    (void) options;
    return intl_fallback_date_to_locale_string(vm, time_value, which);
}

#endif // MAL_INTL

#include "generated/known_native_builtin_intl_c.inc"

MalValue mal_intl_locale_compare_prepared_range(MalVm *vm, MalValue this_string, usize start, usize length, MalValue that, const byte *locale, usize locale_length, u8 options) {
#if MAL_INTL_HAS_COLLATOR
    MalValue roots[2] = {this_string, that};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);
    MalValue result = mal_value_new_undefined();
    MalString *right;
    if (!mal_vm_to_string(vm, roots[1], &right)) goto done;
    roots[1] = mal_value_from_string(right);
    (void) mal_string_code_units(mal_value_to_string(roots[1]));
    c16 stack[MAL_STRING_UTF16_SCRATCH_UNITS];
    c16 *scratch;
    const c16 *left_units = mal_string_range_utf16(mal_value_to_string(roots[0]), start, length, stack, &scratch);
    right = mal_value_to_string(roots[1]);
    u8 hit = 0;
    i32 order = mal_i18n_prepared_collator_compare_utf16(
        (const uint8_t *) locale, locale_length, options,
        (const uint16_t *) left_units, length,
        (const uint16_t *) mal_string_code_units(right), mal_string_length(right), &hit);
    free(scratch);
    if (hit) MAL_PERF_COUNT(intl_collation_cache_hits);
    else MAL_PERF_COUNT(intl_collation_cache_misses);
    if (order < -1 || order > 1) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not create collator for locale");
        goto done;
    }
    result = mal_value_from_i32(order);
 done:
    mal_gc_unroot(&root_span);
    return result;
#else
    (void) locale;
    (void) locale_length;
    (void) options;
    return intl_fallback_locale_compare(vm, this_string, start, length, that);
#endif
}

MalValue mal_intl_locale_compare(MalVm *vm, MalValue this_string, MalValue that, MalValue locales, MalValue options) {
    return mal_intl_locale_compare_range(vm, this_string, 0, mal_string_length(mal_value_to_string(this_string)), that, locales, options);
}

MalValue mal_intl_locale_compare_prepared(MalVm *vm, MalValue this_string, MalValue that, const byte *locale, usize locale_length, u8 options) {
    return mal_intl_locale_compare_prepared_range(vm, this_string, 0, mal_string_length(mal_value_to_string(this_string)), that, locale, locale_length, options);
}
