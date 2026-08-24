#include "builtin_intl.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ascii.h"
#include "array_object.h"
#include "builtin_date.h"
#include "builtin_iterator.h"
#include "builtin_object.h"
#include "gc.h"
#include "heap_string.h"
#include "intl_object.h"
#include "intrinsics.h"
#include "mal_i18n.h"
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
static MalValue intl_fallback_locale_compare(MalVm *vm, MalValue this_string, MalValue that_value) {
    MalValue roots[2] = {this_string, mal_value_new_undefined()};
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, 2);

    MalString *b = nullptr;
    if (!mal_vm_to_string(vm, that_value, &b)) {
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    roots[1] = mal_value_from_string(b);
    MalString *a = mal_value_to_string(roots[0]);
    (void) mal_string_code_units(a);
    b = mal_value_to_string(roots[1]);
    (void) mal_string_code_units(b);
    // Either flatten above can allocate. Reacquire both rooted cells before
    // taking the stable contiguous views used by the comparison loop.
    a = mal_value_to_string(roots[0]);
    b = mal_value_to_string(roots[1]);
    usize la = mal_string_length(a);
    usize lb = mal_string_length(b);
    const c16 *ua = mal_string_code_units(a);
    const c16 *ub = mal_string_code_units(b);
    usize n = la < lb ? la : lb;
    i32 comparison = la == lb ? 0 : (la < lb ? -1 : 1);
    for (usize i = 0; i < n; i++) {
        if (ua[i] != ub[i]) {
            comparison = ua[i] < ub[i] ? -1 : 1;
            break;
        }
    }
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

/** mal_i18n_locale_field as a MalString (empty string when the field is absent). */
static MalString *intl_locale_field_string(MalVm *vm, const MalString *tag, i32 field) {
    byte in[320];
    usize in_len;
    if (!intl_tag_utf8(tag, in, sizeof(in), &in_len)) {
        return mal_string_new_ascii(&vm->heap, (const byte *) "", 0);
    }
    byte out[160];
    i32 n = mal_i18n_locale_field(in, in_len, field, out, (i32) sizeof(out));
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
        MalKey key = mal_key_index(i);
        MalValue existing;
        if (mal_vm_get_property(vm, mal_value_from_array_object(array), key, &existing)) {
            if (mal_value_is_string(existing) && mal_string_length(mal_value_to_string(existing)) == mal_string_length(needle)) {
                MalString *e = mal_value_to_string(existing);
                const c16 *a = mal_string_code_units(e);
                const c16 *b = mal_string_code_units(needle);
                usize n = mal_string_length(needle);
                bool eq = true;
                for (usize j = 0; j < n; j++) {
                    if (a[j] != b[j]) {
                        eq = false;
                        break;
                    }
                }
                if (eq) {
                    return true;
                }
            }
        }
    }
    return false;
}

/**
 * CanonicalizeLocaleList(locales) -> a fresh Array of canonical tag Strings.
 * Returns null with a pending throw on error.
 */
static MalArrayObject *intl_canonicalize_locale_list(MalVm *vm, MalValue locales) {
    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    u32 count = 0;

    if (mal_value_is_undefined(locales)) {
        return result;
    }

    // A String or a Locale instance is treated as a single-element list.
    if (mal_value_is_string(locales) ||
        (mal_value_is_intl_object(locales) && mal_value_to_intl_object(locales)->kind == MAL_INTL_LOCALE)) {
        MalString *tag = mal_value_is_string(locales)
            ? mal_value_to_string(locales)
            : mal_value_to_string(mal_value_to_intl_object(locales)->data);
        MalString *canonical = intl_canonicalize(vm, tag);
        if (canonical == nullptr) {
            return nullptr;
        }
        intl_array_push(vm, result, count++, mal_value_from_string(canonical));
        return result;
    }

    // Otherwise iterate as an array-like (a non-object primitive yields nothing).
    if (!mal_value_is_object(locales)) {
        return result;
    }

    MalValue length_value;
    if (!mal_vm_get_property(vm, locales, mal_intrinsic_string_key(vm, "length"), &length_value)) {
        return nullptr;
    }
    f64 length_number;
    if (!mal_vm_to_number(vm, length_value, &length_number)) {
        return nullptr;
    }
    length_number = mal_ops_number_to_length(length_number);
    if (length_number == 0.0) {
        return result;
    }
    u64 length = (u64) length_number;

    for (u64 i = 0; i < length; i++) {
        // Array index elements are stored under MAL_KEY_INDEX; beyond the index
        // range they would be string keys, but a locale list is never that long.
        MalKey property_key = i <= 0xFFFFFFFEULL
            ? mal_key_index(i)
            : mal_intrinsic_string_key(vm, "");
        if (!mal_vm_has_property(vm, locales, property_key)) {
            continue;
        }
        MalValue element;
        if (!mal_vm_get_property(vm, locales, property_key, &element)) {
            return nullptr;
        }
        if (!mal_value_is_string(element) && !mal_value_is_object(element)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "locale list element must be a String or Object");
            return nullptr;
        }
        MalString *tag;
        if (mal_value_is_intl_object(element) && mal_value_to_intl_object(element)->kind == MAL_INTL_LOCALE) {
            tag = mal_value_to_string(mal_value_to_intl_object(element)->data);
        } else if (!mal_vm_to_string(vm, element, &tag)) {
            return nullptr;
        }
        MalString *canonical = intl_canonicalize(vm, tag);
        if (canonical == nullptr) {
            return nullptr;
        }
        if (!intl_array_contains(vm, result, count, canonical)) {
            intl_array_push(vm, result, count++, mal_value_from_string(canonical));
        }
    }
    return result;
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
static const char *const SUPPORTED_UNITS[] = {
    "acre", "bit", "byte", "celsius", "centimeter", "day", "degree", "fahrenheit", "gigabyte",
    "gram", "hectare", "hour", "kilogram", "kilometer", "liter", "megabyte", "meter", "mile",
    "milliliter", "millimeter", "millisecond", "minute", "month", "ounce", "percent", "petabyte",
    "pound", "second", "stone", "terabyte", "week", "yard", "year",
};

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

    // Copy + sort (the spec mandates a sorted, deduped List).
    const char **sorted = malloc(count * sizeof(char *));
    for (usize i = 0; i < count; i++) {
        sorted[i] = values[i];
    }
    qsort(sorted, count, sizeof(char *), intl_compare_cstr);

    MalArrayObject *result = mal_intrinsic_new_array(vm, 0);
    (void) mal_array_object_fresh_dense_reserve_exact(result, (u32) count);
    for (usize i = 0; i < count; i++) {
        intl_array_push(vm, result, (u32) i, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) sorted[i])));
    }
    free(sorted);
    return mal_value_from_array_object(result);
}

// ---------------------------------------------------------------------------
// Intl.Locale
// ---------------------------------------------------------------------------

// The Unicode-extension keyword options, in (option name, bcp47 key, is-boolean) form.
static const struct {
    const char *option;
    const char *key;
    bool is_bool;
} LOCALE_KEYWORDS[] = {
    {"calendar", "ca", false},
    {"collation", "co", false},
    {"hourCycle", "hc", false},
    {"caseFirst", "kf", false},
    {"numeric", "kn", true},
    {"numberingSystem", "nu", false},
};

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

    // Build a BCP-47 tag with any -u- keyword options, then canonicalize (which
    // validates structure and normalizes ordering/case). Structural overrides
    // Language/script/region options remain unsupported.
    byte buf[400];
    usize len;
    if (!intl_tag_utf8(base_tag, buf, sizeof(buf), &len)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Incorrect locale information provided");
        return mal_value_new_undefined();
    }

    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();
    if (mal_value_is_object(options)) {
        bool wrote_ext = false;
        for (usize k = 0; k < countof(LOCALE_KEYWORDS); k++) {
            MalValue value;
            if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, LOCALE_KEYWORDS[k].option), &value)) {
                return mal_value_new_undefined();
            }
            if (mal_value_is_undefined(value)) {
                continue;
            }
            char value_buf[64];
            if (LOCALE_KEYWORDS[k].is_bool) {
                snprintf(value_buf, sizeof(value_buf), "%s", mal_value_is_truthy(value) ? "true" : "false");
            } else {
                MalString *value_string;
                if (!mal_vm_to_string(vm, value, &value_string)) {
                    return mal_value_new_undefined();
                }
                usize vn = mal_string_length(value_string);
                const c16 *vu = mal_string_code_units(value_string);
                if (vn >= sizeof(value_buf)) {
                    vn = sizeof(value_buf) - 1;
                }
                for (usize i = 0; i < vn; i++) {
                    value_buf[i] = (char) (vu[i] <= 0x7F ? (byte) vu[i] : '?');
                }
                value_buf[vn] = '\0';
            }
            int written = snprintf(
                (char *) buf + len, sizeof(buf) - len, "%s-%s-%s",
                wrote_ext ? "" : "-u", LOCALE_KEYWORDS[k].key, value_buf
            );
            if (written > 0) {
                len += (usize) written;
            }
            wrote_ext = true;
        }
    }

    // Canonicalize the assembled tag.
    bool invalid;
    MalString *assembled = mal_string_new_ascii(&vm->heap, buf, len);
    MalString *canonical = intl_call_locale_fn(vm, mal_i18n_canonicalize_locale, assembled, &invalid);
    if (invalid) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Incorrect locale information provided");
        return mal_value_new_undefined();
    }

    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_LOCALE_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    MalIntlObject *locale = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_LOCALE, nullptr, mal_value_from_string(canonical));
    return mal_value_from_intl_object(locale);
}

static MalValue intl_locale_field_getter(MalVm *vm, MalValue this_value, i32 field, bool as_bool, bool undef_if_empty) {
    MalIntlObject *locale;
    if (!intl_this(vm, this_value, MAL_INTL_LOCALE, &locale, "Intl.Locale.prototype getter called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    MalString *value = intl_locale_field_string(vm, mal_value_to_string(locale->data), field);
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
LOCALE_GETTER(intl_locale_get_calendar, MAL_LOCALE_FIELD_CALENDAR, false, true)
LOCALE_GETTER(intl_locale_get_collation, MAL_LOCALE_FIELD_COLLATION, false, true)
LOCALE_GETTER(intl_locale_get_hour_cycle, MAL_LOCALE_FIELD_HOUR_CYCLE, false, true)
LOCALE_GETTER(intl_locale_get_case_first, MAL_LOCALE_FIELD_CASE_FIRST, false, true)
LOCALE_GETTER(intl_locale_get_numeric, MAL_LOCALE_FIELD_NUMERIC, true, false)
LOCALE_GETTER(intl_locale_get_numbering_system, MAL_LOCALE_FIELD_NUMBERING_SYSTEM, false, true)

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

static void intl_install_locale(MalVm *vm, MalObject *intl_object) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "Locale"), 1, intl_locale_constructor
    );
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_INTL_LOCALE_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_INTL_LOCALE_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_INTL_LOCALE_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_INTL_LOCALE_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    intl_set_to_string_tag(vm, prototype, "Intl.Locale");

    mal_intrinsic_define_method_n(vm, prototype, "toString", 0, intl_locale_to_string);
    mal_intrinsic_define_method_n(vm, prototype, "maximize", 0, intl_locale_maximize);
    mal_intrinsic_define_method_n(vm, prototype, "minimize", 0, intl_locale_minimize);

    intl_define_getter(vm, prototype, "baseName", intl_locale_get_base_name);
    intl_define_getter(vm, prototype, "language", intl_locale_get_language);
    intl_define_getter(vm, prototype, "script", intl_locale_get_script);
    intl_define_getter(vm, prototype, "region", intl_locale_get_region);
    intl_define_getter(vm, prototype, "calendar", intl_locale_get_calendar);
    intl_define_getter(vm, prototype, "collation", intl_locale_get_collation);
    intl_define_getter(vm, prototype, "hourCycle", intl_locale_get_hour_cycle);
    intl_define_getter(vm, prototype, "caseFirst", intl_locale_get_case_first);
    intl_define_getter(vm, prototype, "numeric", intl_locale_get_numeric);
    intl_define_getter(vm, prototype, "numberingSystem", intl_locale_get_numbering_system);

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
static bool intl_is_valid_numbering_system(const MalString *s) {
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
    MalArrayObject *list = intl_canonicalize_locale_list(vm, locales);
    if (list == nullptr) {
        return nullptr;
    }
    MalKey first_key = mal_key_index(0);
    MalValue first;
    if (mal_vm_get_property(vm, mal_value_from_array_object(list), first_key, &first) && mal_value_is_string(first)) {
        return mal_value_to_string(first);
    }
    return mal_intrinsic_ascii(vm, "en-US");
}

static void intl_resolved_set(MalVm *vm, MalObject *object, const char *name, MalValue value) {
    mal_intrinsic_define_data(vm, object, name, value, MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE);
}

/** A fresh object copying the named keys out of an instance's stored template. */
static MalValue intl_resolved_copy(MalVm *vm, MalValue template_value, const char *const *keys, usize key_count) {
    MalObject *out = mal_intrinsic_new_object(vm);
    for (usize i = 0; i < key_count; i++) {
        MalValue value = mal_value_new_undefined();
        if (mal_value_is_object(template_value)) {
            mal_vm_get_property(vm, template_value, mal_intrinsic_string_key(vm, keys[i]), &value);
        }
        // Omit keys the instance never set (e.g. an unspecified dateStyle).
        if (!mal_value_is_undefined(value)) {
            intl_resolved_set(vm, out, keys[i], value);
        }
    }
    return mal_value_from_object(out);
}

#if MAL_INTL_HAS_NUMBER_FORMAT
/** CoerceOptionsToObject: undefined creates a null-prototype bag; all other
 * non-null values pass through ToObject. */
static bool intl_number_format_options(MalVm *vm, MalValue options, MalValue *out) {
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

/** SetNumberFormatDigitOptions for roundingPriority "auto" with standard
 * notation. Reads mnid, mnfd, mxfd, mnsd, mxsd in that (observable) order. When
 * either significant-digit option is present significant-digit rounding wins
 * (*has_significant true) and the fraction outputs are left untouched; otherwise
 * the fraction outputs are resolved with their existing defaults. */
static bool intl_number_format_digits(
    MalVm *vm, MalValue options, bool percent, i32 *minimum_integer, i32 *minimum_fraction, i32 *maximum_fraction,
    i32 *minimum_significant, i32 *maximum_significant, bool *has_significant
) {
    MalValue value;
    bool present;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "minimumIntegerDigits"), &value) ||
        !intl_number_option(vm, value, 1, 21, minimum_integer, &present)) {
        return false;
    }
    if (!present) {
        *minimum_integer = 1;
    }

    MalValue mnfd_value;
    MalValue mxfd_value;
    MalValue mnsd_value;
    MalValue mxsd_value;
    if (!mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "minimumFractionDigits"), &mnfd_value) ||
        !mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "maximumFractionDigits"), &mxfd_value) ||
        !mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "minimumSignificantDigits"), &mnsd_value) ||
        !mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "maximumSignificantDigits"), &mxsd_value)) {
        return false;
    }

    *has_significant = !mal_value_is_undefined(mnsd_value) || !mal_value_is_undefined(mxsd_value);
    if (*has_significant) {
        bool mnsd_present;
        bool mxsd_present;
        if (!intl_number_option(vm, mnsd_value, 1, 21, minimum_significant, &mnsd_present)) {
            return false;
        }
        if (!mnsd_present) {
            *minimum_significant = 1;
        }
        // maximumSignificantDigits is bounded below by the resolved minimum.
        if (!intl_number_option(vm, mxsd_value, *minimum_significant, 21, maximum_significant, &mxsd_present)) {
            return false;
        }
        if (!mxsd_present) {
            *maximum_significant = 21;
        }
        return true;
    }

    bool minimum_present;
    bool maximum_present;
    if (!intl_number_option(vm, mnfd_value, 0, 100, minimum_fraction, &minimum_present) ||
        !intl_number_option(vm, mxfd_value, 0, 100, maximum_fraction, &maximum_present)) {
        return false;
    }
    i32 maximum_default = percent ? 0 : 3;
    if (!minimum_present) {
        *minimum_fraction = 0;
    }
    if (!maximum_present) {
        *maximum_fraction = *minimum_fraction > maximum_default ? *minimum_fraction : maximum_default;
    } else if (*minimum_fraction > *maximum_fraction) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "minimumFractionDigits exceeds maximumFractionDigits");
        return false;
    }
    return true;
}
#endif

// ---------------------------------------------------------------------------
// Intl.Collator
// ---------------------------------------------------------------------------

#if MAL_INTL_HAS_COLLATOR
static MalValue intl_collator_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    MalValue locales = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    MalString *locale = intl_resolve_locale(vm, locales);
    if (locale == nullptr) {
        return mal_value_new_undefined();
    }

    bool present;
    MalString *usage = mal_intrinsic_ascii(vm, "sort");
    if (!intl_option_string(vm, options, "usage", &usage, &present)) {
        return mal_value_new_undefined();
    }
    MalString *sensitivity = nullptr;
    if (!intl_option_string(vm, options, "sensitivity", &sensitivity, &present)) {
        return mal_value_new_undefined();
    }
    i32 strength = 2; // "variant"
    i32 case_level = 0;
    if (sensitivity != nullptr) {
        if (intl_string_eq_ascii(sensitivity, "base")) {
            strength = 0;
        } else if (intl_string_eq_ascii(sensitivity, "accent")) {
            strength = 1;
        } else if (intl_string_eq_ascii(sensitivity, "case")) {
            strength = 0;
            case_level = 1;
        } else {
            strength = 2; // "variant"
        }
    } else {
        sensitivity = mal_intrinsic_ascii(vm, "variant");
    }

    bool numeric_present;
    bool numeric = false;
    if (!intl_option_bool(vm, options, "numeric", &numeric, &numeric_present)) {
        return mal_value_new_undefined();
    }
    bool ignore_present;
    bool ignore_punctuation = false;
    if (!intl_option_bool(vm, options, "ignorePunctuation", &ignore_punctuation, &ignore_present)) {
        return mal_value_new_undefined();
    }
    MalString *case_first = nullptr;
    if (!intl_option_string(vm, options, "caseFirst", &case_first, &present)) {
        return mal_value_new_undefined();
    }
    i32 case_first_code = 0;
    if (case_first != nullptr) {
        if (intl_string_eq_ascii(case_first, "upper")) {
            case_first_code = 1;
        } else if (intl_string_eq_ascii(case_first, "lower")) {
            case_first_code = 2;
        }
    } else {
        case_first = mal_intrinsic_ascii(vm, "false");
    }
    MalString *collation = nullptr;
    if (!intl_option_string(vm, options, "collation", &collation, &present)) {
        return mal_value_new_undefined();
    }
    if (collation == nullptr) {
        collation = mal_intrinsic_ascii(vm, "default");
    }

    byte locale_buf[160];
    usize locale_len;
    if (!intl_tag_utf8(locale, locale_buf, sizeof(locale_buf), &locale_len)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid locale");
        return mal_value_new_undefined();
    }
    void *handle = mal_i18n_collator_new(locale_buf, locale_len, strength, case_level, numeric ? 1 : 0, case_first_code);
    if (handle == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not create collator for locale");
        return mal_value_new_undefined();
    }

    MalObject *resolved = mal_intrinsic_new_object(vm);
    intl_resolved_set(vm, resolved, "locale", mal_value_from_string(locale));
    intl_resolved_set(vm, resolved, "usage", mal_value_from_string(usage));
    intl_resolved_set(vm, resolved, "sensitivity", mal_value_from_string(sensitivity));
    intl_resolved_set(vm, resolved, "ignorePunctuation", mal_value_new_boolean(ignore_punctuation));
    intl_resolved_set(vm, resolved, "collation", mal_value_from_string(collation));
    intl_resolved_set(vm, resolved, "numeric", mal_value_new_boolean(numeric));
    intl_resolved_set(vm, resolved, "caseFirst", mal_value_from_string(case_first));

    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_COLLATOR_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    MalIntlObject *collator = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_COLLATOR, handle, mal_value_from_object(resolved));
    return mal_value_from_intl_object(collator);
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

/**
 * String.prototype.localeCompare's collation, exposed for builtin_string.c: a
 * Collator over (locales, options) comparing two already-resolved strings. The
 * default plan uses Rust's thread-local flat primitive; explicit locales/options
 * retain the full constructor path. Returns a Number (-1/0/1), or undefined with
 * a pending throw.
 */
#endif // MAL_INTL_HAS_COLLATOR — collator service statics

// String.prototype.localeCompare: a real Collator when the service is present,
// else the UTF-16 code-unit fallback. Always defined (builtin_string.c calls it).
MalValue mal_intl_locale_compare(MalVm *vm, MalValue this_string, MalValue that_value, MalValue locales, MalValue options) {
#if MAL_INTL_HAS_COLLATOR
    MalValue roots[3] = {
        this_string,
        mal_value_new_undefined(),
        mal_value_new_undefined(),
    };
    MalRootSpan root_span;
    mal_gc_root(&root_span, roots, countof(roots));
    // builtin_string.c already performed the receiver's observable ToString.
    MalString *self = mal_value_to_string(roots[0]);
    MalString *that;
    if (!mal_vm_to_string(vm, that_value, &that)) {
        mal_gc_unroot(&root_span);
        return mal_value_new_undefined();
    }
    roots[1] = mal_value_from_string(that);

    bool use_default = mal_value_is_undefined(locales) && mal_value_is_undefined(options);
    void *compare_handle = nullptr;
    if (!use_default) {
        MalValue ctor_args[2] = {locales, options};
        roots[2] = intl_collator_constructor(
            vm, mal_value_new_undefined(), ctor_args, 2,
            mal_value_new_undefined(), mal_value_new_undefined());
        if (!mal_value_is_intl_object(roots[2])) {
            mal_gc_unroot(&root_span);
            return mal_value_new_undefined(); // a pending throw from the constructor
        }
        compare_handle = mal_value_to_intl_object(roots[2])->handle;
    }

    // Either input can be a cons string. Flatten both while rooted, then reacquire
    // both pointers so no allocation can leave a stale moving-heap address.
    self = mal_value_to_string(roots[0]);
    (void) mal_string_code_units(self);
    that = mal_value_to_string(roots[1]);
    (void) mal_string_code_units(that);
    self = mal_value_to_string(roots[0]);
    that = mal_value_to_string(roots[1]);
    i32 result = use_default
        ? mal_i18n_default_collator_compare_utf16(
            (const uint16_t *) mal_string_code_units(self), mal_string_length(self),
            (const uint16_t *) mal_string_code_units(that), mal_string_length(that))
        : mal_i18n_collator_compare_utf16(
            compare_handle,
            (const uint16_t *) mal_string_code_units(self), mal_string_length(self),
            (const uint16_t *) mal_string_code_units(that), mal_string_length(that));
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
    return intl_fallback_locale_compare(vm, this_string, that_value);
#endif
}

#if MAL_INTL_HAS_COLLATOR
static void intl_install_collator(MalVm *vm, MalObject *intl_object) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "Collator"), 0, intl_collator_constructor
    );
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

    MalString *locale = intl_resolve_locale(vm, locales);
    if (locale == nullptr) {
        return mal_value_new_undefined();
    }
    bool present;
    MalString *type = nullptr;
    if (!intl_option_string(vm, options, "type", &type, &present)) {
        return mal_value_new_undefined();
    }
    bool ordinal = type != nullptr && intl_string_eq_ascii(type, "ordinal");
    if (type == nullptr) {
        type = mal_intrinsic_ascii(vm, "cardinal");
    }

    byte locale_buf[160];
    usize locale_len;
    if (!intl_tag_utf8(locale, locale_buf, sizeof(locale_buf), &locale_len)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid locale");
        return mal_value_new_undefined();
    }
    void *handle = mal_i18n_plural_rules_new(locale_buf, locale_len, ordinal ? 1 : 0);
    if (handle == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not create plural rules for locale");
        return mal_value_new_undefined();
    }

    MalObject *resolved = mal_intrinsic_new_object(vm);
    intl_resolved_set(vm, resolved, "locale", mal_value_from_string(locale));
    intl_resolved_set(vm, resolved, "type", mal_value_from_string(type));
    intl_resolved_set(vm, resolved, "minimumIntegerDigits", mal_value_from_i32(1));
    intl_resolved_set(vm, resolved, "minimumFractionDigits", mal_value_from_i32(0));
    intl_resolved_set(vm, resolved, "maximumFractionDigits", mal_value_from_i32(3));

    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_PLURAL_RULES_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    MalIntlObject *rules = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_PLURAL_RULES, handle, mal_value_from_object(resolved));
    return mal_value_from_intl_object(rules);
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

// ---------------------------------------------------------------------------
// Intl.NumberFormat supports decimal and percent; currency, unit, and compact remain.
// ---------------------------------------------------------------------------

#if MAL_INTL_HAS_NUMBER_FORMAT || MAL_INTL_HAS_DATE_TIME_FORMAT
static i32 intl_data_int(MalVm *vm, MalValue data, const char *key, i32 fallback) {
    MalValue value;
    if (mal_vm_get_property(vm, data, mal_intrinsic_string_key(vm, key), &value) && mal_ops_is_number(value)) {
        return (i32) mal_ops_number_as_f64(value);
    }
    return fallback;
}

static MalString *intl_data_string(MalVm *vm, MalValue data, const char *key) {
    MalValue value;
    if (mal_vm_get_property(vm, data, mal_intrinsic_string_key(vm, key), &value) && mal_value_is_string(value)) {
        return mal_value_to_string(value);
    }
    return nullptr;
}
#endif

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

static MalValue intl_number_format_handle(MalVm *vm, void *handle, f64 number) {
    byte out[256];
    i32 n = mal_i18n_number_formatter_format(handle, number, out, (i32) sizeof(out));
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
    if (mal_i18n_number_formatter_format(handle, number, big, n) != n) {
        free(big);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format number");
        return mal_value_new_undefined();
    }
    MalValue result = intl_string_from_utf8(vm, big, (usize) n);
    free(big);
    return result;
}

static MalValue intl_number_format_default_en_us(MalVm *vm, f64 number) {
    byte out[512];
    i32 n = mal_i18n_number_format_default_en_us(
        number, out, (i32) sizeof(out)
    );
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
    if (mal_i18n_number_format_default_en_us(number, big, n) != n) {
        free(big);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format number");
        return mal_value_new_undefined();
    }
    MalValue result = intl_string_from_utf8(vm, big, (usize) n);
    free(big);
    return result;
}

static MalValue intl_number_format_value(MalVm *vm, MalIntlObject *nf, f64 number) {
    if (!isfinite(number)) {
        i32 sign_display_code = intl_sign_display_code(intl_data_string(vm, nf->data, "signDisplay"));
        return intl_nonfinite_number(vm, number, sign_display_code);
    }
    return intl_number_format_handle(vm, nf->handle, number);
}

static MalValue intl_number_format_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    MalValue locales = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    MalString *locale = intl_resolve_locale(vm, locales);
    if (locale == nullptr) {
        return mal_value_new_undefined();
    }
    if (!intl_number_format_options(vm, options, &options)) {
        return mal_value_new_undefined();
    }
    static const char *const STYLES[] = {"decimal", "percent", "currency", "unit"};
    bool ok;
    MalString *style = intl_option_enum(vm, options, "style", STYLES, countof(STYLES), "decimal", &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }
    bool percent = intl_string_eq_ascii(style, "percent");

    i32 min_integer;
    i32 min_fraction;
    i32 max_fraction;
    i32 min_significant = 0;
    i32 max_significant = 0;
    bool has_significant;
    if (!intl_number_format_digits(
            vm, options, percent, &min_integer, &min_fraction, &max_fraction,
            &min_significant, &max_significant, &has_significant
        )) {
        return mal_value_new_undefined();
    }
    bool grouping = true;
    bool grouping_present;
    if (!intl_option_bool(vm, options, "useGrouping", &grouping, &grouping_present)) {
        return mal_value_new_undefined();
    }
    if (!grouping_present) {
        grouping = true;
    }
    MalString *sign_display = intl_option_enum(
        vm, options, "signDisplay", INTL_SIGN_DISPLAYS, countof(INTL_SIGN_DISPLAYS), "auto", &ok
    );
    if (!ok) {
        return mal_value_new_undefined();
    }

    MalObject *resolved = mal_intrinsic_new_object(vm);
    intl_resolved_set(vm, resolved, "locale", mal_value_from_string(locale));
    intl_resolved_set(vm, resolved, "numberingSystem", mal_value_from_string(mal_intrinsic_ascii(vm, "latn")));
    intl_resolved_set(vm, resolved, "style", mal_value_from_string(style));
    intl_resolved_set(vm, resolved, "minimumIntegerDigits", mal_value_from_i32(min_integer));
    if (has_significant) {
        intl_resolved_set(vm, resolved, "minimumSignificantDigits", mal_value_from_i32(min_significant));
        intl_resolved_set(vm, resolved, "maximumSignificantDigits", mal_value_from_i32(max_significant));
    } else {
        intl_resolved_set(vm, resolved, "minimumFractionDigits", mal_value_from_i32(min_fraction));
        intl_resolved_set(vm, resolved, "maximumFractionDigits", mal_value_from_i32(max_fraction));
    }
    intl_resolved_set(vm, resolved, "useGrouping", mal_value_new_boolean(grouping));
    intl_resolved_set(vm, resolved, "signDisplay", mal_value_from_string(sign_display));

    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_NUMBER_FORMAT_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    byte locale_buf[160];
    usize locale_len;
    if (!intl_tag_utf8(locale, locale_buf, sizeof(locale_buf), &locale_len)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not build number formatter");
        return mal_value_new_undefined();
    }
    void *handle = mal_i18n_number_formatter_new(
        locale_buf, locale_len, percent ? 1 : 0, min_integer, min_fraction,
        max_fraction, min_significant, max_significant, grouping ? 1 : 0,
        intl_sign_display_code(sign_display)
    );
    if (handle == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not build number formatter");
        return mal_value_new_undefined();
    }
    MalIntlObject *nf = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_NUMBER_FORMAT, handle, mal_value_from_object(resolved));
    return mal_value_from_intl_object(nf);
}

static MalValue intl_number_format_callback(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue callee) {
    (void) this_value;
    (void) nt;
    MalIntlObject *nf = mal_value_to_intl_object(mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0));
    f64 number;
    if (!mal_vm_to_number(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &number)) {
        return mal_value_new_undefined();
    }
    return intl_number_format_value(vm, nf, number);
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
    static const char *const keys[] = {
        "locale", "numberingSystem", "style", "minimumIntegerDigits", "minimumFractionDigits", "maximumFractionDigits",
        "minimumSignificantDigits", "maximumSignificantDigits", "useGrouping", "signDisplay",
    };
    return intl_resolved_copy(vm, nf->data, keys, countof(keys));
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
    MalObject *constructor_object = (MalObject *) constructor;

    vm->intrinsics[MAL_INTRINSIC_INTL_NUMBER_FORMAT_CONSTRUCTOR] = mal_value_from_native_function_object(constructor);
    vm->intrinsics[MAL_INTRINSIC_INTL_NUMBER_FORMAT_PROTOTYPE] = mal_value_from_object(prototype);

    mal_intrinsic_define_data(vm, constructor_object, "prototype", vm->intrinsics[MAL_INTRINSIC_INTL_NUMBER_FORMAT_PROTOTYPE], MAL_PROPERTY_NONE);
    mal_intrinsic_define_data(vm, prototype, "constructor", vm->intrinsics[MAL_INTRINSIC_INTL_NUMBER_FORMAT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
    intl_set_to_string_tag(vm, prototype, "Intl.NumberFormat");

    mal_intrinsic_define_method_n(vm, constructor_object, "supportedLocalesOf", 1, intl_number_format_supported_locales_of);
    intl_define_getter(vm, prototype, "format", intl_number_format_get_format);
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
    if (date_code == -1 && time_code == -1) {
        date_code = 2; // empty options default to a medium date
    }

    byte tz[64];
    i32 tz_len = mal_i18n_local_tz_name(tz, (i32) sizeof(tz));
    MalString *time_zone = mal_string_new_ascii(&vm->heap, tz, (usize) (tz_len <= (i32) sizeof(tz) ? tz_len : (i32) sizeof(tz)));

    MalObject *resolved = mal_intrinsic_new_object(vm);
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

    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    byte locale_buf[160];
    usize locale_len;
    if (!intl_tag_utf8(locale, locale_buf, sizeof(locale_buf), &locale_len)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not build date formatter");
        return mal_value_new_undefined();
    }
    void *handle = mal_i18n_datetime_formatter_new(
        locale_buf, locale_len, date_code, time_code);
    if (handle == nullptr) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not build date formatter");
        return mal_value_new_undefined();
    }
    MalIntlObject *dtf = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_DATE_TIME_FORMAT, handle, mal_value_from_object(resolved));
    return mal_value_from_intl_object(dtf);
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

static i32 intl_list_length_code(const MalString *style) {
    if (style != nullptr && intl_string_eq_ascii(style, "short")) {
        return 1;
    }
    if (style != nullptr && intl_string_eq_ascii(style, "narrow")) {
        return 2;
    }
    return 0; // long
}

static MalValue intl_list_format_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Intl.ListFormat must be called with new");
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
    static const char *const TYPES[] = {"conjunction", "disjunction", "unit"};
    static const char *const STYLES[] = {"long", "short", "narrow"};
    bool ok;
    MalString *type = intl_option_enum(vm, options, "type", TYPES, countof(TYPES), "conjunction", &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }
    MalString *style = intl_option_enum(vm, options, "style", STYLES, countof(STYLES), "long", &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }

    MalObject *resolved = mal_intrinsic_new_object(vm);
    intl_resolved_set(vm, resolved, "locale", mal_value_from_string(locale));
    intl_resolved_set(vm, resolved, "type", mal_value_from_string(type));
    intl_resolved_set(vm, resolved, "style", mal_value_from_string(style));

    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_LIST_FORMAT_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    MalIntlObject *lf = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_LIST_FORMAT, nullptr, mal_value_from_object(resolved));
    return mal_value_from_intl_object(lf);
}

/**
 * StringListFromIterable: drain `iterable` into a fresh array of String values,
 * throwing TypeError if any element is not a String. Returns the array (length
 * in *count_out), or null with a pending throw.
 */
static MalArrayObject *intl_string_list_from_iterable(MalVm *vm, MalValue iterable, u32 *count_out) {
    MalArrayObject *list = mal_intrinsic_new_array(vm, 0);
    *count_out = 0;
    if (mal_value_is_undefined(iterable)) {
        return list;
    }
    MalIteratorRecord record;
    if (!mal_vm_get_iterator(vm, iterable, &record)) {
        return nullptr;
    }
    u32 count = 0;
    while (true) {
        MalValue item;
        bool done;
        if (!mal_vm_iterator_step(vm, &record, &item, &done)) {
            return nullptr;
        }
        if (done) {
            break;
        }
        if (!mal_value_is_string(item)) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Intl.ListFormat list element must be a String");
            mal_vm_iterator_close(vm, &record);
            return nullptr;
        }
        intl_array_push(vm, list, count++, item);
    }
    *count_out = count;
    return list;
}

/** Read a String array of `count` elements into a freshly-malloc'd MalU16Str[]. */
static MalU16Str *intl_collect_u16(MalVm *vm, MalArrayObject *list, u32 count) {
    if (count == 0) {
        return nullptr;
    }
    MalU16Str *items = malloc(sizeof(MalU16Str) * count);
    for (u32 i = 0; i < count; i++) {
        MalKey key = mal_key_index(i);
        MalValue element;
        mal_vm_get_property(vm, mal_value_from_array_object(list), key, &element);
        MalString *s = mal_value_to_string(element);
        items[i].ptr = (const uint16_t *) mal_string_code_units(s);
        items[i].len = mal_string_length(s);
    }
    return items;
}

static MalValue intl_list_format_do(MalVm *vm, MalIntlObject *lf, MalArrayObject *list, u32 count) {
    MalString *locale = intl_data_string(vm, lf->data, "locale");
    i32 type_code = intl_list_type_code(intl_data_string(vm, lf->data, "type"));
    i32 length_code = intl_list_length_code(intl_data_string(vm, lf->data, "style"));
    MalU16Str *items = intl_collect_u16(vm, list, count);
    byte locale_buf[160];
    usize locale_len = 0;
    if (locale != nullptr) {
        intl_tag_utf8(locale, locale_buf, sizeof(locale_buf), &locale_len);
    }
    byte out[512];
    i32 n = mal_i18n_list_format(locale_buf, locale_len, type_code, length_code, items, count, out, (i32) sizeof(out));
    MalValue result;
    if (n < 0) {
        free(items);
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format list");
        return mal_value_new_undefined();
    }
    if (n <= (i32) sizeof(out)) {
        result = intl_string_from_utf8(vm, out, (usize) n);
    } else {
        byte *big = malloc((usize) n);
        mal_i18n_list_format(locale_buf, locale_len, type_code, length_code, items, count, big, n);
        result = intl_string_from_utf8(vm, big, (usize) n);
        free(big);
    }
    free(items);
    return result;
}

static MalValue intl_list_format_format(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    MalIntlObject *lf;
    if (!intl_this(vm, this_value, MAL_INTL_LIST_FORMAT, &lf, "Intl.ListFormat.prototype.format called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    u32 count;
    MalArrayObject *list = intl_string_list_from_iterable(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &count);
    if (list == nullptr) {
        return mal_value_new_undefined();
    }
    return intl_list_format_do(vm, lf, list, count);
}

/** Find `needle` in `hay` at/after `from` (UTF-16). Returns index, or -1. */
static i64 intl_string_index_of(const MalString *hay, const MalString *needle, usize from) {
    usize hn = mal_string_length(hay);
    usize nn = mal_string_length(needle);
    const c16 *h = mal_string_code_units(hay);
    const c16 *p = mal_string_code_units(needle);
    if (nn == 0) {
        return (i64) from;
    }
    if (nn > hn) {
        return -1;
    }
    for (usize i = from; i + nn <= hn; i++) {
        bool eq = true;
        for (usize j = 0; j < nn; j++) {
            if (h[i + j] != p[j]) {
                eq = false;
                break;
            }
        }
        if (eq) {
            return (i64) i;
        }
    }
    return -1;
}

static void intl_parts_push(MalVm *vm, MalArrayObject *parts, u32 *index, const char *type, MalValue value) {
    MalObject *part = mal_intrinsic_new_object(vm);
    intl_resolved_set(vm, part, "type", mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) type)));
    intl_resolved_set(vm, part, "value", value);
    intl_array_push(vm, parts, (*index)++, mal_value_from_object(part));
}

static MalValue intl_substring(MalVm *vm, MalString *s, usize start, usize end) {
    return mal_value_from_string(mal_string_new_slice(&vm->heap, s, start, end - start));
}

static MalValue intl_list_format_format_to_parts(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    MalIntlObject *lf;
    if (!intl_this(vm, this_value, MAL_INTL_LIST_FORMAT, &lf, "Intl.ListFormat.prototype.formatToParts called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    u32 count;
    MalArrayObject *list = intl_string_list_from_iterable(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &count);
    if (list == nullptr) {
        return mal_value_new_undefined();
    }
    MalValue formatted_value = intl_list_format_do(vm, lf, list, count);
    if (!mal_value_is_string(formatted_value)) {
        return mal_value_new_undefined();
    }
    MalString *formatted = mal_value_to_string(formatted_value);

    // Reconstruct parts by matching each element left-to-right; the text between
    // matches is the locale's "literal" separator.
    MalArrayObject *parts = mal_intrinsic_new_array(vm, 0);
    u32 part_index = 0;
    usize cursor = 0;
    for (u32 i = 0; i < count; i++) {
        MalKey key = mal_key_index(i);
        MalValue element;
        mal_vm_get_property(vm, mal_value_from_array_object(list), key, &element);
        MalString *el = mal_value_to_string(element);
        i64 pos = intl_string_index_of(formatted, el, cursor);
        if (pos < 0) {
            pos = (i64) cursor;
        }
        if ((usize) pos > cursor) {
            intl_parts_push(vm, parts, &part_index, "literal", intl_substring(vm, formatted, cursor, (usize) pos));
        }
        intl_parts_push(vm, parts, &part_index, "element", mal_value_from_string(el));
        cursor = (usize) pos + mal_string_length(el);
    }
    if (cursor < mal_string_length(formatted)) {
        intl_parts_push(vm, parts, &part_index, "literal", intl_substring(vm, formatted, cursor, mal_string_length(formatted)));
    }
    return mal_value_from_array_object(parts);
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

// ---------------------------------------------------------------------------
// Intl.RelativeTimeFormat — icu::experimental::relativetime.
// ---------------------------------------------------------------------------

/** SingularRelativeTimeUnit: map a unit string (singular or plural) to 0..7, or -1. */
static i32 intl_relative_unit_code(const MalString *unit) {
    static const char *const SINGULAR[8] = {"second", "minute", "hour", "day", "week", "month", "quarter", "year"};
    static const char *const PLURAL[8] = {"seconds", "minutes", "hours", "days", "weeks", "months", "quarters", "years"};
    for (i32 i = 0; i < 8; i++) {
        if (intl_string_eq_ascii(unit, SINGULAR[i]) || intl_string_eq_ascii(unit, PLURAL[i])) {
            return i;
        }
    }
    return -1;
}

#endif // MAL_INTL_HAS_DISPLAY_NAMES

#if MAL_INTL_HAS_RELATIVE_TIME_FORMAT
static MalValue intl_relative_time_format_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Intl.RelativeTimeFormat must be called with new");
        return mal_value_new_undefined();
    }
    MalValue locales = arg_count >= 1 ? args[0] : mal_value_new_undefined();
    MalValue options = arg_count >= 2 ? args[1] : mal_value_new_undefined();

    MalString *locale = intl_resolve_locale(vm, locales);
    if (locale == nullptr) {
        return mal_value_new_undefined();
    }
    // RelativeTimeFormat uses CoerceOptionsToObject: a primitive options bag is
    // read through its prototype chain (the option readers handle that); only
    // null throws.
    if (mal_value_is_null(options)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "options must be an object");
        return mal_value_new_undefined();
    }
    if (!intl_check_locale_matcher(vm, options)) {
        return mal_value_new_undefined();
    }

    // GetOption order (per options-order): localeMatcher, numeric, style, then
    // the numberingSystem option (which we validate but do not yet apply).
    static const char *const NUMERICS[] = {"always", "auto"};
    static const char *const STYLES[] = {"long", "short", "narrow"};
    bool ok;
    MalString *numeric = intl_option_enum(vm, options, "numeric", NUMERICS, countof(NUMERICS), "always", &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }
    MalString *style = intl_option_enum(vm, options, "style", STYLES, countof(STYLES), "long", &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }
    bool ns_present;
    MalString *numbering_system = nullptr;
    if (!intl_option_string(vm, options, "numberingSystem", &numbering_system, &ns_present)) {
        return mal_value_new_undefined();
    }
    if (ns_present && !intl_is_valid_numbering_system(numbering_system)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid numberingSystem");
        return mal_value_new_undefined();
    }

    MalObject *resolved = mal_intrinsic_new_object(vm);
    intl_resolved_set(vm, resolved, "locale", mal_value_from_string(locale));
    intl_resolved_set(vm, resolved, "style", mal_value_from_string(style));
    intl_resolved_set(vm, resolved, "numeric", mal_value_from_string(numeric));
    intl_resolved_set(vm, resolved, "numberingSystem", mal_value_from_string(mal_intrinsic_ascii(vm, "latn")));

    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_RELATIVE_TIME_FORMAT_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    MalIntlObject *rtf = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_RELATIVE_TIME_FORMAT, nullptr, mal_value_from_object(resolved));
    return mal_value_from_intl_object(rtf);
}

/** Shared format core: returns the formatted string, or undefined + pending throw. */
static MalValue intl_relative_time_do(MalVm *vm, MalIntlObject *rtf, MalValue value_arg, MalValue unit_arg) {
    f64 value;
    if (!mal_vm_to_number(vm, value_arg, &value)) {
        return mal_value_new_undefined();
    }
    if (!isfinite(value)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "Intl.RelativeTimeFormat value must be finite");
        return mal_value_new_undefined();
    }
    MalString *unit;
    if (!mal_vm_to_string(vm, unit_arg, &unit)) {
        return mal_value_new_undefined();
    }
    i32 unit_code = intl_relative_unit_code(unit);
    if (unit_code < 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid unit for Intl.RelativeTimeFormat");
        return mal_value_new_undefined();
    }
    MalString *locale = intl_data_string(vm, rtf->data, "locale");
    MalString *style = intl_data_string(vm, rtf->data, "style");
    MalString *numeric = intl_data_string(vm, rtf->data, "numeric");
    i32 length_code = 0;
    if (style != nullptr && intl_string_eq_ascii(style, "short")) {
        length_code = 1;
    } else if (style != nullptr && intl_string_eq_ascii(style, "narrow")) {
        length_code = 2;
    }
    i32 numeric_auto = numeric != nullptr && intl_string_eq_ascii(numeric, "auto") ? 1 : 0;

    byte locale_buf[160];
    usize locale_len = 0;
    if (locale != nullptr) {
        intl_tag_utf8(locale, locale_buf, sizeof(locale_buf), &locale_len);
    }
    byte out[256];
    i32 n = mal_i18n_relative_time(locale_buf, locale_len, length_code, unit_code, numeric_auto, value, out, (i32) sizeof(out));
    if (n < 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format relative time");
        return mal_value_new_undefined();
    }
    if (n <= (i32) sizeof(out)) {
        return intl_string_from_utf8(vm, out, (usize) n);
    }
    byte *big = malloc((usize) n);
    mal_i18n_relative_time(locale_buf, locale_len, length_code, unit_code, numeric_auto, value, big, n);
    MalValue result = intl_string_from_utf8(vm, big, (usize) n);
    free(big);
    return result;
}

static MalValue intl_relative_time_format_format(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    MalIntlObject *rtf;
    if (!intl_this(vm, this_value, MAL_INTL_RELATIVE_TIME_FORMAT, &rtf, "Intl.RelativeTimeFormat.prototype.format called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    return intl_relative_time_do(
        vm, rtf, arg_count >= 1 ? args[0] : mal_value_new_undefined(), arg_count >= 2 ? args[1] : mal_value_new_undefined()
    );
}

static MalValue intl_relative_time_format_format_to_parts(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    MalIntlObject *rtf;
    if (!intl_this(vm, this_value, MAL_INTL_RELATIVE_TIME_FORMAT, &rtf, "Intl.RelativeTimeFormat.prototype.formatToParts called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    // Coerce value first (to surface the integer substring we split out).
    f64 value;
    if (!mal_vm_to_number(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &value)) {
        return mal_value_new_undefined();
    }
    MalValue formatted_value = intl_relative_time_do(
        vm, rtf, arg_count >= 1 ? args[0] : mal_value_new_undefined(), arg_count >= 2 ? args[1] : mal_value_new_undefined()
    );
    if (!mal_value_is_string(formatted_value)) {
        return mal_value_new_undefined();
    }
    MalString *formatted = mal_value_to_string(formatted_value);
    MalArrayObject *parts = mal_intrinsic_new_array(vm, 0);
    u32 part_index = 0;

    // Locate the integer rendering of |value| and split it out as an "integer"
    // part (with `unit`); the rest is "literal". Auto numeric ("yesterday") has
    // no number, yielding a single literal part.
    byte numbuf[32];
    i32 nb = snprintf((char *) numbuf, sizeof(numbuf), "%.0f", value < 0 ? -value : value);
    MalString *num = mal_string_new_ascii(&vm->heap, numbuf, (usize) (nb < 0 ? 0 : nb));
    i64 pos = intl_string_index_of(formatted, num, 0);
    if (pos < 0 || mal_string_length(num) == 0) {
        if (mal_string_length(formatted) > 0) {
            intl_parts_push(vm, parts, &part_index, "literal", formatted_value);
        }
        return mal_value_from_array_object(parts);
    }
    MalString *unit;
    if (!mal_vm_to_string(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), &unit)) {
        return mal_value_new_undefined();
    }
    if ((usize) pos > 0) {
        intl_parts_push(vm, parts, &part_index, "literal", intl_substring(vm, formatted, 0, (usize) pos));
    }
    // The "integer" part carries a `unit` field (singular unit name).
    {
        MalObject *part = mal_intrinsic_new_object(vm);
        intl_resolved_set(vm, part, "type", mal_value_from_string(mal_intrinsic_ascii(vm, "integer")));
        intl_resolved_set(vm, part, "value", mal_value_from_string(num));
        intl_resolved_set(vm, part, "unit", mal_value_from_string(unit));
        intl_array_push(vm, parts, part_index++, mal_value_from_object(part));
    }
    usize after = (usize) pos + mal_string_length(num);
    if (after < mal_string_length(formatted)) {
        intl_parts_push(vm, parts, &part_index, "literal", intl_substring(vm, formatted, after, mal_string_length(formatted)));
    }
    return mal_value_from_array_object(parts);
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

// ---------------------------------------------------------------------------
// Intl.Segmenter — icu::segmenter (grapheme / word / sentence). The segment()
// result is a Segments object (kind MAL_INTL_SEGMENTS) that is iterable and has
// containing(); iteration yields Segment Iterators (kind MAL_INTL_SEGMENT_ITERATOR).
// ---------------------------------------------------------------------------

static i32 intl_segment_granularity_code(const MalString *g) {
    if (g != nullptr && intl_string_eq_ascii(g, "word")) {
        return 1;
    }
    if (g != nullptr && intl_string_eq_ascii(g, "sentence")) {
        return 2;
    }
    return 0; // grapheme
}

/** Compute segment boundaries (UTF-16 indices) for `input`. Caller frees *bounds
 * and *wordlike. Returns the boundary count (segments + 1). */
static i32 intl_segment_bounds(MalString *input, i32 gran, i32 **bounds_out, u8 **wordlike_out) {
    usize len = mal_string_length(input);
    i32 cap = (i32) len + 1;
    i32 *bounds = malloc(sizeof(i32) * (usize) cap);
    u8 *wordlike = malloc((usize) cap);
    memset(wordlike, 0, (usize) cap);
    i32 n = mal_i18n_segment(gran, (const uint16_t *) mal_string_code_units(input), len, bounds, wordlike, cap);
    if (n < 0) {
        n = 0;
    }
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

#endif // MAL_INTL_HAS_RELATIVE_TIME_FORMAT

#if MAL_INTL_HAS_SEGMENTER
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
    i32 count = intl_segment_bounds(input, gran, &bounds, &wordlike);
    MalValue result = mal_value_new_undefined();
    for (i32 i = 0; i + 1 < count; i++) {
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
    i32 count = intl_segment_bounds(input, gran, &bounds, &wordlike);

    // Snapshot the boundaries + word-like flags as JS arrays on the iterator.
    MalArrayObject *bounds_array = mal_intrinsic_new_array(vm, 0);
    MalArrayObject *wl_array = mal_intrinsic_new_array(vm, 0);
    (void) mal_array_object_fresh_dense_reserve_exact(
        bounds_array, (u32) count);
    (void) mal_array_object_fresh_dense_reserve_exact(
        wl_array, count > 0 ? (u32) count - 1 : 0);
    for (i32 i = 0; i < count; i++) {
        intl_array_push(vm, bounds_array, (u32) i, mal_value_from_i32(bounds[i]));
    }
    for (i32 i = 0; i + 1 < count; i++) {
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
    i32 pos = intl_data_int(vm, iter->data, "pos", 0);

    MalValue bounds_value;
    mal_vm_get_property(vm, iter->data, mal_intrinsic_string_key(vm, "bounds"), &bounds_value);
    MalValue wl_value;
    mal_vm_get_property(vm, iter->data, mal_intrinsic_string_key(vm, "wordlike"), &wl_value);

    MalValue length_value;
    mal_vm_get_property(vm, bounds_value, mal_intrinsic_string_key(vm, "length"), &length_value);
    i32 count = mal_ops_is_number(length_value) ? (i32) mal_ops_number_as_f64(length_value) : 0;
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
    intl_resolved_set(vm, mal_value_to_object(iter->data), "pos", mal_value_from_i32(pos + 1));
    return mal_vm_create_iter_result(vm, data, false);
}

static void intl_install_segmenter(MalVm *vm, MalObject *intl_object) {
    MalObject *function_prototype = mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]);
    MalObject *prototype = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    MalNativeFunctionObject *constructor = mal_native_function_object_new_arity(
        &vm->heap, function_prototype, mal_intrinsic_ascii(vm, "Segmenter"), 0, intl_segmenter_constructor
    );
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

// ---------------------------------------------------------------------------
// Intl.DurationFormat — icu_experimental::duration. The constructor implements
// the (correct) GetDurationUnitOptions defaults in C so resolvedOptions matches
// the spec; ICU formats the output string.
// ---------------------------------------------------------------------------

// The 10 duration units, their resolvedOptions "<unit>" / "<unit>Display" keys,
// allowed-style group (0 date {long,short,narrow}; 1 time adds numeric,2-digit;
// 2 sub-second adds numeric), and the "digital" base default style.
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

#endif // MAL_INTL_HAS_SEGMENTER

#if MAL_INTL_HAS_DURATION_FORMAT
static MalValue intl_duration_format_constructor(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue new_target, MalValue callee) {
    (void) this_value;
    (void) callee;
    if (mal_value_is_undefined(new_target)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "Intl.DurationFormat must be called with new");
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

    bool present;
    MalString *numbering_system = nullptr;
    if (!intl_option_string(vm, options, "numberingSystem", &numbering_system, &present)) {
        return mal_value_new_undefined();
    }
    if (present && !intl_is_valid_numbering_system(numbering_system)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid numberingSystem");
        return mal_value_new_undefined();
    }

    static const char *const BASE_STYLES[] = {"long", "short", "narrow", "digital"};
    bool ok;
    MalString *base = intl_option_enum(vm, options, "style", BASE_STYLES, countof(BASE_STYLES), "short", &ok);
    if (!ok) {
        return mal_value_new_undefined();
    }
    bool digital = intl_string_eq_ascii(base, "digital");
    const char *base_cstr = digital ? "digital" : (intl_string_eq_ascii(base, "long") ? "long" : (intl_string_eq_ascii(base, "narrow") ? "narrow" : "short"));

    MalObject *resolved = mal_intrinsic_new_object(vm);
    intl_resolved_set(vm, resolved, "locale", mal_value_from_string(locale));
    intl_resolved_set(vm, resolved, "numberingSystem", mal_value_from_string(numbering_system != nullptr ? numbering_system : mal_intrinsic_ascii(vm, "latn")));
    intl_resolved_set(vm, resolved, "style", mal_value_from_string(base));

    // GetDurationUnitOptions per unit, applying the spec defaults + validation.
    const char *prev_style = nullptr;
    for (i32 i = 0; i < 10; i++) {
        const char *const *allowed = DURATION_UNITS[i].group == 0 ? DUR_STYLES_DATE : (DURATION_UNITS[i].group == 1 ? DUR_STYLES_TIME : DUR_STYLES_SUBSEC);
        usize allowed_n = DURATION_UNITS[i].group == 0 ? countof(DUR_STYLES_DATE) : (DURATION_UNITS[i].group == 1 ? countof(DUR_STYLES_TIME) : countof(DUR_STYLES_SUBSEC));
        const char *style = dur_get_style(vm, options, DURATION_UNITS[i].unit, allowed, allowed_n, &ok);
        if (!ok) {
            return mal_value_new_undefined();
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
                display_default = "auto";
                if (dur_str_eq(prev_style, "fractional") || dur_str_eq(prev_style, "numeric") || dur_str_eq(prev_style, "2-digit")) {
                    style = "numeric";
                } else {
                    style = base_cstr;
                }
            }
        }
        if (dur_str_eq(style, "numeric") && DURATION_UNITS[i].group == 2) {
            style = "fractional";
            display_default = "auto";
        }
        // GetOption(options, "<unit>Display", «auto, always», display_default).
        static const char *const DISPLAYS[] = {"auto", "always"};
        const char *display = dur_get_style(vm, options, DURATION_UNITS[i].display, DISPLAYS, countof(DISPLAYS), &ok);
        if (!ok) {
            return mal_value_new_undefined();
        }
        if (display == nullptr) {
            display = display_default;
        }
        if (dur_str_eq(display, "always") && dur_str_eq(style, "fractional")) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "fractional unit cannot be displayed always");
            return mal_value_new_undefined();
        }
        if (dur_str_eq(prev_style, "fractional") && !dur_str_eq(style, "fractional")) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "a unit after a fractional unit must be fractional");
            return mal_value_new_undefined();
        }
        if (dur_str_eq(prev_style, "numeric") || dur_str_eq(prev_style, "2-digit")) {
            if (!dur_str_eq(style, "fractional") && !dur_str_eq(style, "numeric") && !dur_str_eq(style, "2-digit")) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "invalid unit style after numeric");
                return mal_value_new_undefined();
            }
            if (i == 5 || i == 6) { // minutes, seconds
                style = "2-digit";
            }
        }
        intl_resolved_set(vm, resolved, DURATION_UNITS[i].unit, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) style)));
        intl_resolved_set(vm, resolved, DURATION_UNITS[i].display, mal_value_from_string(mal_intrinsic_ascii(vm, (const byte *) display)));
        prev_style = style;
    }

    // GetNumberOption(options, "fractionalDigits", 0, 9, undefined).
    i32 fractional_digits = -1;
    MalValue fd_value;
    if (mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "fractionalDigits"), &fd_value) && !mal_value_is_undefined(fd_value)) {
        f64 fd;
        if (!mal_vm_to_number(vm, fd_value, &fd)) {
            return mal_value_new_undefined();
        }
        if (isnan(fd) || fd < 0.0 || fd > 9.0) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "fractionalDigits out of range");
            return mal_value_new_undefined();
        }
        fractional_digits = (i32) floor(fd);
        intl_resolved_set(vm, resolved, "fractionalDigits", mal_value_from_i32(fractional_digits));
    }

    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_DURATION_FORMAT_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    MalIntlObject *df = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_DURATION_FORMAT, nullptr, mal_value_from_object(resolved));
    return mal_value_from_intl_object(df);
}

/**
 * ToDurationRecord(input): read the 10 duration fields off `input` (which must be
 * an object), each via ToIntegerIfIntegral, enforcing a single sign. Fills
 * units[10] (magnitudes) + *sign_negative. Returns false with a pending throw.
 */
static bool intl_to_duration_record(MalVm *vm, MalValue input, u64 *units, bool *sign_negative) {
    if (!mal_value_is_object(input)) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "duration must be an object");
        return false;
    }
    bool any = false;
    i32 sign = 0;
    for (i32 i = 0; i < 10; i++) {
        units[i] = 0;
        MalValue v;
        if (!mal_vm_get_property(vm, input, mal_intrinsic_string_key(vm, DURATION_UNITS[i].unit), &v)) {
            return false;
        }
        if (mal_value_is_undefined(v)) {
            continue;
        }
        any = true;
        f64 d;
        if (!mal_vm_to_number(vm, v, &d)) {
            return false;
        }
        if (!isfinite(d) || floor(d) != d) {
            mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "duration field must be an integer");
            return false;
        }
        if (d < 0.0) {
            if (sign > 0) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "duration fields must have a consistent sign");
                return false;
            }
            sign = -1;
        } else if (d > 0.0) {
            if (sign < 0) {
                mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "duration fields must have a consistent sign");
                return false;
            }
            sign = 1;
        }
        units[i] = (u64) fabs(d);
    }
    if (!any) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_TYPE_ERROR_PROTOTYPE, "duration must have at least one field");
        return false;
    }
    *sign_negative = sign < 0;
    return true;
}

static MalValue intl_duration_format_do(MalVm *vm, MalIntlObject *df, MalValue duration_arg) {
    u64 units[10];
    bool sign_negative;
    if (!intl_to_duration_record(vm, duration_arg, units, &sign_negative)) {
        return mal_value_new_undefined();
    }
    MalString *locale = intl_data_string(vm, df->data, "locale");
    MalString *style = intl_data_string(vm, df->data, "style");
    i32 base_style = 1; // short
    if (style != nullptr) {
        if (intl_string_eq_ascii(style, "long")) {
            base_style = 0;
        } else if (intl_string_eq_ascii(style, "narrow")) {
            base_style = 2;
        } else if (intl_string_eq_ascii(style, "digital")) {
            base_style = 3;
        }
    }
    i32 fractional_digits = intl_data_int(vm, df->data, "fractionalDigits", -1);

    byte locale_buf[160];
    usize locale_len = 0;
    if (locale != nullptr) {
        intl_tag_utf8(locale, locale_buf, sizeof(locale_buf), &locale_len);
    }
    byte out[512];
    i32 n = mal_i18n_duration_format(locale_buf, locale_len, base_style, fractional_digits, sign_negative ? 1 : 0, units, out, (i32) sizeof(out));
    if (n < 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format duration");
        return mal_value_new_undefined();
    }
    if (n <= (i32) sizeof(out)) {
        return intl_string_from_utf8(vm, out, (usize) n);
    }
    byte *big = malloc((usize) n);
    mal_i18n_duration_format(locale_buf, locale_len, base_style, fractional_digits, sign_negative ? 1 : 0, units, big, n);
    MalValue result = intl_string_from_utf8(vm, big, (usize) n);
    free(big);
    return result;
}

static MalValue intl_duration_format_format(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    MalIntlObject *df;
    if (!intl_this(vm, this_value, MAL_INTL_DURATION_FORMAT, &df, "Intl.DurationFormat.prototype.format called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    return intl_duration_format_do(vm, df, arg_count >= 1 ? args[0] : mal_value_new_undefined());
}

static MalValue intl_duration_format_format_to_parts(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) nt;
    (void) cl;
    MalIntlObject *df;
    if (!intl_this(vm, this_value, MAL_INTL_DURATION_FORMAT, &df, "Intl.DurationFormat.prototype.formatToParts called on incompatible receiver")) {
        return mal_value_new_undefined();
    }
    MalValue formatted = intl_duration_format_do(vm, df, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (!mal_value_is_string(formatted)) {
        return mal_value_new_undefined();
    }
    // Best-effort: a single literal part (exact part decomposition needs ICU
    // field positions, which the shim does not yet expose).
    MalArrayObject *parts = mal_intrinsic_new_array(vm, 0);
    u32 idx = 0;
    if (mal_string_length(mal_value_to_string(formatted)) > 0) {
        intl_parts_push(vm, parts, &idx, "literal", formatted);
    }
    return mal_value_from_array_object(parts);
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

void mal_builtin_intl_install(MalVm *vm) {
    (void) vm; // no Intl namespace in this build
}

MalValue mal_intl_locale_compare(MalVm *vm, MalValue this_string, MalValue that_value, MalValue locales, MalValue options) {
    (void) locales;
    (void) options;
    return intl_fallback_locale_compare(vm, this_string, that_value);
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
