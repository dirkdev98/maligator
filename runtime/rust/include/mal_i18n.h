/*
 * mal_i18n.h — C ABI for the `mal_i18n` Rust shim (ICU4X / temporal_rs).
 *
 * Hand-maintained to mirror the `#[no_mangle] extern "C"` surface in
 * runtime/rust/src/lib.rs. The C runtime owns all JS-spec glue; this header
 * exposes only flat i18n primitives.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Identifies the flat transport contract shared with lib.rs. */
#define MAL_I18N_ABI_VERSION 9u

/* Status codes for fallible entry points; mapped to JS exceptions by the C side. */
typedef enum MalI18nStatus {
    MAL_I18N_OK = 0,
    MAL_I18N_RANGE = 1,           /* value out of spec range  -> RangeError */
    MAL_I18N_INVALID = 2,         /* invalid locale/option    -> RangeError */
    MAL_I18N_INTERNAL = 3,        /* internal library error   -> RangeError */
    MAL_I18N_BUFFER_TOO_SMALL = 4 /* retry with reported `needed` length    */
} MalI18nStatus;

/* Returns the ABI version compiled into the linked archive. */
uint32_t mal_i18n_abi_version(void);

/* Spike-only smoke test; removed once a real primitive exists. */
uint32_t mal_i18n_spike_roundtrip(uint32_t x);

/* ---- Timezone: Date's LocalTZA, backed by a bundled IANA tzdb. ---- */

/* Offset east-of-UTC (ms) of the system zone at UTC instant epoch_ms. */
int64_t mal_i18n_local_offset_ms(int64_t epoch_ms);

/* Map a local wall-clock (ms-since-epoch as if UTC) back to the UTC instant. */
int64_t mal_i18n_utc_from_local_ms(int64_t local_ms);

/* Write the system zone's IANA name (UTF-8) into buf (<= cap bytes); returns
 * the full length (probe with cap == 0). */
int32_t mal_i18n_local_tz_name(uint8_t *buf, int32_t cap);

/* ---- Intl.Locale ----
 * Each writes UTF-8 into `out` (<= out_cap bytes) and returns the full length,
 * or -1 if the tag is structurally invalid. */
int32_t mal_i18n_canonicalize_locale(const uint8_t *tag, size_t tag_len, uint8_t *out, int32_t out_cap);
/** Script direction of a locale: 1 right to left, 0 left to right, -1 invalid tag. */
int32_t mal_i18n_locale_direction(const uint8_t *tag, size_t tag_len);
int32_t mal_i18n_locale_maximize(const uint8_t *tag, size_t tag_len, uint8_t *out, int32_t out_cap);
int32_t mal_i18n_locale_minimize(const uint8_t *tag, size_t tag_len, uint8_t *out, int32_t out_cap);
/* An absent first-day keyword returns MAL_LOCALE_FIELD_ABSENT; a present empty
 * keyword returns zero. */
int32_t mal_i18n_locale_field(const uint8_t *tag, size_t tag_len, int32_t field, uint8_t *out, int32_t out_cap);
#define MAL_LOCALE_FIELD_ABSENT (-2)

/* mal_i18n_locale_field selectors. */
#define MAL_LOCALE_FIELD_BASE_NAME 0
#define MAL_LOCALE_FIELD_LANGUAGE 1
#define MAL_LOCALE_FIELD_SCRIPT 2
#define MAL_LOCALE_FIELD_REGION 3
#define MAL_LOCALE_FIELD_CALENDAR 4
#define MAL_LOCALE_FIELD_COLLATION 5
#define MAL_LOCALE_FIELD_HOUR_CYCLE 6
#define MAL_LOCALE_FIELD_CASE_FIRST 7
#define MAL_LOCALE_FIELD_NUMERIC 8
#define MAL_LOCALE_FIELD_NUMBERING_SYSTEM 9
#define MAL_LOCALE_FIELD_VARIANTS 10
#define MAL_LOCALE_FIELD_FIRST_DAY_OF_WEEK 11

/* ---- Intl.Collator ----
 * collator_new returns an opaque, leaked handle (or NULL on failure).
 * strength: 0 primary, 1 secondary, 2 tertiary; case_first: 0 off, 1 upper, 2 lower. */
void *mal_i18n_collator_new(const uint8_t *locale, size_t locale_len, int32_t strength, int32_t case_level, int32_t numeric, int32_t case_first);
int32_t mal_i18n_collator_compare_utf16(void *handle, const uint16_t *a, size_t a_len, const uint16_t *b, size_t b_len);
/* Default en-US plan: -1/0/1, or 2 if the baked plan could not be built. */
int32_t mal_i18n_default_collator_compare_utf16(const uint16_t *a, size_t a_len, const uint16_t *b, size_t b_len);
/* Prepared options: strength bits 0-1, case level bit 2, numeric bit 3, case first bits 4-5.
 * Locale bytes are canonicalized on cache miss; returns -1/0/1, or 2 on invalid input. */
int32_t mal_i18n_prepared_collator_compare_utf16(const uint8_t *locale, size_t locale_len, int32_t options, const uint16_t *a, size_t a_len, const uint16_t *b, size_t b_len, uint8_t *cache_hit);
void mal_i18n_collator_free(void *handle); /* null-tolerant; ABI v2+ */

/* ---- Intl.PluralRules ----
 * category: 0 zero, 1 one, 2 two, 3 few, 4 many, 5 other. */
void *mal_i18n_plural_rules_new(const uint8_t *locale, size_t locale_len, int32_t ordinal);
int32_t mal_i18n_plural_category(void *handle, double number);
void mal_i18n_plural_rules_free(void *handle); /* null-tolerant; ABI v2+ */

/* ---- Intl.NumberFormat (decimal + percent) ----
 * min_significant / max_significant carry the significant-digit options; when
 * max_significant > 0 they drive rounding/padding and the fraction args are
 * ignored, otherwise min_fraction / max_fraction apply. sign_display: 0 auto,
 * 1 never, 2 always, 3 exceptZero, 4 negative (ECMA-402 signDisplay values,
 * applied to the rounded value so negative zero and values rounded to zero are
 * handled correctly). */
void *mal_i18n_number_formatter_new(const uint8_t *locale, size_t locale_len, int32_t percent, int32_t min_integer, int32_t min_fraction, int32_t max_fraction, int32_t min_significant, int32_t max_significant, int32_t grouping, int32_t sign_display);
int32_t mal_i18n_number_formatter_format(void *handle, double number, uint8_t *out, int32_t out_cap);
void mal_i18n_number_formatter_free(void *handle);
int32_t mal_i18n_number_format_default_en_us(double number, uint8_t *out, int32_t out_cap);

/* ---- Intl.DateTimeFormat (dateStyle / timeStyle) ----
 * date_style / time_style: -1 none, 0 full, 1 long, 2 medium, 3 short. */
int32_t mal_i18n_datetime_format(const uint8_t *locale, size_t locale_len, int32_t year, int32_t month, int32_t day, int32_t hour, int32_t minute, int32_t second, int32_t date_style, int32_t time_style, uint8_t *out, int32_t out_cap);
void *mal_i18n_datetime_formatter_new(const uint8_t *locale, size_t locale_len, int32_t date_style, int32_t time_style);
int32_t mal_i18n_datetime_formatter_format(void *handle, int32_t year, int32_t month, int32_t day, int32_t hour, int32_t minute, int32_t second, uint8_t *out, int32_t out_cap);
void mal_i18n_datetime_formatter_free(void *handle);

/* ---- Intl.ListFormat ----
 * A borrowed UTF-16 string (mirrors Rust MalU16Str). */
typedef struct MalU16Str {
    const uint16_t *ptr;
    size_t len;
} MalU16Str;

/* list_type: 0 conjunction, 1 disjunction, 2 unit; length: 0 long,
 * 1 short, 2 narrow. The handle owns the locale's immutable ICU plan. */
void *mal_i18n_list_formatter_new(const uint8_t *locale, size_t locale_len, int32_t list_type, int32_t length);
void mal_i18n_list_formatter_free(void *handle);

typedef struct MalI18nListLiteral {
    size_t start;
    size_t len;
} MalI18nListLiteral;

/* Write UTF-16 literal units and items_count + 1 spans, alternating with the
 * original elements. Return required literal capacity, or -1 on failure. Input
 * spans are borrowed for this call only. No JS allocation/callback may occur
 * while they are borrowed. An undersized out buffer receives a prefix; retry
 * with the returned capacity. spans_cap must be at least items_count + 1. */
int32_t mal_i18n_list_formatter_literals(const void *handle, const MalU16Str *items, size_t items_count, uint16_t *out, size_t out_cap, MalI18nListLiteral *spans, size_t spans_cap);

/* ---- Intl.Segmenter ----
 * granularity: 0 grapheme, 1 word, 2 sentence. Writes segment boundary positions
 * (UTF-16 indices, including 0 and the end) into bounds_out, and a per-segment
 * isWordLike flag into wordlike_out. cap is bounds_out's element capacity.
 * Returns the number of boundaries (segment count + 1). */
size_t mal_i18n_segment(int32_t granularity, const uint16_t *text, size_t text_len, int32_t *bounds_out, uint8_t *wordlike_out, size_t cap);

/* ---- Intl.DisplayNames ----
 * kind: 0 region, 1 script, 2 language; style: 0 long, 1 short, 2 narrow. Writes
 * UTF-8 into out; returns the length, -1 when no name exists (caller applies the
 * Fallback option), or -2 when the code is structurally invalid. */
int32_t mal_i18n_display_name(const uint8_t *locale, size_t locale_len, int32_t kind, int32_t style, const uint8_t *code, size_t code_len, uint8_t *out, int32_t out_cap);

/* Intl.DurationFormat: styles long/short/narrow/numeric/2-digit/fractional = 0..5,
 * display auto/always = 0/1. The metadata pointers live until _free.
 * Original Number values cross as doubles; validation precedes integer conversion. */
typedef struct MalI18nDurationResolved {
    const uint8_t *locale;
    size_t locale_len;
    const uint8_t *numbering;
    size_t numbering_len;
    size_t heap_bytes;
    uint8_t two_digit_hours;
} MalI18nDurationResolved;
void *mal_i18n_duration_new(const uint8_t *locale, size_t locale_len, const uint8_t *numbering, size_t numbering_len, int32_t style, int32_t fractional_digits, const uint8_t *styles, const uint8_t *displays, MalI18nDurationResolved *resolved);
size_t mal_i18n_duration_free(void *handle);
int32_t mal_i18n_duration_parse(const uint16_t *text, size_t length, double *out);
/* Returns the full UTF-8 length, -2 for an invalid record, -1 for a data error. */
int32_t mal_i18n_duration_format(void *handle, const double *units, uint8_t *out, int32_t out_cap);

/* ---- Intl.RelativeTimeFormat ---- */
typedef struct MalI18nRelativeResolved {
    const uint8_t *locale;
    size_t locale_len;
    const uint8_t *numbering_system;
    size_t numbering_len;
    size_t heap_bytes;
    uint8_t locale_matches_input;
} MalI18nRelativeResolved;

/* length: 0 long, 1 short, 2 narrow; numeric_auto != 0 selects "auto".
 * A missing numbering-system option is represented by a zero length.
 * Resolved strings borrow the immutable plan and remain valid until free.
 * heap_bytes reports owned native bytes for GC allocation/process pressure;
 * free returns the same charge for release. Compiled payloads borrow static data. */
void *mal_i18n_relative_time_new(const uint8_t *locale, size_t locale_len, const uint8_t *numbering, size_t numbering_len, int32_t length, int32_t numeric_auto, MalI18nRelativeResolved *resolved);
size_t mal_i18n_relative_time_free(void *handle);

typedef enum MalI18nRelativePartKind {
    MAL_RELATIVE_LITERAL,
    MAL_RELATIVE_INTEGER,
    MAL_RELATIVE_GROUP,
    MAL_RELATIVE_DECIMAL,
    MAL_RELATIVE_FRACTION,
} MalI18nRelativePartKind;

typedef struct MalI18nRelativePart {
    size_t start;
    size_t len;
    int32_t kind;
} MalI18nRelativePart;

/* unit: 0 second .. 7 year. Write UTF-16 text and part spans into caller-owned
 * buffers, returning required text capacity or -1. A nonnull spans_needed asks
 * for parts and receives their required capacity; null omits part tracking.
 * Undersized buffers receive prefixes; retry with both reported capacities.
 * Buffers are borrowed for this call only. No JS allocation/callback may occur. */
int32_t mal_i18n_relative_time_format(void *handle, double value, int32_t unit, uint16_t *out, size_t out_cap, MalI18nRelativePart *spans, size_t spans_cap, size_t *spans_needed);

#ifdef __cplusplus
}
#endif
