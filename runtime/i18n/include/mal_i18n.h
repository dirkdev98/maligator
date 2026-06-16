/*
 * mal_i18n.h — C ABI for the `mal_i18n` Rust shim (ICU4X / temporal_rs).
 *
 * Hand-maintained to mirror the `#[no_mangle] extern "C"` surface in
 * runtime/i18n/src/lib.rs. The C runtime owns all JS-spec glue; this header
 * exposes only flat i18n primitives.
 */
#pragma once

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Bump alongside MAL_I18N_ABI_VERSION in lib.rs on breaking changes. */
#define MAL_I18N_ABI_VERSION 1u

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
int32_t mal_i18n_locale_maximize(const uint8_t *tag, size_t tag_len, uint8_t *out, int32_t out_cap);
int32_t mal_i18n_locale_minimize(const uint8_t *tag, size_t tag_len, uint8_t *out, int32_t out_cap);
int32_t mal_i18n_locale_field(const uint8_t *tag, size_t tag_len, int32_t field, uint8_t *out, int32_t out_cap);

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

/* ---- Intl.Collator ----
 * collator_new returns an opaque, leaked handle (or NULL on failure).
 * strength: 0 primary, 1 secondary, 2 tertiary; case_first: 0 off, 1 upper, 2 lower. */
void *mal_i18n_collator_new(const uint8_t *locale, size_t locale_len, int32_t strength, int32_t case_level, int32_t numeric, int32_t case_first);
int32_t mal_i18n_collator_compare_utf16(void *handle, const uint16_t *a, size_t a_len, const uint16_t *b, size_t b_len);

/* ---- Intl.PluralRules ----
 * category: 0 zero, 1 one, 2 two, 3 few, 4 many, 5 other. */
void *mal_i18n_plural_rules_new(const uint8_t *locale, size_t locale_len, int32_t ordinal);
int32_t mal_i18n_plural_category(void *handle, double number);

/* ---- Intl.NumberFormat (decimal + percent) ---- */
int32_t mal_i18n_number_format(const uint8_t *locale, size_t locale_len, double number, int32_t percent, int32_t min_integer, int32_t min_fraction, int32_t max_fraction, int32_t grouping, uint8_t *out, int32_t out_cap);

/* ---- Intl.DateTimeFormat (dateStyle / timeStyle) ----
 * date_style / time_style: -1 none, 0 full, 1 long, 2 medium, 3 short. */
int32_t mal_i18n_datetime_format(const uint8_t *locale, size_t locale_len, int32_t year, int32_t month, int32_t day, int32_t hour, int32_t minute, int32_t second, int32_t date_style, int32_t time_style, uint8_t *out, int32_t out_cap);

#ifdef __cplusplus
}
#endif
