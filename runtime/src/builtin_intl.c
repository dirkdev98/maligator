#include "builtin_intl.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "array_object.h"
#include "builtin_date.h"
#include "heap_string.h"
#include "intl_object.h"
#include "intrinsics.h"
#include "mal_i18n.h"
#include "value_ops.h"
#include "vm.h"
#include "vm_ops.h"

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
    usize n = strlen(ascii);
    if (mal_string_length(s) != n) {
        return false;
    }
    const c16 *units = mal_string_code_units(s);
    for (usize i = 0; i < n; i++) {
        if (units[i] != (c16) (byte) ascii[i]) {
            return false;
        }
    }
    return true;
}

/** Decode a UTF-8 byte buffer (ICU4X formatter output) into a JS UTF-16 string. */
static MalValue intl_string_from_utf8(MalVm *vm, const byte *bytes, usize len) {
    c16 *units = malloc(sizeof(c16) * (len + 1));
    usize n = 0;
    usize i = 0;
    while (i < len) {
        byte b = bytes[i];
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
            cp -= 0x10000;
            units[n++] = (c16) (0xD800 + (cp >> 10));
            units[n++] = (c16) (0xDC00 + (cp & 0x3FF));
        }
    }
    MalValue result = mal_value_from_string(mal_string_new_copy(&vm->heap, units, n));
    free(units);
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
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_WRITABLE | MAL_PROPERTY_ENUMERABLE | MAL_PROPERTY_CONFIGURABLE,
        .value = value,
        .getter = mal_value_new_undefined(),
        .setter = mal_value_new_undefined(),
    };
    MalKey key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) index)};
    mal_object_define_own((MalObject *) array, key, &desc);
    mal_array_object_set_length(array, index + 1);
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
    MalNativeFunctionObject *getter = mal_native_function_object_new(
        &vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_FUNCTION_PROTOTYPE]),
        mal_intrinsic_ascii(vm, display), callback
    );
    MalPropertyDesc desc = {
        .flags = MAL_PROPERTY_ACCESSOR | MAL_PROPERTY_CONFIGURABLE,
        .value = mal_value_new_undefined(),
        .getter = mal_value_from_native_function_object(getter),
        .setter = mal_value_new_undefined(),
    };
    mal_object_define_own(prototype, mal_intrinsic_string_key(vm, name), &desc);
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
    MalValue prototype;
    if (!mal_vm_get_property(vm, new_target, mal_intrinsic_string_key(vm, "prototype"), &prototype)) {
        return nullptr;
    }
    if (mal_value_is_object(prototype)) {
        return mal_value_to_object(prototype);
    }
    return mal_value_to_object(vm->intrinsics[fallback]);
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
        MalKey key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)};
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
    if (isnan(length_number) || length_number <= 0.0) {
        return result;
    }
    u64 length = length_number > 9007199254740991.0 ? 9007199254740991ULL : (u64) length_number;

    for (u64 i = 0; i < length; i++) {
        // Array index elements are stored under MAL_KEY_INDEX; beyond the index
        // range they would be string keys, but a locale list is never that long.
        MalKey property_key = i <= 0xFFFFFFFEULL
            ? (MalKey) {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32((i32) i)}
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
// Intl.supportedValuesOf — curated, sorted value lists (TODO #12: enumerate via ICU).
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
    // (language/script/region options) are a TODO.
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

/** GetOption(options, name, "string"): false on a pending throw. */
static bool intl_option_string(MalVm *vm, MalValue options, const char *name, MalString **out, bool *present) {
    *present = false;
    if (!mal_value_is_object(options)) {
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

/** GetOption(options, name, "boolean"). */
static bool intl_option_bool(MalVm *vm, MalValue options, const char *name, bool *out, bool *present) {
    *present = false;
    *out = false;
    if (!mal_value_is_object(options)) {
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

/** ResolveLocale (simplified): the first canonical requested locale, else "en-US". */
static MalString *intl_resolve_locale(MalVm *vm, MalValue locales) {
    MalArrayObject *list = intl_canonicalize_locale_list(vm, locales);
    if (list == nullptr) {
        return nullptr;
    }
    MalKey first_key = {.kind = MAL_KEY_INDEX, .value = mal_value_from_i32(0)};
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

// ---------------------------------------------------------------------------
// Intl.Collator
// ---------------------------------------------------------------------------

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
    MalValue collator_value = mal_native_function_object_get_slot(mal_value_to_native_function_object(callee), 0);
    MalIntlObject *collator = mal_value_to_intl_object(collator_value);
    MalString *x;
    MalString *y;
    if (!mal_vm_to_string(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined(), &x)) {
        return mal_value_new_undefined();
    }
    if (!mal_vm_to_string(vm, arg_count >= 2 ? args[1] : mal_value_new_undefined(), &y)) {
        return mal_value_new_undefined();
    }
    i32 result = mal_i18n_collator_compare_utf16(
        collator->handle,
        (const uint16_t *) mal_string_code_units(x), mal_string_length(x),
        (const uint16_t *) mal_string_code_units(y), mal_string_length(y)
    );
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
    MalArrayObject *result = intl_canonicalize_locale_list(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (result == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_from_array_object(result);
}

/**
 * String.prototype.localeCompare's collation, exposed for builtin_string.c: a
 * per-call Collator over (locales, options) comparing two already-resolved
 * strings. Returns a Number (-1/0/1), or undefined with a pending throw.
 */
MalValue mal_intl_locale_compare(MalVm *vm, MalValue this_string, MalValue that_value, MalValue locales, MalValue options) {
    MalString *self;
    MalString *that;
    if (!mal_vm_to_string(vm, this_string, &self)) {
        return mal_value_new_undefined();
    }
    if (!mal_vm_to_string(vm, that_value, &that)) {
        return mal_value_new_undefined();
    }
    MalValue ctor_args[2] = {locales, options};
    MalValue collator = intl_collator_constructor(vm, mal_value_new_undefined(), ctor_args, 2, mal_value_new_undefined(), mal_value_new_undefined());
    if (!mal_value_is_intl_object(collator)) {
        return mal_value_new_undefined(); // a pending throw from the constructor
    }
    MalIntlObject *handle = mal_value_to_intl_object(collator);
    i32 result = mal_i18n_collator_compare_utf16(
        handle->handle,
        (const uint16_t *) mal_string_code_units(self), mal_string_length(self),
        (const uint16_t *) mal_string_code_units(that), mal_string_length(that)
    );
    return mal_value_from_i32(result);
}

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

// ---------------------------------------------------------------------------
// Intl.PluralRules
// ---------------------------------------------------------------------------

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
    MalArrayObject *result = intl_canonicalize_locale_list(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (result == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_from_array_object(result);
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

// ---------------------------------------------------------------------------
// Intl.NumberFormat — style "decimal" + "percent" (currency/unit/compact TODO).
// ---------------------------------------------------------------------------

static i32 intl_data_int(MalVm *vm, MalValue data, const char *key, i32 fallback) {
    MalValue value;
    if (mal_vm_get_property(vm, data, mal_intrinsic_string_key(vm, key), &value) && mal_ops_is_number(value)) {
        return (i32) mal_ops_number_as_f64(value);
    }
    return fallback;
}

static bool intl_data_bool(MalVm *vm, MalValue data, const char *key, bool fallback) {
    MalValue value;
    if (mal_vm_get_property(vm, data, mal_intrinsic_string_key(vm, key), &value) && !mal_value_is_undefined(value)) {
        return mal_value_is_truthy(value);
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

/** Locale-agnostic ±∞ / NaN rendering for non-finite inputs (en symbols). */
static MalValue intl_nonfinite_number(MalVm *vm, f64 number) {
    if (isnan(number)) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, "NaN"));
    }
    c16 units[2];
    usize n = 0;
    if (number < 0) {
        units[n++] = '-';
    }
    units[n++] = 0x221E; // U+221E INFINITY
    return mal_value_from_string(mal_string_new_copy(&vm->heap, units, n));
}

static MalValue intl_number_format_value(MalVm *vm, MalIntlObject *nf, f64 number) {
    if (!isfinite(number)) {
        return intl_nonfinite_number(vm, number);
    }
    MalString *locale = intl_data_string(vm, nf->data, "locale");
    MalString *style = intl_data_string(vm, nf->data, "style");
    bool percent = style != nullptr && intl_string_eq_ascii(style, "percent");
    i32 min_integer = intl_data_int(vm, nf->data, "minimumIntegerDigits", 1);
    i32 min_fraction = intl_data_int(vm, nf->data, "minimumFractionDigits", 0);
    i32 max_fraction = intl_data_int(vm, nf->data, "maximumFractionDigits", percent ? 0 : 3);
    bool grouping = intl_data_bool(vm, nf->data, "useGrouping", true);

    byte locale_buf[160];
    usize locale_len = 0;
    if (locale != nullptr) {
        intl_tag_utf8(locale, locale_buf, sizeof(locale_buf), &locale_len);
    }
    byte out[256];
    i32 n = mal_i18n_number_format(
        locale_buf, locale_len, number, percent ? 1 : 0, min_integer, min_fraction, max_fraction, grouping ? 1 : 0,
        out, (i32) sizeof(out)
    );
    if (n < 0) {
        mal_vm_throw_error(vm, MAL_INTRINSIC_RANGE_ERROR_PROTOTYPE, "could not format number");
        return mal_value_new_undefined();
    }
    if (n <= (i32) sizeof(out)) {
        return intl_string_from_utf8(vm, out, (usize) n);
    }
    byte *big = malloc((usize) n);
    mal_i18n_number_format(locale_buf, locale_len, number, percent ? 1 : 0, min_integer, min_fraction, max_fraction, grouping ? 1 : 0, big, n);
    MalValue result = intl_string_from_utf8(vm, big, (usize) n);
    free(big);
    return result;
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
    bool present;
    MalString *style = nullptr;
    if (!intl_option_string(vm, options, "style", &style, &present)) {
        return mal_value_new_undefined();
    }
    bool percent = style != nullptr && intl_string_eq_ascii(style, "percent");
    if (style == nullptr) {
        style = mal_intrinsic_ascii(vm, "decimal");
    }

    // SetNumberFormatDigitOptions (decimal/percent subset).
    i32 min_integer = 1;
    i32 min_fraction = 0;
    i32 max_fraction = percent ? 0 : 3;
    if (mal_value_is_object(options)) {
        MalValue value;
        if (mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "minimumIntegerDigits"), &value) && !mal_value_is_undefined(value)) {
            f64 d;
            if (!mal_vm_to_number(vm, value, &d)) {
                return mal_value_new_undefined();
            }
            min_integer = d < 1 ? 1 : (d > 21 ? 21 : (i32) d);
        }
        bool min_frac_set = false;
        if (mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "minimumFractionDigits"), &value) && !mal_value_is_undefined(value)) {
            f64 d;
            if (!mal_vm_to_number(vm, value, &d)) {
                return mal_value_new_undefined();
            }
            min_fraction = d < 0 ? 0 : (d > 100 ? 100 : (i32) d);
            min_frac_set = true;
        }
        if (mal_vm_get_property(vm, options, mal_intrinsic_string_key(vm, "maximumFractionDigits"), &value) && !mal_value_is_undefined(value)) {
            f64 d;
            if (!mal_vm_to_number(vm, value, &d)) {
                return mal_value_new_undefined();
            }
            max_fraction = d < 0 ? 0 : (d > 100 ? 100 : (i32) d);
        } else if (min_frac_set && min_fraction > max_fraction) {
            max_fraction = min_fraction;
        }
    }
    if (max_fraction < min_fraction) {
        max_fraction = min_fraction;
    }
    bool grouping = true;
    bool grouping_present;
    if (!intl_option_bool(vm, options, "useGrouping", &grouping, &grouping_present)) {
        return mal_value_new_undefined();
    }
    if (!grouping_present) {
        grouping = true;
    }

    MalObject *resolved = mal_intrinsic_new_object(vm);
    intl_resolved_set(vm, resolved, "locale", mal_value_from_string(locale));
    intl_resolved_set(vm, resolved, "numberingSystem", mal_value_from_string(mal_intrinsic_ascii(vm, "latn")));
    intl_resolved_set(vm, resolved, "style", mal_value_from_string(style));
    intl_resolved_set(vm, resolved, "minimumIntegerDigits", mal_value_from_i32(min_integer));
    intl_resolved_set(vm, resolved, "minimumFractionDigits", mal_value_from_i32(min_fraction));
    intl_resolved_set(vm, resolved, "maximumFractionDigits", mal_value_from_i32(max_fraction));
    intl_resolved_set(vm, resolved, "useGrouping", mal_value_new_boolean(grouping));

    MalObject *prototype = intl_resolve_prototype(vm, new_target, MAL_INTRINSIC_INTL_NUMBER_FORMAT_PROTOTYPE);
    if (prototype == nullptr) {
        return mal_value_new_undefined();
    }
    MalIntlObject *nf = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_NUMBER_FORMAT, nullptr, mal_value_from_object(resolved));
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
        "locale", "numberingSystem", "style", "minimumIntegerDigits", "minimumFractionDigits", "maximumFractionDigits", "useGrouping",
    };
    return intl_resolved_copy(vm, nf->data, keys, countof(keys));
}

static MalValue intl_number_format_supported_locales_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) this_value;
    (void) nt;
    (void) cl;
    MalArrayObject *result = intl_canonicalize_locale_list(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (result == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_from_array_object(result);
}

MalValue mal_intl_number_to_locale_string(MalVm *vm, f64 number, MalValue locales, MalValue options) {
    MalValue ctor_args[2] = {locales, options};
    MalValue nf = intl_number_format_constructor(vm, mal_value_new_undefined(), ctor_args, 2, mal_value_new_undefined(), mal_value_new_undefined());
    if (!mal_value_is_intl_object(nf)) {
        return mal_value_new_undefined();
    }
    return intl_number_format_value(vm, mal_value_to_intl_object(nf), number);
}

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

// ---------------------------------------------------------------------------
// Intl.DateTimeFormat — dateStyle / timeStyle (component options are TODO).
// ---------------------------------------------------------------------------

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
    mal_i18n_datetime_format(locale_buf, locale_len, year, month, day, hour, minute, second, date_code, time_code, big, n);
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
    MalIntlObject *dtf = mal_intl_object_new(&vm->heap, prototype, MAL_INTL_DATE_TIME_FORMAT, nullptr, mal_value_from_object(resolved));
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
    MalString *locale = intl_data_string(vm, dtf->data, "locale");
    i32 date_code = intl_data_int(vm, dtf->data, "dateStyleCode", 2);
    i32 time_code = intl_data_int(vm, dtf->data, "timeStyleCode", -1);
    return intl_datetime_format_epoch(vm, locale, epoch, date_code, time_code);
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

static MalValue intl_date_time_format_supported_locales_of(MalVm *vm, MalValue this_value, const MalValue *args, i32 arg_count, MalValue nt, MalValue cl) {
    (void) this_value;
    (void) nt;
    (void) cl;
    MalArrayObject *result = intl_canonicalize_locale_list(vm, arg_count >= 1 ? args[0] : mal_value_new_undefined());
    if (result == nullptr) {
        return mal_value_new_undefined();
    }
    return mal_value_from_array_object(result);
}

MalValue mal_intl_date_to_locale_string(MalVm *vm, f64 time_value, MalValue locales, MalValue options, i32 which) {
    if (!isfinite(time_value)) {
        return mal_value_from_string(mal_intrinsic_ascii(vm, "Invalid Date"));
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
}

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
    mal_intrinsic_define_method_n(vm, prototype, "resolvedOptions", 0, intl_date_time_format_resolved_options);

    mal_intrinsic_define_data(vm, intl_object, "DateTimeFormat", vm->intrinsics[MAL_INTRINSIC_INTL_DATE_TIME_FORMAT_CONSTRUCTOR], MAL_PROPERTY_WRITABLE | MAL_PROPERTY_CONFIGURABLE);
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

void mal_builtin_intl_install(MalVm *vm) {
    MalObject *intl = mal_object_new(&vm->heap, mal_value_to_object(vm->intrinsics[MAL_INTRINSIC_OBJECT_PROTOTYPE]));
    vm->intrinsics[MAL_INTRINSIC_INTL] = mal_value_from_object(intl);
    intl_set_to_string_tag(vm, intl, "Intl");

    mal_intrinsic_define_method_n(vm, intl, "getCanonicalLocales", 1, intl_get_canonical_locales);
    mal_intrinsic_define_method_n(vm, intl, "supportedValuesOf", 1, intl_supported_values_of);

    intl_install_locale(vm, intl);
    intl_install_collator(vm, intl);
    intl_install_plural_rules(vm, intl);
    intl_install_number_format(vm, intl);
    intl_install_date_time_format(vm, intl);
}
